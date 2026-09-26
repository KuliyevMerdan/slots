# iGaming Slot Client — Roadmap

Drafted **2026-08-16**. A portfolio-grade, **server-authoritative slot game client** (PixiJS +
TypeScript) in a monorepo shaped so a real Node.js RGS can be dropped in later **without touching
client code**. Target role: game client / frontend developer at a slots studio.

This file is the **task map**: blocks, their gates, and the order they land in. The *why* — the
transport seam, the dependency rules, the FSM, the spin curve, the performance constraints — lives in
**[`CLAUDE.md`](CLAUDE.md)**, which is the canon and the thing you keep current as code lands.
Strategic investments nothing owes yet live in **[`RECOMMENDATIONS.md`](RECOMMENDATIONS.md)**.

Check items off as they land. **Every block follows the house pattern:**

> **protocol change → simulator handler + fixture → engine (headless tests) → renderer/UI →
> contract + unit tests green → tick off here + update `CLAUDE.md` (Rule 0) and delete the filled
> Gaps entries (Rule 1)**

**C0 landed 2026-08-16** (workspace, strict TS, enforced boundaries, purity rules, CI, ADR-0001),
**C1 landed 2026-08-17** (`protocol`, `money`, `game-math` — the contracts everything downstream
reads), **S0 landed 2026-08-18** (`rgs-sim` — the pure core that decides outcomes: seeded PRNG, the
round machine, idempotency, persistence, ADR-0003), **S1 landed 2026-08-18** (fault injection, the
named force-outcome scenarios, and the `RgsTransport` seam with `MockTransport`), **C2 landed
2026-08-18** (the engine FSM, the retry policy, resume), **S2 landed 2026-08-18**
(`apps/mock-rgs`, `HttpTransport`, the HTTP binding — ADR-0004) and **C3 landed 2026-08-18**
(`renderer`, `ui`, `apps/game-client` — reels on screen, the five-stage spin curve, the generated
atlas, the sprite pool) and **C4 landed 2026-08-18** (payline highlighting, the tiered big-win
counter, turbo, skip-anything as a completable timeline, and the paytable re-evaluation assertion)
and **C5 landed 2026-08-18** (free spins with retrigger, the intro and outro screens, the feature
counter, preferences through the persistence envelope, and resume proven at five points mid-feature)
and **S4 landed 2026-08-18** (`tools/math-sim`, and the tuning it forced: 96.107% RTP over twenty
million rounds, on strips that no longer make the feature a runaway) and **S3 landed 2026-08-18**
(`tests/contract/` — one suite, a target registry, and capabilities a target declares rather than
quietly lacks). 693 tests green — including the work the S3 review surfaced as unowned: the
math-version gate, the max-win ceiling as a multiple of the stake, the telemetry seam,
`prefers-reduced-motion` with an announced region, the `history` call, and the network soak that
found a shutdown hang in `apps/mock-rgs`.

