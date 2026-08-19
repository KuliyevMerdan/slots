import { z } from 'zod';
import { RoundIdSchema } from './primitives.js';

/**
 * Three classes, each with exactly one defined client behaviour. **The client branches on the
 * class, never on a message string** — a message is for a human reading a log.
 *
 * | Class         | Client behaviour                                                        |
 * | ------------- | ----------------------------------------------------------------------- |
 * | `RECOVERABLE` | backoff retry **with the same idempotency key**, reconnect overlay       |
 * | `PLAYER`      | modal, return to `IDLE`, **no retry**                                   |
 * | `FATAL`       | freeze the reels, error screen, offer reload                            |
 */
export const ERROR_CLASSES = ['RECOVERABLE', 'PLAYER', 'FATAL'] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

export const ErrorClassSchema = z.enum(ERROR_CLASSES);

/**
 * The taxonomy, as data — one source of truth for both the code list and its classification. A new
 * code cannot be added without deciding what the client does about it, because the type of this
 * object requires a class.
 */
export const CLASS_OF_CODE = {
  // RECOVERABLE — the operation may still succeed; retry it with the same key.
  TIMEOUT: 'RECOVERABLE',
  UPSTREAM_UNAVAILABLE: 'RECOVERABLE',
  WALLET_UNAVAILABLE: 'RECOVERABLE',
  RATE_LIMITED: 'RECOVERABLE',

  // PLAYER — the player (or their session) is the reason; retrying changes nothing.
  INSUFFICIENT_FUNDS: 'PLAYER',
  STAKE_NOT_ALLOWED: 'PLAYER',
  SESSION_EXPIRED: 'PLAYER',
  LIMIT_REACHED: 'PLAYER',

  // FATAL — the client and the server disagree about reality. Stop, do not improvise.
  SCHEMA_MISMATCH: 'FATAL',
  UNKNOWN_ROUND: 'FATAL',
  ROUND_CONFLICT: 'FATAL',
  ILLEGAL_TRANSITION: 'FATAL',
  FORCE_OUTCOME_REFUSED: 'FATAL',
  MATH_VERSION_MISMATCH: 'FATAL',
  /**
   * The request was understood, validated, and there is no code behind the endpoint — `apps/rgs`
   * while the R-blocks land, or an operator rollout that shipped routes before implementations.
   * `FATAL` because no retry produces the missing implementation (docs/protocol.md §6, D10).
   */
  NOT_IMPLEMENTED: 'FATAL',
} as const satisfies Record<string, ErrorClass>;

export type ErrorCode = keyof typeof CLASS_OF_CODE;

export const ERROR_CODES = Object.keys(CLASS_OF_CODE) as [ErrorCode, ...ErrorCode[]];

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const classOf = (code: ErrorCode): ErrorClass => CLASS_OF_CODE[code];

/**
 * The taxonomy, given HTTP status codes — the table in docs/protocol.md §2.7.
 *
 * A status is not how the client decides what to do — it branches on the `class`, which is derived
 * from the `code`, which is in the body. The status is for everything *between* the two: a proxy
 * log, a load-balancer health rule, a `curl` in a terminal. It lives here rather than in a server
 * because two servers implement the binding — `apps/mock-rgs` and `apps/rgs` — and two copies of a
 * table that must agree exactly is one copy too many.
 *
 * `satisfies Record<ErrorCode, number>` is the same discipline as `CLASS_OF_CODE`: a new error code
 * cannot be added without deciding what it looks like on the wire.
 */
export const STATUS_OF_CODE = {
  // RECOVERABLE — the client should ask again with the same key.
  TIMEOUT: 504,
  UPSTREAM_UNAVAILABLE: 503,
  WALLET_UNAVAILABLE: 503,
  RATE_LIMITED: 429,

  // PLAYER — the request was understood and refused. 422 rather than 400: nothing is malformed.
  INSUFFICIENT_FUNDS: 422,
  STAKE_NOT_ALLOWED: 422,
  LIMIT_REACHED: 422,
  SESSION_EXPIRED: 401,

  // FATAL — the two sides disagree about reality.
  SCHEMA_MISMATCH: 400,
  UNKNOWN_ROUND: 404,
  ROUND_CONFLICT: 409,
  ILLEGAL_TRANSITION: 409,
  MATH_VERSION_MISMATCH: 409,
  FORCE_OUTCOME_REFUSED: 403,
  NOT_IMPLEMENTED: 501,
} as const satisfies Record<ErrorCode, number>;

export const statusOf = (code: ErrorCode): number => STATUS_OF_CODE[code];

/** The error as it crosses the wire. */
export const ProtocolErrorSchema = z.object({
  class: ErrorClassSchema,
  code: ErrorCodeSchema,
  /** For humans and logs. Never branched on. */
  message: z.string(),
  /** `RECOVERABLE` only, advisory. */
  retryAfterMs: z.int().min(0).optional(),
  roundId: RoundIdSchema.optional(),
  correlationId: z.string().min(1),
});

export type ProtocolErrorPayload = z.infer<typeof ProtocolErrorSchema>;

/**
 * The thrown form. `@slot/transport` maps every failure — including network noise that never
 * reached the server — onto one of these, so the engine only ever sees a classified error.
 */
export class SlotError extends Error {
  readonly errorClass: ErrorClass;
  readonly code: ErrorCode;
  readonly correlationId: string | undefined;
  readonly roundId: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    context: {
      correlationId?: string;
      roundId?: string;
      retryAfterMs?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = 'SlotError';
    this.code = code;
    this.errorClass = classOf(code);
    this.correlationId = context.correlationId;
    this.roundId = context.roundId;
    this.retryAfterMs = context.retryAfterMs;
  }

  static fromPayload(payload: ProtocolErrorPayload): SlotError {
    return new SlotError(payload.code, payload.message, {
      ...(payload.correlationId === undefined ? {} : { correlationId: payload.correlationId }),
      ...(payload.roundId === undefined ? {} : { roundId: payload.roundId }),
      ...(payload.retryAfterMs === undefined ? {} : { retryAfterMs: payload.retryAfterMs }),
    });
  }

  get isRetryable(): boolean {
    return this.errorClass === 'RECOVERABLE';
  }
}

export const isSlotError = (value: unknown): value is SlotError => value instanceof SlotError;
