# Wire protocol

**Status:** decisions pinned **2026-08-16**; implemented by `packages/protocol` (C1), served by
`packages/rgs-sim` (S0/S1) and carried over HTTP by `apps/mock-rgs` and `HttpTransport` (S2);
amended **2026-08-19** (C6) — jurisdiction rules travel on the wire (§2.1, D8) and an expiring
session mid-round has a recovery story (§5, D9) — again **2026-08-19** (R0) — an endpoint a
server has not implemented yet answers `NOT_IMPLEMENTED` (§6, §2.7, D10) — again
**2026-08-19** (R1) — `PendingRound.next` is absent for a round debited and never resolved
(§2.6, §5), the case that gained its first real producer — again **2026-08-19** (R4) —
provable fairness as optional fields and a capability (§9, D11): commit before the bet, reveal at
the close, refused as a claim by any server that honours `forceOutcome` — and again
**2026-08-19** (R5) — the session binds to every call: the token in `authenticate`'s body, an
`Authorization: Bearer` header on the rest (§2.7, §7, D12). This
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
  limits:       { minStake: Minor; maxStake: Minor; maxWinMultiplier: number };
  jurisdiction: JurisdictionId;       // which regime this session is under
  jurisdictionRules: JurisdictionRules; // what that regime means, stated per session — D8
  devMode:      boolean;         // whether this server accepts `forceOutcome` at all
}

interface JurisdictionRules {
  /** A base-game cycle may not start sooner than this after the previous one. 0 = no floor. */
  minSpinIntervalMs:      number;
  turboAllowed:           boolean;
  autoplayAllowed:        boolean;
  /** How often play must be interrupted with a reality check. 0 = never. */
  realityCheckIntervalMs: number;
}
```

`mathVersion` exists so a client shipped with older strips can detect that it is presenting a
different math model than the server is playing, and fail loudly instead of drawing the wrong reels.

`limits.maxWinMultiplier` is a **multiple of the stake actually played**, not an absolute amount: a
ceiling expressed in money is a formality at the top bet level and unreachable at the bottom, so the
same game would have a different maximum win depending on how the player bet. The cap for a round is
`stake × maxWinMultiplier`, and §3 says when it is applied.

**The rules travel with the config, not just the id** (D8). An id alone would make the client's
preset table the authority on what a regime means — the same mistake as client-side math, one layer
up. Instead the server states what it enforces, and the client applies exactly what it was told.
`JURISDICTION_PRESETS`, exported from `@slot/protocol` beside `JURISDICTIONS`, is the baseline
meaning of each id — what a server serves unless an operator configuration overrides it per market;
the wire carries whatever the server actually enforces.

**Enforcement is split by what each side can observe.** The server can see cadence and nothing else:
a `spin` arriving less than `minSpinIntervalMs` after the previous accepted `spin` is refused with
`LIMIT_REACHED` (`PLAYER`). Turbo, autoplay and the reality check are presentation facts a server
cannot observe, so the client's compliance layer is their enforcement point — and the interval is
what keeps a non-compliant client visible anyway, because turbo's only server-visible effect *is*
cadence. Three details are deliberate: the interval is measured between **accepted base-game
`spin` calls** (a free spin is a step inside a round, paced by presentation, not by this rule); an
idempotent replay is exempt, because replay precedes validation (§4); and a compliant client never
triggers the refusal at all — it paces the button, so the server-side check exists to catch the
client that does not.

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
  roundWin: Minor;               // the round's payable total so far, already capped — §3
  capped:   boolean;             // true once `stake × maxWinMultiplier` has clipped the round
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
  roundId:  RoundId;
  step:     number;
  balance:  Minor;               // unchanged — a free spin neither debits nor credits
  roundWin: Minor;               // the round's payable total so far, already capped — §3
  capped:   boolean;             // true once `stake × maxWinMultiplier` has clipped the round
  result:   RoundResult;
  feature:  FeatureProgress;
  next:     NextAction;
}
```

### 2.4 `settle`

```ts
interface SettleReq  { roundId: RoundId }

interface SettleRes  {
  roundId:  RoundId;
  balance:  Minor;               // after the credit
  totalWin: Minor;               // the credited amount — equal to the last `roundWin`
  capped:   boolean;             // true iff the ceiling clipped this round
  next:     'IDLE';
}
```

### 2.5 `history`

