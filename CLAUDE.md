# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

> ⚠️ **The game is a game: it spins, pays, runs its feature, and comes back from a reload.** As of
> **2026-08-18**, **C0, C1, S0, S1, C2, S2, C3, C4 and C5 have landed** — the workspace, the
> contracts (`protocol`, `money`, `game-math`), `rgs-sim`, the `RgsTransport` seam with
> `MockTransport`, `HttpTransport` and the retry policy, `engine`, `apps/mock-rgs`, and `renderer`,
> `ui` and `apps/game-client`: reels, the five-stage spin curve, a pooled symbol layer, payline
> highlighting, a tiered big-win counter, turbo, skip-anything, free spins with retrigger, and
> resume. 559 tests, `pnpm check` green. Three `packages/*` remain scaffolded and empty —
> `platform`, `compliance`, `dev-tools` — and each `src/index.ts` names the block that fills it.
>
> **`pnpm dev:client` opens a playable slot.** It authenticates, spins, lands on the server's
> `stops[]`, lights the paylines it was told won, counts the win up, runs the feature and settles.
> Point it at `apps/mock-rgs` with one environment variable and the same client plays the same game
> over HTTP.
>
> **Two properties are tested rather than claimed.**
> [`tests/mash.test.ts`](tests/mash.test.ts) plays 120 rounds through the real engine, transport,
> simulator and renderer while pressing the button at random, asserting the client's balance equals
> the server's after every round. [`tests/resume.test.ts`](tests/resume.test.ts) throws the client
> away at five points mid-feature — during the intro, mid-spin, between spins, deep in, during the
> outro — rebuilds it from nothing over a surviving store, and asserts the round finishes exactly
> once, credited exactly once.
>
> **What is deliberately not there yet:** audio, i18n and the compliance layer (**C6**), the debug
> panel and the performance pass (**C7**), packaging and the E2E suite (**C8**). The next block is
> **C6**, with **S3** (the contract suite) and **S4** (the RTP report — which the strips now visibly
> need) available in parallel.
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
| `@slot/rgs`         | `apps/rgs`           | Node.js RGS skeleton — routes stubbed, `NotImplemented`    | R0    |
| `@slot/protocol`    | `packages/protocol`  | ★ Contracts: zod schemas + inferred TS types + error taxonomy | ✅ C1 |
| `@slot/money`       | `packages/money`     | Branded `Minor` integer units, exact arithmetic, formatting | ✅ C1 |
| `@slot/game-math`   | `packages/game-math` | Reel strips, paytable, payline evaluator (pure, no I/O)   | ✅ C1 |
| `@slot/engine`      | `packages/engine`    | ★ Headless round orchestration + FSM (**no Pixi, no DOM**) | ✅ C2 |
| `@slot/renderer`    | `packages/renderer`  | Pixi layer: reels, symbols, spin curve, generated atlas    | ✅ C3 |
| `@slot/ui`          | `packages/ui`        | Pixi UI: spin button, bet selector, HUD                    | ✅ C3 |
| `@slot/rgs-sim`     | `packages/rgs-sim`   | ★ Mock server core (pure — runs in a browser or in Node)  | ✅ S0 |
| `@slot/transport`   | `packages/transport` | `RgsTransport` interface + Mock/Http implementations      | ✅ S2 |
| `@slot/platform`    | `packages/platform`  | Audio, storage, visibility, safe-area, device capabilities | C6   |
| `@slot/compliance`  | `packages/compliance`| Jurisdiction rules, reality check, session/loss/stake limits | C6  |
| `@slot/dev-tools`   | `packages/dev-tools` | Debug panel, event log, force-outcome UI                  | C7    |
| —                   | `tools/math-sim`     | RTP / volatility / hit-frequency simulation CLI           | S4    |
| —                   | `tools/perf-harness` | Scripted fps / memory capture                             | C7    |

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
| `featureSpin` | `(roundId, step)` | One free spin inside an already-open round. No debit; wins accrue to `feature.cumulativeWin` |
| `settle` | `roundId` | Credits the round's total win, `RESOLVED → SETTLED`. Required whenever there is money to credit; a zero-win base round settles atomically |

```ts
export type Minor   = number & { readonly __brand: 'Minor' };  // integer minor units
export type RoundId = string;                                   // UUIDv7, client-generated

export interface RoundResult {
  stops:    number[];           // strip index per reel — the authoritative outcome
  view:     SymbolId[][];       // derived grid, sent for convenience + dev-build assertion
  wins:     Win[];
  totalWin: Minor;
  features: Feature[];
}
```

