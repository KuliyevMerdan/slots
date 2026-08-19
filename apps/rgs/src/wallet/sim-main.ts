import { z } from 'zod';
import pino from 'pino';
import type { Minor } from '@slot/protocol';
import { WalletSim, buildWalletSimApp } from './sim.js';

/**
 * The wallet sim as a process — the second command of the RGS image (R7, ADR-0009).
 *
 * `docker compose up` needs an operator wallet for the RGS to speak docs/wallet-api.md to, and
 * the sim already serves that contract for the tests; this entry point serves it on a socket of
 * its own. One image, two commands: `node dist/main.js` is the RGS, `node dist/wallet/sim-main.js`
 * is the wallet across the wire from it — the same production shape an operator integration has,
 * with the operator's system simulated instead of absent.
 *
 * Play money, exactly like everything else in this repository: the balances come from the
 * environment, and a real operator wallet replaces this container and nothing else.
 */

const EnvSchema = z.object({
  WALLET_SIM_PORT: z.coerce.number().int().min(1).max(65_535).default(8789),
  WALLET_SIM_HOST: z.string().min(1).default('127.0.0.1'),
  WALLET_SIM_PLAYER: z.string().min(1).default('demo-player'),
  WALLET_SIM_BALANCE: z.coerce.number().int().min(0).default(1_000_000),
  WALLET_SIM_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new Error(`invalid environment for the wallet sim — ${detail}`);
}
const env = parsed.data;

const logger = pino({ level: env.WALLET_SIM_LOG_LEVEL });

const sim = new WalletSim({ [env.WALLET_SIM_PLAYER]: env.WALLET_SIM_BALANCE as Minor });
const app = buildWalletSimApp(sim);

// The container's own liveness answer — the *wallet contract* still has no health endpoint
// (ADR-0008: the RGS probes it by refusal); this route belongs to the process, not the wire.
app.get('/health', () => ({ status: 'ok' }));

try {
  const address = await app.listen({ port: env.WALLET_SIM_PORT, host: env.WALLET_SIM_HOST });
  logger.info(
    { address, player: env.WALLET_SIM_PLAYER, balance: env.WALLET_SIM_BALANCE },
    'wallet sim listening',
  );
} catch (error) {
  logger.error({ err: error }, 'wallet sim failed to start');
  process.exit(1);
}