Since then **C6 and C7 landed 2026-08-19** (platform, compliance, dev-tools, perf-harness — see
`CLAUDE.md` for what each turned out to be), **R0 landed 2026-08-19** (`apps/rgs` wired and
honestly empty — every route answering `NOT_IMPLEMENTED` (D10), the wallet seam declared, the
contract suite's third target expected-red with its red gate a green CI assertion) and **R1 landed
2026-08-19**: rounds and idempotency behind a store port with in-memory and Postgres
implementations held to one contract, the outcome engine lifted into `@slot/game-math`, and the
third target running the **full** contract suite — including the §5 stranded round only it can
produce. **R2 landed 2026-08-19** as well: the wallet seam is real at the wire —
`RemoteWallet` with deadlines and bounded retries against any wallet speaking
[`docs/wallet-api.md`](docs/wallet-api.md), the rollback path closing the confirmed-debit-no-round
window, and the third contract target running client→HTTP→rgs→HTTP→wallet with faults enacted by
refusing the real wallet. **R3 landed 2026-08-19**: the double-entry ledger — append-only on both
stores (a trigger enforces it on Postgres), every wallet movement journaled with idempotency
mirroring the wallet's own, and a reconciliation job that trues the journal against the wallet and
finds the orphaned stake balance-truing cannot see (ADR-0005). **R4 landed 2026-08-19**: provable
fairness — per-round seed pairs on a CSPRNG chain, commitment before the bet, seed bound at open
and persisted with the round, reveal on the closing response; the player's verification ships in
`@slot/game-math` (a NIST-vectored `sha256Hex`, `stopsForStep`), the wire half is §9/D11, and the
contract suite holds `apps/rgs` to it as a capability the simulators honestly lack (ADR-0006).
**R5 landed 2026-08-19**: sessions for real — the token binds every call via an
`Authorization: Bearer` header carried by the transport itself (§2.7, D12), sessions live in a
store with memory and Postgres twins held to one contract (Postgres rather than the planned Redis
— ADR-0007), tokens are minted server-side from the CSPRNG through an operator surface
(`POST /operator/sessions`, §7), the jurisdiction's pacing rule is enforced server-side
(`LIMIT_REACHED`, replay-exempt), and the game routes sit behind per-token and per-IP token
buckets answering `RATE_LIMITED` with `retryAfterMs`. The contract suite gained the two
PLAYER-class cases that run against **all three targets**: mid-round expiry → renewal → resume
credited once, and the pacing refusal with its idempotent-replay exemption.
**R6 landed 2026-08-19**: observability as three seams (ADR-0008) — one structured line per game
call with the `roundId` on it and the domain's swallowed money-side failures made loud at the
failure site through the `RgsObserver` port; OTel spans (`@opentelemetry/api` as the seam, the
SDK only in `main.ts`) keyed `rgs.round_id`, wallet spans nested by the `tracedWallet` decorator;
a hand-rolled metrics registry on `GET /metrics` with the round-state gauge asked of the store at
scrape time; `/ready` probing the store and the wallet (by refusal) and naming the check that
failed. The gate — one `roundId` retrieves the round's full story across logs, traces and
metrics — is a test over the real HTTP binding.
**R7 landed 2026-08-20** (ADR-0009): the boot contract (`RGS_ENV=production` refuses every dev
placeholder, all violations named at once), one image with two commands (the RGS and the wallet
sim) behind a health-gated rollout with rollback and backup documented in
[docs/deploy.md](docs/deploy.md), CI building the image on every push; the race suite firing
simultaneous duplicates over the real binding against both stores — which found and fixed two
real windows in the domain — plus `pnpm load`, the balance-checking throughput tool; the restore
drill as a CI test; retention made real on Postgres; the metrics scrape movable to its own
listener; and the client's out-of-band token (`VITE_RGS_TOKEN`), closing the switch-over
argument: the real RGS is now a configuration change, end to end. **The R-blocks are complete.**
**C8 is built** (2026-08-20) — the demo image on one origin, rate limiting on `mock-rgs`, the
nightly soak, the E2E suite, the README and the architecture documents. **What remains is the
hosting**: the platform is chosen (Render's free tier, 2026-09-26, declared in `render.yaml`), and
connecting it, the live URL and the GIF close the block.

---

## Task map

Three parts run in parallel after C1: the **client** consumes contracts, the **simulator** fulfils
them, and the **real RGS** is a skeleton that goes green endpoint by endpoint against the same
contract suite. `#` maps each block back to the phase numbering of the original plan.

| Block | Delivers | Gates on | # | Status |
| --- | --- | --- | --- | --- |
| **C0** | Workspace, strict TS, boundary lint, CI, ADR-0001 | — | 0 | ✅ (landed 2026-08-16) |
| **C1** | `protocol` · `money` · `game-math` — the contracts everything reads | C0 | 1 | ✅ (landed 2026-08-17) |
| **C2** | `engine` FSM + `transport` (retry/backoff/timeout, resume) | C1, S1 | 3 | ✅ (landed 2026-08-18) |
| **C3** | Reels on screen — Pixi bootstrap, atlas, pool, spin curve | C2 | 4 | ✅ (landed 2026-08-18) |
| **C4** | Win presentation + interruptibility (slam stop, skip-anything) | C3 | 5 | ✅ (landed 2026-08-18) |
| **C5** | Features + resume — free spins, retrigger, mid-feature reload | C4, S0 | 6 | ✅ (landed 2026-08-18) |
| **C6** | Platform layer — responsive, audio, i18n, compliance | C4 | 7 | ✅ (landed 2026-08-19) |
| **C7** | Dev tools + performance pass | C5, S1 | 8 | ✅ (landed 2026-08-19) |
| **C8** | Packaging — deploy, README, Playwright E2E in CI | C6, C7, S4 | 9 | ◐ (2026-08-20 — all built; the hosted URL and GIF remain) |
| **S0** | `rgs-sim` pure core — PRNG, round machine, idempotency, persistence | C1 | 2 | ✅ (landed 2026-08-18) |
| **S1** | Fault injection + force outcome + `MockTransport` | S0 | 2 | ✅ (landed 2026-08-18) |
| **S2** | `apps/mock-rgs` — Fastify wrapper, the real network path | S0 | 2 | ✅ (landed 2026-08-18) |
| **S3** | The contract suite — one suite, three targets. **The switch-over gate** | S2, R0 | 2 | ✅ (landed 2026-08-18, ahead of R0 — see the block) |
| **S4** | `tools/math-sim` — RTP / hit frequency / volatility report | S0 | 8 | ✅ (landed 2026-08-18) |
| **R0** | `apps/rgs` skeleton — routes stubbed, `NotImplemented`, wallet seam | C1 | 2 | ✅ (landed 2026-08-19) |
| **R1** | Rounds & idempotency on Postgres | R0, S3 | 10 | ✅ (landed 2026-08-19) |
| **R2** | Wallet integration behind `WalletProvider` | R1 | 10 | ✅ (landed 2026-08-19) |
| **R3** | Double-entry ledger in integer minor units | R2 | 10 | ✅ (landed 2026-08-19) |
| **R4** | Server RNG + provably-fair seed commit/reveal | R1 | 10 | ✅ (landed 2026-08-19) |
| **R5** | Sessions, auth, limits — the `PLAYER` error class for real | R1 | 10 | ✅ (landed 2026-08-19) |
| **R6** | Observability — structured logs, metrics, OTel on `roundId` | R1 | 10 | ✅ |
| **R7** | Production readiness — config validation, load test, deploy | R3, R6 | 10 | ✅ |

**Legend:** ☐ not started · ◐ in progress · ✅ landed (add the date, as `✅ (landed 2026-09-04)`).

---

## Product decisions (locked)

- **The client never decides outcomes.** It presents an outcome the server already committed to.
  `stops[]` from the server is the authority; the shipped paytable is used only to highlight
  paylines and sequence animations, and in dev builds to *assert* the server's grid — never to
  decide. This is ADR-0001 and the thing the README leads with.
- **One game, polished.** One skin, one math model, finished. Three unfinished games read worse than
  one that feels right.
- **Play money only.** No real money, payments, or crypto — a visible 18+/demo notice instead.
- **Money is integer minor units** behind a branded type, end to end, on both sides of the wire.
- **`roundId` is client-generated** and is the idempotency key: a retry after a timeout is provably
  the same round, and the server replays rather than re-spins.
- **Recovery is `pendingRound` on authenticate.** No separate recovery endpoint, no reconciliation
  dance — authenticate tells you what round you were in the middle of.
- **The simulator is the spec.** `rgs-sim` is pure, and the same core serves the dev loop, the HTTP
  path and the RTP report — so the RTP you publish is the RTP you play.
- **The contract suite decides when a target is real.** Not a code review, not a feeling: the same
  suite runs against the in-process sim, the sim over HTTP, and `apps/rgs`.
- **Regulated behaviour is data, not branching.** Jurisdiction presets (a UK preset with 2.5 s
  minimum spin duration, autoplay and turbo disabled) are configuration applied at runtime and
  switchable from the debug panel.
- **Dev affordances never ship.** Debug panel and force-outcome are compile-stripped by Vite defines,
  *and* `forceOutcome` is refused server-side outside dev mode. Two independent gates.
- **60 fps on a mid-range Android is the performance bar**, and the README carries the measured
  numbers, not adjectives.

### Deliberately out of scope

State this in the README — scope discipline is itself a signal.

- Real money, payments, crypto
- Branded clones of real games — IP risk, and it reads as amateur
- Spine runtime — licensing friction; spritesheets are fine
- Custom WebGL shaders — nice, not screened for
- Multiple games
- Server-side rendering, native wrappers, admin back-office

---

## Cross-cutting rules (apply from C0 onward)

- **One error taxonomy, three classes.** `RECOVERABLE` (retry with the same `roundId`, reconnect
  overlay) · `PLAYER` (modal, back to `IDLE`, no retry) · `FATAL` (freeze, error screen, offer
  reload). The client branches on the class, **never on a message string**. Defined once, in
  `packages/protocol/errors.ts`.
- **Validate at the boundary, on both sides.** Every request and response passes the shared zod
  schema — in the client, in the sim, and in the real RGS. A drift is a test failure, not a
  production surprise.
- **Idempotency on every mutating call.** `roundId` in, original response back for a duplicate key.
- **Determinism is enforced, not hoped for.** Seeded PRNG only (no `Math.random()`), injected clocks
  (no ambient `Date.now()`), no I/O in `engine`/`rgs-sim`/`game-math`/`money`. A seed replays a
  session exactly — that is what makes the sim, the math tool and the E2E suite trustworthy.
- **Boundaries are CI-enforced.** `engine` or `rgs-sim` importing Pixi or the DOM fails the build.
- **The ticker allocates nothing.** Pool sprites at boot; no closures, array literals or spreads per
  frame.
- **No secrets in the repository**, ever — placeholders only, and nothing committed with a real
  default.
- **Every block ends demoable and CI-green.** If it can't be shown, it isn't done.

---

# Part I — Client & shared packages (Blocks C0–C8)

The deliverable. Runs against the in-process simulator from C2 onward; the HTTP path is proven by S2
and exercised in CI, so "swap the transport" is demonstrated, not asserted.

## Block C0 — Workspace foundations

_Roughly 2–3 days. Everything downstream assumes this exists._

- [x] pnpm workspace (+ catalog) and Turborepo task graph — `build`/`typecheck`/`test`/`dev`,
      `^build` ordering, caching. Eleven empty `packages/*`; `apps/*` and `tools/*` land with their
      own blocks.
- [x] TypeScript **strict** + `noUncheckedIndexedAccess`, shared `config/tsconfig-base.json` — and
      **no `DOM` lib by default**, opted into via `config/tsconfig-dom.json`.
- [x] ESLint + Prettier + **dependency-boundary rules** (`dependency-cruiser`) encoding the table in
      `CLAUDE.md`, plus the purity rules (no `Math.random()` / ambient time / I/O in the pure four).
- [x] **The rules are tested, not just configured** — `config/fixtures/` + `tests/boundaries.test.ts`
      + `tests/purity.test.ts`: each illegal fixture must be rejected by name, each legal one passed.
- [x] Vitest; Husky + lint-staged.
- [x] GitHub Actions: lint → typecheck → test → rule fixtures → build → format, on push and PR.
- [x] `docs/adr/ADR-0001-server-authoritative-outcomes.md`.
- [x] `CLAUDE.md` Commands table made real, with the not-yet-existing commands marked by block.

**Done when:** `pnpm check` is green on a fresh clone and CI passes. ✅ green locally 2026-08-16;
CI is green once the repository has a remote.

## Block C1 — Protocol, money & math

_3–4 days. Write this before any rendering. Everything else is downstream of it._

- [x] **The open protocol questions are closed** (2026-08-16) — the settle call, the free-spin /
      feature contract, balance refresh outside a spin, where the session token comes from, the
      `Ws` transport, and the persistence schema version. Every answer, with its rejected
      alternative, is in [`docs/protocol.md`](docs/protocol.md) §11.
- [x] `packages/protocol`: zod schemas + inferred types for authenticate / spin / featureSpin /
      settle, `GameConfig`, `RoundState`, `PendingRound`, `RoundResult`, `Feature`, and the
      three-class error taxonomy — implementing the contract `docs/protocol.md` pins.
- [x] `PERSISTENCE_SCHEMA_VERSION` + the `PersistedEnvelope<T>` shape exported from `protocol`
      (moved here from C5: S0's storage adapter writes the envelope long before C5 exists).
- [x] `packages/money`: branded `Minor`, exact arithmetic, `Intl.NumberFormat` display formatting —
      and [ADR-0002](docs/adr/ADR-0002-integer-minor-units.md) for where the brand lives.
- [x] `packages/game-math`: reel strips + paytable **as data**, 20-line payline evaluator as pure
      functions, table-driven tests, `MATH_VERSION`.
- [x] `docs/protocol.md` — the wire contract, the `roundId` idempotency rule, why `stops` is
      authoritative and `view` derived, and the `pendingRound` recovery story. Keep it in step with
      the schemas as C1 implements them.

**Done when:** a golden-file test asserts evaluator output for ~30 handcrafted grids, and the
protocol schemas are importable by both a client and a server target. ✅ 2026-08-17 — 30 grids in
`game-math/src/__fixtures__/golden.json`, 145 tests green. The schemas are consumed by two packages
today and carry no workspace dependencies; the *server* half of that claim is proven by S2, where
`apps/mock-rgs` and `HttpTransport` validate against the same schemas on opposite ends of a socket,
and the *client* half lands with C3.

## Block C2 — Engine & transport

_4–5 days. The part reviewers actually read. Gates on **S1** for something to talk to._

- [x] `packages/engine`: the round FSM as an exhaustive discriminated union, total `switch`, typed
      events out. **Zero Pixi imports.**
- [x] Input validation against current state — a spin press during `WIN_PRESENTATION` is a `SKIP`,
      not a queued spin. An input a phase cannot service emits `INPUT_REJECTED` rather than
      vanishing.
- [x] The **interruption contract as data** (slam stop · skip presentation · skip feature intro):
      the engine decides legality, the renderer will implement completion. Skipping and completing
      are asserted to produce an identical state.
- [x] `packages/transport`: `RgsTransport` interface, `MockTransport`, timeout + exponential-backoff
      retry reusing the same `roundId`, failures mapped onto the error taxonomy. `HttpTransport` was
      left to S2, where there is a server to point it at — it landed there.
- [x] Resume: reconstruct engine state from `pendingRound` — the same machine, entered halfway.
- [x] Free-spin sequencing incl. retrigger arithmetic — forwarded, never recomputed.
- [x] Tests: every legal transition and rejection of every illegal one (a phase × input table) ·
      retry with an identical `roundId` produces exactly one debit · resume from each persistable
      state · skip during every animatable state leaves consistent final state.

**Done when:** a headless Vitest run plays **1,000 seeded rounds** including features, retries and
disconnects with no state violations — and no canvas anywhere in sight. ✅
[`tests/soak.test.ts`](tests/soak.test.ts) does it twice: once clean, once through a connection that
drops 5% of responses *after* the server acted and fails wallets on top. Every observed phase change
is checked against a legal-transition table, and the money balances to the minor unit both times.
405 tests across the workspace.

## Block C3 — Reels on screen

_5–6 days._

- [x] Pixi bootstrap in `apps/game-client` (Vite), texture atlas, loading state — DOM rather than
      canvas, because it covers the window before Pixi, the atlas or the session exist.
- [x] `packages/renderer`: reel controller, **symbol object pool** allocated at boot
      (`reels × (rows + 2)`), rectangle mask (not a filter).
- [x] The five-stage spin curve — anticipation dip → acceleration → constant velocity →
      deceleration → **overshoot and settle**. Delta-time driven throughout, pure, and tested:
      every stop on the strip is landed exactly, at three frame rates.
- [x] Staggered reel stops (140 ms) + **scatter anticipation** when the landed reels could still
      complete a trigger.
- [x] Motion blur by swapping a pre-rendered smeared texture above a velocity threshold — **not** a
      `BlurFilter`.
- [x] `packages/ui`: spin button, bet selector, balance/win HUD — driven by a view model, never by
      an engine.
- [x] Wire to engine events; the renderer subscribes and sends back only the two facts it owns
      (`REELS_STOPPED`, and the presentation stubs C4 replaces).
- [x] The art licensing question, answered by removing it: **the atlas is generated at boot**, so the
      repository ships no image and licenses nothing.

**Done when:** it spins, stops exactly on the server's `stops[]`, and holds 60 fps on a throttled
mobile profile. ✅ — landing is asserted stop by stop in `curve.test.ts`, the drawn grid is
compared against the server's view on every spin (`__ASSERT_MATH__`), and the fps claim is measured
since C7: `pnpm perf` reports ~120 fps average at a 4× CPU throttle (p95 9.2 ms, one dropped frame
in 3,888) against the production bundle in headless Chrome.

## Block C4 — Win presentation & interruptibility

_4–5 days._

- [x] Payline highlighting + per-symbol emphasis, sequenced from the server's `wins[]` — a line for a
      line win, rings only for a scatter, and a per-win cycle with a *budget* rather than a fixed
      duration, so a twenty-line max win is a rhythm and not a slideshow.
- [x] Tiered big-win counter (Nice 5× / Big 15× / Mega 50×, as multiples of the stake) with a rolling
      count-up. One counter drives both the banner and the HUD.
- [x] Turbo mode — one factor, applied to the spin curve and the presentation together, leaving
      speed, overshoot and the blur threshold alone.
- [x] **Slam stop** and **skip-anything**: the presentation is a `Timeline` whose `complete()` runs
      every remaining step to its end, so a skip lands the counter on the final number and clears
      every highlight. Asserted as a trace comparison, not as a screenshot.
- [x] Dev-build assertion: re-evaluate the server's `view` with the local paytable and scream on a
      mismatch (`__ASSERT_MATH__`) — plus the forced-outcome hook that makes a max win reachable on
      demand instead of by luck.

**Done when:** you can mash the spin button through an entire max-win presentation and the balance is
still exactly correct. ✅ [`tests/mash.test.ts`](tests/mash.test.ts) does exactly that, 120 rounds of
random pressing through the real engine, transport, simulator and renderer, asserting the client's
balance equals the server's after every round.

## Block C5 — Features & resume

_3–4 days._

- [x] Free spins with retrigger; feature intro and outro screens; a feature-specific treatment for
      the reel area (border, counter, cumulative win). **Music is C6's** — there is no audio layer
      yet, and saying so is more useful than pretending the screen carries the mood alone.
- [x] Feature state restored from `pendingRound` — which means *not* persisted client-side. The
      server's round is the authority; the client keeps nothing that could disagree with it, and
      `GameStage.attach` catches the renderer up with a round that resumed before it existed.
- [x] Client preferences (stake, turbo) written through `protocol`'s `PersistedEnvelope`, with the
      test that a `v` mismatch, corrupt JSON or a drifted shape **discards** rather than
      best-effort parses — plus a remembered stake that is no longer on the server's ladder being
      dropped rather than sent.

**Done when:** a hard refresh at five arbitrary points mid-feature resumes correctly every time. ✅
[`tests/resume.test.ts`](tests/resume.test.ts) does exactly that — during the intro, while a free
spin is landing, between spins, deep into the feature, and during the outro before the credit — by
destroying the client and rebuilding it over a store that survives, then asserting the round finishes
and is credited exactly once.

## Block C6 — Platform layer

_4–5 days._

_The scope below grew on 2026-08-19, when every open gap was given a decided solution — the
rationale for each line lives in CLAUDE.md's gaps registry._

- [x] Responsive portrait + landscape with safe-area insets — one letterbox over a vertical stack,
      with `readSafeAreaInsets` re-read on every resize because a rotated phone moves its notch.
- [x] `packages/platform`: audio **synthesized at boot with WebAudio** (the atlas decision applied
      to sound — no binary, no licence), iOS unlock-on-first-tap, mute on `visibilitychange`,
      storage that cannot throw, device capability detection. Every module takes its browser object
      as an argument, so the whole package tests headless in Node.
- [x] i18n (en/ru) with currency-aware formatting — the face is **Inter** (OFL, via
      `@fontsource/inter`, latin + cyrillic subsets) and coverage is a build-time test: `fontkit`
      walks every character of both catalogues against the shipped woff2 at every shipped weight.
- [x] `packages/compliance`: reality check, session/loss/stake limits, and the **UK preset**
      (2.5 s minimum spin, autoplay and turbo disabled) — but the preset table lives in
      `@slot/protocol` and the *rules travel on the wire* (`GameConfig.jurisdictionRules`, D8): the
      plan's client-side preset table would have made the client the authority on what a regulator
      requires, and the plan was wrong.
- [x] **Autoplay**: a controller above the engine that presses on `IDLE` and stops on spin count /
      single-win limit / loss limit / feature trigger. The engine is untouched — it cannot tell an
      autoplay press from a player's, which was the point.
- [x] **The sim's half of jurisdiction**: a spin arriving before `minSpinIntervalMs` is refused
      (`LIMIT_REACHED`), measured between accepted spins so idempotent replays are exempt. "Refuse
      turbo" resolved to its enforceable half: turbo is presentation a server cannot observe, and
      its only server-visible effect *is* cadence — pinned in docs/protocol.md §2.1.
- [x] **Session expiry mid-round**: expiry is checked on **every** call (the producer), and
      `SESSION_EXPIRED` under an open round re-authenticates transparently through the lobby seam
      and resumes from `pendingRound` — a new `REAUTHENTICATING` phase, one attempt per failure.
      Protocol §5/D9 first, then the sim, then the engine, proved end-to-end in
      `tests/wiring.test.ts` against a session killed mid-feature.
- [x] **Keyboard + contrast**: a DOM control layer driven by the same `PanelView` (real buttons,
      visible on `:focus-visible`), and a WCAG-AA contrast suite over both palettes in CI — which
      failed on its first run: SCAT and H3 carried white glyphs at 1.98:1 and 2.26:1, and their
      fills are darker for it.

**Done when:** switching jurisdiction visibly changes game behaviour, autoplay stops itself at its
limits, and the RU build renders in the intended typeface. ✅ — with one honest asterisk: the
jurisdiction switch is a server-config change today (`createSimConfig({ jurisdiction: 'UK' })`), and
the debug-panel toggle that flips it live is C7's, where the panel itself lands. Autoplay's stops
and the UK pacing are asserted in `autoplay.test.ts` and `policy.test.ts`; the RU typeface is
enforced by the glyph-coverage test rather than promised.

## Block C7 — Dev tools & performance

_3–4 days._

- [x] `packages/dev-tools`: debug panel — force outcome, fault injection, jurisdiction switch, state
      inspector, exportable event log correlated on `roundId`.
- [x] **Round-history panel** beside it, in the same DOM frame: the `history` response, listed
      verbatim, with `retention` stated honestly (decided 2026-08-19 — a history is a document, so
      it is DOM, not canvas).
- [x] Stripped from production by `__DEV_TOOLS__`; **verify the strip in the built bundle**.
- [x] `tools/perf-harness`: scripted fps/memory capture on a throttled profile.
- [x] Performance pass against the rules in `CLAUDE.md` — draw calls, allocation in the ticker, atlas
      batching. Capture the trace.

**Done when:** the perf harness prints fps/draw-calls/heap for a scripted session, and a production
build contains no debug-panel code. ✅ — `pnpm perf` played 30 rounds against the production bundle
at a 4× CPU throttle and printed ~120 fps average (p95 9.2 ms), **7 draw calls a frame** (max 8 —
the symbol layer batches, as the atlas rules promised) and a heap that sawtooths 9.8 → 14.1 → 9.4 MB
(no climb, so nothing allocates per frame), with the Chrome trace saved beside it. The strip is a
gate, not a hope: `verify:strip` runs inside `pnpm check`, proves five dev-surface markers still
exist at their sources, and fails the build if any reaches `dist/` — it caught the panel's CSS
sitting in the shell's `index.html` on its first run, which is why the styles now live in
`@slot/dev-tools` and are injected by the same stripped branch that builds the panel.

## Block C8 — Packaging & release

_2–3 days._

- [x] **Same-origin, built and recorded (ADR-0010):** `MOCK_RGS_STATIC_DIR` mounts the built
      client on the game API's origin via flag-gated `@fastify/static`, CORS never widens, and
      `apps/mock-rgs/Dockerfile` — the server plus the client's demo build, `/ready`-gated — is
      the deployable unit, built by CI. The host is Render's free tier (`render.yaml`, 2026-09-26:
      no card, the Dockerfile as-is, `PORT` obeyed). Still owed: connecting the Blueprint and the
      live URL.
- [x] `@fastify/rate-limit` with a per-IP budget (`MOCK_RGS_RATE_LIMIT_MAX`, healthchecks exempt,
      `trustProxy` for platform proxies) — refusing as `RATE_LIMITED` + `retryAfterMs`, the
      taxonomy's shape, with tests pinning it.
- [x] **A simulator per visitor** (ADR-0011, 2026-09-26): the public demo's lobby begins each
      visitor's own `SimServer` and every call reaches the one its token names — bounded, idle
      visitors forgotten, `/dev/*` scoped to the caller — while `rgs-sim` stays single-session.
      The client remembers its token per tab, so a reload still resumes; E2E plays two visitors
      at once on the deployed composition.
- [x] A **nightly soak** job (`nightly.yml`, 03:17 UTC + on demand): the existing `http-soak`
      with `SOAK_ROUNDS=5000` under `--expose-gc`, where the heap-trend case arms itself; the PR
      gate keeps 300.
- [x] Playwright E2E in CI (`pnpm e2e`, `tests/e2e/`, its own job): forced outcomes against the
      demo composition — a dead spin, a feature paid through the presentation, a reload
      mid-feature that resumes and credits exactly once. Keyboard-driven through the DOM panel;
      the money asserted against both the engine and `/dev/state`.
- [x] README to the structure in the appendix below — the GIF slot and live-demo line carry
      marked placeholders until the deploy; the docker one-liner is the demo meanwhile.
- [x] `docs/architecture.md` + `docs/round-lifecycle.md`, written at C8 with mermaid diagrams —
      the system, the seam, the round's life and every failure path.

**Done when:** a stranger can open the live link, force a max win from the debug panel, and read why
the client can't cheat — in under two minutes.

## Client build order

**C0 → C1 → (S0 · S1 in parallel) → C2 → C3 → C4 → C5 → C6 → C7 → C8.** C6 can overlap C5 — it
touches no engine state. C8 needs the RTP table from S4.

---

# Part II — Simulator & contracts (Blocks S0–S4)

The mock RGS. Pure core, thin wrappers — which is what lets one outcome engine serve the dev loop,
the HTTP path and the 50-million-spin RTP report at once.

## Block S0 — `rgs-sim` pure core

- [x] Pure shape: `(state, request) → (state, response)`. No HTTP, no fs, no ambient time.
- [x] **Seeded PRNG** — xoshiro128\*\*, with rejection sampling so the stop draw carries no modulo
      bias. Spin seeds are derived from `(serverSeed, roundId, clientSeed, step)`, never stored.
- [x] Server-side round machine `OPEN → RESOLVED → SETTLED`, persisted.
- [x] **Idempotency store keyed on `roundId`** — duplicate key replays the original response;
      a duplicate with different parameters is `ROUND_CONFLICT`.
- [x] Persistence adapter interface with two implementations: in-memory (Node) and web-storage
      (browser), so a page reload genuinely resumes — the storage object is injected, never reached
      for ([ADR-0003](docs/adr/ADR-0003-injected-persistence-port.md)).
- [x] Stake validation against `GameConfig` bet levels/limits, and max-win capping — so the `PLAYER`
      error class has a real producer.

**Done when:** two runs from the same seed produce byte-identical round sequences, and a replayed
`roundId` never debits twice. ✅ Both are tests (`replay.test.ts`), alongside a 200-round soak that
checks every minor unit is accounted for and a run with every call sent twice. 106 tests in the
package; 251 across the workspace.

## Block S1 — Fault injection & force outcome

- [x] Runtime-toggleable fault injection: fixed/jittered latency, per-code error rates, a dropped
      response (the server did the work, the answer vanished) and a slow-response rate. Seeded, so a
      faulty session replays down to which call failed.
- [x] Force outcome: the named scenarios — `NEAR_MISS`, `FREE_SPINS_TRIGGER`, `MAX_WIN`,
      `DEAD_SPIN` — each found on the real strips rather than hard-coded, so an S4 re-tune cannot
      strand them.
- [x] **Server-side dev-mode gate on `forceOutcome`** — landed with S0, along with the test that a
      production-mode server refuses a hand-crafted request carrying the field, and the one that
      proves the refusal comes *before* any other validation. The stripped client can no longer send
      it, which is exactly why nothing else would catch a regression there.
- [x] `MockTransport` wired so `apps/game-client` can run against the sim in-process at zero
      latency — driving an injected `InProcessBackend`, because `transport` may only depend on
      `protocol`. `tests/wiring.test.ts` stands in for the client until C3 builds it.

**Done when:** the client can be made to fail, hang and disconnect on demand, and each path lands in
the right error class. ✅ All three, through the real seam — including a lost response recovered by
re-authenticating and retrying the same `roundId` for one debit. 317 tests across the workspace.

_Left to C2, which owns the policy side of the seam: timeout, exponential-backoff retry, and the
mapping of raw network failures onto the taxonomy. Until it lands, a non-zero `dropRate` hangs any
caller that is not racing its own timer._

## Block S2 — `apps/mock-rgs`

- [x] Fastify wrapper over `rgs-sim`; routes generated from the `CALLS` table, every request
      validated with the shared `@slot/protocol` schema, the error taxonomy given HTTP statuses
      (ADR-0004, docs/protocol.md §2.6).
- [x] Correlation ID per request (`x-correlation-id`), adopted from the client or minted, echoed on
      every response and logged (pino, via Fastify) beside the simulator's own replayable id.
- [x] Health/readiness endpoints; `/dev/*` fault injection, session reset and state summary for the
      debug panel; `POST /demo/session` standing in for the operator lobby (§7).
- [x] `HttpTransport` in `@slot/transport` — response validation, failure classification,
      `Retry-After`, and a real abort when the retry policy's clock runs out.
- [x] Faults enacted on a real connection, including a **dropped response as a hijacked socket** —
      the round happened, the answer never arrives, the client's timeout ends the wait.

**Done when:** the client runs identically against `MockTransport` and `HttpTransport` — same
behaviour, different latency. ✅ [`tests/http.test.ts`](tests/http.test.ts) plays one round through
each, against identically seeded simulators, and asserts the responses are equal field for field.

## Block S3 — The contract suite

_The gate everything else references. Landed **2026-08-18**._

- [x] One suite, three targets: `rgs-sim` in-process · sim over HTTP (`apps/mock-rgs`) · `apps/rgs`.
      `tests/contract/targets.ts` is the registry; `suite.ts` names no server implementation;
      `contract.test.ts` is a `for` loop.
- [x] Covers the full round lifecycle, idempotent replay, resume via `pendingRound`, every error
      class, and stake/limit rejection. 25 cases per target, run in CI by `pnpm test:contract`.
- [x] Runs in CI against the first two targets; the third is **documented in the run itself** — it
      is registered with an `unavailable` reason and prints as a named skip, because a suite that
      silently covers two targets while claiming three is worse than one that shows the hole.

**Landed ahead of R0**, which the gate below depends on. At the time `apps/rgs` did not exist, so
the third target could only be absent-by-name; **R0 turned it red** on 2026-08-19 — the target now
runs, and the suite's red gate holds it to `NOT_IMPLEMENTED`-only as a green assertion.

**Done when:** `pnpm test:contract` passes against both sim targets and fails against `apps/rgs`
with `NotImplemented` only — no other kind of failure. _(Both halves hold since R0: the second is
enforced as the red gate, so "fails with `NotImplemented` only" is itself what CI asserts.)_

## Block S4 — `tools/math-sim`

- [x] Headless CLI importing `rgs-sim` — the same outcome engine the game plays on, over
      `game-math`'s strips, paytable and award table. A *round* is the unit: one stake buys the base
      spin and every free spin it leads to.
- [x] Reports RTP (split base / feature), hit frequency, volatility, max win, spins per trigger,
      longest feature, and the win-size distribution — with the design targets printed beside the
      results and a non-zero exit when a row is out of band.
- [x] Reel strips and paytable tuned until RTP converges on the designed figure: **96.107% over
      20,000,000 rounds**, `MATH_VERSION` 2.0.0.

**Done when:** the report prints and RTP converges within tolerance of the design target — and the
table goes in the README. ✅ for the measurement (the table is in `CLAUDE.md` until the README exists
at C8). The headline run is `--spins 20000000` at about 72 seconds; fifty million is the same command
with a bigger number and no new information — the sampling error is already ±0.07pp at twenty.

**What it found, which is the point of running it:** the untuned strips returned **125%** and
triggered the feature every fifteenth round, and because a free spin retriggers on the same three
scatters, the feature was a supercritical branching process — 155 free spins on some seeds. Seven
scatters instead of fifteen, and a paytable scaled to match, bring it back to a designed 96% with a
feature that converges.

## Simulator build order

**S0 → S1 → S2 → S3 → S4.** S0/S1 gate C2 (the client needs something to talk to); S3 additionally
needs R0 to exist as a target; S4 can land any time after S0 but is needed by C8.

---

# Part III — The real Node RGS (Blocks R0–R7)

`apps/rgs` is created **now, empty**, and filled in later. The point is that the seam is real: the
client requires **zero changes** — flip the transport URL. Each R-block turns part of the contract
suite from expected-red to green.

Stack: Fastify + zod (the same `@slot/protocol` schemas), PostgreSQL for rounds and the ledger, Redis
for sessions and idempotency, pino + OpenTelemetry for observability.

## Block R0 — Skeleton & the wallet seam

_Landed **2026-08-19**._

- [x] `apps/rgs/src/` laid out as `http` · `domain` · `wallet` · `ledger` · `math` · `rng` ·
      `persistence` · `observability`.
- [x] Every route validates with the shared schema, then throws `NotImplementedError`.
- [x] `WalletProvider` interface (`getBalance` / `debit` / `credit` / `rollback`) + `MockWallet` —
      the operator↔provider seam every real RGS has. The mock's semantics are tested as the
      specification R2 inherits: idempotency on ref, replay vs. conflict, the reversible debit.
- [x] `RoundRepository` / `IdempotencyRepository` / `ServerSeedProvider` interfaces declared.
- [x] Wired into the contract suite as a third target — the `unavailable` entry replaced with a
      running one marked `expectedRed`, and the suite's **red gate** asserts the expectation in
      green CI: every call refused as `NOT_IMPLEMENTED` and nothing else, with malformed requests
      still `SCHEMA_MISMATCH` — so the refusal provably means "not built", never "not understood".

**Done when:** the contract suite runs against `apps/rgs` and every failure is `NotImplemented`. ✅
— and making that assertable took a protocol amendment (D10): `NOT_IMPLEMENTED` joined the taxonomy
as a `FATAL` code with status `501`, and `STATUS_OF_CODE` moved from `apps/mock-rgs` into
`@slot/protocol`, because two servers implementing one status binding is two copies of a table that
must agree exactly.

## Block R1 — Rounds & idempotency on Postgres

_Landed **2026-08-19**._

- [x] Round table + state machine `OPEN → RESOLVED → SETTLED`, with the transition guarded in a
      transaction — a compare-and-swap `UPDATE … WHERE state = $from`, in the same transaction as
      the idempotency insert, behind a `RoundStore` port with an in-memory twin. One shared
      store-contract suite holds both implementations to identical semantics; the Postgres half
      runs whenever `RGS_TEST_DATABASE_URL` is set — always in CI, via a service container.
- [x] Idempotency records keyed on `(roundId, call, step)`, with the original response replayed on
      a duplicate — **a uniqueness constraint, not a remembering service**: the primary key makes
      a duplicate insert *fail*, and that failure routes a racing retry to the recorded answer.
- [x] Committed migrations (`apps/rgs/migrations/`, a ~40-line runner); indexes on the lookup
      paths (`round_id` PK, partial indexes on player + state for recovery and history).
- [x] Resume: `authenticate` returns `pendingRound` from the store — including the stranded shape
      only this server can produce (debited, never resolved: `OPEN`, no `result`, and no `next`,
      a protocol refinement made for it in §2.6).

**Done when:** the authenticate/spin contract tests go green against `apps/rgs`, including the
replay and resume cases. ✅ — and in practice the *whole* suite went green at once, because a
natural feature trigger during any hunt exercises `featureSpin` and `settle` too; only the
`forceOutcome`/`faultInjection` cases remain, as named capability skips a production server earns.
Two things came with the block: the outcome engine (PRNG + stops-first derivation) moved from
`rgs-sim` into `@slot/game-math` so both servers draw from one implementation (`apps/rgs` may not
import the simulator — `rgs-deps`), and `TargetHandle.strand()` got its real implementation, so
the §5 stranded-round case runs against the one target that can honestly produce it.

## Block R2 — Wallet integration

_Landed **2026-08-19**._

- [x] A real `WalletProvider` implementation behind the R0 interface, with timeouts, bounded
      retries and a **rollback path** for a debit whose round never resolved. `RemoteWallet`
      speaks [`docs/wallet-api.md`](docs/wallet-api.md) — a wire pinned for the block, deliberately
      outside `@slot/protocol` (the wallet is the operator's *platform* contract, not the game
      team's): per-attempt `AbortSignal` deadlines, bounded retries only for unavailability (safe
      because every mutation is idempotent on its ref), refusals surfaced once and never retried.
      The wallet sim serves the same contract over a socket with the §4 failure model injectable —
      refused-before-executing vs. executed-with-the-confirmation-lost, the simulator's FAIL/DROP
      distinction applied to money.
- [x] Failure isolation: a wallet outage produces a `RECOVERABLE` error, never a lost round — a
      credit outage leaves the round `RESOLVED` and the later settle credits exactly once.

**Done when:** a wallet failure injected mid-round leaves no orphaned debit, proven by test. ✅ —
three tests, one per shape: a lost debit confirmation is healed by replaying the ref; an outage
moves nothing and the retry that outlives it starts fresh; and the one confirmed-debit-no-round
state (the store refused the `open`) rolls the debit back, which forced the wire's one non-obvious
rule — **a rolled-back ref is debitable again, as a fresh transaction** — so the client's
same-`roundId` retry converges to exactly one standing debit. The contract suite's third target
now runs the full production chain (client→HTTP→rgs→HTTP→wallet), and its `faultInjection`
capability turned honestly true: `WALLET_UNAVAILABLE` is demanded by refusing the real wallet.

## Block R3 — Double-entry ledger

_Landed **2026-08-19**._

- [x] Append-only, double-entry, **integer minor units**, one entry pair per money movement. Two
      implementations behind one `Ledger` port — in-memory and Postgres, held to one shared
      contract suite exactly as the round store is — with append-only *enforced* on Postgres by a
      trigger, not promised by review. The domain journals after every confirmed wallet movement
      (`STAKE` on debit, `WIN` on credit, `ROLLBACK` on a delivered reversal), and `record`'s
      idempotency mirrors the wallet's, movement for movement: a standing stake replays, a
      rolled-back ref is stakeable again, a win happens once per ref — so every retry path reports
      its movement unconditionally and one movement is one entry (ADR-0005).
- [x] Every round's debit and credit reconcilable from the ledger alone — `entriesFor(roundId)`,
      with the stake journaled *before* the round opens and no foreign key to `rounds`, because
      the debit-with-no-round state is the orphan the scan below exists to find.
- [x] A reconciliation job that trues the ledger against the wallet and reports drift —
      `reconcile()`: per-player balance truing against a caller-supplied opening (windowed by
      `since`), plus a whole-journal orphan scan that catches the state balance-truing cannot see
      (the wallet and the ledger *agree* on an orphan). Run on an interval by `main.ts`
      (`RGS_RECONCILE_INTERVAL_MS`), reported through the app log.

**Done when:** a scripted session's ledger sums to zero and reproduces the exact balance history.
✅ — `ledger/session.test.ts` plays dead rounds, a settled win, a full feature and an
aborted-then-retried spin through the real domain, then retells the whole session from the journal
alone: the accounts cancel, folding the player legs from the opening balance reproduces every
balance the wire reported in order, the house's take is stakes − rollbacks − wins, and
`reconcile()` answers clean. The companion case loses the rollback on purpose: the orphaned stake
is reported at zero drift, and the client's same-`roundId` retry heals the journal without a
correction ever being written.

## Block R4 — Server RNG & provable fairness

_Landed **2026-08-19**._

- [x] `ServerSeedProvider` backed by a CSPRNG — rebuilt as a commitment chain: one pair per round
      (32 bytes of entropy and its SHA-256), minted from injected `RandomBytes` (`main.ts` hands
      in `node:crypto`; tests hand in a seeded stream and stay deterministic). `RGS_SERVER_SEED`
      is gone — there is nothing to configure and nothing to leak.
- [x] Seed **commit on authenticate, reveal on settle**, with the client able to verify the round
      — as built: the commitment on offer travels on `authenticate` and on every closing
      response's `next`; the spin binds it at `open` (persisted on the round row, so a restart
      resolves and reveals the same round, and `pendingRound.fairness` re-reports the binding);
      the reveal rides the response that *closes* the round — `settle`, or `spin` itself for an
      atomically-settled dead round, because nobody is required to settle nothing (§9, D11,
      ADR-0006). The verification toolkit ships in `@slot/game-math` (`sha256Hex` held to NIST
      vectors, `stopsForStep`) — client-runnable by construction; the client *calling* it is a
      logged gap, not a shipped button.
- [x] Documented verification procedure in `docs/` — [`docs/fairness.md`](docs/fairness.md), a
      procedure with an executable twin: the gate test runs exactly what the page describes.

**Done when:** a player can independently recompute a round's `stops[]` from the revealed seed and
their client seed. ✅ — `apps/rgs/src/rng/fairness.test.ts`: the "player" holds only wire data and
`@slot/game-math`, and verifies the hash, the chain's continuity, every step of dead, won and
feature rounds, idempotent reveals on duplicate settles, and the stranded round's binding across
resume. The contract suite repeats the procedure over the full production chain as the
`provableFairness` capability — true only for `apps/rgs`, because a server that honours
`forceOutcome` cannot commit to outcomes, and the simulators skip the cases by name.

## Block R5 — Sessions, auth & limits

- [x] Token validation and session store, with expiry producing the `PLAYER` error class — as
      built: the session binds every non-authenticate call via an `Authorization: Bearer` header
      (§2.7, D12), carried by `HttpTransport` itself so nothing above the transport learns HTTP
      has headers; `SessionStore` has memory and Postgres twins (`migrations/0004_sessions.sql`)
      held to one contract, **Postgres rather than the planned Redis** — one database until scale
      demands two (ADR-0007), and the port is where Redis goes if it ever does. Tokens are minted
      server-side from injected entropy (the R4 arrangement, reused) through
      `POST /operator/sessions` — the lobby's face, key-guarded, outside the game contract (§7) —
      and the demo token still self-issues at boot through the same service.
- [x] Stake/bet-limit and max-win enforcement **server-side** — already real since R1
      (`STAKE_NOT_ALLOWED`, `INSUFFICIENT_FUNDS`, the accrued ceiling) and asserted by the suite;
      R5's addition is that the caller behind every stake is now *identified*.
- [x] Rate limiting per session and per IP on the spin path — a token bucket per axis (injected
      clock, hand-rolled and unit-tested), refusing as `RATE_LIMITED` with `retryAfterMs` in the
      body and `Retry-After` on the wire; budgets from the environment, absent in test
      compositions by design (the suite hammers on purpose).
- [x] **Jurisdiction policy enforced server-side** — the rules a server can *observe* (D8):
      `minSpinIntervalMs` refuses an early spin with `LIMIT_REACHED`, measured between accepted
      spins off the store's own `lastOpenedAt`, replay-exempt, free spins unpaced (§2.1) — the
      same semantics the sim has enforced since C6. Autoplay, turbo and the reality check remain
      the client compliance layer's by D8's own doctrine: a server cannot see them, and the
      operator-configured full rule set is a later block's.

**Done when:** every `PLAYER`-class contract test goes green against `apps/rgs`. ✅ — all four
`PLAYER` codes now have suite cases running against the production chain: `SESSION_EXPIRED`
(a refused foreign token, and mid-round expiry → renewal through the lobby seam → `pendingRound`
resume credited exactly once), `STAKE_NOT_ALLOWED`, `INSUFFICIENT_FUNDS`, and `LIMIT_REACHED`
(the pacing refusal, with the idempotent replay proven exempt) — the latter two describes running
against **all three targets**, because the sims already enforced what `apps/rgs` now does.

## Block R6 — Observability

- [x] Structured logs (pino) with a correlation ID **and `roundId` on every line** — one access
      line per answered game call (call, `roundId`, duration), one enriched line per refusal
      (code, class, `roundId`); Fastify's own request lines are off because ours say more. The
      domain speaks through the `RgsObserver` port (ADR-0008): the two money-side failures
      ADR-0005 swallows by design — the undeliverable rollback, the lost ledger entry — are now
      `error`-level events **at the failure site**, `roundId` and correlation id attached.
- [x] OpenTelemetry traces — `@opentelemetry/api` as the seam (the injected-shape pattern,
      industry-maintained), one SERVER span per call, `tracedWallet` decorating the provider with
      nested CLIENT spans, `rgs.round_id` on every span; the SDK + OTLP exporter register in
      `main.ts` only when `OTEL_EXPORTER_OTLP_ENDPOINT` names a collector.
- [x] Metrics — hand-rolled registry (the R5 token-bucket argument), Prometheus text on
      `GET /metrics`: `rgs_call_duration_seconds{call}`, `rgs_errors_total{call,code,class}`,
      `rgs_calls_total`, `rgs_money_write_failures_total{kind}`, and `rgs_rounds{state}` asked of
      the store at scrape time (`countByState`, both twins, contract-tested) — an `OPEN` count
      that stays high is the stranded-round alarm, and it survives restarts because the store
      answers, not a process-local counter.
- [x] Liveness + readiness — `/health` unchanged; `/ready` runs the composition's named probes
      (the store via its own count query; the wallet **by refusal** — a `WalletError` for the
      probe id proves the wire answers) and turns 503 naming the failing check.

**Done when:** one `roundId` retrieves the full story of a round across logs, traces and metrics.
✅ — [`observability/story.test.ts`](apps/rgs/src/observability/story.test.ts) composes exactly as
`main.ts` does, plays real rounds over the real HTTP binding, and retrieves one round's story
from all three surfaces by its `roundId` alone — then makes the swallowed money-side failures
loud, correlation id intact.

## Block R7 — Production readiness

- [x] Fail-fast env validation at boot; **no dev default accepted in production** — `RGS_ENV` is
      a two-mode contract (ADR-0009): development fills every gap so the dev loop stays
      zero-config; production requires Postgres and a real wallet URL, refuses the placeholder
      operator key and demo token by value, treats an empty string as absence (what compose
      delivers), and names **every** violation in one error. The image defaults to production.
- [x] Containerized build; health-gated rollout; documented rollback — one image, two commands
      (`apps/rgs/Dockerfile`: the RGS, and the wallet sim via `wallet/sim-main.ts`);
      `docker-compose.yml` is the three-process production shape with no secret committed; the
      rollout gate is R6's dependency-probing `/ready` behind a `HEALTHCHECK`; rollback,
      additive-only migrations and the backup procedure are [docs/deploy.md](docs/deploy.md).
      CI builds the image on every push.
- [x] Load test on the spin path — answered twice (ADR-0009). Correctness under races is a CI
      gate: `races-contract.ts` fires identical, conflicting and duplicate calls simultaneously
      over the real binding against both stores — and found two real windows (a wallet
      `REF_CONFLICT` mid-race surfaced as retryable `WALLET_UNAVAILABLE` instead of
      `ROUND_CONFLICT`; a raced settle answered `ILLEGAL_TRANSITION` instead of replaying the
      recorded answer), both fixed in the domain. Throughput is `pnpm load` — hand-rolled honest
      clients, latency percentiles, and a closing-balance check that exits non-zero on drift;
      its first confirmed finding was a lost-update race in its own accounting.
- [x] Backup + restore drill for the round and ledger tables — a CI test in the Postgres suite:
      dump the four tables mid-session (an open round one feature-spin deep), truncate, restore,
      and a fresh composition reports the same pending round, replays the same answers,
      reproduces the ledger to the entry and finishes the feature with the credit arriving
      exactly once. The `pg_dump` twin is documented in deploy.md.

**Done when:** the whole contract suite is green against `apps/rgs`, and the client switches to it by
changing one URL — **no client changes at all**. That is the deliverable's closing argument.
✅ — the suite has been green against `apps/rgs` since R1 and stays so; the client's one missing
seam (a lobby for a server that deliberately has no `/demo/session`) closed as `VITE_RGS_TOKEN`,
the environment standing in for the operator (§7) — so the switch is
`VITE_RGS_TRANSPORT=http`, the proxy target, and a token: configuration, not code. R7 also made
retention real on Postgres (eviction past `retention`, both twins under one contract case) and
moved `GET /metrics` onto its own listener when `RGS_METRICS_PORT` asks (the perimeter split the
R6 gaps note called for).

## RGS build order

**R0 → R1 → (R2 · R4 · R5 in parallel) → R3 → R6 → R7.** R0 lands early — during Part II — because
S3 needs it as a target; everything after it is post-C8 work.

---

# Appendix A — README structure (write it last, plan it now)

1. GIF of a big-win sequence, above the fold
2. Live demo link + "open the debug panel and force a max win"
3. One-paragraph thesis: server-authoritative client, and why that is the correct architecture
4. Architecture diagram + the transport seam
5. Round lifecycle diagram
6. RTP simulation table (spins, RTP, hit frequency, volatility, max win)
7. Performance: device, fps, draw calls, heap
8. Testing: unit / contract / E2E counts and what each covers
9. Monorepo tour, one line per package
10. Roadmap: "Node.js RGS — skeleton and contract tests already in place"
11. Asset licensing + attribution, and the 18+/demo notice

# Appendix B — What this project buys you in an interview

| They ask | You have |
| --- | --- |
| "How do you stop a client from cheating?" | The seam, the dev-build assertion, and why `stops[]` is authoritative |
| "What happens if the network drops mid-spin?" | `roundId` idempotency, `pendingRound` resume, the backoff policy — and a live demo of it |
| "How do you keep 60 fps on low-end Android?" | Pooling, atlas batching, blur-texture swap, zero-alloc ticker — with measured numbers |
| "Have you worked with regulated markets?" | Jurisdiction config as data, the UK spin-duration rule, reality check, limits |
| "How would you test a slot?" | Seeded determinism, force outcomes, headless engine tests, Playwright on fixed seeds |
| "Do you understand game math?" | RTP simulation, volatility index, reel strips as data |
| "Could this scale to a real backend?" | `apps/rgs` exists, the contract suite already runs against it, and the client needs no changes |

# Appendix C — First three commits

1. `chore: scaffold pnpm + turbo workspace with strict TS and CI`
2. `feat(protocol): round contracts, error taxonomy, branded Minor units`
3. `docs(adr): ADR-0001 server-authoritative outcome model`

**Start with the protocol. Everything else is downstream of it.**