```ts
interface HistoryReq {
  limit?: number;                // 1–100, newest first. Defaults to 20.
}

interface HistoryRes {
  rounds: RoundSummary[];        // newest first; settled rounds only
  /** How far back this server keeps rounds at all. The list can never be longer. */
  retention: number;
}

interface RoundSummary {
  roundId:   RoundId;
  at:        number;             // epoch ms, when the round was opened
  stake:     Minor;
  totalWin:  Minor;              // what was credited
  capped:    boolean;
  freeSpins: number;             // 0 for a base-only round
}
```

Read-only, like `authenticate`, and carrying no idempotency key for the same reason. **Settled rounds
only:** a round still in flight is `pendingRound`, and a history that mixed the two would invite a
client to present an unfinished round as a result.

Most regulated markets require a player-visible round history, and this is the server half of it: the
`roundId` is already the key everything else is logged under, so the list joins to a server's own
records without a lookup table. `retention` is on the wire because it is a real limit rather than an
implementation detail — the simulator keeps the last few dozen rounds in a browser store, and a real
RGS keeps months of them in Postgres (R1). A client that shows "your last 50 rounds" has to be told
which number to say.

### 2.6 Shared shapes

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
  kind:      'FREE_SPINS';
  total:     number;             // awarded, including retriggers
  remaining: number;
  step:      number;             // last completed step
  stakeRef:  Minor;              // the triggering stake — multipliers resolve against it
}

