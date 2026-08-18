import type {
  AuthenticateRes,
  CallName,
  FeatureSpinRes,
  GameConfig,
  SettleRes,
  SpinRes,
} from '@slot/protocol';
import { CALLS, SlotError } from '@slot/protocol';
import { createSimConfig } from './config.js';
import { correlationIdFor } from './errors.js';
import { authenticate, featureSpin, settle, spin } from './sim.js';
import type { SimContext } from './sim.js';
import { InMemoryStore, SIM_STORE_KEY } from './store.js';
import type { SimStore } from './store.js';
import { loadState, saveState } from './state.js';
import type { SimOutcome, SimState } from './state.js';

/**
 * The stateful shell around the pure handlers: it holds the state, persists it, and validates what
 * comes in.
 *
 * Everything that is *not* pure lives here and nowhere else — the clock is a constructor argument,
 * the store is an injected port, and the handlers underneath remain `(state, request) → (state,
 * response)`. `MockTransport` (S1) and `apps/mock-rgs` (S2) both wrap this same object, which is
 * the whole reason the RTP the math tool reports is the RTP the game plays.
 *
 * Requests are parsed with the shared `@slot/protocol` schemas rather than trusted. In-process the
 * types already guarantee the shape; over HTTP they guarantee nothing, and one validation path that
 * both callers share is worth more than two that agree today.
 */

export interface SimServerOptions {
  /** Used when the store holds no usable session. */
  initialState: SimState;
  config?: GameConfig;
  store?: SimStore;
  storeKey?: string;
  /** Epoch ms. The only clock this package has, and it is injected — never read ambiently. */
  now: () => number;
}

export class SimServer {
  readonly config: GameConfig;
  readonly #store: SimStore;
  readonly #key: string;
  readonly #now: () => number;
  #state: SimState;

  constructor({
    initialState,
    config = createSimConfig(),
    store = new InMemoryStore(),
    storeKey = SIM_STORE_KEY,
    now,
  }: SimServerOptions) {
    this.config = config;
    this.#store = store;
    this.#key = storeKey;
    this.#now = now;

    const restored = loadState(store, storeKey);
    // A saved session from a different server seed is a different game. Discarding it is the same
    // rule the persistence envelope applies to a version bump: start clean, let `authenticate`
    // re-establish the truth, never half-restore.
    this.#state =
      restored !== null && restored.serverSeed === initialState.serverSeed
        ? restored
        : initialState;
  }

  /** The current state. Readable for tests, the debug panel and the math tool — never mutated. */
  get state(): SimState {
    return this.#state;
  }

  authenticate(request: unknown): AuthenticateRes {
    return this.#run('authenticate', request, authenticate);
  }

  spin(request: unknown): SpinRes {
    return this.#run('spin', request, spin);
  }

  featureSpin(request: unknown): FeatureSpinRes {
    return this.#run('featureSpin', request, featureSpin);
  }

  settle(request: unknown): SettleRes {
    return this.#run('settle', request, settle);
  }

  /** Forget the session. The store key is cleared too, so a reload does not resurrect it. */
  reset(state: SimState): void {
    this.#state = state;
    this.#store.remove(this.#key);
  }

  #run<N extends CallName, Req, Res>(
    call: N,
    request: unknown,
    handler: (state: SimState, request: Req, context: SimContext) => SimOutcome<Res>,
  ): Res {
    const now = this.#now();
    const parsed = CALLS[call].req.safeParse(request);

    if (!parsed.success) {
      // The counter still advances: a malformed request is a call that happened, and its
      // correlation id has to appear in the log like any other.
      this.#state = { ...this.#state, seq: this.#state.seq + 1 };
      this.#persist(now);
      throw new SlotError(
        'SCHEMA_MISMATCH',
        `${call} request failed validation: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`,
        { correlationId: correlationIdFor(this.#state.seq) },
      );
    }

    const outcome = handler(this.#state, parsed.data as Req, { config: this.config, now });
    this.#state = outcome.state;
    this.#persist(now);

    if (!outcome.ok) throw SlotError.fromPayload(outcome.error);
    return outcome.response;
  }

  #persist(now: number): void {
    saveState(this.#store, this.#key, this.#state, now);
  }
}
