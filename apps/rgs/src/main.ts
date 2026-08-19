import { buildApp } from './http/app.js';
import { createGameConfig, readEnv } from './config.js';
import { createRoundService } from './domain/rounds.js';
import { SingleSessionHost } from './domain/sessions.js';
import { staticSeedProvider } from './rng/seeds.js';
import { MemoryRoundStore } from './persistence/memory.js';
import { createPgPool, createPostgresStore } from './persistence/postgres.js';
import { MemoryLedger } from './ledger/memory.js';
import { createPostgresLedger } from './ledger/postgres.js';
import { reconcile } from './ledger/reconcile.js';
import { MockWallet } from './wallet/mock.js';
import { RemoteWallet } from './wallet/remote.js';
import type { Minor } from '@slot/protocol';

/**
 * The entry point: composition, and nothing else. Every decision lives in the modules being
 * composed; this is deliberately the only file in the package that touches `process`.
 *
 * The session is a single demo one issued from the environment until R5 builds the operator seam
 * (§7 — the environment *is* the out-of-band channel in development). The store and the ledger
 * are real either way: Postgres when `RGS_DATABASE_URL` is set — one pool serves both — and
 * in-memory otherwise.
 */

const env = readEnv();
const config = createGameConfig();
const PLAYER_ID = 'demo-player';

const pool = env.RGS_DATABASE_URL === undefined ? undefined : createPgPool(env.RGS_DATABASE_URL);
const store =
  pool === undefined
    ? new MemoryRoundStore()
    : await createPostgresStore({ databaseUrl: env.RGS_DATABASE_URL as string, pool });
const ledger = pool === undefined ? new MemoryLedger() : await createPostgresLedger({ pool });

const wallet =
  env.RGS_WALLET_URL === undefined
    ? new MockWallet({ [PLAYER_ID]: env.RGS_BALANCE as Minor })
    : new RemoteWallet({ baseUrl: env.RGS_WALLET_URL });
const sessions = new SingleSessionHost();
sessions.issue(env.RGS_DEMO_TOKEN, {
  playerId: PLAYER_ID,
  currency: 'EUR',
  expiresAt: Date.now() + env.RGS_SESSION_HOURS * 3_600_000,
});

const rounds = createRoundService({
  store,
  wallet,
  ledger,
  sessions,
  seeds: staticSeedProvider(env.RGS_SERVER_SEED),
  config,
  now: Date.now,
});

const app = buildApp({ logger: { level: env.RGS_LOG_LEVEL }, rounds });

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
  void app.close().then(
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
