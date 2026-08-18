# Wire protocol

**Status:** decisions pinned **2026-08-16**; implemented by `packages/protocol` (C1), served by
`packages/rgs-sim` (S0/S1) and carried over HTTP by `apps/mock-rgs` and `HttpTransport` (S2). This
document is the contract; the code is downstream of it. When the wire changes, change this file and
`packages/protocol` **first**, then the simulator, then the engine, then the UI.

The shapes below are written as TypeScript for readability. In `packages/protocol` each one is a zod
schema whose inferred type is the exported TS type — one definition, used to validate on **both**
sides of the wire.

---

## 1. Invariants

1. **The server decides; the client presents.** `stops[]` is the outcome. `view`, `wins` and
   `totalWin` are sent for presentation and for the dev-build assertion — never recomputed to decide.
2. **The client never computes a balance.** Every response carries the authoritative balance after
   the operation it describes. The HUD displays server numbers; it does not add or subtract them.
3. **Money is integer minor units** (`Minor`) everywhere, in every direction.
4. **Every mutating call is idempotent** under a client-generated key. A retry after a timeout is
   provably the same operation.
5. **The client branches on the error `class`, never on a message string.**

```ts
type Minor    = number & { readonly __brand: 'Minor' };  // integer minor units
type RoundId  = string;                                  // UUIDv7, client-generated
type SymbolId = string;
```

---

## 2. Calls

Four calls. `authenticate` is read-only; the other three mutate and carry an idempotency key.

| Call | Mutates | Idempotency key | Purpose |
| --- | --- | --- | --- |
| `authenticate` | no | — | token → session, balance, `GameConfig`, and `pendingRound` if a round was left open |
| `spin` | yes | `roundId` | debit the stake, produce the base-game outcome |
| `featureSpin` | yes | `(roundId, step)` | one free spin inside an already-open round — no debit |
| `settle` | yes | `roundId` | credit the round's total win, move the round to `SETTLED` |

### 2.1 `authenticate`

```ts
interface AuthenticateReq {
  token: string;                 // opaque; issued out of band — see §7
}

interface AuthenticateRes {
  session:  { playerId: string; currency: string; expiresAt: number };  // epoch ms, server clock
  balance:  Minor;                                                      // authoritative
  config:   GameConfig;
  pendingRound?: PendingRound;   // present iff a round is OPEN or RESOLVED
}
```

```ts
interface GameConfig {
  gameId:       string;
  mathVersion:  string;          // pins the strips + paytable the client presents with
  reels:        number;
  rows:         number;
  strips:       SymbolId[][];    // one strip per reel
  paytable:     PaytableEntry[];
  paylines:     number[][];      // row index per reel
  betLevels:    Minor[];
  limits:       { minStake: Minor; maxStake: Minor; maxWin: Minor };
  jurisdiction: JurisdictionId;  // the server declares it; the client applies it (C6)
  devMode:      boolean;         // whether this server accepts `forceOutcome` at all
}
```

`mathVersion` exists so a client shipped with older strips can detect that it is presenting a
different math model than the server is playing, and fail loudly instead of drawing the wrong reels.

### 2.2 `spin`

```ts
interface SpinReq {
  roundId:       RoundId;        // client-generated; the idempotency key
  stake:         Minor;
  clientSeed?:   string;         // mixed into the round seed by the server
  forceOutcome?: ForceOutcome;   // dev builds only; refused server-side unless devMode — §8
}

interface SpinRes {
  roundId:  RoundId;
  balance:  Minor;               // after the debit, before any credit
  result:   RoundResult;
  feature?: FeatureProgress;     // present iff this spin triggered a feature
  next:     NextAction;
}
```

### 2.3 `featureSpin`

```ts
interface FeatureSpinReq {
  roundId:       RoundId;
  step:          number;         // 1-based index within the feature; (roundId, step) is the key
  forceOutcome?: ForceOutcome;
}

interface FeatureSpinRes {
  roundId: RoundId;
  step:    number;
  balance: Minor;                // unchanged — a free spin neither debits nor credits
  result:  RoundResult;
  feature: FeatureProgress;
  next:    NextAction;
}
```

### 2.4 `settle`

```ts
interface SettleReq  { roundId: RoundId }

interface SettleRes  {
  roundId:  RoundId;
  balance:  Minor;               // after the credit
  totalWin: Minor;               // the credited amount, after max-win capping
  capped:   boolean;             // true iff `limits.maxWin` clipped the payout
  next:     'IDLE';
}
```

### 2.5 Shared shapes

