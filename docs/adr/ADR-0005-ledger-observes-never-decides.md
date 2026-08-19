# ADR-0005 — The ledger observes money; it never decides it

- **Status:** accepted
- **Date:** 2026-08-19
- **Applies to:** `apps/rgs` — `ledger/`, `domain/rounds.ts`, `migrations/0002_ledger.sql`, and
  the reconciliation job in `main.ts` (R3).

## Context

R3 adds the double-entry ledger: append-only, integer minor units, one entry pair per money
movement, with a reconciliation job that trues the journal against the wallet. The interesting
decisions are not the table — they are where recording sits relative to the wallet and the store,
what happens when a recording fails, and how an entry can be written twice without ever counting
twice. The wallet is an external system (`WalletProvider`, docs/wallet-api.md): the database cannot
wrap it in a transaction, every mutation on it is idempotent on its ref, and a rolled-back debit's
ref is debitable again. Whatever the ledger does has to survive the same crash windows and retries
the round machine already survives.

## Decision

**1. The ledger records confirmed movements, after the wallet says yes — and a recording failure
never fails the call.**

The domain journals a `STAKE` after the debit is confirmed, a `WIN` after the credit, a `ROLLBACK`
after a delivered reversal — and swallows a `record` failure at every site. The money has already
moved; refusing the spin over its own audit trail would hand the player a debit with no round,
which is the exact orphan the rollback machinery exists to prevent. A lost entry is *drift*, and
drift is what the reconciliation job reports — the safety net is downstream detection, not upstream
refusal. (The alternative — fail the call so the client's retry re-records — was rejected because
it makes the audit trail a gate on play: an unavailable ledger would stop a game whose wallet and
store are both healthy.)

**2. Idempotency mirrors the wallet's, movement for movement.**

Every call path that can be retried re-reports its movement unconditionally, so `record` must
decide whether a report is a fresh movement or a replay — and it decides exactly as the wallet
does: a standing stake replays (appends nothing), a rolled-back ref is stakeable again as a fresh
entry, a win happens once per ref, and a duplicate carrying different parameters is a conflict.
One shared `judge` function holds the rule; the memory ledger applies it in process and the
Postgres ledger applies it under a per-ref advisory lock inside the recording transaction. This is
what makes `debit → crash → retry` journal one entry, and `debit → rollback → retry-debit` journal
three.

**3. The stake is journaled *before* the round is opened, and the ledger has no foreign key to
`rounds`.**

The journal mirrors the wallet's chronology: the movement happened at the debit, not at the open.
The consequence is that a debit whose open failed and whose rollback could not be delivered leaves
a standing `STAKE` with no round row — deliberately recordable, because that state **is** the
orphan. The wallet and the ledger agree in it (both down one stake), so balance-truing can never
see it; only the missing round gives it away, which is precisely what the reconciliation job's
orphan scan looks for. A foreign key would make the one state the scan exists to find unwritable.

**4. Append-only is enforced, not promised.**

Nothing in the code path can update or delete an entry, and on Postgres a trigger refuses `UPDATE`
and `DELETE` outright — a correction is a new entry, as in any book of account. `TRUNCATE` remains
possible for schema owners (tests reset with it); the guard is against DML, not administration.

**5. Reconciliation trues balances against a caller-supplied baseline, plus a whole-journal orphan
scan — not transactions against a statement.**

The ledger records movements, not balances, so an absolute expectation needs an opening figure from
whoever observed the wallet when the window opened; `since` scopes the delta so a persistent
journal under a fresh baseline is not double-counted. The orphan scan ignores the window — an
orphan does not stop being one because time passed — and is sound wherever the store retains every
round it opened (Postgres does; the in-memory store's eviction past `retention` is a documented
dev-only caveat). Transaction-level truing against the operator's statement is a settlement-file
exercise between back offices (R7), not a wire call this seam should invent.

## Consequences

- "A scripted session's ledger sums to zero and reproduces the exact balance history" is the R3
  gate and a test (`ledger/session.test.ts`), not a claim — including through an aborted open, a
  lost rollback, and the same-`roundId` retry that heals both the round and the journal.
- The domain still works if the ledger is slow or down; what suffers is auditability, and the
  reconciliation report says so. R6's structured logging is where an individual failed write
  becomes a loud event at the moment it happens.
- The `judge` semantics are pinned by one contract suite run against both implementations
  (`ledger-contract.ts`), the same arrangement the round store uses — the memory twin defines,
  Postgres is held to it in CI on every push.
