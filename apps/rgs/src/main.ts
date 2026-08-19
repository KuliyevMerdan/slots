import { buildApp } from './http/app.js';
import { readEnv } from './config.js';

/**
 * The entry point. Reads the environment, listens, shuts down cleanly — and that is all: every
 * decision lives in `buildApp` and behind the seams it composes, and this is deliberately the only
 * module in the package that touches `process`.
 */

const env = readEnv();

const app = buildApp({ logger: { level: env.RGS_LOG_LEVEL } });

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
    { address, ready: false },
    'rgs skeleton listening — every game route answers NOT_IMPLEMENTED (R0)',
  );
} catch (error) {
  app.log.error({ err: error }, 'rgs failed to start');
  process.exit(1);
}