interface PendingRound {
  roundId:  RoundId;
  state:    'OPEN' | 'RESOLVED';
  stake:    Minor;
  roundWin: Minor;               // the round's payable total so far, already capped
  capped:   boolean;
  result?:  RoundResult;         // present once the round resolved
  feature?: FeatureProgress;     // present while a feature is in flight
  next?:    NextAction;          // what the client calls to continue — see below
}
```

`next` is absent in exactly one case: a round debited and never resolved (`OPEN`, no `result`, no
`feature` — §5's stranded case, first producible by `apps/rgs` in R1). The call that moves that
round on is the `spin` retry itself, which is not a `NextAction` — the client already decides this
case from `state` + `feature`, so the field would carry a lie rather than an instruction. Everywhere
else it is required, and the schema enforces the asymmetry.

### 2.7 HTTP binding

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
| Session | `Authorization: Bearer <token>` on every call except `authenticate` — the same token that call carried in its body (D12, R5). A multi-session server (`apps/rgs`) refuses a call without it as `SESSION_EXPIRED`; the single-session dev simulators accept and ignore it, because their one session is the process's |

`AUTHORIZATION_HEADER`, `bearerOf()` and `tokenOfBearer()` are exported from `@slot/protocol`
beside the routes, so the client's spelling and the server's parsing are one definition.
`HttpTransport` binds the header itself: it remembers the token from the last `authenticate` it
carried successfully, so nothing above the transport — the engine, the retry policy — ever learns
that HTTP has headers.

`HTTP_ROUTE_PREFIX` and `routeFor()` are exported from `@slot/protocol` beside the `CALLS` table, so
the client's path and the server's routes come from one definition. The status table below is
exported the same way, as `STATUS_OF_CODE` — two servers implement this binding (`apps/mock-rgs`
today, `apps/rgs` as the R-blocks land), and two copies of a table that must agree exactly is one
copy too many. It is declared `satisfies Record<ErrorCode, number>`, so a new error code cannot join
the taxonomy without deciding what it looks like on the wire.

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
| `501` | `NOT_IMPLEMENTED` — the route exists, the implementation does not (§6, D10) |
| `503` | `UPSTREAM_UNAVAILABLE` · `WALLET_UNAVAILABLE` |
| `504` | `TIMEOUT` |

**A dropped response has no status.** The simulator's `DROP` fault means the call ran and its answer
was lost, so the server holds the connection open and says nothing — the client's own timeout ends
the wait, exactly as it does in-process. Encoding it as a 504 would tell the client something the
network never did.

Surfaces outside the game contract: `POST /demo/session → { token }` (§7, a dev affordance on
`apps/mock-rgs`), `GET /health` · `GET /ready`, and — since R5 — `POST /operator/sessions` on
`apps/rgs`, the operator lobby's key-guarded issuing surface (§7). `apps/mock-rgs` adds `/dev/*` —
fault injection, session reset and expiry, a state summary — which `apps/rgs` does not have.

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
in `roundWin` and is credited once, by `settle`.

**The ceiling is applied as the round accrues, never at the end.** `roundWin` is
`min(everything won so far, stake × maxWinMultiplier)`, so it is the payable figure in every
response, and `settle.totalWin` equals the last `roundWin` the client was sent. Capping only at
`settle` would mean the win presentation counts up to a number the player is not paid — the reels,
the banner and the balance have to agree, and they can only agree if the server states the payable
total on the way in rather than the raw one on the way out.

`result.totalWin` is **not** capped: it is what the math paid for that grid, which is what the
client's dev-build assertion and the contract suite re-evaluate. The distinction is deliberate —
`result` is the outcome, `roundWin` is the money.

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

`roundWin` rides along for the same reason it is on every other response: a client rebuilt mid-round
has to know what the round will pay before it presents anything, and it must not derive that by
adding up results it may never have seen.

`balance` from `authenticate` is authoritative and replaces whatever the client had. This is also
what makes a credit from outside the game — or a settle the client never saw the response to —
visible: reconnecting always re-reads the balance.

**An expiring session mid-round resolves through this same path** (D9). Any authenticated call can
fail with `SESSION_EXPIRED` — the server checks expiry on every call, not only on `authenticate` —
and what the client does depends on whether a round is open:

- **No round in flight** → `SESSION_EXPIRED` behaves as any `PLAYER` error: a modal, back to `IDLE`.
- **A round in flight** → returning to `IDLE` would abandon a debited round, so the client
  re-authenticates *transparently*: it obtains a fresh token through the same out-of-band lobby seam
  that issued the first one (§7), calls `authenticate`, and resumes from `pendingRound` exactly as a
  reload does. The player sees a pause, not a modal.

There is deliberately **no renew call**: three servers would have to carry it, and the recovery path
above already exists and is tested. One transparent attempt per failure — if the re-authenticate
itself fails, that failure surfaces as an ordinary error under §6, because a client looping on
re-auth against a server that keeps refusing is a client hammering an endpoint that already said no.

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
| `FATAL` | `SCHEMA_MISMATCH` · `UNKNOWN_ROUND` · `ROUND_CONFLICT` · `ILLEGAL_TRANSITION` · `FORCE_OUTCOME_REFUSED` · `MATH_VERSION_MISMATCH` · `NOT_IMPLEMENTED` | freeze the reels, error screen, offer reload |

`STAKE_NOT_ALLOWED` covers both a stake outside `betLevels` and one outside `limits` — the client
already knows both from `GameConfig`, so the distinction buys nothing at the boundary.
`FORCE_OUTCOME_REFUSED` is `FATAL` on purpose: a production client cannot send the field, so
receiving the refusal means the request was tampered with or the build is wrong.

Two codes carry context the table cannot: `SESSION_EXPIRED` is `PLAYER`, but with a round in flight
the client re-authenticates transparently instead of showing the modal (§5, D9) — the class still
holds, because retrying *the failed call* changes nothing; what recovers is a different call. And
`LIMIT_REACHED` has a jurisdictional producer: a `spin` arriving before `minSpinIntervalMs` has
passed (§2.1).

`NOT_IMPLEMENTED` is the answer of a server that understood the request and has no code behind the
endpoint — `apps/rgs` while the R-blocks land, or an operator integration reached before a rollout
finished. `FATAL` because no retry produces the missing implementation, and a client presented with
a round its server cannot play has nothing safe to improvise (D10). It is a *validated* refusal:
schema errors still answer `SCHEMA_MISMATCH`, so the two are distinguishable on the wire — which is
exactly what the contract suite's expected-red gate branches on.

---

## 7. Where the session token comes from

**Out of band, and deliberately outside this protocol.** In production an operator's lobby issues the
token and hands it to the game in the launch URL (`?token=…&lang=…&currency=…`), which is the
standard iGaming shape. `authenticate` treats it as an opaque string; the client never mints one.

For the demo, `apps/mock-rgs` exposes `POST /demo/session → { token }` and the in-process simulator
exposes an equivalent helper. **Both are dev affordances standing in for the operator, not part of
the game contract** — they are documented here so the auth path is honest rather than fictional.

`apps/rgs` has the validating half for real since **R5**: sessions live in a store (memory or
Postgres, one contract), tokens are minted server-side from injected entropy, and the lobby's face
is an **operator surface** — `POST /operator/sessions { playerId, currency?, ttlMs? } → { token,
session }`, guarded by an operator key header (`x-operator-key`), outside the game contract exactly
as `/demo/session` is. Issuing for a player who already holds a round **renews** in the only sense
that matters: the fresh token is a new session for the same player, so it re-attaches to the same
balance and the same `pendingRound`. The demo composition still self-issues `RGS_DEMO_TOKEN` at
boot through the same service, because a server nobody can authenticate against is not a server.

Issuing a session **renews** it: asking the demo lobby again extends the running session's
`expiresAt` rather than wiping the game, exactly as an operator lobby would hand a returning player
a fresh token onto the same wallet. This is what makes the §5 mid-round recovery playable — the
fresh token re-attaches to the same balance and the same `pendingRound`.

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

## 9. Provable fairness (R4, D11)

Optional fields and a **capability**, not a requirement — because fairness and `forceOutcome` are
mutually exclusive by construction: a server that will play whatever it is told cannot publish a
hash of an outcome it has not been told yet. The simulators honestly omit every field below; a
server that refuses `forceOutcome` always (`apps/rgs`) is the kind that can commit.

```ts
interface FairnessNext    { next: Commitment }                                   // authenticate
interface FairnessBinding { commitment: Commitment }                             // pendingRound
interface SpinFairness    { commitment: Commitment; reveal?: string; next?: Commitment }
interface SettleFairness  { commitment: Commitment; reveal: string; next: Commitment }

type Commitment = string;      // SHA-256, 64 lowercase hex characters
```

The scheme is a chain of per-round pairs, one rule per moment:

- **Commit before the bet.** `authenticate.fairness.next` — and every closing response's
  `fairness.next` — is the SHA-256 of the seed the *next* round will play. The player holds it
  before choosing `roundId` and `clientSeed`, both client-minted, so after publishing the hash the
  server has nothing left to choose.
- **Bind at open.** The round's `spin` response echoes `fairness.commitment` — exactly the
  commitment that was on offer. The bound seed is persisted with the round, so a restart resolves
  and reveals the same round, and `pendingRound.fairness` re-reports the binding on resume (§5).
- **Reveal at close.** The response that closes the round — `spin` for a round with nothing left
  to pay (it settled atomically, §3), `settle` for every other — carries `reveal` (the bound seed)
  and `next` (the commitment now on offer). `reveal` and `next` travel together or not at all.
- **Verify with the maths you already have.** `sha256(reveal)` must equal the held commitment, and
  for every step `k` the round played, `drawStops(config, deriveSpinSeed(reveal, roundId,
  clientSeed, k))` must equal that step's `result.stops` — both functions ship in
  `@slot/game-math`, and the procedure is written out in [`fairness.md`](fairness.md).

One round derives every step from one committed seed, which is why a single reveal verifies the
whole round, feature and all. Idempotent replays carry the fairness block verbatim — a duplicate
`settle` reveals the same seed, not a second one.

---

## 10. Persisted state

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

## 11. Deliberately not in v1

Stated so their absence reads as a decision rather than an oversight.

- **No WebSocket transport.** Nothing in this protocol is push-shaped: every call is a request the
  client initiates. A `Ws` implementation would be a stub nobody calls. If a jackpot ticker or a live
  balance feed ever lands, it earns its own transport then.
- **No standalone balance read.** Every response carries the authoritative balance and `authenticate`
  re-reads it on reconnect, so a `getBalance` call would have no caller. Adding one later is purely
  additive.

---

## 12. Decision log

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

**D5 — No WebSocket transport.** See §11.

**D6 — The persistence schema version lives in `@slot/protocol`, defined in C1.**
The sim's `localStorage` adapter (S0) and the client's feature persistence (C5) both write the
envelope, so the constant has to exist before either — not at C5, where it was originally scheduled.

**D7 — The maximum win is a multiple of the stake played, and it is applied as the round accrues.**
Two decisions that only make sense together. A cap expressed as an absolute amount is a different
game at every bet level — unreachable at the minimum stake, a formality at the maximum — so it is
`stake × maxWinMultiplier`. And it is applied on the way *in*, so `roundWin` is always the payable
figure: a cap applied only at `settle` makes the win presentation count up to a number the player is
not paid, and no amount of client-side cleverness fixes that, because the client is not allowed to
compute money.
*Rejected:* capping at `settle` and having the client present `min(totalWin, cap)` itself — that is
the client deciding what a player won, which is the one thing ADR-0001 forbids.
*Rejected:* leaving `FeatureProgress.cumulativeWin` alongside `roundWin`. They would always be the
same number, and two fields that must agree are a defect waiting for the day they do not.

**D8 — Jurisdiction rules travel on the wire; the id is a name, not the meaning.** (2026-08-19)
`GameConfig.jurisdictionRules` states what the regime requires — spin cadence, turbo, autoplay, the
reality check — and both sides apply it: the server enforces the half it can observe (cadence), the
client's compliance layer applies the rest. `JURISDICTION_PRESETS` in `@slot/protocol` is the
baseline meaning of each id; an operator config may override per market, and the wire carries what
is actually enforced.
*Rejected:* a client-side preset table keyed on the id alone. It makes the client the authority on
what a regulator requires — a UK session against a server whose idea of UK differs would enforce the
client's idea, silently. The rules are data the server declares, like everything else it declares.

**D9 — No renew call; an expired session mid-round recovers through `authenticate`.** (2026-08-19)
§5 defines it: with a round open, the client transparently re-authenticates with a fresh token from
the lobby seam (§7) and resumes from `pendingRound`; with no round open, `SESSION_EXPIRED` stays an
ordinary `PLAYER` modal. Expiry is checked on **every** call, so the code finally has a mid-round
producer.
*Rejected:* a `renew` call. Three servers would have to carry and test it, and it would exist only
to avoid a recovery path that already exists, is already tested, and already handles every other
way a session dies.

**D10 — `NOT_IMPLEMENTED` is a protocol error: `FATAL`, `501`.** (2026-08-19)
R0 wires `apps/rgs` into the contract suite before any endpoint works, and its gate is "every
failure is `NotImplemented` **and nothing else**" — which is only assertable if the refusal is
distinguishable on the wire from a crash, a schema error and an outage. So the skeleton's answer is
a first-class taxonomy member: a valid `ProtocolError` body, `code: NOT_IMPLEMENTED`, status `501`.
`FATAL` because retrying cannot produce the missing code, and the state is not the player's doing.
The code outlives R0: a rollout that ships routes before implementations is a real state of a real
server, and `501` is what HTTP has always called it.
*Rejected:* answering `503 UPSTREAM_UNAVAILABLE`. It is `RECOVERABLE`, so every client would retry
three times against an endpoint that cannot succeed — and the contract suite could not tell "not
built yet" from "temporarily down", which un-defines the R0 gate.

**D11 — Provable fairness is a capability with per-round chained commitments, revealed on the
closing response.** (2026-08-19)
Optional fields, because the claim is only honest where `forceOutcome` is refused always — the
simulators exist to be driven, and a required field would make them lie (§9). Per-round pairs
rather than one session seed, because "reveal on settle" and "future rounds stay unpredictable"
cannot both hold for a seed that serves more than one round. The reveal rides the response that
*closes* the round — `settle` usually, `spin` for an atomically-settled dead round — because a
client is not required to call `settle` when there is nothing to credit, and a reveal nobody
receives is not a reveal. And the chain rotates only when an open succeeds, so a failed open
retries under the very commitment the player is holding.
*Rejected:* committing to a session-long seed with material derived per round
(`HMAC(secret, roundId)`) — the reveal of one round's material is then unverifiable against the
commitment until the session ends, which turns "verify your round" into "trust us until logout".
*Rejected:* a separate `verifyRound` call — the whole point is that verification needs nothing
from the server it is checking.
*Rejected:* a non-protocol body only the suite understands. The first thing a real client meeting
the skeleton would see is a body it cannot parse — `SCHEMA_MISMATCH` — blaming the wrong side.

**D12 — The session binds via an `Authorization: Bearer` header, carried by the transport.**
(2026-08-19)
The token already travels once, in `authenticate`'s body (§2.1, §7); every other call now carries
the same token as a standard bearer credential, and a multi-session server refuses its absence as
`SESSION_EXPIRED` — which is the amendment the Gaps registry promised R5 would make. A *header*
because that is where every proxy, gateway and access-log policy in the industry already expects a
credential (and why the token is not in a URL — §2.7's body rule, same reasoning). Carried *by the
transport* — `HttpTransport` remembers the token from the last successful `authenticate` — because
the alternative is teaching the engine, the retry policy and every caller of `RgsPort` that HTTP
exists, which is precisely what the seam was built to prevent. The single-session simulators accept
and ignore the header: their one session **is** the process's, and enforcing a binding they cannot
multiplex would be theatre.
*Rejected:* the token as a field on every request body. It would enter the idempotency
fingerprint, so the same retry after a mid-round renewal (§5, D9) would read as `ROUND_CONFLICT` —
the recovery story breaking the recovery story.
*Rejected:* cookies. A game embedded in an operator's page is exactly where ambient credentials
misfire (CSRF, third-party-cookie policy); an explicit header is inert until someone sends it.
*Rejected:* requiring the header of the simulators too. A rule enforced where it cannot matter
teaches integrators nothing and doubles the dev-affordance surface.
