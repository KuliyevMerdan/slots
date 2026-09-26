import { z } from 'zod';
import type { Minor } from '@slot/protocol';
import { SimServer, createSimConfig, createSimState } from '@slot/rgs-sim';
import type { VisitorIdentity, VisitorPolicy } from './sessions.js';

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
  /**
   * Most visitors held at once (`sessions.ts`) — each a simulator with up to fifty settled rounds
   * of stored responses, on the order of a hundred kilobytes at worst, so the default stays well
   * inside a free-tier container's memory. At capacity the longest-idle visitor makes room.
   */
  MOCK_RGS_MAX_SESSIONS: z.coerce.number().int().min(1).default(200),
  /** How long a visitor may go without a call before the server forgets them. */
  MOCK_RGS_SESSION_IDLE_MINUTES: z.coerce.number().min(1).default(30),
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

/**
 * `PORT` is the hosting platforms' convention (Render, Cloud Run, Heroku all inject it) and the
 * container cannot know which port it will be given. An explicit `MOCK_RGS_PORT` still wins, so a
 * developer's `.env` is never overridden by an ambient variable from somewhere else.
 */
export const readEnv = (env: NodeJS.ProcessEnv = process.env): MockRgsEnv => {
  const parsed = EnvSchema.safeParse({ ...env, MOCK_RGS_PORT: env.MOCK_RGS_PORT ?? env.PORT });
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
export const createSim = (
  env: MockRgsEnv,
  now: () => number = Date.now,
  visitor?: VisitorIdentity,
): SimServer =>
  new SimServer({
    initialState: createSimState({
      // A visitor's seed is the server's seed plus their ordinal: every visitor plays a different
      // sequence, and a pinned MOCK_RGS_SEED still replays the whole server — visitor 3 of one
      // run is visitor 3 of the next. Their token is minted at random instead, because a token
      // derived from a seed anyone can read would let a stranger play someone else's session.
      serverSeed:
        visitor === undefined
          ? env.MOCK_RGS_SEED
          : `${env.MOCK_RGS_SEED}/visitor-${visitor.ordinal}`,
      balance: env.MOCK_RGS_BALANCE as Minor,
      expiresAt: now() + env.MOCK_RGS_SESSION_HOURS * 3_600_000,
      ...(visitor === undefined ? {} : { token: visitor.token }),
    }),
    config: createSimConfig({ devMode: env.MOCK_RGS_DEV_MODE }),
    now,
  });

/** The visitor pool's policy, from the environment — what `main.ts` hands `buildApp`. */
export const visitorPolicy = (env: MockRgsEnv, now: () => number = Date.now): VisitorPolicy => ({
  create: (identity) => createSim(env, now, identity),
  maxSessions: env.MOCK_RGS_MAX_SESSIONS,
  idleMs: env.MOCK_RGS_SESSION_IDLE_MINUTES * 60_000,
  now,
});
