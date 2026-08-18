import type { ErrorCode, ProtocolErrorPayload, RoundId } from '@slot/protocol';
import { classOf } from '@slot/protocol';

/**
 * Correlation ids, from the session's call counter rather than a uuid.
 *
 * A pure package cannot mint a random id, and it turns out it should not want to: a replayed
 * session produces replayed ids, so the debug panel's exported event log (C7) lines up between two
 * runs of the same seed. `apps/mock-rgs` overrides this with a per-request id from the HTTP layer,
 * where the value has to be unique across sessions rather than reproducible within one.
 */
export const correlationIdFor = (seq: number): string => `sim-${seq.toString(10).padStart(6, '0')}`;

/**
 * Build the wire form of an error.
 *
 * The class is never passed in — it is derived from the code by `@slot/protocol`, so the simulator
 * cannot mislabel one and thereby change what the client does about it.
 */
export const errorPayload = (
  seq: number,
  code: ErrorCode,
  message: string,
  roundId?: RoundId,
): ProtocolErrorPayload => ({
  class: classOf(code),
  code,
  message,
  correlationId: correlationIdFor(seq),
  ...(roundId === undefined ? {} : { roundId }),
});
