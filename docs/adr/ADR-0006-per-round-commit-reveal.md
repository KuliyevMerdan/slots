# ADR-0006 — Fairness is a per-round commitment chain, and a capability rather than a requirement

- **Status:** accepted
- **Date:** 2026-08-19
- **Applies to:** `@slot/protocol` (`fairness.ts`, §9/D11), `@slot/game-math` (`verify.ts`),
  `apps/rgs` (`rng/`, the round store's bound pair, `domain/rounds.ts`), the contract suite's
  `provableFairness` capability (R4).

## Context

R4's gate: a player can independently recompute a round's `stops[]` from the revealed seed and
their client seed. The derivation already had the right shape —
`deriveSpinSeed(serverSeed, roundId, clientSeed, step)`, with `roundId` and `clientSeed` both
client-minted — what was missing is the proof that `serverSeed` was fixed *before* the bet. The
scheme has to survive this workspace's own constraints: the simulator honours `forceOutcome` and
must not claim fairness it cannot have; rounds resume across restarts (§5); `settle` is optional
for a round with nothing to credit; and a failed `open` is retried under the same `roundId`.

## Decision

**1. One seed per round, chained: commit on offer, bind at open, reveal at close.**

Revealing a seed that serves more than one round would make every later round predictable, so
"reveal on settle" forces per-round seeds. The commitment for round *n+1* is published on round
*n*'s closing response (and on `authenticate`), so it is always in the player's hand before the
bet that binds it. A session-long secret with per-round derived material was rejected: its
per-round reveals cannot be checked against the commitment until the session ends, which is
"trust us until logout".

**2. The reveal rides the response that closes the round — `settle`, or `spin` itself for a dead
round.**

A zero-win base round settles atomically and the client is not required to call `settle` for it
(§3); a reveal that waits for a call nobody makes is not a reveal. So the closing response carries
`reveal` + `next`, whichever call it is — and idempotent replays carry the block verbatim, because
the recorded response *is* the replay.

**3. The bound pair is persisted on the round row; the chain rotates only on a successful open.**

The seed must survive a restart or a stranded round could neither resolve identically nor reveal
honestly — so binding is a column, not a memory. Rotation on success (not on offer) is what makes
a failed open retryable under the very commitment the player holds, instead of burning a pair the
player never saw closed. The pair *on offer* is process state: a restart mints a fresh chain, the
held `next` visibly mismatches, and the durable chain arrives with R5's real sessions — stated in
`docs/fairness.md` rather than papered over.

**4. Fairness is a contract-suite capability, mutually exclusive with `forceOutcome` by
construction.**

A server that will play whatever it is told cannot publish a hash of an outcome it has not been
told yet. The fields are optional on the wire; the simulators omit them and skip the cases by
name; `apps/rgs` — which refuses `forceOutcome` always — claims the capability and is held to it
over the full production chain.

**5. The player's arithmetic ships in `@slot/game-math`, including SHA-256 itself.**

`sha256Hex` is a dependency-free FIPS 180-4 implementation held to published NIST vectors — this
package runs wherever the client runs, and a fairness check that needs `node:crypto` or a CDN is
a fairness check most players cannot run. `stopsForStep` is the gate as a function:
`drawStops(config, deriveSpinSeed(reveal, roundId, clientSeed, step))`.

## Consequences

- Entropy is injected (`RandomBytes`): `main.ts` hands the provider `node:crypto`'s CSPRNG —
  `RGS_SERVER_SEED` is gone, there is nothing to configure or leak — while tests hand in a seeded
  stream and keep every hunt deterministic.
- Two concurrent opens in one session could bind pairs out of the order the player observed;
  irrelevant for the single-session server R4 ships on, and R5's per-session chains are the
  structural fix.
- The verification procedure is documentation with an executable twin: `docs/fairness.md`
  describes exactly what `apps/rgs/src/rng/fairness.test.ts` and the suite's `provable fairness`
  cases run.
