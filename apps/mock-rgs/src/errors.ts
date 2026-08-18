import type { ErrorCode, ProtocolErrorPayload } from '@slot/protocol';
import { SlotError, classOf } from '@slot/protocol';

/**
 * The error taxonomy, given HTTP status codes.
 *
 * A status is not how the client decides what to do — it branches on the `class`, which is derived
 * from the `code`, which is in the body. The status is for everything *between* the two: a proxy log,
 * a load-balancer health rule, a `curl` in a terminal. Getting it wrong would not break the game and
 * would make every operations conversation about this service worse.
 *
 * `satisfies Record<ErrorCode, number>` is the same discipline as `CLASS_OF_CODE`: a new error code
 * cannot be added to the protocol without someone deciding what it looks like on the wire.
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
} as const satisfies Record<ErrorCode, number>;

export const statusOf = (code: ErrorCode): number => STATUS_OF_CODE[code];

/**
 * The wire form of an error, with the HTTP request's correlation id rather than the simulator's.
 *
 * The sim numbers its calls (`sim-000042`) because a pure package cannot mint a uuid and a replayed
 * session should replay its ids. Over HTTP that value is no longer unique — two sessions produce the
 * same ids — so the request id wins in the body, and the sim's own id goes to the log line beside it.
 * One is for correlating a player's report with a server log; the other is for correlating two runs
 * of the same seed with each other.
 */
export const errorBody = (error: SlotError, correlationId: string): ProtocolErrorPayload => ({
  class: classOf(error.code),
  code: error.code,
  message: error.message,
  correlationId,
  ...(error.roundId === undefined ? {} : { roundId: error.roundId }),
  ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
});

/**
 * Anything Fastify threw before or instead of the simulator.
 *
 * A malformed body never reaches `SimServer` — Fastify rejects it at the JSON parser — so it has to
 * be classified here, and it is the same `SCHEMA_MISMATCH` the sim would have produced. Everything
 * else is this server failing, which is `RECOVERABLE`: the client retries with the same `roundId`
 * and the round is either replayed or freshly played, both of them correct.
 */
export const classifyFrameworkError = (error: unknown): SlotError => {
  const { statusCode, message } = (error ?? {}) as { statusCode?: number; message?: string };
  const status = statusCode ?? 500;

  const detail = message ?? 'the request failed before the simulator saw it';

  // 400/415 is Fastify's own JSON parser refusing the body — the same `SCHEMA_MISMATCH` the
  // simulator would have produced had the body reached it.
  if (status === 400 || status === 404 || status === 415) {
    return new SlotError('SCHEMA_MISMATCH', detail);
  }
  return new SlotError('UPSTREAM_UNAVAILABLE', detail);
};