Six design points, all of them now load-bearing in `rgs-sim`:

- **`roundId` is generated client-side**, so a retry after a timeout is provably the same round. The
  server returns the original result for a duplicate key rather than spinning again.
- **`stops` is the outcome; `view` is derived.** Sending both lets the client assert consistency and
  makes strip-alignment bugs debuggable.
- **`pendingRound` on authenticate is the whole recovery path.** No separate recovery endpoint.
- **Money is integer minor units everywhere**, behind a branded type, so `stake + 0.1` is a compile
  error rather than a rounding incident.
- **The client never computes a balance.** Every response carries the authoritative balance after the
  operation it describes — post-debit on `spin`, post-credit on `settle`. The HUD displays server
  numbers; it never adds or subtracts them. This is why `settle` is an explicit call.
- **One round is one stake, one debit and one credit.** Free spins are *steps* inside that round,
  keyed `(roundId, step)`, so a disconnect on spin 7 of 10 resumes at spin 7. Retrigger arithmetic is
  the server's; `feature.total` / `feature.remaining` arrive already folded.

## Commands

> **Keep this table in step with `package.json`.** Commands marked _(block)_ do not exist yet — the
> block named is the one that adds them. Everything else runs today.

Everything runs from the repo root. The one command before every commit:

```bash
pnpm check
```

| Command                | What it does                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `pnpm check`           | lint → build → typecheck → test → root suites → format check. **What CI runs.**      |
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
| `pnpm test:contract`   | The contract suite against every target (see **Testing layers**) _(S3)_              |
| `pnpm e2e`             | Playwright, fixed seed + forced outcomes _(C8)_                                      |
| `pnpm math-sim`        | RTP report — `pnpm math-sim --spins 50000000` _(S4)_                                 |
| `pnpm perf`            | Scripted fps/memory capture via `tools/perf-harness` _(C7)_                          |

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
  All eleven `packages/*` are scaffolded and empty — each `src/index.ts` names the block that fills
  it. `apps/*` and `tools/*` arrive with their own blocks (C3, S2, R0, S4, C7).
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
game-client → everything above
```

```
mock-rgs    → protocol, rgs-sim               # apps/mock-rgs — NOT transport
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

### Purity rules for `engine`, `rgs-sim`, `game-math`, `money`

These four packages are pure and deterministic. `Math.random()`, `Date.now()`, argless `new Date()`
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

| Class | Codes | Client behaviour |
| --- | --- | --- |
| `RECOVERABLE` | `TIMEOUT` · `UPSTREAM_UNAVAILABLE` · `WALLET_UNAVAILABLE` · `RATE_LIMITED` | Exponential backoff retry **with the same `roundId`**; reconnect overlay |
| `PLAYER` | `INSUFFICIENT_FUNDS` · `STAKE_NOT_ALLOWED` · `SESSION_EXPIRED` · `LIMIT_REACHED` | Modal, return to `IDLE`, **no retry** |
| `FATAL` | `SCHEMA_MISMATCH` · `UNKNOWN_ROUND` · `ROUND_CONFLICT` · `ILLEGAL_TRANSITION` · `FORCE_OUTCOME_REFUSED` · `MATH_VERSION_MISMATCH` | Freeze the reels, error screen, offer reload |

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

### Math — `packages/game-math`

Strips, paylines and the paytable **as data**, plus a pure evaluator. `evaluate()` reads a grid the
server sent and returns the wins to highlight; `viewFrom()` derives the grid from `stops`, and
`viewMatchesStops()` is what the dev build and the contract suite use to catch a server whose view
disagrees with its own outcome. `MATH_VERSION` names this strips-and-paytable combination.

Two behaviours worth knowing, both tested: a line that starts with wilds is paid the **better** of
the two readings (wilds as themselves vs. wilds standing in for the first real symbol), and wilds
never substitute for the scatter. The rules are specified one line at a time in `evaluate.test.ts`;
what they add up to on a full screen is pinned by 30 handcrafted grids in
`src/__fixtures__/golden.json` (`pnpm --filter @slot/game-math golden:update` regenerates the
expectations — for a deliberate math change, never to make a red test green).

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
- Target **60 fps on a mid-range Android**. The trace and the numbers are **C7**; nothing here claims
  them yet.

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
already did** — `FeatureProgress` arrives with `total`, `remaining` and `cumulativeWin` already
folded, retriggers included, so a retrigger is simply a `total` that grew and the client's whole
contribution is noticing and announcing it. And **every screen is built from the event that carries
its data**, never from the phase change: the engine emits `PHASE_CHANGED` *first*, so a banner built
on the phase announces "0 SPINS" — which is precisely what it did until it was fixed. A phase that
owes the engine an input and has nothing to show recovers on the next frame with an empty timeline,
because the one unacceptable outcome is a round that waits forever.

