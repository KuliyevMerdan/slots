import type { CallName, CallRequest, CallResponse } from '@slot/protocol';
import { NotImplementedError } from '../errors.js';

/**
 * The round lifecycle, as a service the HTTP layer dispatches into.
 *
 * The shape is the `CALLS` table made into methods — one per call, request in, response out — which
 * is deliberately the same surface `RgsTransport` has on the client side: the wire is symmetric,
 * and both ends of it are generated from the one table in `@slot/protocol` rather than hand-kept in
 * step.
 *
 * R1 builds the real one: the round machine `OPEN → RESOLVED → SETTLED` in a transaction, replay
 * from the idempotency store, `pendingRound` from the round repository. R5 threads the session
 * through (which is why nothing here takes a player id yet — the token travels in the
 * `authenticate` request, and what it resolves to is R5's to define). Until then every method
 * throws, and the HTTP layer has already validated the request by the time it does — so the
 * refusal provably means "not built", never "not understood".
 */
export type RoundService = {
  [N in CallName]: (request: CallRequest<N>) => Promise<CallResponse<N>>;
};

/** Which block turns each stub real — printed in the error, asserted by nothing. */
const BUILT_BY: Record<CallName, string> = {
  authenticate: 'R1, R5',
  spin: 'R1',
  featureSpin: 'R1',
  settle: 'R1',
  history: 'R1',
};

const stub = <N extends CallName>(
  call: N,
): ((request: CallRequest<N>) => Promise<CallResponse<N>>) =>
  (() => Promise.reject(new NotImplementedError(`domain/rounds.${call} (${BUILT_BY[call]})`))) as (
    request: CallRequest<N>,
  ) => Promise<CallResponse<N>>;

export const notImplementedRounds = (): RoundService => ({
  authenticate: stub('authenticate'),
  spin: stub('spin'),
  featureSpin: stub('featureSpin'),
  settle: stub('settle'),
  history: stub('history'),
});