```ts
type RoundState = 'OPEN' | 'RESOLVED' | 'SETTLED';   // server-side; §3
type NextAction = 'IDLE' | 'FEATURE_SPIN' | 'SETTLE';

interface RoundResult {
  stops:    number[];            // strip index per reel — the authoritative outcome
  view:     SymbolId[][];        // derived grid: convenience + dev-build assertion
  wins:     Win[];
  totalWin: Minor;               // this spin's win (this step's win, inside a feature)
  features: Feature[];           // what this spin awarded, if anything
}

interface Win {
  kind:      'LINE' | 'SCATTER';
  line?:     number;             // payline index; absent for scatter wins
  symbol:    SymbolId;
  count:     number;
  positions: Array<[reel: number, row: number]>;
  amount:    Minor;
}

type Feature =
  | { kind: 'FREE_SPINS';           awarded: number; trigger: { symbol: SymbolId; count: number } }
  | { kind: 'FREE_SPINS_RETRIGGER'; awarded: number };

interface FeatureProgress {
  kind:          'FREE_SPINS';
  total:         number;         // awarded, including retriggers
  remaining:     number;
  step:          number;         // last completed step
  cumulativeWin: Minor;          // base win + every free spin so far, uncredited until `settle`
  stakeRef:      Minor;          // the triggering stake — multipliers resolve against it
}

interface PendingRound {
  roundId:  RoundId;
  state:    'OPEN' | 'RESOLVED';
  stake:    Minor;
  result?:  RoundResult;         // present once the round resolved
  feature?: FeatureProgress;     // present while a feature is in flight
  next:     NextAction;          // exactly what the client must do to continue
}
```

### 2.6 HTTP binding

The shapes above are the contract; this is how they travel. Pinned here because two independent
implementations have to agree on it exactly — `HttpTransport` in the client, `apps/mock-rgs` today,
`apps/rgs` later — and because the contract suite (S3) runs one suite against all three. The
reasoning and the rejected alternatives are in
[ADR-0004](adr/ADR-0004-http-binding.md).

| | |
| --- | --- |
| Route | `POST /rgs/<call>` — `authenticate`, `spin`, `featureSpin`, `settle` |
| Body | The request shape from §2, as JSON. `POST` for all four, including the read-only `authenticate`: a token belongs in a body, not in a URL that lands in every access log on the way |
| Success | `200` with the response shape from §2 |
| Failure | The `ProtocolError` of §6, as JSON, with the status below |
| Correlation | `x-correlation-id` in both directions: the client mints one, the server adopts it or mints its own, and every response echoes it |

`HTTP_ROUTE_PREFIX` and `routeFor()` are exported from `@slot/protocol` beside the `CALLS` table, so
the client's path and the server's routes come from one definition.

**The client branches on the `class` in the body, never on the status.** The status is for the things
between the two — a proxy log, a health rule, a `curl` in a terminal:

| Status | Codes |
| --- | --- |
| `400` | `SCHEMA_MISMATCH` |
| `401` | `SESSION_EXPIRED` |
| `403` | `FORCE_OUTCOME_REFUSED` |
| `404` | `UNKNOWN_ROUND` (and any unknown route, as `SCHEMA_MISMATCH`) |
| `409` | `ROUND_CONFLICT` · `ILLEGAL_TRANSITION` · `MATH_VERSION_MISMATCH` |
| `422` | `INSUFFICIENT_FUNDS` · `STAKE_NOT_ALLOWED` · `LIMIT_REACHED` — understood and refused, not malformed |
| `429` | `RATE_LIMITED` (honours `Retry-After`) |
| `503` | `UPSTREAM_UNAVAILABLE` · `WALLET_UNAVAILABLE` |
| `504` | `TIMEOUT` |

**A dropped response has no status.** The simulator's `DROP` fault means the call ran and its answer
was lost, so the server holds the connection open and says nothing — the client's own timeout ends
the wait, exactly as it does in-process. Encoding it as a 504 would tell the client something the
network never did.

Two surfaces outside the game contract, both dev affordances: `POST /demo/session → { token }` (§7),
and `GET /health` · `GET /ready`. `apps/mock-rgs` adds `/dev/*` — fault injection, session reset, a
state summary — which `apps/rgs` will not have.

---

## 3. Round lifecycle

The server-side machine is `OPEN → RESOLVED → SETTLED`. `next` tells the client which call, if any,
drives the next transition — the client never infers it.

| Outcome of the call | Round state after | `next` | Client's next call |
| --- | --- | --- | --- |
| base spin, no win, no feature | `SETTLED` (atomically) | `IDLE` | none |
| base spin, win, no feature | `RESOLVED` | `SETTLE` | `settle` |
| base spin triggers a feature (with or without a base win) | `OPEN` | `FEATURE_SPIN` | `featureSpin` |
| free spin, more remaining | `OPEN` | `FEATURE_SPIN` | `featureSpin` |
| last free spin | `RESOLVED` | `SETTLE` | `settle` |
| `settle` | `SETTLED` | `IDLE` | none |

