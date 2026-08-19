import type { ProtocolErrorPayload } from '@slot/protocol';
import { SlotError, classOf } from '@slot/protocol';

/**
 * The status table lived here until R0. It moved to `@slot/protocol` (`STATUS_OF_CODE`) the day a
 * second server started implementing the binding — `apps/rgs` — because two copies of a table that
 * must agree exactly is one copy too many. Re-exported so this package's public surface is
 * unchanged; everything below is what is genuinely this server's: the wire form of an error body,
 * and the classification of failures Fastify produced before the simulator saw the request.
 */
export { STATUS_OF_CODE, statusOf } from '@slot/protocol';

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

  // 400/415 is Fastify's own JSON parser refusing the body, and 413 is the body-size cap — in
  // every case a request no honest build of the client produces, and one a retry would only repeat.
  // The same `SCHEMA_MISMATCH` the simulator would have produced had the body reached it.
  if (status === 400 || status === 404 || status === 413 || status === 415) {
    return new SlotError('SCHEMA_MISMATCH', detail);
  }
  return new SlotError('UPSTREAM_UNAVAILABLE', detail);
};
