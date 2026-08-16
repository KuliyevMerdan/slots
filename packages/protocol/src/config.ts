import { z } from 'zod';
import { PositiveMinorSchema, SymbolIdSchema } from './primitives.js';

/**
 * Regulated behaviour is **data, not branching**. The server declares which regime the session is
 * under; the client applies the preset (`@slot/compliance`). Server-side enforcement is R5 — until
 * then this field is a declaration, not a guarantee.
 */
export const JURISDICTIONS = ['DEFAULT', 'UK'] as const;

export type JurisdictionId = (typeof JURISDICTIONS)[number];

export const JurisdictionIdSchema = z.enum(JURISDICTIONS);

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
  /** A payout is capped here. `SettleRes.capped` says when that happened. */
  maxWin: PositiveMinorSchema,
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