**One round is one stake and one debit.** Free spins carry no stake: the debit happened at trigger,
and `stakeRef` records what multipliers resolve against. Every win — base and feature — accumulates
in `cumulativeWin` and is credited once, by `settle`.

A retrigger arrives as a `FREE_SPINS_RETRIGGER` entry in a free spin's `result.features`; the server
has already folded it into `feature.total` and `feature.remaining`. **The client displays the
arithmetic; it does not perform it.**

**Why a zero-win base round settles atomically:** it has nothing to credit and nothing to present, so
the extra round trip buys nothing. Every round that *does* move money ends with an explicit `settle`,
which is what keeps invariant 2 true — the client shows the post-debit balance during the win
presentation and the post-credit balance after it, and never computes either.

---

## 4. Idempotency

| Call | Key | Duplicate with identical parameters | Duplicate with different parameters |
| --- | --- | --- | --- |
| `spin` | `roundId` | the original `SpinRes` is replayed — **no second spin, no second debit** | `FATAL` / `ROUND_CONFLICT` |
| `featureSpin` | `(roundId, step)` | the original `FeatureSpinRes` is replayed | `FATAL` / `ROUND_CONFLICT` |
| `settle` | `roundId` | the original `SettleRes` is replayed — **no second credit** | — |

`settle` on an already-`SETTLED` round is a **replay, not an error**: a client that timed out waiting
for the credit must be able to ask again and receive the same answer.

Retries always reuse the key. The transport layer owns timeout and exponential backoff; it never
mints a new `roundId` on retry. That rule is the whole reason a network failure mid-spin is a
presentation problem rather than a money problem.

---

## 5. Recovery

`authenticate` is the only recovery path — there is no separate reconciliation endpoint.

- `pendingRound` absent → nothing was in flight; go to `IDLE` with the returned `balance`.
- `pendingRound.state === 'OPEN'` with `feature` → the feature resumes at `step + 1`.
- `pendingRound.state === 'OPEN'` without `feature` → the spin was debited but never resolved; the
  server resolves it on the next `spin` retry with the same `roundId`.
- `pendingRound.state === 'RESOLVED'` → present `result` (or skip straight to the end of it) and call
  `settle`.

`balance` from `authenticate` is authoritative and replaces whatever the client had. This is also
what makes a credit from outside the game — or a settle the client never saw the response to —
visible: reconnecting always re-reads the balance.

---

## 6. Errors

```ts
interface ProtocolError {
  class:         'RECOVERABLE' | 'PLAYER' | 'FATAL';
  code:          ErrorCode;
  message:       string;         // for humans and logs — never branched on
  retryAfterMs?: number;         // RECOVERABLE only, advisory
  roundId?:      RoundId;
  correlationId: string;
}
```

| Class | Codes | Client behaviour |
| --- | --- | --- |
| `RECOVERABLE` | `TIMEOUT` · `UPSTREAM_UNAVAILABLE` · `WALLET_UNAVAILABLE` · `RATE_LIMITED` | backoff retry **with the same key**, reconnect overlay |
| `PLAYER` | `INSUFFICIENT_FUNDS` · `STAKE_NOT_ALLOWED` · `SESSION_EXPIRED` · `LIMIT_REACHED` | modal, return to `IDLE`, **no retry** |
| `FATAL` | `SCHEMA_MISMATCH` · `UNKNOWN_ROUND` · `ROUND_CONFLICT` · `ILLEGAL_TRANSITION` · `FORCE_OUTCOME_REFUSED` · `MATH_VERSION_MISMATCH` | freeze the reels, error screen, offer reload |

`STAKE_NOT_ALLOWED` covers both a stake outside `betLevels` and one outside `limits` — the client
already knows both from `GameConfig`, so the distinction buys nothing at the boundary.
`FORCE_OUTCOME_REFUSED` is `FATAL` on purpose: a production client cannot send the field, so
receiving the refusal means the request was tampered with or the build is wrong.

---

## 7. Where the session token comes from

**Out of band, and deliberately outside this protocol.** In production an operator's lobby issues the
token and hands it to the game in the launch URL (`?token=…&lang=…&currency=…`), which is the
standard iGaming shape. `authenticate` treats it as an opaque string; the client never mints one.

