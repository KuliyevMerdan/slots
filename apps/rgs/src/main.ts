import { buildApp } from './http/app.js';
import { createGameConfig, readEnv } from './config.js';
import { createRoundService } from './domain/rounds.js';
import { SingleSessionHost } from './domain/sessions.js';
import { staticSeedProvider } from './rng/seeds.js';
import { MemoryRoundStore } from './persistence/memory.js';
import { createPostgresStore } from './persistence/postgres.js';
import { MockWallet } from './wallet/mock.js';
import type { Minor } from '@slot/protocol';

/**
 * The entry point: composition, and nothing else. Every decision lives in the modules being
 * composed; this is deliberately the only file in the package that touches `process`.
 *
 * The wallet is `MockWallet` until R2 integrates a real provider, and the session is a single
 * demo one issued from the environment until R5 builds the operator seam (§7 — the environment
 * *is* the out-of-band channel in development). The store is real either way: Postgres when
 * `RGS_DATABASE_URL` is set, in-memory otherwise.
 */

const env = readEnv();
const config = createGameConfig();

const store =
  env.RGS_DATABASE_URL === undefined
    ? new MemoryRoundStore()
    : await createPostgresStore({ databaseUrl: env.RGS_DATABASE_URL });

const wallet = new MockWallet({ 'demo-player': env.RGS_BALANCE as Minor });
const sessions = new SingleSessionHost();
sessions.issue(env.RGS_DEMO_TOKEN, {
  playerId: 'demo-player',
  currency: 'EUR',
  expiresAt: Date.now() + env.RGS_SESSION_HOURS * 3_600_000,
});

const rounds = createRoundService({
  store,
  wallet,
  sessions,
  seeds: staticSeedProvider(env.RGS_SERVER_SEED),
  config,
  now: Date.now,
});

const app = buildApp({ logger: { level: env.RGS_LOG_LEVEL }, rounds });

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
