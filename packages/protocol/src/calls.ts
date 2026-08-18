import { z } from 'zod';
import { GameConfigSchema } from './config.js';
import {
  CurrencySchema,
  NonNegativeMinorSchema,
  PositiveMinorSchema,
  RoundIdSchema,
  TimestampSchema,
} from './primitives.js';
import {
  FeatureProgressSchema,
  ForceOutcomeSchema,
  NextActionSchema,
  PendingRoundSchema,
  RoundResultSchema,
} from './round.js';

/* ── authenticate ─────────────────────────────────────────────────────────────────────────────
 * Read-only. Token in, session + balance + config out — and `pendingRound` if a round was left
 * open, which is the whole reconnect story.
 */

export const AuthenticateReqSchema = z.object({
  /** Opaque. Issued out of band by the operator's lobby — see docs/protocol.md §7. */
  token: z.string().min(1),
});

export type AuthenticateReq = z.infer<typeof AuthenticateReqSchema>;

export const SessionSchema = z.object({
  playerId: z.string().min(1),
  currency: CurrencySchema,
  expiresAt: TimestampSchema,
});

export type Session = z.infer<typeof SessionSchema>;

export const AuthenticateResSchema = z.object({
  session: SessionSchema,
  /** Authoritative. Replaces whatever the client thought it had. */
  balance: NonNegativeMinorSchema,
  config: GameConfigSchema,
  pendingRound: PendingRoundSchema.optional(),
});

export type AuthenticateRes = z.infer<typeof AuthenticateResSchema>;

/* ── spin ─────────────────────────────────────────────────────────────────────────────────────
 * Debits the stake. Idempotent on `roundId`: a duplicate replays the original response rather
 * than spinning again.
 */

export const SpinReqSchema = z.object({
  roundId: RoundIdSchema,
  stake: PositiveMinorSchema,
  /** Mixed into the round seed by the server. */
  clientSeed: z.string().min(1).max(64).optional(),
  forceOutcome: ForceOutcomeSchema.optional(),
});

export type SpinReq = z.infer<typeof SpinReqSchema>;

export const SpinResSchema = z.object({
  roundId: RoundIdSchema,
  /** After the debit, before any credit. The client never computes this. */
  balance: NonNegativeMinorSchema,
  result: RoundResultSchema,
  feature: FeatureProgressSchema.optional(),
  next: NextActionSchema,
});

export type SpinRes = z.infer<typeof SpinResSchema>;

/* ── featureSpin ──────────────────────────────────────────────────────────────────────────────
 * One free spin inside an already-open round. No debit. Idempotent on `(roundId, step)`, so a
 * disconnect on spin 7 of 10 resumes at spin 7.
 */

export const FeatureSpinReqSchema = z.object({
  roundId: RoundIdSchema,
  /** 1-based index within the feature. */
  step: z.int().min(1),
  forceOutcome: ForceOutcomeSchema.optional(),
});

export type FeatureSpinReq = z.infer<typeof FeatureSpinReqSchema>;

export const FeatureSpinResSchema = z.object({
  roundId: RoundIdSchema,
  step: z.int().min(1),
  /** Unchanged — a free spin neither debits nor credits. Sent so the HUD never has to remember. */
  balance: NonNegativeMinorSchema,
  result: RoundResultSchema,
  feature: FeatureProgressSchema,
  next: NextActionSchema,
});

export type FeatureSpinRes = z.infer<typeof FeatureSpinResSchema>;

/* ── settle ───────────────────────────────────────────────────────────────────────────────────
 * Credits the round's total win. Idempotent on `roundId`; settling an already-settled round is a
 * replay, not an error, so a client that missed the response can simply ask again.
 */

export const SettleReqSchema = z.object({
  roundId: RoundIdSchema,
});

export type SettleReq = z.infer<typeof SettleReqSchema>;

export const SettleResSchema = z.object({
  roundId: RoundIdSchema,
  /** After the credit. */
  balance: NonNegativeMinorSchema,
  /** The amount actually credited, after max-win capping. */
  totalWin: NonNegativeMinorSchema,
  /** True iff `limits.maxWin` clipped the payout. The player has to be told. */
  capped: z.boolean(),
  next: z.literal('IDLE'),
});

export type SettleRes = z.infer<typeof SettleResSchema>;

/* ── the call table ───────────────────────────────────────────────────────────────────────────
 * One place that says what the wire is, so HTTP routing (S2), the contract suite (S3) and the
 * transport (C2) enumerate the same four calls instead of three hand-written lists.
 */

export const CALLS = {
  authenticate: { req: AuthenticateReqSchema, res: AuthenticateResSchema, mutating: false },
  spin: { req: SpinReqSchema, res: SpinResSchema, mutating: true },
  featureSpin: { req: FeatureSpinReqSchema, res: FeatureSpinResSchema, mutating: true },
  settle: { req: SettleReqSchema, res: SettleResSchema, mutating: true },
} as const;

export type CallName = keyof typeof CALLS;

export const CALL_NAMES = Object.keys(CALLS) as [CallName, ...CallName[]];

/**
 * The request and response type of a call, by name.
 *
 * Derived from the same table the routing and validation read, so a generic caller — the simulator's
 * dispatcher, `MockTransport`, the contract suite — stays typed without any of them re-declaring the
 * mapping. Three hand-written copies of "spin returns SpinRes" is three chances to drift.
 */
export type CallRequest<N extends CallName> = z.infer<(typeof CALLS)[N]['req']>;

export type CallResponse<N extends CallName> = z.infer<(typeof CALLS)[N]['res']>;

/* ── the HTTP binding ─────────────────────────────────────────────────────────────────────────
 * The URL is part of the wire, so it is pinned where the rest of the wire is — docs/protocol.md
 * §2.6. `HttpTransport` builds its request path from this and `apps/mock-rgs` registers its routes
 * from it, which is one fewer string for the two of them to disagree about.
 */

export const HTTP_ROUTE_PREFIX = '/rgs';

/** `POST /rgs/spin`. One route per call — no verbs in the body, no envelope, nothing to dispatch on. */
export const routeFor = (call: CallName): string => `${HTTP_ROUTE_PREFIX}/${call}`;

/**
 * The header carrying the correlation id, in both directions.
 *
 * The client mints one per request and the server echoes it, so a round is traceable from a browser
 * console to a server log without either side inventing a scheme the other has to guess.
 */
export const CORRELATION_HEADER = 'x-correlation-id';