For the demo, `apps/mock-rgs` exposes `POST /demo/session → { token }` and the in-process simulator
exposes an equivalent helper. **Both are dev affordances standing in for the operator, not part of
the game contract** — they are documented here so the auth path is honest rather than fictional.
`apps/rgs` replaces this with real session validation in **R5**.

---

## 8. `forceOutcome` — two independent gates

```ts
type ForceOutcome =
  | { scenario: 'NEAR_MISS' | 'FREE_SPINS_TRIGGER' | 'MAX_WIN' | 'DEAD_SPIN' }
  | { stops: number[] };
```

1. The client cannot send it: the field is only populated behind the `__DEV_TOOLS__` Vite define, and
   the code is compile-stripped from production bundles.
2. The server refuses it: unless `devMode` is on, a request carrying `forceOutcome` fails with
   `FORCE_OUTCOME_REFUSED`, and there is a test that asserts exactly that against a
   production-mode server.

Gate 2 is what catches a regression in gate 1, which is why both exist.

---

## 9. Persisted state

Any client- or sim-side persisted payload (`localStorage` round state, feature progress) carries a
schema version exported from `@slot/protocol`:

```ts
export const PERSISTENCE_SCHEMA_VERSION = 1;

interface PersistedEnvelope<T> {
  v:       number;   // PERSISTENCE_SCHEMA_VERSION at write time
  savedAt: number;   // epoch ms, from the injected clock
  data:    T;
}
```

**Rule: on `v` mismatch, or on any parse failure, discard the payload and re-authenticate.** Never
best-effort parse. `authenticate` returns `pendingRound` anyway, so the server's view of the round
survives a discarded local payload — which means the safe behaviour is also the cheap one.

---

## 10. Deliberately not in v1

Stated so their absence reads as a decision rather than an oversight.

- **No WebSocket transport.** Nothing in this protocol is push-shaped: every call is a request the
  client initiates. A `Ws` implementation would be a stub nobody calls. If a jackpot ticker or a live
  balance feed ever lands, it earns its own transport then.
- **No standalone balance read.** Every response carries the authoritative balance and `authenticate`
  re-reads it on reconnect, so a `getBalance` call would have no caller. Adding one later is purely
  additive.
- **No seed commit/reveal.** Provable fairness is **R4** work; adding the fields now would ship a
  fairness claim the simulator cannot honour. Tracked in
  [`RECOMMENDATIONS.md`](../RECOMMENDATIONS.md) as an investment worth bringing forward.
- **No round-history call.** Tracked as a gap in [`CLAUDE.md`](../CLAUDE.md); `roundId` plus the
  persisted round state make it nearly free when it is scheduled.

---

## 11. Decision log

Each entry answers a question that was open in the `CLAUDE.md` **Gaps** registry until this document
landed. The rejected alternative is recorded because it was genuinely arguable.

**D1 — Settlement is an explicit `settle` call, not an implicit one on the next spin.**
Matching most real RGS APIs is the smaller half of the reason. The larger half: with an explicit
credit step, the client can show the post-debit balance during the win presentation and the
post-credit balance after it, both sent by the server — so the HUD never does arithmetic on money.
*Rejected:* settling implicitly on the next spin. It leaves a round `RESOLVED` forever when the
player closes the tab, and forces the client to fake the pre-credit balance by subtraction.
*Renamed:* the sketch called this `resolve` with `next: 'RESOLVE'`. The server has already *resolved*
the round when it says so; the call the client makes is `settle`, and `next` says `SETTLE`.

**D2 — Free spins are steps inside one round, requested one at a time.**
One round is one stake, one debit and one credit — which keeps the ledger (R3) trivially
reconcilable. `(roundId, step)` gives every free spin its own idempotency key, so a disconnect during
spin 7 of 10 resumes at spin 7 rather than replaying the feature.
*Rejected:* returning the whole feature as a batch in the trigger response. Simpler for the
simulator, but it collapses per-spin idempotency, makes mid-feature resume a presentation replay
rather than a real one, and does not survive the port to a real RGS.

**D3 — Every response carries the authoritative balance.**
The stale-HUD problem (resume, external credit, an unseen settle) disappears if there is exactly one
rule: the last response is the truth, and `authenticate` re-reads it.
*Rejected:* a separate balance-read call — nothing would call it, and it invites the client to poll.

**D4 — The token is issued out of band, with a documented demo issuer in the simulator.**
Anything else would be inventing an operator. §7 says so explicitly and points at where the real one
plugs in (R5).

**D5 — No WebSocket transport.** See §10.

**D6 — The persistence schema version lives in `@slot/protocol`, defined in C1.**
The sim's `localStorage` adapter (S0) and the client's feature persistence (C5) both write the
envelope, so the constant has to exist before either — not at C5, where it was originally scheduled.
