import type {
  AuthenticateReq,
  AuthenticateRes,
  CallName,
  CallResponse,
  FeatureSpinReq,
  FeatureSpinRes,
  HistoryReq,
  HistoryRes,
  SettleReq,
  SettleRes,
  SpinReq,
  SpinRes,
} from '@slot/protocol';

/**
 * `RgsTransport` — the seam the whole architecture hangs on.
 *
 * The client depends on this interface and on `@slot/protocol`, never on a server implementation.
 * Swapping the in-process simulator for a real RGS is a change of which object is constructed at
 * boot, which is what makes "swap the transport URL" a credible claim rather than a slogan.
 *
 * One method per call in `@slot/protocol`'s `CALLS` table. Everything else a transport does — timeout, exponential
 * backoff retrying the same `roundId`, mapping network noise onto the error taxonomy — happens
 * *behind* this interface, so the engine only ever sees a classified `SlotError`. That policy layer
 * is `withRetry` in retry.ts.
 *
 * `options` is optional on every method, which is what keeps the engine's `RgsPort` — four
 * one-argument methods — satisfied by any transport without the engine ever learning that
 * cancellation exists.
 */
export interface RgsTransport {
  authenticate(request: AuthenticateReq, options?: CallOptions): Promise<AuthenticateRes>;
  spin(request: SpinReq, options?: CallOptions): Promise<SpinRes>;
  featureSpin(request: FeatureSpinReq, options?: CallOptions): Promise<FeatureSpinRes>;
  settle(request: SettleReq, options?: CallOptions): Promise<SettleRes>;
  /** Read-only, and outside the round lifecycle — which is why the engine's port does not have it. */
  history(request: HistoryReq, options?: CallOptions): Promise<HistoryRes>;
}

/**
 * What the policy layer passes down to the implementation.
 *
 * The only member is the signal `ResilientTransport` aborts when an attempt runs out of clock.
 * Without it the timeout is a lie told to the caller: the promise rejects, the reels stop waiting,
 * and the request carries on holding a connection until the server answers into nothing. A slot on a
 * bad mobile link retries three times, so that is three abandoned sockets per spin.
 *
 * An implementation may ignore it — `MockTransport` does, because a dropped in-process response is
 * modelled as a promise that never settles and there is no socket to reclaim.
 */
export interface CallOptions {
  readonly signal?: AbortSignal;
}

/**
 * What an in-process backend hands back for one call.
 *
 * Note that this package **does not import `@slot/rgs-sim`** — the dependency table says
 * `transport → protocol` and nothing else, so the simulator is injected and matched structurally
 * rather than depended on. Same reasoning as ADR-0003: the thing that needs the platform takes it as
 * an argument. It also means `transport` stays shippable without the simulator attached, and a test
 * can drive `MockTransport` with a twelve-line fake.
 */
export type BackendDelivery<T> =
  /** Answer with `response`, after `delayMs`. */
  | { readonly kind: 'DELIVER'; readonly delayMs: number; readonly response: T }
  /** Answer with `error`, after `delayMs`. */
  | { readonly kind: 'REJECT'; readonly delayMs: number; readonly error: Error }
  /** Never answer: the call was executed and its response was lost in flight. */
  | { readonly kind: 'DROP' };

export interface InProcessBackend {
  deliver<N extends CallName>(call: N, request: unknown): BackendDelivery<CallResponse<N>>;
}
