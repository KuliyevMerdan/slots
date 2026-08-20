# Deploying `apps/rgs`

**Status:** pinned **2026-08-20** (R7). The decisions behind this document are
[ADR-0009](adr/ADR-0009-production-readiness.md); the environment contract it describes is
implemented in [`apps/rgs/src/config.ts`](../apps/rgs/src/config.ts) (`hardenEnv`) and tested in
`config.test.ts`.

Play money only. This document describes deploying the demo RGS in its production *shape* — the
discipline is real, the money is not.

## The image

One image, two commands:

```bash
docker build -f apps/rgs/Dockerfile -t slot-rgs .
```

- `node dist/main.js` — the RGS (the image's default command)
- `node dist/wallet/sim-main.js` — the wallet sim, serving [docs/wallet-api.md](wallet-api.md)
  over a socket: the stand-in for the operator's wallet in demos and staging

The image defaults to `RGS_ENV=production`, so a bare `docker run` **refuses to start** and names
everything missing. That is the R7 boot contract working:

- `RGS_DATABASE_URL` is required — the in-memory store forgets every round and its money on
  restart.
- `RGS_WALLET_URL` is required — the in-process mock wallet is play money inside the game process.
- `RGS_OPERATOR_KEY` must be 24+ characters and not the public dev placeholder.
- `RGS_DEMO_TOKEN` must not be the dev placeholder. Unset it (the production default): tokens
  then come only from `POST /operator/sessions`, key-guarded, the lobby's face (protocol §7).

Every violation is reported in **one** error — a deploy fails with a checklist, not a scavenger
hunt.

## The worked example

[`docker-compose.yml`](../docker-compose.yml) at the repository root is the production shape in
one file — Postgres, the wallet sim across a real wire, and the RGS in production mode:

```bash
RGS_DB_PASSWORD=<mint one> RGS_OPERATOR_KEY=<mint one, 24+ chars> docker compose up --build
```

No secrets are committed; compose refuses to interpolate without the two variables — the same
fail-fast rule the server itself applies. Add `RGS_DEMO_TOKEN=<mint one>` to make the deployment
playable without an operator call. `GET /metrics` listens on `8790` **inside the compose
network** and is deliberately not published — the scrape is infrastructure surface, not player
surface (`RGS_METRICS_PORT`).

## Health-gated rollout

`/ready` is the gate (R6): it probes the store (a real query) and the wallet (**by refusal** — a
wallet-vocabulary error proves the wire answers; only silence counts as down) and turns 503
naming the failing check. The image's `HEALTHCHECK` polls it, and compose starts the RGS only
after Postgres and the wallet report healthy.

A rollout is therefore: start the new version **beside** the old one, wait until its `/ready`
answers 200, shift traffic, retire the old version. Any orchestrator that understands a health
check (compose, ECS, Kubernetes readiness probes) enacts this without custom code. Two properties
make the swap safe:

- **Migrations run at boot and are additive-only.** `createPostgresStore` applies the committed
  migrations (`apps/rgs/migrations/`) before the server listens; a migration never rewrites or
  deletes what an older version still reads, so old and new can briefly share the database.
- **Interrupted rounds are the protocol's ordinary weather.** A round stranded by a kill mid-spin
  is §5's case: the client's same-`roundId` retry or its next `authenticate` resumes it against
  the new version, and the restore drill (below) proves the data survives round-trips.

**Rollback** is the same gate run backward: start the previous image tag, wait for its `/ready`,
shift traffic back. Because migrations are additive, the older version runs against the newer
schema. What a rollback must never include is reverting a migration against live data — roll the
*code* back, leave the schema alone.

## Backup and restore

Everything the server must not lose lives in four tables: `rounds`, `idempotency_records`,
`ledger_entries`, `sessions`. The wallet's balances are the operator's, not ours — after a
restore, the reconciliation job (R3) trues the journal against the wallet and reports any drift.

```bash
# Backup (the ledger is append-only; a snapshot is always internally consistent)
pg_dump --data-only --table=rounds --table=idempotency_records \
        --table=ledger_entries --table=sessions "$RGS_DATABASE_URL" > rgs-backup.sql

# Restore into a migrated, empty database
psql "$RGS_DATABASE_URL" < rgs-backup.sql
```

`pg_dump` emits identity columns with explicit values and resets their sequences; anything else
that restores these tables must do the same (`OVERRIDING SYSTEM VALUE`, then `setval`).

**The drill is a test, not a runbook promise:** the `backup + restore drill (R7)` case in
[`postgres.test.ts`](../apps/rgs/src/persistence/postgres.test.ts)
plays a session up to a mid-feature open round, dumps the four tables, truncates them, restores,
and then proves the part that matters — a *fresh* composition over the restored database reports
the same pending round, replays the same recorded answers, reproduces the ledger to the entry,
and **finishes the interrupted feature with the credit arriving exactly once**. It runs in CI on
every push, against the same migrations this document tells you to rely on.

## Load

```bash
pnpm load                                      # 10 connections × 50 rounds against the dev URL
pnpm load --url http://host:8788 --token <t> --connections 50 --rounds 200
```

`tools/load-test` is a swarm of honest clients: full rounds, idempotent retries under the same
`roundId`, the server's `retryAfterMs` honoured (being rate-limited is the server working, so it
never exhausts the retry budget — the wait scales and jitters instead). It prints latency
percentiles per call and checks the server's closing balance against its own account of every
stake and credit; **drift exits non-zero**. The correctness half of the same claim runs in CI as
the race suite (`races-contract.ts`): identical concurrent spins collapse to one debit,
conflicting ones to one winner, concurrent settles to one credit — against both stores.

## Observability in production

- Logs: pino JSON on stdout — ship them with whatever reads container stdout.
- Traces: set `OTEL_EXPORTER_OTLP_ENDPOINT` and spans flow OTLP/HTTP; unset, the API is a no-op.
- Metrics: set `RGS_METRICS_PORT` to move `GET /metrics` off the player port (compose does).
- One `roundId` retrieves a round's story across all three — that is R6's tested gate.

## The demo image (C8, ADR-0010)

The playable demo is its own image — `apps/mock-rgs` serving the game API *and* the built client
from one origin, so no CORS policy exists anywhere:

```bash
docker build -f apps/mock-rgs/Dockerfile -t slot-demo .
docker run --rm -p 8787:8787 slot-demo
```

That is the whole deployment: `http://localhost:8787/` is a playable slot, `/ready` is the health
gate, and the client inside is the **demo build** — debug panel and grid assertion on, because
"force a max win and read why the client can't cheat" is the exhibit. It is deliberately not the
production bundle `verify:strip` proves clean, and never claims to be.

Three environment variables matter behind a hosting platform's proxy (Fly, Railway, anything that
terminates TLS in front of the container):

- `MOCK_RGS_TRUST_PROXY` — baked `true` in the image: `request.ip` reads `X-Forwarded-For`, so
  the per-IP budget refuses one abusive client instead of everyone behind the proxy.
- `MOCK_RGS_RATE_LIMIT_MAX` — requests per IP per minute (default 600, healthchecks exempt).
  The refusal is the protocol's own `RATE_LIMITED` with `retryAfterMs`, so an honest client waits
  it out rather than erroring.
- `MOCK_RGS_SEED` — set it to make the session's outcome sequence replayable across restarts;
  leave the default for the demo.

Everything in this image is play money and single-session: one balance, reset on restart, `/dev/*`
mounted on purpose (the debug panel is part of the demo). Nothing here is the real RGS — that is
the rest of this document.
