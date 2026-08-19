# ADR-0009 — Production readiness is a boot contract, one image, and drills that run in CI

**Date:** 2026-08-20 · **Block:** R7 · **Status:** accepted

## Context

R7 owes four things (ROADMAP): fail-fast env validation with no dev default accepted in
production; a containerized build with a health-gated rollout and a documented rollback; a load
test proving idempotency under races rather than under tests; and a backup + restore drill for
the round and ledger tables. Each has a conventional enterprise answer (a config service, a Helm
chart, k6, a runbook wiki page). This repository's rule is that infrastructure earns its place by
a test or a property — so each piece was built as the smallest thing that can *prove* itself.

## Decision

- **The environment is a two-mode contract, not a pile of defaults.** `RGS_ENV=development`
  fills every gap with placeholders (zero-config dev loop); `RGS_ENV=production` refuses them —
  Postgres and a real wallet URL required, no public keys, the demo session only by explicit
  choice — and names **every** violation in one error, because a deploy should fail with a
  checklist. Empty strings read as absence (`optional()`), because that is what compose delivers
  for an unset variable. The image defaults to production, so the safe mode is the one you get
  by doing nothing.
- **One image, two commands.** The same build serves `node dist/main.js` (the RGS) and
  `node dist/wallet/sim-main.js` (the wallet sim across a real wire) — so `docker compose up`
  reproduces the three-process production shape (RGS, database, operator wallet) without
  inventing a second artifact. The rollout gate is R6's `/ready` — probing the store and the
  wallet — behind a standard `HEALTHCHECK`; rollback is the previous tag behind the same gate,
  legal because migrations are additive-only and run at boot.
- **The load question is answered twice, by two different instruments.** Correctness under
  concurrency is a CI gate: the race suite fires identical, conflicting and duplicate requests
  *simultaneously* over the real HTTP binding against both stores — and promptly earned its keep
  by finding two real windows (a wallet `REF_CONFLICT` surfacing as retryable
  `WALLET_UNAVAILABLE`; a raced settle answering `ILLEGAL_TRANSITION` instead of replaying).
  Throughput is an on-demand tool, `tools/load-test` — hand-rolled honest clients, latency
  percentiles, and a closing-balance check that exits non-zero on drift — kept out of the merge
  gate because load in a merge gate is flake with a purpose. Its first confirmed finding was in
  itself: `credited += (await …)` reads its left side before suspending, the textbook lost
  update — the exact class of bug the tool exists to surface, and the reason its accounting now
  awaits before it adds.
- **The restore drill is a CI test, not a runbook paragraph.** The Postgres suite dumps the four
  tables mid-session (an open round one feature-spin deep), truncates, restores with
  `OVERRIDING SYSTEM VALUE` + `setval` (what `pg_dump` output does), and asserts a *fresh*
  composition finishes the interrupted round with the credit arriving exactly once. docs/deploy.md
  documents the `pg_dump` twin of the same procedure.

## Consequences

- **`apps/rgs` can be deployed by someone who has never read the source**: build the image, set
  the variables the boot error lists, gate on `/ready`. The demo remains zero-config because
  development mode still fills every gap.
- **The client switches servers without a client change** — the R7 closing argument. The one
  seam that was missing (a lobby for a server that deliberately has no `/demo/session`) is the
  out-of-band token: `VITE_RGS_TOKEN`, the environment standing in for the operator (§7).
- **Two race fixes landed in the domain** because the race suite exists; both memory and
  Postgres now answer duplicates identically under genuine concurrency, which no sequential test
  could claim.
- **Eviction became real on Postgres** (retention was "a number, not an eviction" since R1) —
  the same commit that settles past retention drops the oldest settled rounds, records and all,
  and the store contract holds both twins to it.

*Rejected:* k6/autocannon (a dependency and a DSL for what forty lines of honest client do,
without the balance check that makes it a gate); reverting migrations in a rollback (roll code
back, never schema, because the old version reads the new schema but not vice versa); a separate
wallet-sim image (a second artifact to version for a process the RGS image already contains);
`NODE_ENV` as the mode switch (it means "optimize", not "refuse dev defaults" — overloading it
breaks the one tool that reads it correctly, the runtime).
