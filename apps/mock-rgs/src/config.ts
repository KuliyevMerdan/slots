import { z } from 'zod';
import type { Minor } from '@slot/protocol';
import { SimServer, createSimConfig, createSimState } from '@slot/rgs-sim';

/**
 * The environment, validated like anything else that crosses a boundary.
 *
 * There are no secrets here and there never will be — this is play money, a demo token and no
 * operator credentials (see `.env.example`, the only one in the repository). What there *is* is a
 * server seed, and a mistyped one silently changes every outcome the session produces, which is
 * exactly the class of thing a schema catches and a `process.env.X || default` does not.
 */

const EnvSchema = z.object({
  MOCK_RGS_PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
  MOCK_RGS_HOST: z.string().min(1).default('127.0.0.1'),
  /** Fixes the whole session's outcome sequence. The same seed replays it identically. */
  MOCK_RGS_SEED: z.string().min(1).default('mock-rgs-dev-seed'),
  /** Starting balance, in minor units. */
  MOCK_RGS_BALANCE: z.coerce.number().int().min(0).default(1_000_000),
  /** Whether `forceOutcome` is honoured. True here because this server exists to be driven. */
  MOCK_RGS_DEV_MODE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  MOCK_RGS_SESSION_HOURS: z.coerce.number().min(0.1).default(12),
  MOCK_RGS_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  /**
   * When set, the built client (`apps/game-client/dist`) is served from `/` — the same origin the
   * game API lives on, so the deployed demo needs no CORS at all (ADR-0010). Absent in
   * development, where Vite serves the client and proxies `/rgs` here instead.
   */
  MOCK_RGS_STATIC_DIR: z.string().min(1).optional(),
  /**
   * Per-IP request budget, per minute — the moment this server faces a network that is not
   * `127.0.0.1` it needs one. Generous by design: an honest client under the pacing rule makes a
   * few calls a second at worst, retries included, and the budget exists to stop a loop, not a
   * player. Tests build the app without one on purpose (the suites hammer); `main.ts` always
   * passes this.
   */
  MOCK_RGS_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(600),
  /**
   * Trust `X-Forwarded-For` for `request.ip` — required behind a deploy platform's proxy, or
   * every player shares the proxy's one rate-limit bucket. Off when the socket faces clients.
   */
  MOCK_RGS_TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export type MockRgsEnv = z.infer<typeof EnvSchema>;

export const readEnv = (env: NodeJS.ProcessEnv = process.env): MockRgsEnv => {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid environment for @slot/mock-rgs — ${detail}`);
  }
  return parsed.data;
};

/**
 * The simulator this server fronts.
 *
 * `now` is a parameter here for the same reason it is one inside the simulator: the clock is the
 * only thing in this process that cannot be replayed, so it is passed rather than reached for. The
 * store is left at its default — in-memory — because a server that resurrected yesterday's session
 * from disk on boot would make every test's starting point a question.
 */
export const createSim = (env: MockRgsEnv, now: () => number = Date.now): SimServer =>
  new SimServer({
    initialState: createSimState({
      serverSeed: env.MOCK_RGS_SEED,
      balance: env.MOCK_RGS_BALANCE as Minor,
      expiresAt: now() + env.MOCK_RGS_SESSION_HOURS * 3_600_000,
    }),
    config: createSimConfig({ devMode: env.MOCK_RGS_DEV_MODE }),
    now,
  });
