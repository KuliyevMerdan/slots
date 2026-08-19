import { z } from 'zod';
import type { GameConfig, JurisdictionId, JurisdictionRules, Minor } from '@slot/protocol';
import { JURISDICTION_PRESETS } from '@slot/protocol';
import { BET_LEVELS, MATH_CONFIG } from '@slot/game-math';

/**
 * The environment, validated like anything else that crosses a boundary — the same discipline as
 * `apps/mock-rgs`. `RGS_SERVER_SEED` carries no committed secret: it is the dev default of a value
 * R4 replaces with committed/revealed material, and a real deployment sets its own. Postgres
 * arrives through `RGS_DATABASE_URL` (R1) — set, it selects the Postgres store; absent, the
 * in-memory store, which is what the dev loop and the contract suite run on.
 */

const EnvSchema = z.object({
  RGS_PORT: z.coerce.number().int().min(0).max(65_535).default(8788),
  RGS_HOST: z.string().min(1).default('127.0.0.1'),
  RGS_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  /** Every spin seed derives from this until R4's commit/reveal. Dev default, never a secret. */
  RGS_SERVER_SEED: z.string().min(1).default('rgs-dev-seed'),
  /**
   * The demo session this server issues to itself at boot (§7: tokens are issued out of band, and
   * in development the environment *is* the out-of-band channel). R5 replaces this with real
   * operator-issued sessions.
   */
  RGS_DEMO_TOKEN: z.string().min(1).default('rgs-demo-token'),
  RGS_SESSION_HOURS: z.coerce.number().min(0.1).default(12),
  /** Demo wallet balance, minor units — the MockWallet's until R2 integrates a real provider. */
  RGS_BALANCE: z.coerce.number().int().min(0).default(1_000_000),
  /** postgres://… — selects the Postgres store. Absent means in-memory. */
  RGS_DATABASE_URL: z.string().min(1).optional(),
});

export type RgsEnv = z.infer<typeof EnvSchema>;

export const readEnv = (env: NodeJS.ProcessEnv = process.env): RgsEnv => {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid environment for @slot/rgs — ${detail}`);
  }
  return parsed.data;
};

/* ── the served GameConfig ────────────────────────────────────────────────────────────────────
 * `@slot/game-math` owns the math half — strips, paylines, paytable, `mathVersion` — and this
 * file adds the commercial half, exactly the seam the simulator has (`createSimConfig`). The two
 * servers deliberately publish the same defaults today; they are two *configurations*, not two
 * copies of the math, and an operator config diverging them is the intended future.
 */

export const RGS_GAME_ID = 'aurora-reels';

const firstBetLevel = BET_LEVELS[0];
const lastBetLevel = BET_LEVELS[BET_LEVELS.length - 1];

if (firstBetLevel === undefined || lastBetLevel === undefined) {
  throw new RangeError('@slot/game-math exported an empty BET_LEVELS');
}

/** The payout ceiling, as a multiple of the stake played — see the sim's twin for the argument. */
export const RGS_MAX_WIN_MULTIPLIER = 5_000;

export interface GameConfigOptions {
  gameId?: string;
  jurisdiction?: JurisdictionId;
  jurisdictionRules?: JurisdictionRules;
  minStake?: Minor;
  maxStake?: Minor;
  maxWinMultiplier?: number;
}

/**
 * Note what is *not* an option: `devMode`. This server never honours `forceOutcome` — there is no
 * flag to set, so there is no flag to mis-set (docs/protocol.md §8).
 */
export const createGameConfig = ({
  gameId = RGS_GAME_ID,
  jurisdiction = 'DEFAULT',
  jurisdictionRules = JURISDICTION_PRESETS[jurisdiction],
  minStake = firstBetLevel,
  maxStake = lastBetLevel,
  maxWinMultiplier = RGS_MAX_WIN_MULTIPLIER,
}: GameConfigOptions = {}): GameConfig => ({
  gameId,
  ...MATH_CONFIG,
  strips: MATH_CONFIG.strips.map((strip) => [...strip]),
  paytable: MATH_CONFIG.paytable.map((entry) => ({ ...entry, pays: [...entry.pays] })),
  paylines: MATH_CONFIG.paylines.map((line) => [...line]),
  betLevels: [...BET_LEVELS],
  limits: { minStake, maxStake, maxWinMultiplier },
  jurisdiction,
  jurisdictionRules: { ...jurisdictionRules },
  devMode: false,
});
