# The wallet API — the operator↔provider seam, pinned

**Status:** pinned **2026-08-19** (R2); implemented by `apps/rgs/src/wallet/` — `wire.ts` (zod
schemas), `RemoteWallet` (the client this RGS ships), `buildWalletSimApp` (the reference server the
tests and the dev composition run against). This is **not** part of
[`docs/protocol.md`](protocol.md): that document is the player-client↔RGS wire and belongs with
`@slot/protocol`, handable to an operator's *game* team; this one is the RGS↔wallet wire, spoken to
the operator's *platform* team, and a different operator means a different adapter behind the same
`WalletProvider` interface — which is the whole reason the interface exists (R0).

The player's money lives in the operator's wallet, not in the RGS. Every movement the game ever
makes goes through four calls, and every design decision below serves one goal: **a network that
loses any message must never lose or duplicate money.**

## 1. The calls

`POST`, JSON bodies, ids in the body rather than the URL (the same argument as the game wire: a
path lands in every access log between the two systems).

| Call | Body | Answers |
| --- | --- | --- |
| `POST /wallet/balance` | `{ playerId }` | `{ balance }` |
| `POST /wallet/debit` | `{ playerId, amount, ref }` | `{ balance }` — after the debit |
| `POST /wallet/credit` | `{ playerId, amount, ref }` | `{ balance }` — after the credit |
| `POST /wallet/rollback` | `{ ref }` | `{ balance }` — after the reversal |

`amount` is integer minor units (ADR-0002). `ref` is the transaction reference — the RGS uses the
`roundId` for the stake and `` `${roundId}:settle` `` for the win, so a wallet statement reads as
rounds without a join.

## 2. Errors

A refusal is a status plus `{ code, message }`. The client maps `code`; `message` is for logs.

| Status | Code | Meaning |
| --- | --- | --- |
| `422` | `INSUFFICIENT_FUNDS` | Understood, refused: the balance cannot cover the debit |
| `404` | `UNKNOWN_PLAYER` | No wallet for this player |
| `404` | `UNKNOWN_REF` | `rollback` for a ref never seen |
| `409` | `REF_CONFLICT` | The ref was seen with **different** parameters, or a rollback of a credit |

Anything else — a 5xx, a network failure, a timeout, an unreadable body — is not a refusal but an
*unavailability*: the RGS retries (bounded) and ultimately surfaces `WALLET_UNAVAILABLE`, the
`RECOVERABLE` class of the game wire. A 4xx code is never retried: the wallet understood and said
no, and asking again is asking the same question.

## 3. The ref lifecycle — the part that carries the money safety

Every mutation is **idempotent on `ref`**:

- A duplicate `debit`/`credit` with identical parameters **replays** the recorded answer — the
  balance that transaction produced, not today's. One stake, one debit, however many times the
  request went out. This is what makes the RGS's bounded retry safe: a debit whose *response* was
  lost is healed by asking again with the same ref.
- A duplicate with different parameters is `REF_CONFLICT` — a retry is a replay, never a rewrite.
- `rollback` reverses a **debit** only (returning a credit is a correction — the ledger
  conversation, R3), and is itself idempotent: reversing twice is one reversal, replayed.
- **A ref that was rolled back becomes debitable again, as a fresh transaction.** This is the one
  rule that is not obvious and is load-bearing, so it is stated here rather than discovered: the
  RGS rolls a debit back when it has confirmed the debit but cannot create the round it was for
  (see §4). The player's client retries the same round with the same `roundId` — the game wire
  *requires* it to — and that retry must be able to take the stake again. Replaying the reversed
  transaction's answer would resolve a round against money that was already returned; refusing the
  ref outright would strand the retry loop. Re-debiting is the semantics under which
  `debit → rollback → debit → round resolves` converges to exactly one standing debit.

## 4. Failure model — who heals what

Two failure shapes exist for every mutation, and they are different problems (the same FAIL/DROP
distinction the game simulator makes):

- **Refused before executing** (wallet down, 5xx): nothing moved. The RGS's bounded retry asks
  again; if the outage outlasts the retries, the game call fails `WALLET_UNAVAILABLE` and *nothing
  anywhere has changed* — the client's own retry starts fresh.
- **Executed, response lost**: money moved, confirmation did not. The RGS cannot tell this from
  the first case — which is the point of idempotent refs: the same bounded retry replays the
  transaction and gets the confirmation the network dropped.

One window remains once the debit is *confirmed*: the RGS's own store may refuse to open the
round. That is the one state in which the RGS knows a debit stands for a round that cannot exist,
and it is the rollback's producer: undo the debit, then surface the store failure as
`RECOVERABLE`. If the rollback itself cannot be delivered, the debit is an orphan the reconciliation
job (R3) exists to find — the RGS does not pretend otherwise.
