# ADR-0010 — The deployed demo is same-origin: the API serves the client, CORS never widens

**Date:** 2026-08-20 · **Block:** C8 · **Status:** accepted

## Context

Development never had a cross-origin problem to solve: Vite proxies `/rgs`, `/demo` and `/dev` to
`apps/mock-rgs`, the browser makes same-origin requests, and the server sends no CORS headers at
all. C8 deploys the demo behind a real URL, where there is no Vite and therefore no proxy — so the
question deferred since S2 finally demands an answer: either the client is served from the same
origin as the RGS, or the RGS grows a CORS policy.

## Decision

**Same-origin. `apps/mock-rgs` gains a flag-gated static mount and serves the built client
itself; no CORS header is ever sent.**

- `MOCK_RGS_STATIC_DIR` (absent by default) points the server at `apps/game-client/dist`;
  `@fastify/static` serves it from `/`. The game routes are registered explicitly and win over the
  wildcard; a missing file gets the same protocol-shaped 404 as an unknown route.
- One process, one origin, one deploy — which is also how operators actually embed games: the
  launch URL's host serves both the page and its API, and a game client that *needs* CORS to
  reach its RGS is the exception, not the rule.
- Development is unchanged: the flag is off, Vite serves the client, the proxy stays.

The same public-socket milestone brings the per-IP budget (`@fastify/rate-limit`, configured only
by `main.ts` so the test suites can keep hammering on purpose) and `trustProxy` (without it, a
platform's proxy makes every player share one bucket). Both refuse in the taxonomy's shape —
`RATE_LIMITED`, `retryAfterMs` in the body — because a deploy detail must not invent a second
error vocabulary.

## Alternatives rejected

- **CORS on the RGS (`Access-Control-Allow-Origin`).** Two deploys to keep in step, a preflight
  on every mutating call, and a header teaching the habit the real server must never learn —
  `*` against an API that carries a bearer token is exactly the configuration a reviewer should
  never find. Rejected while a same-origin answer costs one static mount.
- **A reverse proxy in front of both (nginx, a platform rewrite).** Solves the origin without
  touching the server, but adds a third moving part to a two-process demo and hides the answer in
  deployment configuration nothing in the repository tests. The static mount *is* tested.
- **Serving the client from a CDN/static host (the Vercel half of a split deploy).** The client
  is four hundred kilobytes of one bundle; a CDN buys nothing a demo needs and reopens the CORS
  question it exists to close.

## Consequences

- The deployable unit is one container: the server image carries `dist/` and the built client,
  `MOCK_RGS_STATIC_DIR` set, `/ready` as the health gate.
- A genuinely cross-origin operator integration remains `apps/rgs`'s problem, taken up with the
  operator that needs it — an explicit origin allow-list and never `*`. Nothing in this ADR
  prejudges that design; it only refuses to build it for a demo that does not need it.
