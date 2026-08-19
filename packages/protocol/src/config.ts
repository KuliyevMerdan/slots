import { z } from 'zod';
import { PositiveMinorSchema, SymbolIdSchema } from './primitives.js';

/**
 * Regulated behaviour is **data, not branching**. The server declares which regime the session is
 * under *and what that regime means* — the rules travel with the config (docs/protocol.md §2.1,
 * D8), the server enforces the half it can observe (spin cadence), and the client's compliance
 * layer (`@slot/compliance`) applies the rest.
 */
export const JURISDICTIONS = ['DEFAULT', 'UK'] as const;

export type JurisdictionId = (typeof JURISDICTIONS)[number];

export const JurisdictionIdSchema = z.enum(JURISDICTIONS);

/**
 * What a jurisdiction requires, as data on the wire.
 *
 * The id names the regime; this object *is* the regime, and it is deliberately the thing both sides
 * read. An id alone would make the client's preset table the authority on what a regulator requires
 * — the same mistake as client-side math, one layer up (D8).
 */
export const JurisdictionRulesSchema = z.object({
  /**
   * A base-game cycle may not start sooner than this after the previous one. 0 = no floor.
   *
   * The one rule the server can enforce itself: a `spin` arriving early is `LIMIT_REACHED`. A free
   * spin is a step inside a round and is paced by presentation, not by this rule — and an
   * idempotent replay is exempt, because replay precedes validation (docs/protocol.md §4).
   */
  minSpinIntervalMs: z.int().min(0),
  turboAllowed: z.boolean(),
  autoplayAllowed: z.boolean(),
  /** How often play must be interrupted with a reality check. 0 = never. */
  realityCheckIntervalMs: z.int().min(0),
});

export type JurisdictionRules = z.infer<typeof JurisdictionRulesSchema>;

/**
 * The baseline meaning of each jurisdiction id — what a server serves unless an operator
 * configuration overrides it per market. The wire carries whatever the server actually enforces;
 * the client applies what arrives, never this table.
 *
 * The UK preset is the 2021 GB slots rules in miniature: a 2.5 s minimum game cycle, no turbo, no
 * autoplay, and an hourly reality check.
 */
export const JURISDICTION_PRESETS: Record<JurisdictionId, JurisdictionRules> = {
  DEFAULT: {
    minSpinIntervalMs: 0,
    turboAllowed: true,
    autoplayAllowed: true,
    realityCheckIntervalMs: 0,
  },
  UK: {
    minSpinIntervalMs: 2_500,
    turboAllowed: false,
    autoplayAllowed: false,
    realityCheckIntervalMs: 3_600_000,
  },
};

/**
 * What a symbol pays, per matching count. `LINE` pays multiply the **line bet**; `SCATTER` pays
 * multiply the **total stake** — the distinction is a classic source of quiet RTP bugs, so it is
 * on the wire rather than in a convention.
 */
export const PaytableEntrySchema = z.object({
  symbol: SymbolIdSchema,
  kind: z.enum(['LINE', 'SCATTER']),
  pays: z
    .array(
      z.object({
        count: z.int().min(1),
        multiplier: z.int().min(1),
      }),
    )
    .min(1),
});

export type PaytableEntry = z.infer<typeof PaytableEntrySchema>;

export const LimitsSchema = z.object({
  minStake: PositiveMinorSchema,
  maxStake: PositiveMinorSchema,
  /**
   * The payout ceiling, as a multiple of **the stake actually played** — the round's cap is
   * `stake × maxWinMultiplier`.
   *
   * A multiplier rather than an amount, because an absolute ceiling is a different game at every bet
   * level: unreachable at the minimum stake and a formality at the maximum. The server applies it as
   * the round accrues, so `roundWin` is always the payable figure and `SettleRes.capped` says
   * whether it bit (docs/protocol.md §3, D7).
   */
  maxWinMultiplier: z.int().min(1),
});

export type Limits = z.infer<typeof LimitsSchema>;

/**
 * Everything the client needs to present the game — and nothing it could decide an outcome with.
 * The strips and paytable are shipped so paylines can be highlighted and wins sequenced; authority
 * stays with the server's `stops[]` (ADR-0001).
 */
export const GameConfigSchema = z
  .object({
    gameId: z.string().min(1),
    /**
     * Pins the strips + paytable this client presents with. If it disagrees with the server's, the
     * client is drawing the wrong reels — `MATH_VERSION_MISMATCH`, and it is `FATAL` on purpose.
     */
    mathVersion: z.string().min(1),
    reels: z.int().min(1),
    rows: z.int().min(1),
    /** One strip per reel, in reel order. */
    strips: z.array(z.array(SymbolIdSchema).min(1)).min(1),
    paytable: z.array(PaytableEntrySchema).min(1),
    /** One entry per line; each entry is a row index per reel. */
    paylines: z.array(z.array(z.int().min(0)).min(1)).min(1),
    betLevels: z.array(PositiveMinorSchema).min(1),
    limits: LimitsSchema,
    jurisdiction: JurisdictionIdSchema,
    jurisdictionRules: JurisdictionRulesSchema,
    /** Whether this server will honour `forceOutcome` at all. Never true in production. */
    devMode: z.boolean(),
    // Currency is deliberately *not* here: it belongs to the player's wallet, so it arrives once in
    // `session` (docs/protocol.md §2.1). Two copies of it is one copy too many.
  })
  .refine((config) => config.strips.length === config.reels, {
    error: 'strips must have exactly one entry per reel',
    path: ['strips'],
  })
  .refine((config) => config.paylines.every((line) => line.length === config.reels), {
    error: 'every payline must name a row for every reel',
    path: ['paylines'],
  })
  .refine((config) => config.paylines.every((line) => line.every((row) => row < config.rows)), {
    error: 'a payline names a row outside the visible window',
    path: ['paylines'],
  })
  .refine((config) => config.limits.minStake <= config.limits.maxStake, {
    error: 'minStake must not exceed maxStake',
    path: ['limits'],
  });

export type GameConfig = z.infer<typeof GameConfigSchema>;
