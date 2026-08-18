import { z } from 'zod';
import {
  NonNegativeMinorSchema,
  PositiveMinorSchema,
  RoundIdSchema,
  SymbolIdSchema,
} from './primitives.js';

/** The server-side round machine. One round is one stake, one debit and one credit. */
export const ROUND_STATES = ['OPEN', 'RESOLVED', 'SETTLED'] as const;

export type RoundState = (typeof ROUND_STATES)[number];

export const RoundStateSchema = z.enum(ROUND_STATES);

/**
 * What the client must do next. The client never infers this from the result — it is told, so that
 * adding a feature type later does not silently change client behaviour.
 */
export const NEXT_ACTIONS = ['IDLE', 'FEATURE_SPIN', 'SETTLE'] as const;

export type NextAction = (typeof NEXT_ACTIONS)[number];

export const NextActionSchema = z.enum(NEXT_ACTIONS);

/** `[reel, row]`, both zero-based. */
export const PositionSchema = z.tuple([z.int().min(0), z.int().min(0)]);

export const WinSchema = z.object({
  kind: z.enum(['LINE', 'SCATTER']),
  /** Payline index; absent for scatter wins, which pay anywhere. */
  line: z.int().min(0).optional(),
  symbol: SymbolIdSchema,
  count: z.int().min(1),
  positions: z.array(PositionSchema).min(1),
  amount: NonNegativeMinorSchema,
});

export type Win = z.infer<typeof WinSchema>;

/** What a spin *awarded*. Progress through an award is `FeatureProgress`. */
export const FeatureSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('FREE_SPINS'),
    awarded: z.int().min(1),
    trigger: z.object({ symbol: SymbolIdSchema, count: z.int().min(1) }),
  }),
  z.object({
    kind: z.literal('FREE_SPINS_RETRIGGER'),
    awarded: z.int().min(1),
  }),
]);

export type Feature = z.infer<typeof FeatureSchema>;

/**
 * Where the feature is now. **The server has already folded retriggers into `total` and
 * `remaining`** — the client displays this arithmetic, it never performs it.
 *
 * What the feature has *won* is not here: that is `roundWin`, on the response itself, because it is
 * a fact about the round rather than about the feature and a round without a feature has one too.
 * Two fields carrying the same number is a defect waiting for the day they disagree (D7).
 */
export const FeatureProgressSchema = z
  .object({
    kind: z.literal('FREE_SPINS'),
    total: z.int().min(1),
    remaining: z.int().min(0),
    /** Last completed step; the next `featureSpin` is `step + 1`. */
    step: z.int().min(0),
    /** The triggering stake — free spins carry no stake, so multipliers resolve against this. */
    stakeRef: PositiveMinorSchema,
  })
  .refine((feature) => feature.remaining <= feature.total, {
    error: 'remaining free spins cannot exceed the total awarded',
    path: ['remaining'],
  })
  .refine((feature) => feature.step <= feature.total, {
    error: 'step cannot exceed the total awarded',
    path: ['step'],
  });

export type FeatureProgress = z.infer<typeof FeatureProgressSchema>;

/**
 * `stops` is the outcome; everything else is derived from it and sent for presentation — and, in
 * dev builds, for the client to re-evaluate and assert against (`__ASSERT_MATH__`).
 */
export const RoundResultSchema = z.object({
  /** Strip index per reel — the authoritative outcome. */
  stops: z.array(z.int().min(0)).min(1),
  /** Derived grid, `view[reel][row]`. */
  view: z.array(z.array(SymbolIdSchema).min(1)).min(1),
  wins: z.array(WinSchema),
  /** This spin's win. Inside a feature, this step's win. */
  totalWin: NonNegativeMinorSchema,
  features: z.array(FeatureSchema),
});

export type RoundResult = z.infer<typeof RoundResultSchema>;

/**
 * The entire recovery story. `authenticate` returns this when a round was left in flight, and it
 * says exactly what the client must do to continue — there is no separate recovery endpoint.
 */
export const PendingRoundSchema = z.object({
  roundId: RoundIdSchema,
  state: z.enum(['OPEN', 'RESOLVED']),
  stake: PositiveMinorSchema,
  /** What the round will pay, already capped. A rebuilt client must not have to add this up. */
  roundWin: NonNegativeMinorSchema,
  capped: z.boolean(),
  result: RoundResultSchema.optional(),
  feature: FeatureProgressSchema.optional(),
  next: NextActionSchema,
});

export type PendingRound = z.infer<typeof PendingRoundSchema>;

export const FORCE_OUTCOME_SCENARIOS = [
  'NEAR_MISS',
  'FREE_SPINS_TRIGGER',
  'MAX_WIN',
  'DEAD_SPIN',
] as const;

export type ForceOutcomeScenario = (typeof FORCE_OUTCOME_SCENARIOS)[number];

/**
 * Dev builds only. Two independent gates: the client cannot send it (compile-stripped behind
 * `__DEV_TOOLS__`), and the server refuses it unless `GameConfig.devMode` — because one gate is a
 * typo away from failing.
 */
export const ForceOutcomeSchema = z.union([
  z.object({ scenario: z.enum(FORCE_OUTCOME_SCENARIOS) }),
  z.object({ stops: z.array(z.int().min(0)).min(1) }),
]);

export type ForceOutcome = z.infer<typeof ForceOutcomeSchema>;
