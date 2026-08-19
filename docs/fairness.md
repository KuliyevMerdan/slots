# Verifying a round — the player's procedure

**Status:** shipped with **R4** (2026-08-19). The wire half is
[`protocol.md` §9](protocol.md) (D11); the arithmetic ships in `@slot/game-math`; the server half
lives in `apps/rgs` and is exercised by the contract suite's `provableFairness` cases and the gate
test in `apps/rgs/src/rng/fairness.test.ts`.

The claim being verified: **the server fixed your round's outcome before you bet, and can prove
it.** Not "the game is generous" — the RTP report covers what the maths pays — but "nothing about
your round was decided after your money moved".

## What you hold, and when

| Moment | You hold |
| --- | --- |
| After `authenticate` | `fairness.next` — the SHA-256 commitment for your next round |
| You choose | `roundId` (a UUIDv7 you mint) and, optionally, `clientSeed` (your own entropy) |
| After `spin` | `fairness.commitment` — must equal the commitment you were holding |
| After the closing response | `fairness.reveal` (the seed) and `fairness.next` (your next commitment) |

The closing response is `settle` for any round with money to credit, and the `spin` response
itself for a dead round — it settled atomically, so the seed has nothing left to decide.

## The checks

With `config` from `authenticate` and the functions from `@slot/game-math`:

```ts
import { sha256Hex, stopsForStep } from '@slot/game-math';

// 1. The reveal answers to the commitment you held before betting.
sha256Hex(reveal) === commitment;

// 2. Every step's grid recomputes from the reveal and your own inputs.
//    step 0 is the base spin; free spins are 1-based.
stopsForStep(config, reveal, roundId, clientSeed, step); // === that step's result.stops
```

Check 1 proves the seed was fixed before you bet: the hash arrived first, and SHA-256 is not
invertible on 32 bytes of entropy. Check 2 proves the outcome you were shown is the one that seed
produces — for every free spin too, because a round derives all its steps from its one bound seed
(`deriveSpinSeed(seed, roundId, clientSeed, step)`).

What makes the two checks sufficient is *who chose what*: the server chose the seed, but committed
to it before your bet; you chose `roundId` and `clientSeed`, so the server could not have picked a
seed that favours it against inputs it had not seen. After the commitment, there is nothing left
for the server to decide.

## What this does not prove

- **That the strips are fair.** Verification proves the server played the game it committed to —
  the RTP of that game is a property of `config.strips` and the paytable, measured by
  `pnpm math-sim` and published in the README. A crooked game, honestly committed, would verify.
- **Anything about a server that omits the fields.** Fairness is a capability (§9): the
  simulators, which honour `forceOutcome`, do not and must not claim it.
- **Chain continuity across a server restart.** The pair on offer lives with the session; a
  restart mints a fresh chain and your held `next` will not match the next round's `commitment`.
  The mismatch is *visible* — that is the design — and a durable chain belongs to R5's real
  session store.

## Trying it

Any test in `apps/rgs/src/rng/fairness.test.ts` is the procedure above, executed literally. The
contract suite runs the same checks over HTTP against the full production chain
(`tests/contract/suite.ts`, the `provable fairness` cases).