**Turbo is one switch** — `scaleCurve` shortens every duration in the spin curve and the same factor
scales the presentation. Speed, overshoot and the blur threshold are untouched, because turbo should
shorten a spin rather than hand the player a different game; and when the compliance layer (C6)
forbids turbo in a jurisdiction there is exactly one thing for it to refuse.

`@slot/ui` is the control surface: spin button, bet selector, turbo toggle, balance/win HUD. It takes
a **view model, not an engine** — `ui → protocol, money` is the whole dependency list — so the client
maps phases onto `PanelView` and the interruption contract stays in the engine where it is tested.
Two rules hold throughout: the HUD **never computes money** (every number it shows arrived from the
server), and the stake is always one of `GameConfig.betLevels`.

### The client — `apps/game-client`

Vite plus about four hundred lines, and **no game rules anywhere in it**. It is the wiring site: the
one file in the project that imports everything, supplies the arguments each package was designed to
take, and maps engine phases onto a button label.

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
- **The renderer attaches to a machine already in motion.** The stage cannot be built until
  `authenticate` has answered — the strips arrive in that response — so a resumed round is announced
  before anything is listening, and events are not replayed. `GameStage.attach(state)` reads the
  engine's state once and puts the reels where the round already is. Without it a reload mid-feature
  hung on motionless reels; with it, the same reload lands on the outcome and plays on.
- **The client remembers preferences, not the round.** The stake and turbo go through
  `@slot/protocol`'s `PersistedEnvelope`, and a version mismatch, corrupt JSON or drifted shape is
  **discarded** rather than repaired — the same rule the simulator's own store obeys. A remembered
  stake that is no longer on the server's bet ladder is dropped too, because the alternative is a
  reload that turns into `STAKE_NOT_ALLOWED` on the first spin. Everything else — the balance, the
  round, the feature — is the server's, and `authenticate` returns it.
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
root — standing in for `apps/game-client`, and the seed of the contract suite (S3).

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
than a global, for the same reason the simulator's storage does (ADR-0003).

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
| `prng.ts` | xoshiro128\*\* seeded from a string, with **rejection sampling** in `nextBelow` — a plain modulo over-represents low stops and would tilt the published RTP. Spin seeds are *derived*, never stored: `(serverSeed, roundId, clientSeed, step)` |
| `outcome.ts` | Draws the stops, then derives everything else from them. `view`, `wins` and `totalWin` are consequences of `stops`, never inputs — which is what makes the client's dev-build assertion meaningful |
| `sim.ts` | The four handlers, the round machine `OPEN → RESOLVED → SETTLED`, and the idempotency store |
| `state.ts` | `SimState` as a zod schema whose inferred type *is* the exported type — the wire discipline, applied to the disk |
| `store.ts` | The persistence port: `InMemoryStore` and `WebStorageStore` (ADR-0003) |
| `config.ts` | `MATH_CONFIG` plus the commercial half — bet limits, max win, jurisdiction, `devMode` |
| `server.ts` | `SimServer` — validation, persistence, `SlotError` |

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
- **Stake validation and max-win capping** — `STAKE_NOT_ALLOWED`, `INSUFFICIENT_FUNDS` and
  `SettleRes.capped` all have real producers, so the `PLAYER` error class is testable end to end.
- **Retrigger arithmetic**, folded server-side. `remaining = total - step` holds through every free
  spin; the client displays it and never computes it.
- **A persistence port** with two implementations, in-memory and web-storage. Round history is
  bounded (`MAX_ROUND_HISTORY`) and only `SETTLED` rounds are ever evicted.
- **The `forceOutcome` dev gate** — the field is refused unless `GameConfig.devMode`, and refused
  *before* any other validation, so a tampered request never learns anything else. Explicit `stops[]`
  work in dev mode; the named scenarios are S1.

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

The binding is pinned in [docs/protocol.md §2.6](docs/protocol.md) and argued in
[ADR-0004](docs/adr/ADR-0004-http-binding.md). Four points are worth knowing without opening either:

