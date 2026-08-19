# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

> ⚠️ **The game is a game, its math is a designed 96%, and the real RGS plays it against a real wallet seam.**
> As of **2026-08-19**, **C0, C1, S0, S1, C2, S2, C3, C4, C5, S4, S3, C6, C7, R0, R1, R2, R3, R4 and R5 have landed** — the
> workspace, the contracts (`protocol`, `money`, `game-math`), `rgs-sim`, the `RgsTransport` seam
> with `MockTransport`, `HttpTransport` and the retry policy, `engine`, `apps/mock-rgs`, `renderer`,
> `ui` and `apps/game-client`, `tools/math-sim` — the RTP report that tuned the strips —
> `tests/contract/`, the switch-over gate, `packages/platform` and `packages/compliance` —
> jurisdiction rules **on the wire** (D8), the transparent mid-round re-authenticate (§5, D9),
> autoplay, synthesized audio, en/ru under a glyph-coverage test, WCAG AA in CI — and now
> **`packages/dev-tools` and `tools/perf-harness`**: a debug panel that drives every seam the
> architecture already had (force outcome, fault injection, jurisdiction switch, session expiry, a
> state inspector, an exportable event log correlated on `roundId`), a player-facing round-history
> drawer over the wire's `history` call, and a perf harness whose numbers are measured rather than
> promised — ~120 fps at a 4× CPU throttle, 7 draw calls a frame, a heap that sawtooths flat. The
> production bundle is **proven** free of all of it: `verify:strip` fails `pnpm check` if any dev
> marker reaches `dist/`. And **`apps/rgs` plays the full contract (R0 + R1)** — eight modules
> laid out the way a real RGS is built, every route validating with the shared schemas; the domain
> is real since R1: the round machine and idempotency behind a store port with **two
> implementations, in-memory and Postgres** (committed migrations, guarded transitions, an
> insert-only idempotency table), held to one shared store-contract suite — the Postgres half runs
> against a service container in CI on every push. The outcome engine (the seeded PRNG and the
> stops-first derivation) moved into `@slot/game-math`, so both servers and the RTP report draw
> from **one implementation of the math**. **The wallet seam is real at the wire since R2**:
> `RemoteWallet` — per-attempt deadlines, bounded retries made safe by idempotent refs — speaks
> [`docs/wallet-api.md`](docs/wallet-api.md) to any operator wallet, the wallet sim serves that
> contract in dev and tests with both §4 failure shapes injectable (refused before executing vs.
> executed with the confirmation lost), and the rollback path closes the one
> confirmed-debit-no-round window — "a wallet failure mid-round leaves no orphaned debit" is a
> test, not a promise. **The money is auditable since R3**: a double-entry ledger — append-only,
> integer minor units, one entry pair per confirmed wallet movement — behind a `Ledger` port with
> in-memory and Postgres twins held to one contract suite (a trigger enforces append-only on
> Postgres), `record`'s idempotency mirroring the wallet's own so every retry path journals its
> movement unconditionally and one movement is one entry; a reconciliation job trues the journal
> against the wallet on an interval and finds the orphaned stake balance-truing cannot see
> (ADR-0005). The R3 gate is a test: a scripted session's ledger sums to zero and reproduces the
> exact balance history from the entries alone. **The outcomes are provably fair since R4** (§9,
> D11, ADR-0006): per-round seed pairs on a CSPRNG chain — commitment published before the bet,
> seed bound at open (persisted on the round row, so a restart resolves and reveals the same
> round), revealed on the response that closes the round with the next commitment beside it — and
> the player's whole verification ships in `@slot/game-math` (`sha256Hex` held to NIST vectors,
> `stopsForStep`), documented in [`docs/fairness.md`](docs/fairness.md). Fairness is a contract
> *capability*, mutually exclusive with `forceOutcome` by construction: the simulators skip the
> cases by name, `apps/rgs` — which refuses `forceOutcome` always — is held to them over the full
> production chain. **The sessions are real since R5** (§2.7, §7, D12, ADR-0007): every
> non-authenticate call binds its session with an `Authorization: Bearer` header — carried by
> `HttpTransport` itself, so nothing above the transport learns HTTP has headers — verified
> against a `SessionStore` with memory and Postgres twins held to one contract (Postgres over the
> planned Redis: one database until scale demands two), tokens minted from the CSPRNG through the
> key-guarded operator surface (`POST /operator/sessions`, the lobby's face; the demo token still
> self-issues at boot through the same service). The server now also enforces what it can observe
> of the jurisdiction (D8): a spin inside `minSpinIntervalMs` is refused `LIMIT_REACHED` off the
> store's own `lastOpenedAt` — replay-exempt, free spins unpaced — and the game routes sit behind
> per-token and per-IP token buckets answering `RATE_LIMITED` with `retryAfterMs`. The contract
> suite gained the mid-round expiry → renew → resume case and the pacing case, both running
> against **all three targets**. The contract suite's third target runs the whole suite over the
> full production chain — client→HTTP→rgs→HTTP→wallet — its fault case enacted by refusing the
> *real* wallet, and the §5 stranded round runs against the one target that can honestly produce
> it. 1008 tests locally, 1031 in CI, `pnpm check` green.
>
> **`pnpm dev:client` opens a playable slot.** It authenticates, spins, lands on the server's
> `stops[]`, lights the paylines it was told won, counts the win up, runs the feature and settles —
> with sound, in the session's language, under the session's jurisdiction rules. Point it at
> `apps/mock-rgs` with one environment variable and the same client plays the same game over HTTP.
>
> **Five properties are tested rather than claimed.**
> [`tests/mash.test.ts`](tests/mash.test.ts) plays 120 rounds through the real engine, transport,
> simulator and renderer while pressing at random, asserting the client's balance equals the
> server's after every round. [`tests/resume.test.ts`](tests/resume.test.ts) throws the client away
> at five points mid-feature and rebuilds it, asserting the round finishes and is credited exactly
> once. [`tests/wiring.test.ts`](tests/wiring.test.ts) kills the session mid-feature and asserts the
> round still comes home, credited once, with no error screen. `pnpm math-sim` plays twenty million
> rounds through the game's own evaluator and prints the RTP, the hit frequency, the volatility and
> the win distribution — **96.107%**, measured, on the strips that ship. And `pnpm test:contract`
> plays the whole of [`docs/protocol.md`](docs/protocol.md) — lifecycle, idempotent replay,
> `pendingRound` recovery, every error class — against **every registered target**, `apps/rgs`
> included since R1: the same suite that gated the simulators now gates the real server, and the
> §5 stranded-round case runs against the one target that can honestly produce it.
>
> **What is deliberately not there yet:** packaging, the README, rate limiting on `mock-rgs`, the
> nightly soak and the E2E suite (**C8**). The next block is **C8**; **R6** (observability) is
> the R-block now unblocked, and **R7** waits only on R6.
>
> The canon is four documents: `CLAUDE.md` (this file), [`ROADMAP.md`](ROADMAP.md) (the task map),
> [`RECOMMENDATIONS.md`](RECOMMENDATIONS.md) (the strategic registry) and
> [`docs/protocol.md`](docs/protocol.md) (the wire contract, now implemented by `packages/protocol`
> and served by `packages/rgs-sim`). Decisions that would surprise a reviewer are in
> [`docs/adr/`](docs/adr/).
>
> Sections below still marked with a block (`C2`, `C3`, `S1`…) describe the shape the code **must
> take**, not code that exists.
>
> **This distinction is load-bearing.** When you implement a block, rewrite its section here in the
> present tense in the same change ([Rule 0](#rule-0--keep-this-file-updated-after-every-change)) —
> and if reality diverged from the plan, the plan is what's wrong. Do not leave a section describing
> an intent the code no longer has.

## Project description

> ⚠️ **Keep this section current.** See [Rule 0](#rule-0--keep-this-file-updated-after-every-change).

A portfolio-grade, **server-authoritative slot game client** — PixiJS + TypeScript — in a monorepo
shaped so a real Node.js RGS (Remote Game Server) can be dropped in later without touching a line of
client code. The deliverable is the **client**; the backend is a deterministic simulator today and a
real service later.

**Target role:** game client / frontend developer at a slots studio.
**Play money only.** No real money, no payments, no crypto — a visible 18+/demo notice instead.

### The one architectural decision everything hangs on

**The client never decides outcomes. It presents an outcome the server already committed to.**

```
game-client ──▶ RgsTransport (interface) ──▶ ┌ MockTransport   (in-process sim, zero latency)
                                             ├ HttpTransport   (sim over HTTP — proves the wire)
                                             └ HttpTransport   (later: the real Node RGS)
```

The client depends on `@slot/protocol` — types plus runtime schemas — never on a server
implementation. Swapping mock for real is a **config change, not a refactor**. Lead with this in the
README and in interviews.

**The nuance that must be stated explicitly** (in `docs/architecture.md` and the README): the client
*does* ship the paytable, because it needs it to highlight paylines and sequence win animations. It
never uses it to *decide* anything. In dev builds it re-evaluates the server's grid and asserts the
win set matches — a mismatch is a loud console error. **Presentation logic, not authority.**

### Packages

`pnpm` workspaces + Turborepo. Scope is `@slot/*`. A ✅ in the **Block** column means the package is
real, ◐ means partly built with the named block finishing it; everything else is scaffolded and
empty, and the block named is the commitment.

| Package             | Path                 | Role                                                     | Block |
| ------------------- | -------------------- | -------------------------------------------------------- | ----- |
| `@slot/game-client` | `apps/game-client`   | The deliverable — Pixi client on Vite                     | ✅ C3 |
| `@slot/mock-rgs`    | `apps/mock-rgs`      | Fastify wrapper around `rgs-sim` — proves the network path | ✅ S2 |
| `@slot/rgs`         | `apps/rgs`           | Node.js RGS — rounds & idempotency on Postgres (in-memory twin); wallet over HTTP behind the R0 seam (docs/wallet-api.md); double-entry ledger + reconciliation (R3); per-round commit/reveal on a CSPRNG (R4); real sessions on a bearer binding + operator surface + pacing + rate limits (R5) | ✅ R5 |
| `@slot/protocol`    | `packages/protocol`  | ★ Contracts: zod schemas + inferred TS types + error taxonomy | ✅ C1 |
| `@slot/money`       | `packages/money`     | Branded `Minor` integer units, exact arithmetic, formatting | ✅ C1 |
| `@slot/game-math`   | `packages/game-math` | Reel strips, paytable, payline evaluator — and, since R1, the outcome engine (PRNG + stops-first derivation) both servers draw from | ✅ C1 |
| `@slot/engine`      | `packages/engine`    | ★ Headless round orchestration + FSM (**no Pixi, no DOM**) | ✅ C2 |
| `@slot/renderer`    | `packages/renderer`  | Pixi layer: reels, symbols, spin curve, generated atlas    | ✅ C3 |
| `@slot/ui`          | `packages/ui`        | Pixi UI: spin button, bet selector, HUD                    | ✅ C3 |
| `@slot/rgs-sim`     | `packages/rgs-sim`   | ★ Mock server core (pure — runs in a browser or in Node)  | ✅ S0 |
| `@slot/transport`   | `packages/transport` | `RgsTransport` interface + Mock/Http implementations      | ✅ S2 |
| `@slot/platform`    | `packages/platform`  | Audio, storage, visibility, safe-area, device capabilities | ✅ C6 |
| `@slot/compliance`  | `packages/compliance`| Jurisdiction rules, reality check, session/loss/stake limits | ✅ C6 |
| `@slot/dev-tools`   | `packages/dev-tools` | Debug panel, event log, force-outcome UI                  | ✅ C7 |
| —                   | `tools/math-sim`     | RTP / volatility / hit-frequency simulation CLI           | ✅ S4 |
| —                   | `tools/perf-harness` | Scripted fps / draw-call / heap capture                   | ✅ C7 |

Plus `config/` (shared tsconfig, eslint, prettier, vitest presets), `docs/` (`architecture.md`,
`protocol.md`, `round-lifecycle.md`, `adr/`) and `.github/workflows/`.

### Target protocol surface

**Pinned in [`docs/protocol.md`](docs/protocol.md) (2026-08-16)** — every shape, rule and rejected
alternative lives there; this is the summary. `packages/protocol` implements it as zod schemas and
`packages/rgs-sim` serves all four calls. `authenticate` is read-only, the other three mutate and
carry an idempotency key.

| Call | Key | Purpose |
| --- | --- | --- |
| `authenticate` | — | Token → session, balance, `GameConfig` (paytable, strips, bet levels, limits, jurisdiction), **and `pendingRound` if a round was left open — the entire reconnect story** |
| `spin` | `roundId` | `{ roundId, stake, clientSeed?, forceOutcome? }` → `{ balance, result, feature?, next }` — debits the stake |
| `featureSpin` | `(roundId, step)` | One free spin inside an already-open round. No debit; wins accrue to the response's `roundWin` |
| `settle` | `roundId` | Credits the round's total win, `RESOLVED → SETTLED`. Required whenever there is money to credit; a zero-win base round settles atomically |
| `history` | — | Read-only. The last settled rounds, newest first, plus the `retention` this server keeps — the server half of the player-visible round history regulated markets require |

```ts
export type Minor   = number & { readonly __brand: 'Minor' };  // integer minor units
export type RoundId = string;                                   // UUIDv7, client-generated

export interface RoundResult {
  stops:    number[];           // strip index per reel — the authoritative outcome
  view:     SymbolId[][];       // derived grid, sent for convenience + dev-build assertion
  wins:     Win[];
  totalWin: Minor;              // what the math paid for this grid — uncapped, and never the credit
  features: Feature[];
}
```

Seven design points, all of them load-bearing (six in `rgs-sim`; the seventh is `apps/rgs`'s):

- **`roundId` is generated client-side**, so a retry after a timeout is provably the same round. The
  server returns the original result for a duplicate key rather than spinning again.
- **`stops` is the outcome; `view` is derived.** Sending both lets the client assert consistency and
  makes strip-alignment bugs debuggable.
- **`pendingRound` on authenticate is the whole recovery path.** No separate recovery endpoint.
- **Money is integer minor units everywhere**, behind a branded type, so `stake + 0.1` is a compile
  error rather than a rounding incident.
- **The ceiling is a multiple of the stake played, applied as the round accrues.**
  `limits.maxWinMultiplier` rather than an amount, because an absolute cap is a different game at
  every bet level. Every mutating response carries `roundWin` — the round's payable total, already
  capped — so the presentation counts to the number the balance will receive, and `settle.totalWin`
  equals the last `roundWin` the client was sent. `result.totalWin` stays uncapped because it is the
  math, not the money (ADR/protocol D7).
- **The client never computes a balance.** Every response carries the authoritative balance after the
  operation it describes — post-debit on `spin`, post-credit on `settle`. The HUD displays server
  numbers; it never adds or subtracts them. This is why `settle` is an explicit call.
- **One round is one stake, one debit and one credit.** Free spins are *steps* inside that round,
  keyed `(roundId, step)`, so a disconnect on spin 7 of 10 resumes at spin 7. Retrigger arithmetic is
  the server's; `feature.total` / `feature.remaining` arrive already folded.
- **Jurisdiction rules travel on the wire** (`GameConfig.jurisdictionRules`, D8): the id names the
  regime, the rules object *is* the regime, and each side enforces what it can observe — the server
  refuses a spin arriving before `minSpinIntervalMs` (`LIMIT_REACHED`), the client's compliance layer
  applies turbo, autoplay and the reality check, which a server cannot see. `JURISDICTION_PRESETS`
  in `@slot/protocol` is the baseline meaning of each id; an operator config may override.
- **An expiring session mid-round recovers through `authenticate`** (§5, D9). Expiry is checked on
  every call, so the code has a producer; with a round open the client renews transparently through
  the lobby seam and resumes from `pendingRound`, with no round open it stays a `PLAYER` modal.
  There is deliberately no renew call, and the demo lobby **renews** on re-issue — the fresh token
  re-attaches to the same balance and the same round.
- **Provable fairness is optional fields and a capability** (§9, D11): commitment before the bet,
  seed bound at open, reveal on the closing response with the next commitment beside it —
  verifiable with `@slot/game-math` alone ([`docs/fairness.md`](docs/fairness.md)). A server that
  honours `forceOutcome` cannot claim it, which is exactly why the simulators do not.
- **The session binds via `Authorization: Bearer`, carried by the transport** (§2.7, D12, R5):
  the token travels once in `authenticate`'s body and as a bearer header on every other call.
  `HttpTransport` remembers it from the last successful `authenticate`, so nothing above the
  transport learns HTTP has headers; a multi-session server (`apps/rgs`) refuses its absence as
  `SESSION_EXPIRED`, and the single-session simulators accept and ignore it.

## Commands

> **Keep this table in step with `package.json`.** Commands marked _(block)_ do not exist yet — the
> block named is the one that adds them. Everything else runs today.

Everything runs from the repo root. The one command before every commit:

```bash
pnpm check
```

| Command                | What it does                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `pnpm check`           | lint → build → typecheck → test → root suites → contract suite → format check. **What CI runs.** |
| `pnpm lint`            | ESLint (incl. the purity rules) **and** the dependency-boundary rules                |
| `pnpm lint:boundaries` | `dependency-cruiser` over `packages/` — the dependency table, enforced               |
| `pnpm typecheck`       | Root suites + `turbo run typecheck` across every package                             |
| `pnpm test`            | `turbo run test` — unit tests (Vitest) per package                                   |
| `pnpm test:root`       | Root suites: the boundary and purity rules actually fire, and the sim/transport seam wires up |
| `pnpm build`           | `turbo run build` with `^build` ordering, `dist/` per package                        |
| `pnpm format`          | Prettier write (code and config; the hand-wrapped Markdown canon is left alone)      |
| `pnpm dev`             | Client + `mock-rgs` in watch mode — the one dev command _(C3 · S2)_                  |
| `pnpm dev:client`      | Client only, `MockTransport` in-process, zero latency _(C3)_                         |
| `pnpm dev:rgs`         | `apps/mock-rgs` only (Fastify) — for driving the HTTP path _(S2)_                    |
| `pnpm test:contract`   | The contract suite against every registered target — the switch-over gate            |
| `pnpm e2e`             | Playwright, fixed seed + forced outcomes _(C8)_                                      |
| `pnpm math-sim`        | RTP report — `pnpm math-sim --spins 50000000` _(S4)_                                 |
| `pnpm perf`            | fps / draw-calls / heap for a scripted session — `pnpm perf --spins 100 --throttle 4` |
| `pnpm verify:strip`    | Prove the production bundle contains no dev tooling. Runs inside `check`, after build |

Scoped work uses pnpm filters:

```bash
pnpm --filter @slot/engine test
```

### Node is installed under `nvm`, and an agent's `HOME` may not be the real one

Node lives at `/Users/merdan/.nvm/versions/node/v20.19.5/bin` (the `nvm` default alias is `20`,
matching `engines.node: >=20.19` and `@types/node: ^20`). It is **not** installed system-wide — there
is no `/opt/homebrew/bin/node`.

Some agent sessions run with `HOME` rewritten to a sandbox instance directory, so `~` does **not**
resolve to `/Users/merdan`, the `nvm` shim never loads, and every command fails with
`env: node: No such file or directory` — `pnpm` is on `PATH` but cannot start. Do not conclude Node is
missing: prepend the absolute path instead.

```bash
export PATH="/Users/merdan/.nvm/versions/node/v20.19.5/bin:$PATH"; pnpm check
```

Search `/Users/merdan/...` by absolute path rather than `~/...` when looking for anything else in the
real home directory.

## Architecture

### Monorepo & the build graph

- **pnpm workspaces** define the packages (`packages/*`, `apps/*`, `tools/*`); **Turborepo**
  orchestrates `build`/`dev`/`typecheck`/`test` with caching and `^build` ordering (`turbo.json`).
  Every `packages/*` and `apps/*` is real; `apps/rgs` is deliberately a skeleton (R0) that the
  R-blocks fill.
- **One version per tool, in the pnpm catalog** (`pnpm-workspace.yaml`). Packages say
  `"typescript": "catalog:"`, so the workspace moves in one edit and drift is impossible.
- **TypeScript strict, plus `noUncheckedIndexedAccess`** — `config/tsconfig-base.json`, extended by
  every package. Reel and grid indexing is exactly where off-by-ones hide; that flag is not optional
  here. **The base config has no `DOM` lib**: a package that needs the browser opts in by extending
  `config/tsconfig-dom.json`, so `document` inside the engine is a type error, not a review comment.
- Each package carries `tsconfig.json` (`noEmit`, for typecheck and the editor) and
  `tsconfig.build.json` (declarations + source maps into `dist/`).
- **Vite** for the client (fast HMR, `define` flags for stripping dev tools); **Vitest** everywhere
  for tests (same transform pipeline).
- **Zod lives in `protocol`** — one definition produces both the compile-time type and the runtime
  validator, used on **both sides of the wire**.
- **CI** (`.github/workflows/ci.yml`) runs lint → build → typecheck → test → root suites → format
  on every push and PR. The build comes before the typecheck because packages resolve each other
  through `dist/`, and the root suites read those declarations too. Keep it green; it is what
  enforces the block discipline.

### Dependency rules — enforced, not suggested

Enforced by **`dependency-cruiser`** ([`.dependency-cruiser.cjs`](.dependency-cruiser.cjs), part of
`pnpm lint`). The table below is the config, one rule per line:

```
protocol    → (nothing)                        # and nothing from @slot/* — ADR-0002
money       → protocol                         # for the branded Minor type only
game-math   → protocol, money
engine      → protocol, money, game-math       # NO pixi, NO dom
rgs-sim     → protocol, money, game-math       # NO pixi, NO dom
transport   → protocol
renderer    → protocol, engine, money          # pixi allowed here
ui          → protocol, money                  # pixi allowed here
platform    → protocol                         # browser APIs behind ports — NO pixi, no game state
compliance  → protocol, money                  # pure (in PURE_PACKAGES) — NO pixi, NO dom
dev-tools   → protocol, money, engine          # DOM panel — NO pixi
game-client → everything above
```

```
mock-rgs    → protocol, rgs-sim               # apps/mock-rgs — NOT transport
rgs         → protocol, money, game-math      # apps/rgs — NOT rgs-sim, NOT transport
```

Plus three rules the table doesn't spell out: **no cycles**, **no deep imports** — a package is
reached through its entry point, never into another's `src/`, and an app is held to the same rule —
and one option that is load-bearing rather than cosmetic. `dist/` is **`doNotFollow`, not
`exclude`**: a workspace import resolves to the target's *built* entry point, so excluding `dist`
deleted the edge from the graph and the rule fired only while the import was **undeclared** and
therefore unresolvable. Adding the dependency to `package.json` first — the normal way anyone
introduces one — made the boundary silently stop being enforced. `doNotFollow` keeps the edge and
declines to cruise what is behind it. The Pixi ban had the **same** shape of hole — it matched
`^pixi\.js`, the *unresolved* spelling — so it too fired only while the import was undeclared, and
went quiet the moment the package was added to a `package.json`. It now matches any path segment.
Both holes were found by a fixture failing, which is the argument for having fixtures.

**`engine` importing Pixi must fail CI.** That single rule is what keeps the engine unit-testable
without a canvas, and it is the strongest structural signal a reviewer will read. Which is why the
rules themselves are tested: `config/fixtures/` holds deliberately illegal files — for the engine and
for `apps/mock-rgs` — and [`tests/boundaries.test.ts`](tests/boundaries.test.ts) asserts each one is
rejected **by name**, and that a legal import is not. A rule nobody has watched fail is a rule you
are trusting, not enforcing — which is exactly how the `dist` hole above survived until S2 went
looking.

### Purity rules for `engine`, `rgs-sim`, `game-math`, `money`, `compliance`

These five packages are pure and deterministic — `compliance` included, and its code keeps the
promise made before it existed: a reality check or a session limit is a pure function of an injected
clock, or it is untestable. `Math.random()`, `Date.now()`, argless `new Date()`
and `fetch` are **lint errors** inside them ([`eslint.config.mjs`](eslint.config.mjs)), `window` /
`document` / `localStorage` are lint errors *and* type errors (no `DOM` lib), and
[`tests/purity.test.ts`](tests/purity.test.ts) proves those rules fire. In addition to the import
boundaries:

- **No `Math.random()`.** Seeded PRNG only (xoshiro128\*\* or PCG32) — a given seed replays an
  identical session, which is what makes the sim, the math tool and the E2E suite all trustworthy.
- **No ambient `Date.now()` / `new Date()`.** Take a clock as a parameter. Wall-clock reads inside
  pure code destroy replay and make time-dependent tests flaky.
- **No I/O.** No `fetch`, no `fs`, no `localStorage` — those live behind ports (`RgsTransport`,
  the persistence adapter, `platform`).

### Contracts — `packages/protocol`

The single source of truth for anything that crosses the wire, implementing
[`docs/protocol.md`](docs/protocol.md) as zod schemas whose inferred types are the exported TS types:
`primitives` (the branded `Minor`, `RoundId`), `errors`, `config` (`GameConfig`), `round`
(`RoundResult`, `Feature`, `FeatureProgress`, `PendingRound`), `calls` (the four calls plus the
`CALLS` table that HTTP routing and the contract suite both read), and `persistence`
(`PERSISTENCE_SCHEMA_VERSION`, the envelope, and the discard-and-re-authenticate rule).

`GameConfigSchema` and `FeatureProgressSchema` carry refinements, not just shapes — a payline that
names a row outside the window, or a feature with more spins remaining than were ever awarded, is
rejected at the boundary rather than three animations later. **The only workspace dependency is
none:** `protocol` imports nothing from `@slot/*`, which is what keeps it handable to an operator's
team (ADR-0002).

**When you change the wire, change it here first**, then the sim, then the engine, then the UI. Both
sides validate against the same schema — a drift is a test failure, not a production surprise.

**Error taxonomy** (`protocol/errors.ts`) — three classes, each with one defined client behaviour.
The client branches on the class, never on a message string. `CLASS_OF_CODE` is the single source of
both the code list and its classification, so a new code cannot be added without deciding what the
client does about it; `SlotError` derives the class **from the code**, so a server that mislabels one
does not get to change client behaviour:

`STATUS_OF_CODE` sits beside `CLASS_OF_CODE` since R0 — the HTTP status binding both servers share
(`apps/mock-rgs` re-exports it; `apps/rgs` imports it) — so a new code cannot join the taxonomy
without deciding its class *and* what it looks like on the wire:

| Class | Codes | Client behaviour |
| --- | --- | --- |
| `RECOVERABLE` | `TIMEOUT` · `UPSTREAM_UNAVAILABLE` · `WALLET_UNAVAILABLE` · `RATE_LIMITED` | Exponential backoff retry **with the same `roundId`**; reconnect overlay |
| `PLAYER` | `INSUFFICIENT_FUNDS` · `STAKE_NOT_ALLOWED` · `SESSION_EXPIRED` · `LIMIT_REACHED` | Modal, return to `IDLE`, **no retry** — except `SESSION_EXPIRED` under an open round, which renews transparently and resumes (§5, D9) |
| `FATAL` | `SCHEMA_MISMATCH` · `UNKNOWN_ROUND` · `ROUND_CONFLICT` · `ILLEGAL_TRANSITION` · `FORCE_OUTCOME_REFUSED` · `MATH_VERSION_MISMATCH` · `NOT_IMPLEMENTED` | Freeze the reels, error screen, offer reload |

### Money — `packages/money`

Integer **minor units** behind a branded `Minor` type. The brand itself is declared in `protocol`, so
an amount arrives from the wire already branded — see [ADR-0002](docs/adr/ADR-0002-integer-minor-units.md),
which is also why the dependency table reads `money → protocol`.

**Every operation is exact or it throws.** No rounding mode exists, because nothing needs one:
paytable multipliers are integers and every bet level is a whole multiple of the payline count, so
`divideExact(stake, lines)` never has a remainder. `multiply` refuses a fractional factor,
`divideExact` refuses a remainder, and every result is checked for safe-integer overflow. Formatting
is the one place minor units become a decimal string, and it reads the number of minor digits from
`Intl` rather than assuming two — JPY has none, KWD has three.

### The math, measured — `tools/math-sim`

`pnpm math-sim` plays complete rounds through **the game's own outcome engine** — `rgs-sim`'s
`resolveStops` over `game-math`'s strips, paytable and award table — and prints what the game
actually does. One implementation of the math is the only reason the published figure means
anything; a spreadsheet would be a second one, and the two would disagree the week after they were
written. The one thing the tool does not reproduce is the *seed plumbing* (a batch of twenty million
spins has no rounds to replay), and it says so where it does it.

**A round is the unit**: one stake buys the base spin and every free spin it leads to, so the
feature's return belongs to the round that paid for it. Reporting per-spin RTP with free spins
counted as spins is the classic way to publish a number nobody can reproduce.

Measured over **20,000,000 rounds** on `MATH_VERSION` 2.0.0 — this is the table the README carries at
C8:

| Measure | Result | Design |
| --- | --- | --- |
| **RTP** | **96.107%** | 96.0% ± 0.5% |
| — base game | 87.131% | |
| — feature | 8.976% | |
| Hit frequency | 43.45% | 25–45% |
| Volatility (σ per round) | 3.05 | medium |
| Spins per feature trigger | 110 | 80–250 |
| Longest feature seen | 70 free spins | ≤ 120 |
| Max win seen | 304× stake | |
| Runaway features | 0 | 0 |

**The CLI exits non-zero when the game is out of band**, which makes it a regression test as much as
a report — and `simulate.test.ts` runs a quarter of a million rounds in CI for the same reason, with
a wider band because the sampling error at that size is around a third of a percentage point.

**What S4 found is the reason the block exists.** The untuned strips carried fifteen scatters, which
triggered the feature every fifteenth round and — because a free spin retriggers on the same three
scatters — made the feature a **supercritical branching process**: features of 155 free spins, and an
RTP of 125%. Seven scatters and a paytable scaled to match bring it to 96% with a feature that
converges. The tuning is in the strips and the paytable, both of which now say so in their headers.

### Math — `packages/game-math`

Strips, paylines and the paytable **as data**, plus a pure evaluator. `evaluate()` reads a grid the
server sent and returns the wins to highlight; `viewFrom()` derives the grid from `stops`, and
`viewMatchesStops()` is what the dev build and the contract suite use to catch a server whose view
disagrees with its own outcome. `MATH_VERSION` names this strips-and-paytable combination.

**Since R1 it also owns the outcome engine** — `prng.ts` (xoshiro128\*\* with rejection sampling,
`deriveSpinSeed`) and `outcome.ts` (`drawStops` → `resolveStops`: stops first, everything else a
consequence), both moved from `rgs-sim` the day `apps/rgs` needed the identical engine and could
not import the simulator it exists to replace (`rgs-deps`). One implementation of drawing and
paying a grid is the only reason the published RTP and the contract suite's cross-server
assertions mean anything — the same argument the RTP report already made about the evaluator. The
move was proved byte-identical by the tests that pin seeded sequences and replayed sessions, which
did not change. On the *client*, nothing here decides an outcome (ADR-0001): the client imports
the evaluator to highlight and re-check, never `outcome.ts`.

Two behaviours worth knowing, both tested: a line that starts with wilds is paid the **better** of
the two readings (wilds as themselves vs. wilds standing in for the first real symbol), and wilds
never substitute for the scatter. The rules are specified one line at a time in `evaluate.test.ts` —
in terms of `pays(symbol, count)` rather than literals, because the rules outlive any particular
tuning — and what they add up to on a full screen is pinned by 30 handcrafted grids in
`src/__fixtures__/golden.json` (`pnpm --filter @slot/game-math golden:update` regenerates the
expectations from a **built** `dist/`, for a deliberate math change, never to make a red test green).

`MATH_VERSION` is **2.0.0** as of S4 — the outcome engine moving *in* did not move it, because the
game is unchanged. It moves whenever the strips, paylines or paytable move, because a client
drawing 1.0.0's reels against a 2.0.0 server is showing the player a different game — which is what
`MATH_VERSION_MISMATCH` exists for, and what the engine's authenticate gate enforces (C5).

### Engine — `packages/engine` (the part reviewers actually read)

Zero Pixi imports, zero DOM, zero network. Runs entirely under Vitest.

```
BOOTING ─(authenticate)─▶ IDLE ─(PRESS)─▶ SPINNING ─(response)─▶ STOPPING
                                                                    │
                                        ┌───────────────────────────┤ (win)
                                        ▼                           │ (no win)
                                 WIN_PRESENTATION ──────────────────┤
                                        │                           │
              next=FEATURE_SPIN ────────┤                           │
                                        ▼                           │
        FEATURE_INTRO ─▶ FEATURE_SPINNING ─▶ STOPPING ─▶ … ─▶ FEATURE_OUTRO
                                        │                           │
              next=SETTLE ──────────────┴──────────▶ SETTLING ──────┘
                                                          │
                                                          ▼
                                                        IDLE
ERROR (from anywhere) ─▶ RETRY | DISMISS | FROZEN, by error class
REAUTHENTICATING (SESSION_EXPIRED under an open round) ─▶ back into the round, via §5
```

Two files. [`reduce.ts`](packages/engine/src/reduce.ts) is the machine — pure, total,
`(state, input) → (state, events, effects)` — and [`engine.ts`](packages/engine/src/engine.ts) is a
thin driver that performs the effects and publishes the events. Same split as `rgs-sim`, for the
same reason: all the rules live where a test can drive them a thousand rounds deep without a network.

- **An exhaustive discriminated union**, one shape per phase, with a `switch` TypeScript proves
  total. Each phase carries exactly what that phase can have — no `result?: RoundResult` dangling
  off `IDLE` for someone to read by accident.
- **Every transition emits a typed event**; the renderer subscribes. The engine never reaches into
  the renderer.
- **Inputs are validated against the current phase.** There is one player input — `PRESS` — and what
  it means depends on where the machine is. An input a phase cannot service is *rejected*, never
  queued, and says so via `INPUT_REJECTED` so the debug log can show it was dropped. That single
  rule kills the most common class of slot bug: the second spin that starts while the first is still
  paying out.
- **The engine never computes a balance.** Every phase copies it from the response that carried it.

**The interruption contract lives here, as data:**

| Input during | Effect |
| --- | --- |
| `SPINNING` / `FEATURE_SPINNING` | Slam stop → `slam` is set, and rides out on `REELS_TARGETED` |
| `WIN_PRESENTATION` | Skip → advances to *exactly* the state `PRESENTATION_COMPLETE` would have |
| `FEATURE_INTRO` / `FEATURE_OUTRO` | Skip → straight to the next free spin, or to the settle |

The renderer **implements** a skip by completing timelines; the engine **decides** that a skip is
legal. Keep that split — it is why the behaviour stays testable, and it is why the skip test asserts
that skipping and completing produce an identical state.

**Errors are the taxonomy made into behaviour.** `RECOVERABLE` → `RETRY`, and the retry request is
*rebuilt from the phase it failed in*, so the `roundId` belongs to the round that is still open and a
retry structurally cannot mint a new one. `PLAYER` → `DISMISS` back to `IDLE`, no retry offered.
`FATAL` → `FROZEN`, with no input that leaves it.

**`SESSION_EXPIRED` is context-aware** (§5, D9). Under an open call phase — and only when the driver
was given a lobby seam (`renewSession`, injected because tokens are issued out of band) — the
machine enters `REAUTHENTICATING`: the driver fetches a fresh token, authenticates, and the response
resolves the round the way a reload would. `pendingRound` present → the ordinary §5 resume, server's
account wins. Absent → the interrupted phase is re-entered and its call re-driven: a refused spin
runs fresh under the new session, a lost settle replays idempotently. One transparent attempt per
failure — a failure *during* the renewal takes the ordinary error path (a `RECOVERABLE` one is
retryable through the same machinery, because `effectFor(REAUTHENTICATING)` is
`CALL_REAUTHENTICATE`). The math gate runs on the renewed session too: the server behind the fresh
token may not be the server the round started on. With no open round, or no lobby, the modal stands.

**The math versions meet on the authenticate path, and disagreeing freezes the game.**
`GameConfig.mathVersion` says what the server pays on; `@slot/game-math`'s `MATH_VERSION` says what
this build's evaluator implements — and the client ships real math in code, not just config: the
payline evaluator's substitution rules and the symbol the reels anticipate on. `authenticated()`
compares them **before everything else, including a round already in flight**, because continuing a
resumed round means presenting an outcome immediately. Three choices are deliberate: **exact
equality** (a version that moved for a cosmetic reason is a versioning mistake to fix at the source,
not a reason to loosen a gate), **`MATH_VERSION_MISMATCH` → `FATAL` → `FROZEN`** (there is no safe
way to present an outcome you cannot reproduce, and no input leaves that state), and **imported
rather than injected** — an injected version is a gate the wiring site can forget to connect, and a
safety check nobody notices is missing is worse than none. Every unit test in the workspace builds
both halves from the same package, so they agree by construction; that is why the gate is *also*
proved at a wiring site, in [`tests/wiring.test.ts`](tests/wiring.test.ts), against a simulator
serving a different version.

**Resume is the same machine, entered halfway.** `AUTHENTICATED` reads `pendingRound` and drops into
the phase that continues it — re-sending the spin for a round debited but never resolved, or landing
the reels on a decided outcome and letting the ordinary transitions carry it to the settle. There is
no separate recovery path to keep in step.

`SlotEngine` takes an `RgsPort` rather than importing `@slot/transport` — the dependency table says
`engine → protocol, money, game-math`, and any `RgsTransport` satisfies the port structurally. That
is the third time this shape has earned its place (see [ADR-0003](docs/adr/ADR-0003-injected-persistence-port.md)),
after the simulator's storage port and `InProcessBackend`: **when a pure package needs something the
boundary forbids it to import, it takes the shape as an argument.**

### Renderer + UI — `packages/renderer`, `packages/ui`

The engine gets you past code review; **the feel gets you the offer.** This is where the time went.

**The spin curve is pure code with tests**, which is the trick that makes feel reviewable at all.
[`curve.ts`](packages/renderer/src/curve.ts) is `(motion, dt) → motion` with no Pixi in sight, so
`curve.test.ts` can assert the things that must be true underneath the animation: every stop on the
strip is landed **exactly**, at three different frame rates; the five stages run in order; a slam
lands sooner *on the same stop*; the reel dips backwards before it launches and returns to where it
started. Five stages, all delta-time driven, never frame-count driven:

1. **Anticipation dip** — a brief backwards hold before acceleration (~60 ms)
2. **Acceleration** — ease-in to blur velocity (~200 ms)
3. **Constant velocity** — blurred symbols, and where a reel waits for its turn
4. **Deceleration** — ease-out onto a landing computed once, absolutely
5. **Overshoot + settle** — travel 0.32 symbols past, spring back, land on the integer

Stage 5 is the single detail that separates a slot that feels right from one that doesn't. Reel stops
are staggered 140 ms apart, and **scatter anticipation** holds reels 3+ for nearly a second when the
landed reels could still complete a trigger.

Two things are worth knowing about how the reels are drawn. **The curve's position only increases**
— that keeps the arithmetic monotonic and the landing exact — while the reel spins *downward*,
because the strip index is read backwards from the position; the caller pays one line
(`stripLength - stop`) and the reel comes to rest showing exactly the grid the server sent. And
**`SCAT` is not a name this package knows**: the anticipation symbol is injected, because
`renderer → protocol, engine, money` does not include `game-math`.

**The symbol atlas is generated at boot, into one texture** ([`atlas.ts`](packages/renderer/src/atlas.ts)).
That answers two constraints with one decision. The performance rules want a single texture — one
draw-call batch for the symbol layer — and motion blur as a *pre-rendered texture swap* rather than a
`BlurFilter`. And this repository is public, which makes shipped art a licensing question rather than
a shopping one. Drawing the symbols ourselves means no binary asset, no licence and no attribution,
while still producing one `RenderTexture` sliced into frames that share a source and therefore batch.
The blurred variant is a **vertical smear** — a spinning reel blurs along one axis — laid out two
rows down, because the smear reaches past its own cell and would otherwise ghost into the sharp
frame. Real art replaces this file and nothing else.

**Performance rules — hard constraints, not aspirations, and all of them hold today:**

- One texture atlas, one draw-call batch for the symbol layer.
- **Symbol object pool** — `reels × (rows + 2)` sprites allocated at boot; nothing is instantiated
  during a spin.
- Motion blur by swapping the pre-rendered smeared texture above a velocity threshold.
- **Zero allocation in the ticker:** no closures, no array literals, no object spreads per frame. The
  one exception is documented where it lives — `advance` returns a new `ReelMotion` per reel per
  frame, which is what keeps the curve pure and testable, and is five small objects against a budget
  that bans per-frame closures.
- Reels are masked with a rectangle, not a filter.
- Target **60 fps on a mid-range Android** — and since C7 the claim is measured rather than made:
  `pnpm perf` plays the production bundle at a 4× CPU throttle and reports ~120 fps average
  (p95 9.2 ms, one dropped frame in 3,888), **7 draw calls a frame** (max 8 — the batching, as a
  figure), and a heap that sawtooths 9.8 → 14.1 → 9.4 MB over thirty rounds — no climb, which is
  what "zero allocation in the ticker" looks like from outside. The Chrome trace lands in
  `tools/perf-harness/traces/`. The instruments live outside the game (a rAF probe, wrapped WebGL
  entry points, CDP heap metrics, the DOM control layer pressing the button), so the bundle being
  measured is the bundle that ships, dev hooks and all their absence included.

**The win presentation is a `Timeline`, and that is the whole interruption story.** A sequence of
steps with durations, built from the server's `wins[]`: the total counts up over every winning cell,
a tiered win gets a banner and a hold, then each win is shown in turn with its payline drawn and its
own amount, and a final zero-length step puts the screen back exactly as it was found. `complete()`
runs every remaining step *to its end, in order* — so a skip lands the counter on the final number
and clears every highlight, rather than freezing a presentation half-lit over the next spin.
[`timeline.test.ts`](packages/renderer/src/timeline.test.ts) asserts that directly: two identical
timelines, one played and one completed, produce the same trace.

Three details worth knowing:

- **Tiers are multiples of the stake** ([`tiers.ts`](packages/renderer/src/tiers.ts)) — NICE at 5×,
  BIG at 15×, MEGA at 50× — compared with integer arithmetic, so a win one minor unit short of a tier
  does not round into it. An absolute threshold would make the same banner a formality at the top bet
  and unreachable at the bottom.
- **The per-win cycle has a budget, not a per-win duration.** A max-win screen can pay twenty lines,
  and twenty × 700 ms is a slideshow the player mashes through — so many wins become a rhythm and a
  few still get their beat each.
- **One counter, two readouts.** The rolling amount is published by the presentation and the client
  feeds it to the HUD, so the number in the banner and the number under `WIN` cannot disagree.

**The feature is the same machinery again** ([`feature.ts`](packages/renderer/src/feature.ts)): an
intro timeline, an outro that counts the feature's total up, a counter above the reels and a warm
border that says the rules have changed. Two rules it lives by. **It displays arithmetic the server
already did** — `FeatureProgress` arrives with `total` and `remaining` already folded and the
response carries the round's payable `roundWin`, retriggers included, so a retrigger is simply a
`total` that grew and the client's whole contribution is noticing and announcing it. And **every screen is built from the event that carries
its data**, never from the phase change: the engine emits `PHASE_CHANGED` *first*, so a banner built
on the phase announces "0 SPINS" — which is precisely what it did until it was fixed. A phase that
owes the engine an input and has nothing to show recovers on the next frame with an empty timeline,
because the one unacceptable outcome is a round that waits forever.

**Turbo is one switch** — `scaleCurve` shortens every duration in the spin curve and the same factor
scales the presentation. Speed, overshoot and the blur threshold are untouched, because turbo should
shorten a spin rather than hand the player a different game — and now that a jurisdiction *does*
forbid it (`jurisdictionRules.turboAllowed`, the UK preset), there is exactly one thing to refuse:
the client boots with turbo off regardless of the remembered preference and the toggle is disabled,
visibly, because a control that vanishes reads as a bug and one that is off reads as a rule.

**Every player-visible sentence is injectable.** `FeatureLabels`, `WinLabels` (renderer) and
`PanelLabels` (ui) default to the English the screens always had; the client passes the session's
catalogue (en/ru — see the client's i18n) and the packages never learn which language they speak.
The typeface is Inter (OFL, latin + cyrillic subsets via `@fontsource/inter`), first in both
`FONT_STACK`s, because the RU catalogue needs Cyrillic and a face without it falls back per glyph.

**Contrast is a test, not luck.** `contrast.ts` implements the WCAG 2.1 arithmetic (exported —
the debug panel will want the same numbers), and [`tests/contrast.test.ts`](tests/contrast.test.ts)
holds every text-on-surface pair in both palettes to AA. It failed on its first run: SCAT and H3
carried white glyphs at 1.98:1 and 2.26:1, and their fills in `SYMBOL_STYLE` are darker for it.

**`onReelLanded` is the audio layer's seam** — fired once per reel on its landing frame, in stagger
order, from the same edge `update()` already detects. Presentation only: by the time a reel lands,
the outcome was decided long ago.

**`prefers-reduced-motion` is a different switch, and it wins.** Turbo is a preference about pace and
keeps every stage of the spin; `reducedMotionCurve` removes the stages — no backwards dip, no
overshoot, no stagger, no scatter anticipation hold, no motion-blurred texture — and the same factor
collapses every timed screen to the frame it needs to hand the engine its input. The game underneath
is untouched: the same stops, the same wins, the same money. Two details are load-bearing and both
are tested. **The reel still lands exactly on the server's stop** at any frame rate, because an
accessibility mode that quietly lands on the wrong symbol is worse than none. And the durations are
1 ms rather than 0, because three of the five stages divide by their own duration and a zero-length
stage in a zero-length frame is `0 / 0` — a reel position of `NaN` is a considerably worse
accessibility outcome than a fast one. `GameStage` resolves the two preferences in one place, so the
precedence is a fact rather than an ordering convention.

`@slot/ui` is the control surface: spin button, bet selector, turbo and **autoplay** toggles (the
AUTO pill renders the run's remaining count on itself), balance/win HUD. It takes a **view model,
not an engine** — `ui → protocol, money` is the whole dependency list — so the client maps phases
onto `PanelView` and the interruption contract stays in the engine where it is tested. Two rules
hold throughout: the HUD **never computes money** (every number it shows arrived from the server),
and the stake is always one of `GameConfig.betLevels`.

### The client — `apps/game-client`

Vite plus the wiring site, and **no game rules anywhere in it**: the one place in the project that
imports everything, supplies the arguments each package was designed to take, and maps engine phases
onto a button label.

- **Which server it talks to is one environment variable.** `VITE_RGS_TRANSPORT=mock` constructs the
  simulator in the tab — persisted through `WebStorageStore(localStorage)`, so a reload mid-round
  really does resume through `pendingRound` — and `http` constructs `HttpTransport`. Both are wrapped
  in `withRetry`, so the retry rules are one implementation.
- **The browser reaches `apps/mock-rgs` through Vite's dev proxy**, not through CORS. `/rgs`, `/demo`
  and `/dev` are forwarded, so the client makes same-origin requests in development and the mock
  server never has to hand out `Access-Control-Allow-Origin: *`.
- **`roundId` is minted here, as a UUIDv7** — the client-side key that makes a retry provably the same
  round. The engine takes it as an injected factory because a pure package may not reach for `crypto`.
- **Both dev gates are wired.** `__ASSERT_MATH__` runs three checks — the server's `view` against its
  own `stops`, the grid actually drawn against the grid the server sent, and (as of C4) the server's
  `wins[]` **re-evaluated with the local paytable** — screaming into the console on any mismatch. The
  third is the expensive one to be missing: it catches a client whose shipped paytable has drifted
  from the one the server is paying on, which would light a win the player was not paid.
  `__DEV_TOOLS__` exposes `window.__slot`, including `force('MAX_WIN')` — a one-shot forced outcome
  for the next spin, which is how a win presentation is developed at all rather than waited for.
  Both flags are `define`d to literal booleans, so a production build contains neither the flag nor
  the code behind it, and the server refuses `forceOutcome` outside dev mode regardless.
- **One drawer, two documents** ([`drawer.ts`](apps/game-client/src/drawer.ts)). The round-history
  panel ([`history.ts`](apps/game-client/src/history.ts)) is every build's: the wire's `history`
  response listed verbatim — stake, win, capped mark, free spins, formatted by `@slot/money` with
  the session's currency — refetched on every open, with `retention` stated honestly ("this demo
  server keeps only the last N settled rounds"), in both languages. The debug panel is dev builds':
  the same frame, reached by a DEV button the dev branch itself creates, wired to the panel from
  `@slot/dev-tools` with the connection's `dev` control plane (in-process `SimServer` methods, or
  `/dev/*` over HTTP — one port shape, two enactments, chosen in `transport.ts`). A failed history
  fetch is a sentence in the panel, never an error screen over a working game. The reality-check
  dialog now also traps focus (`trapFocus`, the WAI-ARIA dialog pattern) — Tab cannot walk out into
  a page the overlay covers.
- **The renderer attaches to a machine already in motion.** The stage cannot be built until
  `authenticate` has answered — the strips arrive in that response — so a resumed round is announced
  before anything is listening, and events are not replayed. `GameStage.attach(state)` reads the
  engine's state once and puts the reels where the round already is. Without it a reload mid-feature
  hung on motionless reels; with it, the same reload lands on the outcome and plays on.
- **The client remembers preferences, not the round.** The stake, turbo and mute go through
  `@slot/protocol`'s `PersistedEnvelope`, and a version mismatch, corrupt JSON or drifted shape is
  **discarded** rather than repaired — the same rule the simulator's own store obeys. A remembered
  stake that is no longer on the server's bet ladder is dropped too, because the alternative is a
  reload that turns into `STAKE_NOT_ALLOWED` on the first spin — and a remembered turbo is dropped
  where the jurisdiction forbids it, because the rules outrank the preference. Everything else —
  the balance, the round, the feature — is the server's, and `authenticate` returns it.
- **The jurisdiction's rules are applied where each one lives.** The pacing gate holds the spin
  button for the remainder of `minSpinIntervalMs` (a timer wakes the render when the window opens —
  the server enforces the same rule, so a client that got this wrong would be told with
  `LIMIT_REACHED`); the reality check is a DOM dialog that interrupts only on the way into `IDLE`,
  states **minutes played and no money** (ADR-0001), and stops autoplay before it opens; autoplay
  itself is `AutoplayController` — it presses like a player, folds each round through
  `@slot/compliance`, respects the same pacing, and the AUTO pill counts it down.
- **Audio is wired at the seams the packages expose.** Cues play on engine events (press, feature
  award, win — tiered through the same `tierFor` the banner uses, so the fanfare and the plate
  cannot disagree) and on the renderer's `onReelLanded` ticks; visibility mutes through
  `watchVisibility`; the first gesture unlocks the context (`attachUnlock`); the sound toggle is a
  real DOM button, persisted as a preference, hidden where WebAudio does not exist.
- **The client speaks en/ru** ([`i18n.ts`](apps/game-client/src/i18n.ts)): the locale arrives in the
  launch URL (`?lang=ru`, the operator's word — §7) with `navigator.language` as the demo fallback,
  and one catalogue feeds the panel labels, the renderer's screens, the announcer, the DOM shell and
  `<html lang>`. Money is formatted by `@slot/money` through `Intl`, never by the catalogue.
  Coverage is enforced, not promised: `i18n.test.ts` walks every character of both catalogues —
  plural forms sampled — against the shipped Inter woff2 files with `fontkit`, at every shipped
  weight, so a new string with a missing glyph fails CI.
- **The keyboard gets the same panel** ([`dom-controls.ts`](apps/game-client/src/dom-controls.ts)):
  real `<button>`s rendered from the same `PanelView` the Pixi panel renders — spin, bet up/down,
  turbo, autoplay — transparent until `:focus-visible`, because the canvas is the visual and this is
  its shadow in the accessibility tree. Handlers reach the same engine inputs, so a keyboard press
  is indistinguishable from a pointer press by the time it arrives.
- **The letterbox respects the notch.** `layout()` re-reads `readSafeAreaInsets` on every resize
  (rotation arrives as a resize and moves the notch) and centres the stage inside what remains;
  portrait and landscape come out of the same vertical stack.
- **Failures are reported through a seam, not to the console directly.**
  [`telemetry.ts`](apps/game-client/src/telemetry.ts) is an interface, a console adapter and a guard;
  wiring Sentry or an operator's collector later means constructing a different object at boot. Four
  sites report: the boot failure (which happens before anything is subscribed, and is the shape a
  math-version mismatch takes), every `ERROR_RAISED`, both `__ASSERT_MATH__` mismatches, and the
  outermost catch in `main.ts`. Every call goes through `guarded`, because a reporter that throws
  while reporting an error would turn a frozen reel set into a blank page.
- **The screen-reader story is one live region.** A canvas is a rectangle with nothing in the
  accessibility tree, so the HTML shell carries a polite `role="status"` region and
  [`announce.ts`](apps/game-client/src/announce.ts) turns the panel's own view model into the
  sentence that goes in it — the same view model the panel renders, so what is heard and what is seen
  cannot describe different states. It announces *state* rather than events (the region is
  `aria-atomic`, so each update replaces the last) and **only when something changed**, because a
  slot renders every frame and re-writing an identical sentence re-announces it in some readers.
- The loading state is DOM rather than canvas, because it has to be visible before Pixi, the atlas or
  the session exist — and if the boot fails it says why, in words, instead of leaving a black
  rectangle. The 18+/demo notice sits under the canvas on every screen.

### Transport — `packages/transport`

`RgsTransport` is the seam: four async methods, one per call. The client depends on this interface
and on `@slot/protocol`, never on a server implementation, which is what makes swapping the
simulator for a real RGS a change of which object is constructed at boot.

`MockTransport` (**S1**) is the dev default and is deliberately thin — the backend decides what
happens to a call, including how long it takes and whether it is answered at all, and this enacts
it. A dropped response becomes a promise that **never settles**, because that is what a hard
disconnect looks like to a caller; turning it into a `TIMEOUT` is the retry layer's job, and doing
it here would make the transport useless for testing the retry layer.

**It does not import `@slot/rgs-sim`.** The dependency table says `transport → protocol` and nothing
else, so the in-process backend is an injected structural interface (`InProcessBackend`) that
`SimServer` happens to satisfy — the same reasoning as [ADR-0003](docs/adr/ADR-0003-injected-persistence-port.md),
and the reason `mock.test.ts` can drive the whole thing with a twenty-line fake. Neither package can
test that the two actually meet, so [`tests/wiring.test.ts`](tests/wiring.test.ts) does it at the
root — standing in for `apps/game-client`, and the seed the contract suite grew from.

`withRetry` is the policy, as a decorator so both implementations share one copy of the rules. Three
of them, and they are the whole point: **only `RECOVERABLE` errors are retried** (a `PLAYER` error
means retrying changes nothing; a `FATAL` one means hammering the endpoint cannot fix a disagreement
about reality); **a retry re-sends the identical request**, so the `roundId` is unchanged and the
server replays rather than re-spins; and **raw network noise never reaches the engine** — a rejected
`fetch` or an aborted request becomes `UPSTREAM_UNAVAILABLE` here. A server that sent `retryAfterMs`
wins over the client's own arithmetic, because it knows something the client does not. `onRetry` is
the seam a debug log or a telemetry reporter hangs on.

Because it owns the clock it also owns **cancellation**: every attempt is handed an `AbortSignal`
that fires when that attempt times out, and `HttpTransport` hangs its request off it. A timeout that
only rejects the caller's promise is half a timeout — over HTTP the request goes on holding a socket
until the server answers into nothing, three times per spin on a bad link. `CallOptions` is optional
on every method, so the engine's `RgsPort` — four one-argument methods — never learns that
cancellation exists.

`HttpTransport` (**S2**) is the same four calls over the wire: `POST /rgs/<call>`, with the route
built from `@slot/protocol`'s `routeFor()` so the client's path and the server's routes come from one
definition. It **validates the response** against the same schema the server validated the request
with (a shape the client cannot read is a `FATAL` `SCHEMA_MISMATCH`, caught at the boundary rather
than three animations later), **classifies every failure** — a protocol error body becomes the
`SlotError` the server meant, and anything else is mapped by status — and **carries a correlation id**
the server echoes, so one round is traceable across two processes. The class is always derived from
the code, so a server that mislabels a `PLAYER` error as `RECOVERABLE` cannot talk the client into
retrying a spin the player cannot afford. `fetch` arrives as a three-member structural type rather
than a global, for the same reason the simulator's storage does (ADR-0003). And since R5 it
**carries the session binding itself** (§2.7, D12): it remembers the token from the last
successful `authenticate` and sends `Authorization: Bearer` on every other call — held in the
transport so the engine and the retry policy never learn that HTTP has headers, and a mid-round
renewal re-binds by simply authenticating again through the same object. The single-session
simulators accept and ignore the header; `apps/rgs` requires it.

**The one line that decides which server this is, is the base URL.**
[`tests/http.test.ts`](tests/http.test.ts) is what makes that a statement rather than a hope: one
round, played through both transports against two identically seeded simulators, asserted equal field
for field.

### The simulator is the spec — `packages/rgs-sim`

`rgs-sim` is **pure**: every handler is `(state, request, context) → (state, response | error)`. No
HTTP, no fs, no clock of its own — `context` carries the config and an injected `now`. That purity is
what lets the same outcome engine serve three consumers — the dev loop, the HTTP path (S2) and the
50-million-spin RTP report (S4). One engine behind all three is a far stronger story than three
separate hacks, and it means the RTP you publish is the RTP you play.

Errors are **returned, not thrown**, so a rejected call still advances the call counter its
correlation id comes from. `SimServer` is the thin stateful shell that holds the state, validates
requests against the shared `@slot/protocol` schemas, persists through the store port, and rethrows
the payload as a `SlotError` for callers who prefer exceptions.

| Module | What it owns |
| --- | --- |
| `sim.ts` | The four handlers, the round machine `OPEN → RESOLVED → SETTLED`, and the idempotency store |
| `state.ts` | `SimState` as a zod schema whose inferred type *is* the exported type — the wire discipline, applied to the disk |
| `store.ts` | The persistence port: `InMemoryStore` and `WebStorageStore` (ADR-0003) |
| `config.ts` | `MATH_CONFIG` plus the commercial half — bet limits, max win, jurisdiction, `devMode` |
| `server.ts` | `SimServer` — validation, persistence, `SlotError` |

The PRNG and the outcome derivation (`prng.ts`, `outcome.ts`) lived here until R1 and are now
`@slot/game-math`'s — shared with `apps/rgs` and the RTP report, one implementation for every
consumer. The sim keeps what is a *server's*: awarding the feature, the round machine, the money.

What it does today (**S0**):

- **Seeded PRNG** — xoshiro128\*\*. Two runs from one seed produce byte-identical round sequences,
  and that is a test, not a claim.
- **The round machine**, persisted: a zero-win base round settles atomically, a win goes `RESOLVED`
  and waits for `settle`, a feature holds the round `OPEN` across its free spins.
- **Idempotency keyed on `roundId`** (and `(roundId, step)` for free spins): a duplicate replays the
  stored response — no second spin, no second debit — and a duplicate carrying *different*
  parameters is `ROUND_CONFLICT`. The comparison is key-order independent, so an honest retry can
  never be mistaken for a conflict.
- **Recovery through `pendingRound` alone**, exactly as docs/protocol.md §5 specifies. A reload
  mid-feature resumes at the next step.
- **Stake validation and the max-win ceiling** — `STAKE_NOT_ALLOWED`, `INSUFFICIENT_FUNDS` and
  `SettleRes.capped` all have real producers, so the `PLAYER` error class is testable end to end.
  The ceiling is `stake × maxWinMultiplier` and is applied **as the round accrues**, which is what
  makes `settle` a credit with nothing left to compute — it no longer even takes a clock.
- **Retrigger arithmetic**, folded server-side. `remaining = total - step` holds through every free
  spin; the client displays it and never computes it.
- **A persistence port** with two implementations, in-memory and web-storage. Round history is
  bounded (`MAX_ROUND_HISTORY`) and only `SETTLED` rounds are ever evicted.
- **The `forceOutcome` dev gate** — the field is refused unless `GameConfig.devMode`, and refused
  *before* any other validation, so a tampered request never learns anything else. Explicit `stops[]`
  work in dev mode; the named scenarios are S1.

And since **C6**, the policy surface — the sim pushes back, so the client's compliance layer was
built against a server that does:

- **Session expiry is checked on every call**, not only `authenticate` — which is what gives the §5
  mid-round recovery a producer. `SimServer.issueSession()` is the faked lobby and it **renews**:
  the token re-attaches to the same balance and `pendingRound`. `expireSession()` kills the session
  on demand, for tests and the debug panel (C7).
- **The pacing rule**: a `spin` arriving before `jurisdictionRules.minSpinIntervalMs` has passed is
  refused with `LIMIT_REACHED`, measured between *accepted* spins (`SimState.lastSpinAt`) so an
  idempotent replay is exempt and a refused call does not push the window. Free spins are not paced
  — a step inside a round is presentation-paced, per §2.1.

And since **S1**:

- **Named force-outcome scenarios** (`scenarios.ts`) — `NEAR_MISS`, `FREE_SPINS_TRIGGER`, `MAX_WIN`,
  `DEAD_SPIN`, every one of them *found on the actual strips* rather than hard-coded, so an S4
  re-tune cannot leave them pointing at whatever symbol moved. `MAX_WIN` is coordinate ascent over
  the real payout, which matters more than it sounds: the first version maximised "high symbols
  visible per reel" and lost to an ordinary spin, because a payline needs its symbol on a
  *particular row* and because five scatters pay more than any line on this paytable.
- **Fault injection** (`faults.ts`) — latency, jitter, a slow-response rate, per-code error rates
  and a **dropped response**. Toggleable at runtime (`setFaults`) and **seeded**: the verdict is a
  pure function of the server seed and the call number, so a faulty session replays down to which
  call failed. A bug you cannot re-run is a bug you do not fix.

The fault model's one real idea: **a `FAIL` is decided before the handler runs and a `DROP` after
it.** A rejected call never happened, so a retry is a fresh attempt; a dropped call *did* happen and
left a debited round nobody has seen, so a retry with the same key must replay it. The second is the
scenario the whole idempotency design exists for, and it is now producible on demand.

The sim can neither sleep nor hang, so `deliver()` returns the verdict as data — `DELIVER` /
`REJECT` / `DROP` plus a delay — and the caller enacts it. `MockTransport` does that in-process and
`apps/mock-rgs` does it to an HTTP response. One policy, two enactments.

### The network path — `apps/mock-rgs`

The simulator, over a real socket, in about two hundred lines of Fastify. It exists to prove one
sentence: **the client runs identically against `MockTransport` and `HttpTransport` — same
behaviour, different latency.** Everything that *decides* anything is `@slot/rgs-sim` and is not
reimplemented here; this app parses a request, hands it to `SimServer.deliver`, and enacts what comes
back. If it had its own copy of the rules, the parity test would only prove that two implementations
currently agree.

The binding is pinned in [docs/protocol.md §2.7](docs/protocol.md) and argued in
[ADR-0004](docs/adr/ADR-0004-http-binding.md). Four points are worth knowing without opening either:

- **Routes come from the `CALLS` table**, via `routeFor()` — `POST /rgs/spin` and friends. A fifth
  call would be routed, validated and typed the moment it joined the contract.
- **The status code is for operators; the body is for the client.** The client branches on the
  `class`, which is derived from the `code`, which is in the body. `STATUS_OF_CODE` lived here until
  R0 and now lives in `@slot/protocol` (two servers, one binding — this app re-exports it), still
  declared `satisfies Record<ErrorCode, number>`, so a new error code cannot be added without
  deciding what it looks like on the wire.
- **A dropped response is a hijacked reply** — the connection is held open and says nothing, because
  that is what the fault *is*: the round happened and the answer was lost. The client's own timeout
  ends the wait, exactly as in-process. Hijacked sockets are tracked so shutdown destroys them
  instead of waiting on a connection that waits forever — **in `preClose`, not `onClose`**, and that
  distinction was a bug until `tests/http-soak.test.ts` went looking: `onClose` runs after Fastify
  has already begun waiting for open connections, so destroying the sockets there is too late and
  `close()` never returns. The tracking was right; the moment it fired was not, and `app.inject()`
  cannot reproduce it because its socket is a fake with no connection to end.
- **`x-correlation-id` in both directions.** The client mints one and the server echoes it; the
  simulator's own `sim-000042` ids (replayable, not unique across sessions) go to the log line beside
  it.
- **Two limits of its own** (2026-08-19): a 16 KB body cap — the whole protocol fits in hundreds of
  bytes — and a 5 s request timeout for a client that never finishes sending. An oversized body is
  refused as `SCHEMA_MISMATCH`, not a retry invitation, and the test pins that. Rate limiting is
  deliberately still absent (see the gaps registry): it arrives in C8, when this server first faces
  a network that is not `127.0.0.1`.

`/dev/*` — fault injection, session reset and expiry, a state summary — is what the debug panel drives and
what lets the contract suite *demand* a failure rather than wait for one; it is mounted only
when `devRoutes` is on, and `apps/rgs` does not have it (tested: `/dev/state` is a 404 there). `POST /demo/session` is not gated, because a
server you cannot obtain a token for is not a server (docs/protocol.md §7) — and issuing **renews**
the running session rather than wiping it, which is what makes the §5 mid-round expiry recovery
playable over HTTP. Configuration is
environment, validated with a schema like anything else that crosses a boundary — a mistyped server
seed silently changes every outcome the session produces.

### The real RGS — `apps/rgs` (R0 laid it out; R1 made it play; R2 made the wallet real; R3 made the money auditable; R4 made the outcomes provable; R5 made the sessions real)

```
apps/rgs/src/
├─ http/          routes from the CALLS table; schema validation; bearer extraction, rate
│                 limiting and the operator surface (R5)
├─ domain/        createRoundService — the real lifecycle (R1), caller-bound since R5;
│                 sessions.ts — the SessionStore port, its twins' contract, the minting service
├─ wallet/        the R0 seam, real at the wire (R2): RemoteWallet + wire schemas + the wallet sim
├─ ledger/        double-entry journal (R3): port + memory/Postgres twins, one contract; reconcile
├─ math/          re-exports @slot/game-math — never a second copy
├─ rng/           the commitment chain (R4): per-round seed pairs over injected entropy
├─ persistence/   the RoundStore port: memory + Postgres (migrations committed), one contract
└─ observability/ correlation id minted/adopted + echoed; pino via Fastify (R6 grows it)
```

**The domain is real since R1** — `createRoundService` implements docs/protocol.md §3/§4/§5 over
injected ports, with the simulator as its reference semantics and one structural difference that
matters: **the wallet is an external system the database cannot wrap in a transaction.** The debit
and the round resolve are separated by a window a process can die in — which is §5's stranded
round, produced honestly (debit, open, stop) by the contract target's `strand()`, resumed by the
client's ordinary spin retry, and reported by `authenticate` as `pendingRound` with no `result`
and no `next` (the schema's one sanctioned absence). Idempotency is fingerprint-based exactly as
in the sim — key-order-independent canonicalisation, replay vs. `ROUND_CONFLICT` — and a commit
that loses a race re-reads the recorded answer rather than inventing a second one.

**Persistence is a port with two implementations held to one contract.**
`store-contract.ts` defines the semantics — insert-only idempotency records, transitions that
assert the state they move *from*, recovery and history reads — and both `MemoryRoundStore` and
`PostgresRoundStore` run it. The Postgres half (committed SQL migrations, a compare-and-swap
`UPDATE … WHERE state = $from` inside the same transaction as the record insert, uniqueness as
primary keys) runs whenever `RGS_TEST_DATABASE_URL` is set — **always in CI**, where a
`postgres:16` service container provides it, so "the database enforces what the memory store
promises" is asserted on every push. `main.ts` picks the store by `RGS_DATABASE_URL`; the contract
suite's third target runs on memory because its subject is the wire.

**The wallet is real at the wire since R2** — pinned in [`docs/wallet-api.md`](docs/wallet-api.md),
deliberately *outside* `@slot/protocol`: the game wire is the operator's game team's contract, the
wallet wire is their platform team's, and a different operator means a different adapter behind
the same `WalletProvider`. `RemoteWallet` is that adapter: four POSTs under a resilience policy —
a per-attempt `AbortSignal` deadline, bounded retries only for *unavailability* (safe because
every mutation is idempotent on its ref), refusals surfaced once and never retried. The wallet sim
(`WalletSim` + `buildWalletSimApp`) serves the same contract over a socket with the §4 failure
model injectable — **refused before executing** vs. **executed, confirmation lost** — the FAIL/DROP
distinction again, wallet-side; `MockWallet` stays the one implementation of the semantics
underneath both, and its tests are the wire's specification. Two rules carry the money safety: a
lost confirmation is healed by replaying the ref, and **a rolled-back debit's ref is debitable
again as a fresh transaction** — what makes the domain's rollback (a confirmed debit whose round's
`open` failed — the one such state) converge with the client's same-`roundId` retry to exactly one
standing debit. That sentence is R2's gate, and it is a test, not a promise. `forceOutcome`
is refused always — there is no dev flag to mis-set.

**The ledger is real since R3** — append-only, double-entry, integer minor units, one entry pair
per confirmed wallet movement (`STAKE` on debit, `WIN` on credit, `ROLLBACK` on a delivered
reversal), behind a `Ledger` port with memory and Postgres twins held to one contract suite, the
store's arrangement repeated (Postgres runs in CI on every push, and there a trigger *enforces*
append-only rather than promising it). Three decisions carry it (ADR-0005). **It observes; it
never decides**: recording happens after the wallet confirms, a `record` failure never fails the
call — the drift a lost entry creates is what reconciliation finds. **Its idempotency mirrors the
wallet's**, movement for movement — one shared `judge` (a standing stake replays, a rolled-back
ref is stakeable again, a win happens once per ref), applied in-process by the memory twin and
under a per-ref advisory lock by Postgres — so every retry path journals unconditionally and one
movement is one entry. And **the stake is journaled before the round opens, with no foreign key to
`rounds`**: a debit whose open failed and whose rollback was lost leaves a standing `STAKE` with
no round row — the *orphan*, on which the wallet and the ledger agree (both down one stake, zero
drift), so only `reconcile()`'s orphan scan can find it, and does. `reconcile()` trues each
player's balance against a caller-supplied opening (`since`-windowed) plus that whole-journal
scan; `main.ts` runs it on an interval (`RGS_RECONCILE_INTERVAL_MS`, lazy baseline, logged via
pino). The R3 gate is [`ledger/session.test.ts`](apps/rgs/src/ledger/session.test.ts): a scripted
session — dead rounds, a settled win, a full feature, an aborted-then-retried spin — retold from
the journal alone: accounts cancel, folding the player legs from the opening balance reproduces
every balance the wire reported in order, the house's take is stakes − rollbacks − wins, and the
reconciliation answers clean; its companion loses the rollback on purpose and watches the orphan
get reported, then healed by the same-`roundId` retry with no correction ever written.

**The outcomes are provably fair since R4** (docs/protocol.md §9, D11; ADR-0006;
[`docs/fairness.md`](docs/fairness.md)). One seed pair per round, chained: the commitment on offer
travels on `authenticate` and on every closing response's `next`, always in the player's hand
before the bet that binds it; the spin binds the pair at `open` — persisted on the round row, so a
restart resolves and reveals the same round, and `pendingRound.fairness` re-reports the binding on
resume — and the chain rotates only when an open succeeds, so a failed open retries under the very
commitment the player holds. The reveal rides the response that *closes* the round (`settle`, or
`spin` itself for an atomically-settled dead round, because a client is not required to settle
nothing), beside the next commitment. Entropy is injected: `main.ts` hands the provider
`node:crypto`'s CSPRNG — `RGS_SERVER_SEED` no longer exists — while tests hand in a seeded stream
and stay deterministic. Verification needs nothing from the server it checks: `sha256Hex` (pure
FIPS 180-4, held to NIST vectors) and `stopsForStep` ship in `@slot/game-math`, and the gate —
"a player can independently recompute a round's `stops[]` from the revealed seed and their client
seed" — is [`rng/fairness.test.ts`](apps/rgs/src/rng/fairness.test.ts), run again over the full
production chain by the contract suite's `provableFairness` cases. The capability is mutually
exclusive with `forceOutcome` by construction — a server that will play whatever it is told cannot
publish a hash of an outcome it has not been told yet — which is why the simulators skip these
cases by name and always will.

**The sessions are real since R5** (docs/protocol.md §2.7, §7, D12; ADR-0007). The wire's
amendment is the binding: every non-authenticate call carries `Authorization: Bearer <token>` —
spelled and parsed by one pair of `@slot/protocol` helpers, carried by `HttpTransport` itself
(it remembers the token from the last successful `authenticate`, so the engine and the retry
policy never learn HTTP has headers), extracted by the HTTP layer into a `Caller` the domain
resolves per call. `SessionPort.verify` is now backed by a `SessionStore` — memory and Postgres
twins (`migrations/0004_sessions.sql`) under one contract suite, Postgres rather than the
roadmap's Redis because one database until scale demands two is the cheaper truth (ADR-0007) —
and expiry stays a judgment the *domain* makes against its injected clock, so "expired" and
"never issued" stay distinguishable in the server's records while refusing identically on the
wire. Tokens are minted from injected entropy (the R4 arrangement, reused) by a session service
whose out-of-band face is `POST /operator/sessions` — key-guarded (`x-operator-key`,
`RGS_OPERATOR_KEY`), outside the game contract exactly as `/demo/session` is, speaking plain
operator JSON; the demo token still self-issues at boot through the same service. R5 also gave
the server the jurisdiction half it can observe (D8): a spin arriving inside
`minSpinIntervalMs` is refused `LIMIT_REACHED`, measured between *opened* rounds off the store's
`lastOpenedAt` — so idempotent replays are exempt by construction and free spins are never paced
(§2.1), the sim's semantics since C6 — and the game routes sit behind hand-rolled token buckets
(injected clock, unit-tested) per session token and per client IP, refusing `RATE_LIMITED` with
`retryAfterMs` in the body and `Retry-After` on the wire. Test compositions carry no budgets by
design: the suite hammers on purpose, and `main.ts` always passes the env-configured ones.

What is deliberately absent, and stays absent: `/dev/*` (a production server is not driveable),
`/demo/session` (tokens come from the operator's lobby, §7 — `/operator/sessions` is its
validating half since R5), and
any import of `@slot/rgs-sim` or `@slot/transport` — enforced by `rgs-deps`, tested by fixture.
The HTTP layer still validates before it dispatches, so `SCHEMA_MISMATCH` and a domain refusal
stay distinguishable — and the stub composition (`notImplementedRounds`) still exists and still
answers `NOT_IMPLEMENTED`/`501` under test, because taking an endpoint dark again must stay a
tested state, not an archaeological one. `/ready` now answers `200 ready: true` with the shipped
`MATH_VERSION`; a stub composition says `503`, because a load balancer should know the difference.

### Platform — `packages/platform`

Everything the browser makes awkward, behind one boring interface — and every module takes its
browser object as an argument (the ADR-0003 shape), which is why the whole package tests headless in
Node with fakes a few lines long.

- **Audio is synthesized at boot** (`audio.ts`) — the atlas decision applied to sound. Seven cues
  from oscillator math and seeded noise (press click, per-reel stop ticks, win fanfares that grow a
  note per tier, a warm feature pad): no binary asset, no licence, no attribution, and real audio
  replaces this module and nothing else. The synthesis is pure `Float32Array` arithmetic with its
  own tests; `SlotAudio` wraps a structural `AudioContextPort`, resumes a suspended context on the
  first gesture (`attachUnlock` — the iOS story), and holds the player's mute and the tab's
  visibility as *separate* flags so returning to the tab restores the player's own choice.
- **`watchVisibility`** — the visibilitychange port; the client wires it to `setHidden`.
- **`safeStorage`** — storage that cannot throw: probes with one write, falls back to memory, and
  swallows quota errors mid-session. A preference that fails to save must never take the game down.
- **`readSafeAreaInsets`** — the CSS `env(safe-area-inset-*)` probe, measured on demand because a
  rotated phone moves its notch; the client re-reads it on every resize.
- **`detectCapabilities`** — pixel ratio, touch, coarse pointer, reduced motion, WebAudio, cores.
  Facts only; nothing here decides anything with them.

### Compliance — `packages/compliance`

Pure functions of an injected clock (it is in `PURE_PACKAGES`), applying the
`JurisdictionRules` that arrive **on the wire** — the preset table itself lives in `@slot/protocol`
(`JURISDICTION_PRESETS`), because an id alone would have made the client's table the authority on
what a regulator requires (D8).

- **Pacing** (`pacing.ts`) — `canSpin` / `spinDelay` / `nextSpinAllowedAt`: the client half of the
  wire's `minSpinIntervalMs` rule. A compliant client paces the button and never triggers the
  server's refusal.
- **Reality check** (`reality.ts`) — schedule arithmetic: due one interval after play began and one
  after each acknowledgement. Deliberately **time-only**: the overlay states minutes played, never
  money, because money the player sees comes from the server (ADR-0001).
- **Limits** (`limits.ts`) — session time / net loss / single-stake trackers over server-sent
  amounts. The one sanctioned aggregation of money on the client: the sums exist to *stop play*,
  never to describe or pay it.
- **Autoplay decisions** (`autoplay.ts`) — `afterRound` folds one settled round and answers with a
  stop reason: `COMPLETE`, `WIN_LIMIT`, `LOSS_LIMIT`, `FEATURE` — or `NOT_ALLOWED` where the
  jurisdiction forbids the run outright.

The **controller** that presses lives in the client (`apps/game-client/src/autoplay.ts`), above the
engine: it sends `PRESS` on an idle table, folds rounds on the event that carries the credit (not on
the phase change — `ROUND_SETTLED` arrives *after* `PHASE_CHANGED`, the same ordering lesson the
feature banner learned), stops on any error, and paces its own presses through the same
`spinDelay` a human press obeys. The engine cannot tell the difference, which is the demonstration
that the FSM's input contract is right.

### Dev-tools — `packages/dev-tools`

The developer's hands on every seam the architecture already exposes — **nothing in it is a new
capability**, which is why removing it removes nothing the game uses. Forcing an outcome is the
client's existing one-shot provider; fault injection is `setFaults` (in-process) or `PUT
/dev/faults` (HTTP); expiring the session is `expireSession`; the inspector reads the engine's own
`state` and the `/dev/state` summary. Everything DOM arrives injected and structural (the
`dom-controls.ts` pattern), so the whole panel tests headless in Node — and every capability is an
**optional port**: a section whose port is absent is not rendered, so the same panel serves the
in-process sim (which has a live jurisdiction switch) and the HTTP path (which deliberately does
not — a remote server's regime is that server's configuration) without either pretending.

- **The event log** (`log.ts`) correlates on `roundId`: events that do not name their round are
  attributed to the round that is open, so an export reads as rounds rather than a stream. Capped
  (oldest dropped, `seq` monotonic across the cut), timestamped from an injected clock, exported as
  JSON through a `download` port — the client turns it into a file save.
- **The jurisdiction switch restarts, never hot-swaps**: the choice is remembered under a dev-only
  key and the client reloads, so the new rules arrive the only honest way — on the wire, from
  `authenticate` (D8). The wire stays the authority even for a developer toggle.
- **The panel's CSS ships inside the package** (`style.ts`, injected by the wiring), not in the
  shell's `index.html` — because the shell ships to production and `verify:strip` failed on exactly
  that, first run. The styles are stripped with the code they style, by the same branch.
- **Two gates, verified**: the client's dev wiring is a compile-stripped branch around a *dynamic*
  import, so the package never enters the production graph — and `verify:strip` (in `pnpm check`)
  proves it against the built output: five markers the dev surface cannot exist without, each first
  shown to still exist at its source (a stale marker fails the check rather than passing it
  vacuously), then asserted absent from every built file. The server refusing `forceOutcome`
  outside dev mode remains gate two.

### Testing layers

| Layer | Where | What it proves |
| --- | --- | --- |
| **Unit** | beside the code, Vitest | Pure logic: evaluator (golden-file grids), money arithmetic, FSM transitions, **the spin curve** |
| **Renderer, headless** | `packages/renderer`, `packages/ui` | Pixi's scene graph is ordinary JavaScript until something draws: with a faked atlas, the stage's whole event contract runs in Node (`config/vitest.pixi.ts` stubs the two globals Pixi reads on import) |
| **Math** | `tools/math-sim` | 250k rounds in CI against the design band; 20M on demand for the published figure |
| **Mash** | `tests/mash.test.ts` | 120 rounds through the real engine, transport, simulator **and renderer**, pressing at random — the client's balance equals the server's after every round |
| **Resume** | `tests/resume.test.ts` | The client is destroyed and rebuilt at five points mid-feature over a surviving store — the round finishes once, and is credited once |
| **Engine soak** | `tests/soak.test.ts` | 1,000 seeded rounds incl. features, retries and disconnects, with **no state violations** |
| **Transport parity** | `tests/http.test.ts` | One round through `MockTransport` and through `HttpTransport`, against identically seeded simulators, **equal field for field** |
| **Contrast** | `tests/contrast.test.ts` | Every text-on-surface pair both palettes can produce holds WCAG 2.1 AA — found two failures the day it was written |
| **Glyph coverage** | `apps/game-client` (`i18n.test.ts`) | Every character of both string catalogues has a glyph in the shipped Inter woff2, at every shipped weight |
| **Network soak** | `tests/http-soak.test.ts` | 300 rounds over a real socket, a faulty-line run, and a shutdown with a hundred abandoned responses in flight — the failures that only exist on a connection |
| **Contract** | `tests/contract/`, one suite per target | `rgs-sim` in-process · sim over HTTP · `apps/rgs` (the full suite since R1, incl. the §5 stranded round only it can produce) — the switch-over gate |
| **Store contract** | `apps/rgs` (`store-contract.ts`) | One suite, two stores: memory always; Postgres whenever `RGS_TEST_DATABASE_URL` is set — always in CI, via a `postgres:16` service container. The session store (R5) has the same twin pair under its own contract |
| **Ledger** | `apps/rgs` (`ledger/`) | One contract suite, two ledgers (memory always; Postgres in CI, where a trigger proves append-only); the R3 gate — a scripted session's journal sums to zero, reproduces the exact balance history, reconciles clean, and reports then heals the orphaned stake |
| **Fairness** | `apps/rgs` (`rng/fairness.test.ts`) + the contract suite | The R4 gate: the "player" recomputes every step's `stops[]` from the reveal and their own inputs — hash, chain continuity, stranded-round binding — with `@slot/game-math` only; the suite repeats it over the production chain, `sha256Hex` is held to NIST vectors |
| **Wallet seam** | `apps/rgs` (`wallet/`) | `RemoteWallet` against the wallet sim over a real socket: an outage outlived by bounded retries, a lost confirmation healed by the idempotent ref, a refusal surfaced once and never retried (docs/wallet-api.md §4) |
| **E2E** | Playwright, in CI | Fixed seed + forced outcomes: spin, win, feature, resume after reload |
| **Perf** | `tools/perf-harness` | `pnpm perf`: 30 spins against the production bundle, 4× CPU throttle, headless Chrome — ~120 fps avg, p95 9.2 ms, 7 draw calls/frame (max 8: the symbol layer batches), heap sawtooths 9.8 → 14.1 → 9.4 MB. Frames from a rAF probe, draw calls by wrapping the WebGL entry points, heap over CDP; driven through the DOM control layer, so no dev hook is needed and the measured bundle is the shipped one |

The contract suite is the load-bearing one: it is the only reason "swap the transport URL" is a
credible claim.

#### The contract suite — `tests/contract/`

Three files, and the split is the whole design. [`targets.ts`](tests/contract/targets.ts) says what
a target *is* — an `RgsTransport` plus a control plane that can hand back a known starting point and
the server's own account of what happened — and registers the three.
[`suite.ts`](tests/contract/suite.ts) is the contract, parameterised over one target and naming no
server implementation anywhere in it. [`contract.test.ts`](tests/contract/contract.test.ts) is a
`for` loop.

Three rules make it a gate rather than a second copy of the unit tests:

- **It reaches a state by playing, not by forcing it.** `spinUntil` spins fresh rounds until one has
  the shape a test needs, finishing every round that does not — because `forceOutcome` is refused by
  every production server, and a suite built on it would be unrunnable against the one target that
  matters. Only the feature cases use it, and they are marked as needing the capability.
- **A capability a target lacks turns the case into a *named skip*, never an omission — and a
  target that runs but cannot pass yet is *expected red*, never quietly excluded.** `apps/rgs`
  walked the whole ladder: a named skip until R0, expected-red through it (the **red gate**
  asserted in green CI that every call was refused `NOT_IMPLEMENTED` and nothing else), and the
  full suite since R1. The `expectedRed` mechanism stays in the suite — taking an endpoint dark
  again must remain a tested state. The capability skips now cut both ways: the simulators skip
  the `unresolvedRounds` case they structurally cannot produce, and `apps/rgs` — the target whose
  `strand()` finally runs it — skips the `forceOutcome` cases a production server refuses by
  design. `faultInjection` turned *true* for it in R2, the only way a production-shaped server can
  offer it honestly: `WALLET_UNAVAILABLE` is demanded by refusing the target's real wallet, not by
  simulating a refusal.
- **The control plane is a port, not a back door.** The HTTP target resets and inspects through
  `apps/mock-rgs`'s `/dev/*` routes rather than the `SimServer` object it happens to hold, so the
  same target definition works against a server in another process.

What it does **not** prove, said here so nobody reads more into a green run: against all three
registered targets the paytable re-evaluation is a function agreeing with itself, because every one
of them — `rgs-sim` and, since R1, `apps/rgs` — derives its wins with the same `@slot/game-math`
the suite checks them with; sharing the engine was the deliberate choice (one implementation of the
math), and this is its cost. The assertion is aimed at the target the registry does not hold yet:
an operator's server reached by base URL, shipping its own math — which is exactly when a paytable
can drift.

### Environment & build flags

- **No secrets in this repository, ever.** Play money, a demo token, no operator credentials. If the
  real RGS later needs any, they arrive as environment variables with placeholder names
  (`<RGS_TOKEN>`, `<DB_PASSWORD>`) and never as committed defaults.
- **One `.env.example` at the root**; per-package env files are not allowed.
- Vite `define` flags: `__DEV_TOOLS__` (debug panel + force-outcome UI) and `__ASSERT_MATH__` (the
  client-side re-evaluation of the server grid). **Both false in production builds.**

## Gaps & missing pieces

_Living registry — see **[Rule 1](#rule-1--log-the-gaps-you-hit)**. Things absent in the **protocol**,
the **simulator**, the **real RGS**, or the **client** that the current work implies should exist.
**Add** a note when you hit one; **delete** it the moment the piece lands. This is the answer to
"what did we miss?". Strategic, forward-looking items that no built feature owes yet live in
**[`RECOMMENDATIONS.md`](RECOMMENDATIONS.md)** under the same maintenance rules — **never duplicate a
bullet between the two.**_

**Protocol — pinned in [`docs/protocol.md`](docs/protocol.md); what the pinning exposed**

_The six questions that lived here (the settle call, the feature contract, balance refresh, the
session token, the `Ws` transport, the persistence version) were answered on 2026-08-16, and the
session-expiry question that followed them was answered on 2026-08-19 and built the same day (§5,
D8, D9 — jurisdiction rules on the wire, no renew call, transparent mid-round re-authenticate)._

- (none)

**Workspace & tooling**

- **The network soak is a test, not a load test.** `tests/http-soak.test.ts` plays 300 rounds over a
  real socket, including a faulty-line run and a shutdown with a hundred abandoned responses in
  flight — which is what found the `preClose` bug. What it is not is *load*: one client, no
  concurrency, no memory measurement over time. Sustained multi-client load and a heap trend belong
  to R7, and the nightly run `RECOMMENDATIONS.md` asks for.
  **Decision (2026-08-19, build in C8):** a scheduled nightly CI job runs the existing soak with the
  round count from an environment variable (~5,000) plus a heap-trend assertion — the PR gate keeps
  300, because load in a merge gate is flake with a purpose. Multi-client load (k6/autocannon) waits
  for R7, where there is a server worth loading.
- **The cross-origin question is deferred, not answered.** Development works because Vite proxies
  `/rgs`, `/demo` and `/dev` to `apps/mock-rgs`, so the browser makes same-origin requests and the
  server never widens CORS. A *deployed* client (C8) has no proxy: either it is served from the same
  origin as the RGS, or the RGS grows a real CORS policy.
  **Decision (2026-08-19, build in C8):** same-origin, CORS never widens. `apps/mock-rgs` gains a
  flag-gated `@fastify/static` that serves the built client from the same origin the game API lives
  on — one process, one deploy, zero CORS headers, which is also how operators actually embed games.
  Record it as an ADR; a genuinely cross-origin operator integration is `apps/rgs`'s problem
  (post-R5, with the operator that needs it), with an explicit origin allow-list and never `*`.
- **`apps/mock-rgs` has no rate limiting.** The body-size cap (16 KB) and the request timeout landed
  2026-08-19 as `Fastify` constructor options, with a test pinning the oversized-body refusal to
  `SCHEMA_MISMATCH` — a payload no honest client produces is not a retry invitation.
  **Decision (2026-08-19):** `@fastify/rate-limit` with a per-IP budget arrives in C8, the moment
  this server first faces a network that is not `127.0.0.1`. `apps/rgs`'s half landed in R5
  (per-token and per-IP buckets, `RATE_LIMITED` + `Retry-After`); backpressure under real load
  stays R7's.

**Simulator (`packages/rgs-sim`) — behaviour the real RGS will have to earn**

- **The sim cannot produce an `OPEN` round with no feature, and the contract suite says so out
  loud.** docs/protocol.md §5 defines that recovery case — "the spin was debited but never resolved"
  — and neither simulator target has a window in which it can happen: a handler is synchronous, so
  debit and resolve land in the same call. S3 chose to declare rather than fake it: the case is a
  target capability (`unresolvedRounds`), it is skipped **by name** in every run, and a target that
  can produce it must implement `TargetHandle.strand()`. So the client still implements that branch
  of recovery against no producer, and the first real evidence arrives with R1.
  **Decision (2026-08-19):** stays exactly so — splitting a synchronous handler to fake the window
  would test fiction. `TargetHandle.strand()` got its real implementation in the `apps/rgs` target
  the same day (R1): the wallet debit and the store commit are genuinely separate systems there,
  and the §5 case now runs green against it while remaining a named skip for both sim targets.
- **The sim's policy surface is minimal, and deliberately stays so.** Since C6 the sim refuses a
  spin arriving before `minSpinIntervalMs` (`LIMIT_REACHED`) and expires sessions on every call —
  the two rules the client's compliance layer is built against, and since R5 the two `apps/rgs`
  enforces as well (the contract suite holds all three targets to both). What a real regulator
  also requires of the *server* — enforced autoplay limits, acknowledged reality checks, a full
  jurisdiction rule set behind an operator configuration — still has no producer anywhere: it is
  an operator-configuration surface no block owns yet, and it should arrive with a real operator
  integration rather than as fiction.

**Real RGS (`apps/rgs`) — playing since R1; what remains is the seams' real halves**

- **A failed money-side write is found by reconciliation, not announced when it happens.** A
  rollback that cannot be delivered, or a ledger write that fails, is swallowed by design
  (ADR-0005) — the reconciliation job reports the orphan or the drift on its next tick, through
  the app log. What R6 owes is the *instant* structured event at the failure site itself, with
  the `roundId` and the correlation id on it, so ops hears the bang and not just the echo.
- **History retention on Postgres is a number, not an eviction.** The memory store evicts settled
  rounds past `retention`; the Postgres store keeps every row and reports its configured figure —
  honest for now, but archival/partitioning is an ops job that belongs to R7.

**Client — implied by the domain, built by no block**

- **The reality check offers CONTINUE and nothing else.** Regulated markets require the pause to
  also offer a way *out* — quit the game, show the session's elapsed time on demand — and the demo's
  dialog has one button, because "exit" in an operator-embedded game is the lobby's affordance and
  there is no lobby. When C8 packages the demo behind a real URL, the dialog should gain an honest
  second action (reload to the landing page, if nothing else). The focus half landed with C7: the
  dialog traps Tab (`trapFocus`, drawer.ts), so only the missing second action remains.
- **The client holds the verification toolkit and never opens it.** Since R4 every closing
  response from `apps/rgs` carries a reveal, and `@slot/game-math` — which the client ships —
  can check it; but no client code calls `sha256Hex`/`stopsForStep` yet. The natural first home
  is the dev-build assertion (verify the reveal beside the existing win re-evaluation), and the
  player-facing "verify this round" affordance belongs beside the history drawer (C8+). Until
  then the ability the R4 bullet promised exists as a shipped library and a documented procedure,
  not as a button.
- **Autoplay's plan is fixed at the wiring site.** `{ spins: 25, stopOnFeature: true }` — the stop
  conditions regulators care about (loss limit, single-win limit) are implemented and tested in
  `@slot/compliance` but nothing lets a player *set* them, and the same is true of the session
  limits (`limits.ts` has trackers and no settings surface). The drawer frame these settings wanted
  now exists (C7); the picker itself — honestly labelled as player-protection settings, and
  player-facing rather than dev-gated — is C8's to add beside the history panel.

**Assets & content**

- **The audio set is functional, not designed.** Seven synthesized cues cover the moments that need
  sound (press, reel stops, tiered wins, the feature), and "real audio replaces `audio.ts` and
  nothing else" is now true — but nobody with ears has tuned them, there is no feature *music* (a
  pad plays once at the trigger; nothing loops), and no count-up tick plays under the rolling
  counter although the cue exists. A pass with taste is C8 polish; the fallback if synthesis never
  satisfies remains Kenney's CC0 packs, attributed in the README out of courtesy.

## Rules

### Rule 0 — Keep this file updated after every change

After any change to the codebase, **update this `CLAUDE.md` in the same change** so it always
reflects reality. At minimum keep the **Project description** accurate (packages, protocol surface,
client capabilities) and update **Commands**/**Architecture** whenever you add or move a package,
script, module, or convention. **Treat a feature as unfinished until its docs here are updated.**

While the repository is pre-code, this has a second half: **rewrite the relevant section from future
tense into present tense as it lands**, and delete the block reference once it has. A document that
still promises what the code already does is as wrong as one that describes code that doesn't exist.

### Rule 1 — Log the gaps you hit

This project is built **client-first against a simulator**, so implementing one surface routinely
reveals things that don't exist yet elsewhere. Whenever, while working a task, you notice something
**absent or incomplete in the protocol, the simulator, the real RGS, the client, or the assets** that
the current work implies *should* exist, record it in
**[Gaps & missing pieces](#gaps--missing-pieces)** — one bullet, in the right category. Judge what
belongs there by **best practice, established patterns, code quality, correctness and UX** (a missing
error path, an untested state, an endpoint the client has to fake, an accessibility hole) — note real
gaps, not hypothetical nice-to-haves.

Then keep the registry **honest and current**, because the question "what did we miss?" is answered
from it:

- **Delete a note the moment its gap is filled** — in the same change that fills it.
- **Don't duplicate** an existing note; refine it instead.
- If a whole category empties out, leave the heading with `- (none)` so the structure stays.

### Other rules

- **The server decides; the client presents.** Any code path where the client determines an outcome,
  a balance, or a win amount is a bug — including "just for the mock". The dev-build assertion exists
  to catch drift, and it must stay loud.
- **The protocol is the contract.** Change `packages/protocol` first when altering anything that
  crosses the wire, then the simulator, then the engine, then the UI. Never duplicate a wire type
  locally.
- **Respect the boundaries.** The dependency table above is enforced in CI. `engine` and `rgs-sim`
  stay free of Pixi and the DOM; `renderer`/`ui` are the only Pixi consumers. Don't add a shortcut
  import to "just get it working" — that import is the whole architecture.
- **Determinism is a feature.** Seeded PRNG, injected clocks, no ambient randomness or time in pure
  packages. A test that cannot be replayed from a seed is not finished.
- **Money is integer minor units.** Always. Formatting happens at the very edge, in `money`.
- **The ticker allocates nothing.** No closures, array literals, or spreads per frame in render code;
  pool sprites at boot.
- **Idempotency is not optional.** Every mutating call carries a client-generated `roundId`; retries
  reuse it; the server replays rather than re-spins.
- **Dev-only code is compile-stripped.** Anything behind `__DEV_TOOLS__` / `__ASSERT_MATH__` must be
  absent from a production bundle — and `forceOutcome` must additionally be refused server-side
  outside dev mode. Two gates, because one is a typo away from failing.
- **Every block ends CI-green and demoable.** The house pattern is: **protocol change → simulator
  handler + fixture → engine (headless tests) → renderer/UI → contract + unit tests green → update
  `CLAUDE.md` (Rule 0) and the Gaps registry (Rule 1)**.
- **An ADR for every decision that would surprise a reviewer.** Short, `docs/adr/ADR-000N-*.md`.
  ADR-0001 is the server-authoritative model; ADR-0002 is integer minor units and where the brand
  lives; ADR-0003 is why the simulator's persistence port takes storage as an argument instead of
  reaching for `localStorage`.
