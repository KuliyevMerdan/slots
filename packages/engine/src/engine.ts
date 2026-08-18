import type {
  AuthenticateReq,
  AuthenticateRes,
  FeatureSpinReq,
  FeatureSpinRes,
  ForceOutcome,
  RoundIdFactory,
  SettleReq,
  SettleRes,
  SpinReq,
  SpinRes,
} from '@slot/protocol';
import { SlotError, isSlotError } from '@slot/protocol';
import { initialState, reduce } from './reduce.js';
import type { EngineEffect, EngineEvent, EngineInput, EngineState } from './types.js';

/**
 * The driver: it holds the state, runs the reducer, performs the effects and publishes the events.
 *
 * Same split as `rgs-sim` — a pure core with a thin stateful shell — and for the same reason. All
 * the interesting rules live in `reduce.ts` where a test can drive them a thousand rounds deep
 * without a network; this class only does the parts that are inherently effectful.
 *
 * **It does not import `@slot/transport`.** The dependency table says `engine → protocol, money,
 * game-math`, so the transport arrives as `RgsPort`, a structural interface any `RgsTransport`
 * already satisfies. Third time the workspace has reached for this shape (see ADR-0003), and it
 * keeps paying: the engine's tests drive a stub, and the engine ships without a transport attached.
 */

/** The four calls the engine needs. `RgsTransport` satisfies this without knowing it exists. */
export interface RgsPort {
  authenticate(request: AuthenticateReq): Promise<AuthenticateRes>;
  spin(request: SpinReq): Promise<SpinRes>;
  featureSpin(request: FeatureSpinReq): Promise<FeatureSpinRes>;
  settle(request: SettleReq): Promise<SettleRes>;
}

export type EngineListener = (event: EngineEvent, state: EngineState) => void;

export interface SlotEngineOptions {
  port: RgsPort;
  /** Injected: this package may not reach for `crypto`, any more than it may for a clock. */
  newRoundId: RoundIdFactory;
  /**
   * A development hook: what the next base spin should be forced to, if anything.
   *
   * The client only wires one behind `__DEV_TOOLS__`, and the server refuses the field outside dev
   * mode — two independent gates, neither of them here. See `ReduceContext.forceOutcome`.
   */
  forceOutcome?: () => ForceOutcome | undefined;
}

export class SlotEngine {
  readonly #port: RgsPort;
  readonly #newRoundId: RoundIdFactory;
  readonly #forceOutcome: (() => ForceOutcome | undefined) | undefined;
  readonly #listeners = new Set<EngineListener>();
  #state: EngineState = initialState;
  /** Effects run one at a time, in order — a round is a sequence, not a fan-out. */
  #draining: Promise<void> = Promise.resolve();

  constructor({ port, newRoundId, forceOutcome }: SlotEngineOptions) {
    this.#port = port;
    this.#newRoundId = newRoundId;
    this.#forceOutcome = forceOutcome;
  }

  get state(): EngineState {
    return this.#state;
  }

  /** Subscribe. Returns the unsubscribe function, which the renderer calls on teardown. */
  on(listener: EngineListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Start the session — and resume a round that was left in flight, if there is one. */
  async start(token: string): Promise<void> {
    try {
      const response = await this.#port.authenticate({ token });
      this.send({ type: 'AUTHENTICATED', response });
    } catch (error) {
      this.send({ type: 'CALL_FAILED', error: asSlotError(error) });
    }
    await this.settled();
  }

  /**
   * Apply an input. Synchronous by design: the reducer decides immediately, and any calls it asked
   * for are queued behind whatever is already in flight.
   */
  send(input: EngineInput): EngineState {
    const transition = reduce(this.#state, input, {
      newRoundId: this.#newRoundId,
      ...(this.#forceOutcome === undefined ? {} : { forceOutcome: this.#forceOutcome }),
    });
    this.#state = transition.state;

    for (const event of transition.events) this.#emit(event);
    for (const effect of transition.effects) this.#enqueue(effect);

    return this.#state;
  }

  /** Resolves once every queued call has been made and its result fed back in. */
  async settled(): Promise<void> {
    // Re-read each time: performing one effect can enqueue the next, and the round is not idle
    // until the chain stops growing.
    let seen: Promise<void>;
    do {
      seen = this.#draining;
      await seen;
    } while (seen !== this.#draining);
  }

  #emit(event: EngineEvent): void {
    for (const listener of this.#listeners) listener(event, this.#state);
  }

  #enqueue(effect: EngineEffect): void {
    this.#draining = this.#draining.then(() => this.#perform(effect));
  }

  async #perform(effect: EngineEffect): Promise<void> {
    try {
      switch (effect.type) {
        case 'CALL_SPIN':
          this.send({ type: 'SPIN_RESOLVED', response: await this.#port.spin(effect.request) });
          return;
        case 'CALL_FEATURE_SPIN':
          this.send({
            type: 'FEATURE_SPIN_RESOLVED',
            response: await this.#port.featureSpin(effect.request),
          });
          return;
        case 'CALL_SETTLE':
          this.send({ type: 'SETTLE_RESOLVED', response: await this.#port.settle(effect.request) });
          return;
      }
    } catch (error) {
      this.send({ type: 'CALL_FAILED', error: asSlotError(error) });
    }
  }
}

/**
 * A safety net, not the classification layer.
 *
 * `@slot/transport` maps every failure onto the taxonomy before it gets here, so in practice this
 * only fires for a port that is not a transport — a stub in a test, or a future implementation that
 * forgot. `UPSTREAM_UNAVAILABLE` keeps such a slip recoverable rather than turning it into a freeze.
 */
const asSlotError = (error: unknown): SlotError =>
  isSlotError(error)
    ? error
    : new SlotError(
        'UPSTREAM_UNAVAILABLE',
        `the transport threw something that was not a SlotError: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
