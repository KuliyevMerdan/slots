import type { ProtocolErrorPayload } from '@slot/protocol';
import { SlotError, classOf } from '@slot/protocol';
import { isNotImplemented } from '../errors.js';

/**
 * Everything this server throws, classified onto the wire.
 *
 * The status comes from `STATUS_OF_CODE` in `@slot/protocol` — the binding both servers share —
 * and the body is the `ProtocolError` of docs/protocol.md §6, built here. The client branches on
 * the `class` in the body, which `SlotError` derives from the code; the status is for the proxy
 * log and the `curl`.
 */

export const errorBody = (error: SlotError, correlationId: string): ProtocolErrorPayload => ({
  class: classOf(error.code),
  code: error.code,
  message: error.message,
  correlationId,
  ...(error.roundId === undefined ? {} : { roundId: error.roundId }),
});

/**
 * Map whatever reached the error handler onto a `SlotError`.
 *
 * Three cases, in honesty order. A `NotImplementedError` is this skeleton's own answer —
 * `NOT_IMPLEMENTED`, the code D10 added for exactly this server. A `SlotError` passes through:
 * the request validation throws them already classified. Everything else is Fastify failing
 * before the domain was reached — a body the JSON parser refused, an oversized payload — and is
 * `SCHEMA_MISMATCH` when the framework blamed the request (4xx), `UPSTREAM_UNAVAILABLE` when it
 * did not.
 */
export const classifyError = (error: unknown): SlotError => {
  if (isNotImplemented(error)) {
    return new SlotError('NOT_IMPLEMENTED', error.message);
  }
  if (error instanceof SlotError) {
    return error;
  }

  const { statusCode, message } = (error ?? {}) as { statusCode?: number; message?: string };
  const status = statusCode ?? 500;
  const detail = message ?? 'the request failed before the domain saw it';

  if (status >= 400 && status < 500) {
    return new SlotError('SCHEMA_MISMATCH', detail);
  }
  return new SlotError('UPSTREAM_UNAVAILABLE', detail);
};
