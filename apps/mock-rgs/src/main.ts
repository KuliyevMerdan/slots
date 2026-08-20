import { buildApp } from './app.js';
import { createSim, readEnv } from './config.js';

/**
 * The entry point: `pnpm dev:rgs`.
 *
 * Everything interesting is in `buildApp` and `@slot/rgs-sim`; this file reads the environment,
 * listens, and shuts down without leaving the port held. It is deliberately the only module in the
 * package that touches `process`.
 */

const env = readEnv();
const sim = createSim(env);

const app = buildApp({
  sim,
  logger: { level: env.MOCK_RGS_LOG_LEVEL },
  staticDir: env.MOCK_RGS_STATIC_DIR,
  // Always on here, never in the test compositions — the apps/rgs arrangement. One minute is the
  // window; only the budget is configuration.
  rateLimit: { max: env.MOCK_RGS_RATE_LIMIT_MAX, timeWindowMs: 60_000 },
  trustProxy: env.MOCK_RGS_TRUST_PROXY,
});

const shutdown = (signal: string): void => {
  app.log.info({ signal }, 'shutting down');
  // Any deliberately dropped response is holding a socket open forever; `close` destroys them
  // through the app's `onClose` hook rather than waiting for a client that will never hang up.
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
  const address = await app.listen({ port: env.MOCK_RGS_PORT, host: env.MOCK_RGS_HOST });
  app.log.info(
    {
      address,
      gameId: sim.config.gameId,
      mathVersion: sim.config.mathVersion,
      devMode: sim.config.devMode,
      serverSeed: env.MOCK_RGS_SEED,
      staticDir: env.MOCK_RGS_STATIC_DIR ?? null,
      // Printed on purpose: it is the demo lobby's token (docs/protocol.md §7), and the alternative
      // is every developer curling /demo/session before they can do anything.
      token: sim.state.token,
    },
    'mock-rgs listening',
  );
} catch (error) {
  app.log.error({ err: error }, 'mock-rgs failed to start');
  process.exit(1);
}
