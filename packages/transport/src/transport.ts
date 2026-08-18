import type {
  AuthenticateReq,
  AuthenticateRes,
  CallName,
  CallResponse,
  FeatureSpinReq,
  FeatureSpinRes,
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
 * Four methods, matching the four calls. Everything else a transport does — timeout, exponential
 * backoff retrying the same `roundId`, mapping network noise onto the error taxonomy — happens
 * *behind* this interface, so the engine only ever sees a classified `SlotError`. That policy layer
 * is block C2; this package currently ships the seam and the in-process implementation.
 */
export interface RgsTransport {
  authenticate(request: AuthenticateReq): Promise<AuthenticateRes>;
  spin(request: SpinReq): Promise<SpinRes>;
  featureSpin(request: FeatureSpinReq): Promise<FeatureSpinRes>;
  settle(request: SettleReq): Promise<SettleRes>;
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
