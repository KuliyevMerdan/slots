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
quietly lacks). 683 tests green — including the work the S3 review surfaced as unowned: the
math-version gate, the max-win ceiling as a multiple of the stake, the telemetry seam,
`prefers-reduced-motion` with an announced region, the `history` call, and the network soak that
found a shutdown hang in `apps/mock-rgs`.

**Next is C6** — the platform layer: responsive layout, audio, i18n and the compliance presets. It is
also where the feature stops being silent. **R0** — the `apps/rgs` skeleton — can run in parallel,
and is what turns the contract suite's third target from a named skip into an expected-red one.

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
| **C6** | Platform layer — responsive, audio, i18n, compliance | C4 | 7 | ☐ |
| **C7** | Dev tools + performance pass | C5, S1 | 8 | ☐ |
| **C8** | Packaging — deploy, README, Playwright E2E in CI | C6, C7, S4 | 9 | ☐ |
| **S0** | `rgs-sim` pure core — PRNG, round machine, idempotency, persistence | C1 | 2 | ✅ (landed 2026-08-18) |
| **S1** | Fault injection + force outcome + `MockTransport` | S0 | 2 | ✅ (landed 2026-08-18) |
| **S2** | `apps/mock-rgs` — Fastify wrapper, the real network path | S0 | 2 | ✅ (landed 2026-08-18) |
| **S3** | The contract suite — one suite, three targets. **The switch-over gate** | S2, R0 | 2 | ✅ (landed 2026-08-18, ahead of R0 — see the block) |
| **S4** | `tools/math-sim` — RTP / hit frequency / volatility report | S0 | 8 | ✅ (landed 2026-08-18) |
| **R0** | `apps/rgs` skeleton — routes stubbed, `NotImplemented`, wallet seam | C1 | 2 | ☐ |
| **R1** | Rounds & idempotency on Postgres | R0, S3 | 10 | ☐ |
| **R2** | Wallet integration behind `WalletProvider` | R1 | 10 | ☐ |
| **R3** | Double-entry ledger in integer minor units | R2 | 10 | ☐ |
| **R4** | Server RNG + provably-fair seed commit/reveal | R1 | 10 | ☐ |
| **R5** | Sessions, auth, limits — the `PLAYER` error class for real | R1 | 10 | ☐ |
| **R6** | Observability — structured logs, metrics, OTel on `roundId` | R1 | 10 | ☐ |
| **R7** | Production readiness — config validation, load test, deploy | R3, R6 | 10 | ☐ |

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
mobile profile. ✅ for the first two — landing is asserted stop by stop in `curve.test.ts` and the
drawn grid is compared against the server's view on every spin (`__ASSERT_MATH__`). **The fps claim
is not made yet:** `tools/perf-harness` and the measured numbers are C7, and until then the README
says nothing about frame rate.

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

- [ ] Responsive portrait + landscape with safe-area insets.
- [ ] `packages/platform`: Howler audio sprite, iOS unlock-on-first-tap, mute on `visibilitychange`,
      storage, device capability detection.
- [ ] i18n (en/ru) with currency-aware formatting — **and verify the chosen face actually carries
      Cyrillic** before shipping the RU build.
- [ ] `packages/compliance`: reality check, session/loss/stake limits, and a **UK jurisdiction
      preset** (2.5 s minimum spin, autoplay and turbo disabled), applied at runtime.

**Done when:** switching jurisdiction in the debug panel visibly changes game behaviour, and the RU
build renders in the intended typeface.

## Block C7 — Dev tools & performance

_3–4 days._

- [ ] `packages/dev-tools`: debug panel — force outcome, fault injection, jurisdiction switch, state
      inspector, exportable event log correlated on `roundId`.
- [ ] Stripped from production by `__DEV_TOOLS__`; **verify the strip in the built bundle**.
- [ ] `tools/perf-harness`: scripted fps/memory capture on a throttled profile.
- [ ] Performance pass against the rules in `CLAUDE.md` — draw calls, allocation in the ticker, atlas
      batching. Capture the trace.

**Done when:** the perf harness prints fps/draw-calls/heap for a scripted session, and a production
build contains no debug-panel code.

## Block C8 — Packaging & release

_2–3 days._

- [ ] Deploy the client + `mock-rgs` (Vercel / Fly / Railway), with a health endpoint on the server
      side.
- [ ] Playwright E2E in CI: fixed seed + forced outcomes — spin, win, feature, reload-and-resume.
- [ ] README to the structure in the appendix below, GIF above the fold.
- [ ] `docs/architecture.md` + `docs/round-lifecycle.md` diagrams.

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