- **Routes come from the `CALLS` table**, via `routeFor()` — `POST /rgs/spin` and friends. A fifth
  call would be routed, validated and typed the moment it joined the contract.
- **The status code is for operators; the body is for the client.** The client branches on the
  `class`, which is derived from the `code`, which is in the body. `STATUS_OF_CODE` is declared
  `satisfies Record<ErrorCode, number>`, so a new error code cannot be added without deciding what it
  looks like on the wire.
- **A dropped response is a hijacked reply** — the connection is held open and says nothing, because
  that is what the fault *is*: the round happened and the answer was lost. The client's own timeout
  ends the wait, exactly as in-process. Hijacked sockets are tracked so shutdown destroys them
  instead of waiting on a connection that waits forever.
- **`x-correlation-id` in both directions.** The client mints one and the server echoes it; the
  simulator's own `sim-000042` ids (replayable, not unique across sessions) go to the log line beside
  it.

`/dev/*` — fault injection, session reset, a state summary — is what the debug panel (C7) drives and
what lets the contract suite (S3) *demand* a failure rather than wait for one; it is mounted only
when `devRoutes` is on, and `apps/rgs` will not have it. `POST /demo/session` is not gated, because a
server you cannot obtain a token for is not a server (docs/protocol.md §7). Configuration is
environment, validated with a schema like anything else that crosses a boundary — a mistyped server
seed silently changes every outcome the session produces.

### The future backend — `apps/rgs`

Created in **R0**, before it does anything, structured the way it would really be built:

```
apps/rgs/src/
├─ http/          routes, request validation via @slot/protocol schemas
├─ domain/        round lifecycle, stake validation      → throw NotImplemented
├─ wallet/        WalletProvider interface + MockWallet   (the operator↔provider seam)
├─ ledger/        double-entry interface                  → throw NotImplemented
├─ math/          re-exports @slot/game-math
├─ rng/           ServerSeedProvider interface
├─ persistence/   RoundRepository, IdempotencyRepository interfaces
└─ observability/ pino logger, correlation-ID middleware
```

Every route validates with the shared zod schema and throws `NotImplementedError`. **The contract
suite runs against both `rgs-sim` and `apps/rgs`** — the sim passes today, the real one goes green
endpoint by endpoint. That is the scalability answer made concrete, and it is why R-blocks can land
one at a time without a big-bang cutover.

`WalletProvider` (`getBalance` / `debit` / `credit` / `rollback`) is the seam every real RGS has
between operator and game provider. Stubbing it in R0 costs an hour and shows you know the industry
shape.

### Platform, compliance, dev-tools

- **`platform`** — audio (Howler sprite, iOS unlock-on-first-tap, mute on `visibilitychange`),
  storage, visibility, safe-area insets, device capability detection. Everything the browser makes
  awkward, behind one boring interface.
- **`compliance`** — jurisdiction presets as **data**, applied at runtime: reality check, session /
  loss / stake limits, and a **UK preset** (2.5 s minimum spin duration, autoplay and turbo
  disabled). Switching jurisdiction in the debug panel must visibly change game behaviour.
- **`dev-tools`** — debug panel (force outcome, fault injection, jurisdiction switch, state
  inspector, exportable event log correlated on `roundId`), **stripped from production by the
  `__DEV_TOOLS__` Vite define**. Verify the strip in the bundle; a debug panel that ships is a bug.

### Testing layers

| Layer | Where | What it proves |
| --- | --- | --- |
| **Unit** | beside the code, Vitest | Pure logic: evaluator (golden-file grids), money arithmetic, FSM transitions, **the spin curve** |
| **Renderer, headless** | `packages/renderer`, `packages/ui` | Pixi's scene graph is ordinary JavaScript until something draws: with a faked atlas, the stage's whole event contract runs in Node (`config/vitest.pixi.ts` stubs the two globals Pixi reads on import) |
| **Mash** | `tests/mash.test.ts` | 120 rounds through the real engine, transport, simulator **and renderer**, pressing at random — the client's balance equals the server's after every round |
| **Resume** | `tests/resume.test.ts` | The client is destroyed and rebuilt at five points mid-feature over a surviving store — the round finishes once, and is credited once |
| **Engine soak** | `tests/soak.test.ts` | 1,000 seeded rounds incl. features, retries and disconnects, with **no state violations** |
| **Transport parity** | `tests/http.test.ts` | One round through `MockTransport` and through `HttpTransport`, against identically seeded simulators, **equal field for field** |
| **Contract** | one suite, three targets | `rgs-sim` in-process · sim over HTTP · `apps/rgs` — the switch-over gate |
| **E2E** | Playwright, in CI | Fixed seed + forced outcomes: spin, win, feature, resume after reload |
| **Perf** | `tools/perf-harness` | fps/memory on a throttled mobile profile — numbers, not adjectives |

