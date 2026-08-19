import { randomBytes } from 'node:crypto';
import pino from 'pino';
import { trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { buildApp } from './http/app.js';
import { createGameConfig, readEnv } from './config.js';
import { createRoundService } from './domain/rounds.js';
import { MemorySessionStore, createSessionService } from './domain/sessions.js';
import { createPostgresSessionStore } from './domain/sessions-postgres.js';
import { createRgsMetrics } from './observability/metrics.js';
import { fanoutObserver, meteredObserver, pinoObserver } from './observability/observer.js';
import { tracedWallet } from './observability/tracing.js';
import { committingSeedProvider } from './rng/seeds.js';
import { MemoryRoundStore } from './persistence/memory.js';
import { createPgPool, createPostgresStore } from './persistence/postgres.js';
import { MemoryLedger } from './ledger/memory.js';
import { createPostgresLedger } from './ledger/postgres.js';
import { reconcile } from './ledger/reconcile.js';
import { MockWallet } from './wallet/mock.js';
import { WalletError } from './wallet/provider.js';
import { RemoteWallet } from './wallet/remote.js';
import type { Minor } from '@slot/protocol';

/**
 * The entry point: composition, and nothing else. Every decision lives in the modules being
 * composed; this is deliberately the only file in the package that touches `process`.
 *
 * Sessions are real since R5: a store (Postgres when `RGS_DATABASE_URL` is set — one pool serves
 * rounds, ledger and sessions — in-memory otherwise), a service minting tokens from the CSPRNG,
 * and the operator surface (`/operator/sessions`, §7) as the lobby's face. The demo session is
 * still issued at boot from the environment — through the same service, because a server nobody
 * can authenticate against is not a server.
 *
 * Observability is composed since R6 (ADR-0008): one pino instance serves Fastify and the
 * domain's observer, so a round's lines interleave in one stream; the tracer is the OTel API's —
 * real only when `OTEL_EXPORTER_OTLP_ENDPOINT` names a collector; the metrics bundle carries the
 * round-state gauge wired to the store; `/ready` probes the store and the wallet.
 */

const env = readEnv();
const config = createGameConfig();
const PLAYER_ID = 'demo-player';

const logger = pino({ level: env.RGS_LOG_LEVEL });

/*
 * The tracer (R6): the API is always the seam; the SDK joins only when there is somewhere to
 * send spans. The exporter reads the standard OTEL_* environment itself — the endpoint checked
 * here is the switch, not a value to thread through.
 */
const tracerProvider =
  env.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
    ? undefined
    : new NodeTracerProvider({
        spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
      });
tracerProvider?.register();
const tracer = trace.getTracer('@slot/rgs');

const pool = env.RGS_DATABASE_URL === undefined ? undefined : createPgPool(env.RGS_DATABASE_URL);
const store =
  pool === undefined
    ? new MemoryRoundStore()
    : await createPostgresStore({ databaseUrl: env.RGS_DATABASE_URL as string, pool });
const ledger = pool === undefined ? new MemoryLedger() : await createPostgresLedger({ pool });

const wallet = tracedWallet(
  env.RGS_WALLET_URL === undefined
    ? new MockWallet({ [PLAYER_ID]: env.RGS_BALANCE as Minor })
    : new RemoteWallet({ baseUrl: env.RGS_WALLET_URL }),
  tracer,
);

const metrics = createRgsMetrics({ roundsByState: () => store.countByState() });
const observe = fanoutObserver(pinoObserver(logger), meteredObserver(metrics));

const sessionStore =
  pool === undefined ? new MemorySessionStore() : await createPostgresSessionStore({ pool });
const sessions = createSessionService({
  store: sessionStore,
  // The same entropy the fairness chain runs on (R4): tokens must be unguessable, not replayable.
  randomBytes: (byteCount) => randomBytes(byteCount),
  now: Date.now,
  defaultTtlMs: env.RGS_SESSION_HOURS * 3_600_000,
});
await sessions.issue({ playerId: PLAYER_ID, currency: 'EUR', token: env.RGS_DEMO_TOKEN });

const rounds = createRoundService({
  store,
  wallet,
  ledger,
  sessions,
  // The one composition that gets real entropy: the fairness chain runs on the CSPRNG (R4).
  seeds: committingSeedProvider((byteCount) => randomBytes(byteCount)),
  config,
  now: Date.now,
  observe,
});

const app = buildApp({
  loggerInstance: logger,
  rounds,
  operator: { sessions, key: env.RGS_OPERATOR_KEY },
  rateLimit: {
    perTokenPerSecond: env.RGS_RATE_LIMIT_PER_TOKEN,
    perIpPerSecond: env.RGS_RATE_LIMIT_PER_IP,
    burst: env.RGS_RATE_LIMIT_BURST,
  },
  observability: {
    tracer,
    metrics,
    readiness: [
      // The gauge's read doubles as the database ping — one question both surfaces ask.
      { name: 'store', check: () => store.countByState() },
      {
        // Probe by refusal: a wallet that *answers* — even `UNKNOWN_PLAYER` for the probe id —
        // is up and speaking the contract; only silence and transport failures count as down.
        name: 'wallet',
        check: () =>
          wallet.getBalance(PLAYER_ID).catch((error: unknown) => {
            if (error instanceof WalletError) return;
            throw error;
          }),
      },
    ],
  },
});

/*
 * The reconciliation job (R3): true the ledger against the wallet on an interval and say so.
 * The baseline is captured lazily on the first tick that can reach the wallet — an unreachable
 * wallet at boot must not stop the server, and a baseline needs the wallet to answer. Entries are
 * scoped to the window the baseline opened, so a persistent ledger under a fresh process does not
 * double-count history the opening balance already contains; the orphan scan inside `reconcile`
 * still reads the whole journal.
 */
if (env.RGS_RECONCILE_INTERVAL_MS > 0) {
  let baseline: { opening: Minor; since: number } | undefined;
  const tick = async (): Promise<void> => {
    try {
      baseline ??= { opening: await wallet.getBalance(PLAYER_ID), since: Date.now() };
      const report = await reconcile({
        ledger,
        wallet,
        store,
        players: [{ playerId: PLAYER_ID, ...baseline }],
      });
      if (report.clean) app.log.debug({ report }, 'ledger reconciled: clean');
      else app.log.warn({ report }, 'ledger reconciliation found drift');
    } catch (error) {
      app.log.warn({ err: error }, 'ledger reconciliation could not run');
    }
  };
  setInterval(() => void tick(), env.RGS_RECONCILE_INTERVAL_MS).unref();
}

const shutdown = (signal: string): void => {
  app.log.info({ signal }, 'shutting down');
  void app
    .close()
    // Flush what the batch processor is still holding — spans lost at shutdown are the ones
    // that explain why the process was shutting down.
    .then(() => tracerProvider?.shutdown())
    .then(
      () => process.exit(0),
      () => process.exit(1),
    );
};

process.on('SIGINT', () => {
  shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});

try {
  const address = await app.listen({ port: env.RGS_PORT, host: env.RGS_HOST });
  app.log.info(
    {
      address,
      store: env.RGS_DATABASE_URL === undefined ? 'memory' : 'postgres',
      wallet: env.RGS_WALLET_URL ?? 'mock (in-process)',
      gameId: config.gameId,
      mathVersion: config.mathVersion,
      // Printed for the same reason mock-rgs prints its token: it is the demo session (§7), and
      // the alternative is a server nobody can authenticate against.
      token: env.RGS_DEMO_TOKEN,
    },
    'rgs listening',
  );
} catch (error) {
  app.log.error({ err: error }, 'rgs failed to start');
  process.exit(1);
}