**Landed ahead of R0**, which the gate below depends on. `apps/rgs` does not exist yet, so the third
target cannot be expected-red — only absent, and it says so by name. **R0 owns turning it red**; its
own checklist already carries "wired into the contract suite as a third target".

**Done when:** `pnpm test:contract` passes against both sim targets and fails against `apps/rgs`
with `NotImplemented` only — no other kind of failure. _(The first half holds today; the second is
R0's gate.)_

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

- [ ] `apps/rgs/src/` laid out as `http` · `domain` · `wallet` · `ledger` · `math` · `rng` ·
      `persistence` · `observability`.
- [ ] Every route validates with the shared schema, then throws `NotImplementedError`.
- [ ] `WalletProvider` interface (`getBalance` / `debit` / `credit` / `rollback`) + `MockWallet` —
      the operator↔provider seam every real RGS has.
- [ ] `RoundRepository` / `IdempotencyRepository` / `ServerSeedProvider` interfaces declared.
- [ ] Wired into the contract suite as a third target — replace the `unavailable` entry in
      `tests/contract/targets.ts` with a real one (expected-red, documented).

**Done when:** the contract suite runs against `apps/rgs` and every failure is `NotImplemented`.

## Block R1 — Rounds & idempotency on Postgres

- [ ] Round table + state machine `OPEN → RESOLVED → SETTLED`, with the transition guarded in a
      transaction.
- [ ] Idempotency records keyed on `roundId`, with the original response replayed on a duplicate —
      **a uniqueness constraint, not a remembering service**.
- [ ] Committed migrations; indexes on the lookup paths (`roundId`, player + state).
- [ ] Resume: `authenticate` returns `pendingRound` from the store.

**Done when:** the authenticate/spin contract tests go green against `apps/rgs`, including the
replay and resume cases.

## Block R2 — Wallet integration

- [ ] A real `WalletProvider` implementation behind the R0 interface, with timeouts, bounded retries
      and a **rollback path** for a debit whose round never resolved.
- [ ] Failure isolation: a wallet outage produces a `RECOVERABLE` error, never a lost round.

**Done when:** a wallet failure injected mid-round leaves no orphaned debit, proven by test.

## Block R3 — Double-entry ledger

- [ ] Append-only, double-entry, **integer minor units**, one entry pair per money movement.
- [ ] Every round's debit and credit reconcilable from the ledger alone.
- [ ] A reconciliation job that trues the ledger against the wallet and reports drift.

**Done when:** a scripted session's ledger sums to zero and reproduces the exact balance history.

## Block R4 — Server RNG & provable fairness

- [ ] `ServerSeedProvider` backed by a CSPRNG.
- [ ] Seed **commit on authenticate, reveal on settle**, with the client able to verify the round.
- [ ] Documented verification procedure in `docs/`.

**Done when:** a player can independently recompute a round's `stops[]` from the revealed seed and
their client seed.

## Block R5 — Sessions, auth & limits

- [ ] Token validation and session store (Redis), with expiry producing the `PLAYER` error class.
- [ ] Stake/bet-limit and max-win enforcement **server-side** — the client's limits become a UI
      convenience, not the rule.
- [ ] Rate limiting per session and per IP on the spin path.
- [ ] **Jurisdiction policy enforced server-side** (minimum spin duration, autoplay constraints), so
      the compliance package stops being the only guard.

**Done when:** every `PLAYER`-class contract test goes green against `apps/rgs`.

## Block R6 — Observability

- [ ] Structured logs (pino) with a correlation ID **and `roundId` on every line**.
- [ ] OpenTelemetry traces spanning authenticate → spin → wallet → settle.
- [ ] Metrics: spin latency histogram, error rate by class, round-state gauges.
- [ ] Liveness + readiness endpoints (readiness pings the database and the wallet).

**Done when:** one `roundId` retrieves the full story of a round across logs, traces and metrics.

## Block R7 — Production readiness

- [ ] Fail-fast env validation at boot; **no dev default accepted in production** (secrets, wallet
      URL, seeds).
- [ ] Containerized build; health-gated rollout; documented rollback.
- [ ] Load test on the spin path — concurrency against the same player and the same `roundId`, to
      prove idempotency holds under races rather than under tests.
- [ ] Backup + restore drill for the round and ledger tables.

**Done when:** the whole contract suite is green against `apps/rgs`, and the client switches to it by
changing one URL — **no client changes at all**. That is the deliverable's closing argument.

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