The contract suite is the load-bearing one: it is the only reason "swap the transport URL" is a
credible claim.

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
session token, the `Ws` transport, the persistence version) were answered on 2026-08-16 — the answers
and their rejected alternatives are in `docs/protocol.md` §11. What is left is what those decisions
made visible:_

- **An expiring session has no story mid-round.** `session.expiresAt` and the `PLAYER` code
  `SESSION_EXPIRED` are pinned, but a `PLAYER` error returns the client to `IDLE` — which, with a
  debited round still `OPEN`, silently abandons the player's money. Either expiry triggers a
  transparent re-authenticate that resumes from `pendingRound`, or the protocol needs a renew call.
  `rgs-sim` produces the code but deliberately checks expiry on `authenticate` **only**, and the
  engine now makes the consequence concrete: `SESSION_EXPIRED` is `PLAYER`, so `DISMISS` returns to
  `IDLE` and a debited round is simply abandoned. Nothing re-authenticates. Decide before C6, when
  the compliance layer starts ending sessions on purpose.
- **`limits.maxWin` is an absolute amount, not a multiple of the stake.** Real max-win caps are
  expressed as N× the stake actually played, so a minimum-stake player and a maximum-stake player do
  not share a ceiling — under the current shape they do, and the minimum-stake player's cap is
  effectively unreachable while the maximum-stake player's binds far too early. `rgs-sim` implements
  the field as specified rather than working around it. Changing it is a wire change, so it belongs
  in `docs/protocol.md` first; decide before S4 tunes the math against a ceiling that will move.
- **Nothing compares the two math versions.** `GameConfig.mathVersion` is on the wire, `game-math`
  exports `MATH_VERSION`, `apps/mock-rgs` now publishes the server's on `GET /ready` — and nothing
  puts the two side by side. The comparison belongs on the authenticate path and raises
  `MATH_VERSION_MISMATCH`; it is still scheduled in no block. Until it exists, a strip edit ships a
  client drawing reels the server is not playing, and neither `tests/soak.test.ts` nor
  `tests/http.test.ts` would notice, because both halves come from the same workspace. The HTTP path
  makes this worse rather than better: a deployed `apps/mock-rgs` can now be a different build from
  the client talking to it.

**Workspace & tooling**

- **Two targets, two hand-written suites — not the one suite S3 promises.**
  `tests/wiring.test.ts` and `tests/http.test.ts` prove the in-process and HTTP paths agree, but they
  are two files that happen to assert similar things, not *one* suite parameterised over three
  targets. The HTTP one also plays a single round where the soak plays a thousand: the network path
  has no equivalent of `tests/soak.test.ts`, so a fault that only manifests under sustained load over
  a socket has nothing looking for it. S3 is where both are fixed.
- **Three packages still have no boundary rule.** The dependency table covers `protocol`, `money`,
  `game-math`, `engine`, `rgs-sim`, `transport`, `renderer`, `ui` and `apps/mock-rgs` — so
  `platform`, `compliance` and `dev-tools` are unconstrained: today nothing stops `compliance`
  importing Pixi or `platform` importing the engine. (`apps/game-client` is deliberately
  unconstrained — it is the wiring site, and it may reach everything.) Decide what each may reach
  (C6/C7 are the natural moments) and add the rules; until then the enforcement story has three holes
  in it.

- **The cross-origin question is deferred, not answered.** Development works because Vite proxies
  `/rgs`, `/demo` and `/dev` to `apps/mock-rgs`, so the browser makes same-origin requests and the
  server never widens CORS. A *deployed* client (C8) has no proxy: either it is served from the same
  origin as the RGS, or the RGS grows a real CORS policy. Decide it in C8 rather than at the point a
  built bundle silently fails against a live server.
- **The HTTP server has no limits of its own** — no rate limiting, no body-size cap, no request
  timeout. Fine for a dev tool bound to `127.0.0.1`, and exactly the list `apps/rgs` cannot ship
  without (R5/R7). Worth stating so its absence reads as a decision.

**Math — visible now that a feature actually plays**

