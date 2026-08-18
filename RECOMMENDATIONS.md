# Recommendations — what to invest in next

_Living registry, maintained like the **Gaps & missing pieces** section of [`CLAUDE.md`](CLAUDE.md)
but for a different kind of item: **Gaps** records concrete missing pieces that the current design
already implies (a protocol call the client has to fake, an error class with no producer); this file
records **strategic recommendations** — investments nothing owes yet, judged worth making before or
shortly after the project is shown to a studio. The same maintenance rules apply:_

- _**Delete a bullet the moment it's done or consciously rejected** — in the same change._
- _When a recommendation turns into concrete scheduled work, move it: a task list belongs in
  [`ROADMAP.md`](ROADMAP.md), a discovered missing piece belongs in the Gaps registry. Don't hold it
  in both._
- _**Never duplicate a Gaps bullet here** (autoplay, accessibility, the asset licensing question, the
  capped-max-win presentation and the telemetry seam are already tracked there) — refine the existing
  note instead._
- _If a category empties out, keep the heading with `- (none)`._

**Before you show it to a studio**

- **Record the demo GIF from a scripted, seeded run.** The README hero is the single highest-leverage
  artefact in the repository, and it should be reproducible: a Playwright script with a fixed seed +
  `forceOutcome: MAX_WIN` that anyone (including you, six months later) can re-run to regenerate it.
  A hand-captured GIF is a screenshot of a moment; a scripted one is evidence that the force-outcome
  and determinism machinery works.
- **Write `docs/architecture.md` while you build C2, not at C8.** The transport seam is the argument
  the whole project makes, and it is much easier to write down while the reasoning is fresh. The
  README then quotes it rather than inventing it under deadline.
- **Put the honest limitations in the README yourself.** "Play money", "one game", "the RGS is a
  skeleton with contract tests" — stating scope beats letting a reviewer discover it. Scope
  discipline is a signal; the appearance of overclaiming is the opposite one.

**Architecture & contracts**

- **Prove the math is data by shipping a second config used only by tests.** "Multiple games" is
  correctly out of scope — but a second reel-strip + paytable configuration consumed by `math-sim`
  and the golden-file tests costs a day and demonstrates the thing a studio actually cares about: the
  math is configuration, not code. It also catches every place a constant leaked into logic.
- **Keep `protocol` publishable from day one.** Clean `exports`, no deep imports, no dependency on
  anything else in the workspace. You probably never publish it — but a package that *could* be
  published is a package with a genuinely enforced boundary, and it makes "we'd hand this to the
  operator's team" a real sentence.

**Game math & fairness**

- **Bring seed commit/reveal forward into the simulator.** It is scheduled for R4, which means the
  demo can never show provable fairness — the one property that makes a fairness claim more than
  marketing. Committing on authenticate and revealing on settle in `rgs-sim` turns R4 from an
  invention into a port, and gives the README a section most portfolio slots don't have.
- **Publish the volatility distribution, not just the RTP number.** Two games at 96% RTP can feel
  completely different. A win-size histogram and a max-win frequency figure from `math-sim` show you
  understand what volatility *means* to a player, which is the actual math conversation.
- **Run the RTP convergence in CI at a small spin count.** Not 50M — one million spins on a schedule,
  asserting RTP within a tolerance band. It catches the class of bug where a strip edit silently
  moves the model, which is otherwise found by nobody.

**Performance**

- **Make the perf harness a gate, not a report.** `tools/perf-harness` (C7) is planned to print
  numbers a human reads. A threshold that fails CI when a scripted session drops below a frame-time
  budget is a small addition and turns the performance claim from a snapshot into a property. The
  README number stays honest even after twenty more commits.
- **Add a bundle-size budget and pack the atlas in CI.** Load time is the first thing a mobile player
  experiences and the first thing a reviewer notices. A size budget on the built client plus an
  atlas-packing step (rather than a committed pre-packed sheet) keeps both the bundle and the source
  images reviewable.
- **Test on a real low-end Android, not just a throttled desktop profile.** CPU throttling in DevTools
  does not reproduce mobile GPU fill-rate limits, thermal behaviour, or memory pressure — and reels
  with a full-screen win animation are exactly a fill-rate problem. One cheap physical device changes
  what the number means.

**Security & compliance**

- **Supply-chain hygiene from the first `pnpm install`.** A public repository with a live demo is a
  public dependency surface. Pin versions with a committed lockfile (given), run `pnpm audit` in CI,
  and put a dependency-update bot on it — Pixi, Vite and the Fastify stack all move fast enough that
  a six-month-old portfolio project starts failing audits on its own. Cheap now, embarrassing later.
- **Rate-limit the spin path before anything is publicly deployed.** Even a play-money demo on a free
  tier is a public endpoint doing work per request. A per-session and per-IP budget on `mock-rgs`
  costs a middleware and prevents your demo from being someone's load generator.

**Testing & CI**

- **Visual regression on a handful of key frames.** With a fixed seed and forced outcomes, the win
  presentation is deterministic — Playwright screenshots at named beats (reels stopped, payline
  highlighted, big-win counter mid-roll) guard the part of the project least reachable by unit tests.
  Keep it to a few frames; a hundred flaky screenshots is worse than none.
- **A soak test in the nightly job.** 100k seeded rounds through the engine with fault injection on,
  asserting no state violations and no memory growth. Slot bugs concentrate in the long tail —
  retrigger arithmetic, resume after a disconnect during a feature — and a nightly is where you find
  them cheaply.

**Presentation**

- **A short architecture walkthrough video (3–4 minutes).** Screen recording: force a max win, kill
  the network mid-spin, reload mid-feature, switch jurisdiction. Reviewers who won't clone the repo
  will watch four minutes, and every one of those moments is a claim in the README made visible.
- **Keep the ADR count small and the ADRs short.** Three or four real decisions (server authority,
  hand-rolled FSM over XState, blurred-texture over `BlurFilter`, minor-unit money) beat fifteen
  ceremonial ones. Each is half a page: context, decision, consequence.
