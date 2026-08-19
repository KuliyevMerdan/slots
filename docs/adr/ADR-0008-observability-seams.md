# ADR-0008 — Observability is three seams, not a framework

**Date:** 2026-08-19 · **Block:** R6 · **Status:** accepted

## Context

R6 owes four things: structured logs with the `roundId` on every line, OTel traces spanning a
round's calls and its wallet movements, metrics (spin latency, error rate by class, round-state
gauges), and readiness that actually pings the store and the wallet. The reflexive answer is an
observability framework wired through everything. This codebase's pattern is the opposite: when a
module needs something its boundary forbids, it takes the shape as an argument (ADR-0003) — so
the question was which *seams* observability needs, and what the smallest honest implementation
of each one is.

## Decision

Three seams, each with a different answer, chosen by what already existed:

- **Logs: pino stays Fastify's, plus one port for the domain.** The HTTP layer writes one access
  line per answered game call (call name, `roundId`, duration) and one enriched line per refusal
  (code, class, `roundId`) — Fastify's own request logging is disabled because those lines say
  less than ours. The domain gets `RgsObserver`, a one-method port for the events HTTP cannot
  see: the two money-side failures ADR-0005 swallows by design (an undeliverable rollback, a lost
  ledger entry) become `error`-level events **at the failure site**, with the `roundId` and the
  correlation id on them — the bang, where reconciliation remains the echo. One pino instance
  serves Fastify and the observer, so a round's lines interleave in one stream.
- **Traces: `@opentelemetry/api` is the port; the SDK lives in `main.ts`.** The API package is a
  facade with a no-op default — precisely the injected-shape pattern, maintained by the industry.
  The HTTP layer opens one SERVER span per call; `tracedWallet` decorates the `WalletProvider`
  (the `withRetry` shape) with CLIENT spans that nest under it. Every span carries
  `rgs.round_id`. A real provider + OTLP exporter is registered only when
  `OTEL_EXPORTER_OTLP_ENDPOINT` names a collector; tests hand in an in-memory exporter and read
  the spans back.
- **Metrics: hand-rolled, like the R5 token bucket.** Three instrument kinds and the Prometheus
  text format are a page of unit-tested arithmetic; `prom-client` would be a dependency doing the
  same page. The round-state gauge is *asked at scrape time* via `store.countByState()` — a
  gauge tracked incrementally forgets every open round a restart inherited, and a high `OPEN`
  count is the stranded-round alarm, which must survive restarts to mean anything.

Readiness probes the same two dependencies the domain cannot play without: the store (the gauge's
own query) and the wallet — **by refusal**: a wallet that answers `UNKNOWN_PLAYER` for the probe
id is up and speaking the contract; only silence and transport failures count as down. This keeps
the wallet wire (docs/wallet-api.md) unchanged — no health endpoint invented for our convenience
on a contract that is the operator's to version.

The gate is a test, not a sentence: `observability/story.test.ts` composes exactly as `main.ts`
does, plays real rounds over the real binding, and retrieves one round's full story from the logs
(filtered by `roundId`), the traces (filtered by `rgs.round_id`) and `/metrics` — then asserts
the two swallowed failures are loud, with the correlation id intact.

## Consequences

- **The domain still composes bare.** `observe` defaults to a no-op; every pre-R6 test builds the
  service unchanged. A composition pays only for what it reads.
- **One join key, three surfaces.** `roundId` on the log line, `rgs.round_id` on the span, the
  round-state gauge from the store — plus the correlation id tying log lines to spans. "What
  happened to round X" is one filter in each system rather than an archaeology project.
- **Two new production dependencies of substance** (`@opentelemetry/api` + the SDK/exporter pair
  used only by `main.ts`), and pino promoted from Fastify's internal to a declared dependency.
  The metrics path adds none.
- **The exposition format is ours to keep correct.** The registry's rendering is pinned by unit
  tests (escaping, cumulative buckets, `+Inf`, `_sum`/`_count`); a format bug is a red test here
  rather than a silent scrape failure in someone's Grafana.

*Rejected:* a metrics library (a dependency for a page of arithmetic); auto-instrumentation
(spans named after Fastify internals rather than the protocol's calls, and a bootstrap flag the
composition cannot test); a wallet health endpoint (a wire change to the operator's contract for
a question a refusal already answers); logging through the observer everywhere (the HTTP layer
already sees successes and refusals — the port is only for what it cannot see).