- **The feature retriggers itself half to death.** Playing the trigger scenario across twenty-four
  seeds gives features of 10, 20, 30 — and 80, 95, 155 free spins. On untuned strips every reel
  carries scatters, so a retrigger is roughly as likely as the trigger was, and the tail runs away.
  That is an RTP problem, a session-length problem and a presentation problem at once (a hundred and
  fifty free spins is not a feature, it is a wait). **S4** owns the tuning; until it lands,
  `tests/resume.test.ts` pins a seed whose feature is ten spins so the suite stays a fixed-length
  experiment rather than a coin toss.

**Simulator (`packages/rgs-sim`) — behaviour the real RGS will have to earn**

- **The sim cannot produce an `OPEN` round with no feature.** docs/protocol.md §5 defines that
  recovery case — "the spin was debited but never resolved" — and the in-process sim has no window
  in which it can happen: a handler is synchronous, so debit and resolve land in the same call.
  Only a real RGS that crashes between the two can produce it (R1). The client will implement that
  branch of recovery against no producer, and the contract suite (S3) has to decide whether to fake
  one or to mark the case untestable against this target.
- **Jurisdiction is declared but not enforced.** `GameConfig.jurisdiction` now comes *from* the
  server, which is the right direction, but enforcement still lives entirely in the client's
  `compliance` package (C6). A real regulator requires the *server* to enforce minimum spin duration
  and autoplay limits; the sim has no policy surface at all, so the UK preset remains a UI convention
  rather than a rule until R5.

**Real RGS (`apps/rgs`) — the whole surface**

- **Every endpoint is unimplemented, by design (R0).** The contract suite is expected to fail against
  this target until R1+ lands, and that expectation is documented, not silent. Replace this bullet
  with specific gaps as the R-blocks land and the failures become real ones.

**Client — implied by the domain, built by no block**

- **Autoplay does not exist, yet the UK preset disables it.** Every real slot has autoplay, the
  compliance work (C6) assumes it, and no block builds it — including the loss/win-limit stop
  conditions regulators actually care about. Either schedule it or state in the README that it is out
  of scope; the current position is an inconsistency.
- **No game history / "last rounds" surface.** Regulated markets require a player-visible round
  history, and `roundId` + the persisted round state already make it nearly free.
- **A capped max win counts up to a number the player is not paid.** The presentation rolls to
  `result.totalWin`, and `settle` may credit less because `limits.maxWin` clipped it — after which the
  status line reads `MAXIMUM WIN REACHED` and the balance moves by the smaller figure. The counter,
  the banner and the credit should agree; today the first two are the round's win and the third is
  the capped one. The fix needs the cap on the way *in* (the server knows at spin time whether the
  round will clip) or a presentation that counts to the credited amount, and it is a wire question
  before it is a rendering one.
- **Accessibility is unaddressed, and every block makes it more concrete.** There is no
  `prefers-reduced-motion` path: the reels spin, the winning symbols pulse and a big win flashes a
  banner, none of which has a reduced variant — and the timings are all data, so one would be cheap.
  Win highlighting is a ring plus a dim, which happens to survive colour blindness, but nothing
  verifies that. And a canvas game still has no screen-reader story at all: the balance, the win and
  the phase are pixels, not an announced region, though the HTML shell is right there to hold one.
  All of it is unscheduled.
- **A `FATAL` error is reported to nobody.** The debug panel exports an event log *locally*; there is
  no telemetry seam, so a schema mismatch in a deployed build is invisible. The fix is a `Telemetry`
  port with a console adapter, called from the error boundary and the FSM's illegal-transition path —
  an hour's work, and the seam a real reporter slots into later.

**Assets & content**

- **The feature is silent, and so is everything else.** C5 gives the feature a border, a counter and
  two screens; what tells a player the rules changed in every real slot is the music, and there is no
  audio layer at all until C6. The gap below is the blocker for it.
- **Audio has no source, and no licence story.** The art question is answered — the symbol atlas is
  *generated at boot* from shapes and text, so the repository ships no image, licenses nothing and
  attributes nobody, and swapping in real art later replaces one file. Sound cannot be generated as
  cheaply: C6 assumes an audio sprite, and for a **public** repository every clip has to be CC0 or
  properly licensed with attribution in the README. Resolve it before C6, not during.
- **Font coverage for RU is unverified.** i18n ships en/ru (C6). Many display faces carry no Cyrillic;
  if the chosen face doesn't, a Russian build silently falls back per glyph and the type design
  simply doesn't apply to half the supported languages. Verify the actual `.ttf`/atlas when the face
  is picked, not after.

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
