import type {
  AuthenticateReq,
  AuthenticateRes,
  CallName,
  CallResponse,
  FeatureSpinReq,
  FeatureSpinRes,
  GameConfig,
  HistoryReq,
  HistoryRes,
  SettleReq,
  SettleRes,
  SpinReq,
  SpinRes,
} from '@slot/protocol';
import { CALLS, SlotError } from '@slot/protocol';
import { createSimConfig } from './config.js';
import { correlationIdFor, errorPayload } from './errors.js';
import { NO_FAULTS, decideFault, retryAdvice } from './faults.js';
import type { FaultConfig } from './faults.js';
import { authenticate, featureSpin, history, settle, spin } from './sim.js';
import { InMemoryStore, SIM_STORE_KEY } from './store.js';
import type { SimStore } from './store.js';
import { loadState, saveState } from './state.js';
import type { SimState } from './state.js';

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
 *
 * Two ways in, on purpose. The four typed methods are the direct path — no faults, throw on error —
 * and are what tests and `tools/math-sim` want. `deliver()` is the fault-aware path a transport
 * uses: it returns what *should* happen, including how long to wait and whether to answer at all,
 * because a pure package cannot sleep and cannot drop a connection.
 */

/**
 * How long a freshly issued demo session lives. Long enough that expiry never interrupts a dev
 * loop by accident; short enough to be a real fact rather than a forever.
 */
export const DEMO_SESSION_TTL_MS = 12 * 3_600_000;

export type SimDelivery<T> =
  /** Answer with `response`, after waiting `delayMs`. */
  | { readonly kind: 'DELIVER'; readonly delayMs: number; readonly response: T }
  /** Answer with `error`, after waiting `delayMs`. */
  | { readonly kind: 'REJECT'; readonly delayMs: number; readonly error: SlotError }
  /**
   * Never answer. The call **was** executed and the state moved — this is a lost response, not a
   * lost request, which is precisely the case idempotency exists to survive.
   */
  | { readonly kind: 'DROP' };

export interface SimServerOptions {
  /** Used when the store holds no usable session. */
  initialState: SimState;
  config?: GameConfig;
  store?: SimStore;
  storeKey?: string;
  /** Epoch ms. The only clock this package has, and it is injected — never read ambiently. */
  now: () => number;
  /** Fault injection. Off by default; toggle at runtime with `setFaults`. */
  faults?: FaultConfig;
}

type Executed<T> =
  { readonly ok: true; readonly response: T } | { readonly ok: false; readonly error: SlotError };

export class SimServer {
  readonly config: GameConfig;
  readonly #store: SimStore;
  readonly #key: string;
  readonly #now: () => number;
  #state: SimState;
  #faults: FaultConfig;

  constructor({
    initialState,
    config = createSimConfig(),
    store = new InMemoryStore(),
    storeKey = SIM_STORE_KEY,
    now,
    faults = NO_FAULTS,
  }: SimServerOptions) {
    this.config = config;
    this.#store = store;
    this.#key = storeKey;
    this.#now = now;
    this.#faults = faults;

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

  get faults(): FaultConfig {
    return this.#faults;
  }

  /** Runtime-toggleable, which is the point: the debug panel flips these mid-session. */
  setFaults(faults: FaultConfig): void {
    this.#faults = faults;
  }

  authenticate(request: unknown): AuthenticateRes {
    return this.#direct('authenticate', request);
  }

  spin(request: unknown): SpinRes {
    return this.#direct('spin', request);
  }

  featureSpin(request: unknown): FeatureSpinRes {
    return this.#direct('featureSpin', request);
  }

  settle(request: unknown): SettleRes {
    return this.#direct('settle', request);
  }

  history(request: unknown): HistoryRes {
    return this.#direct('history', request);
  }

  /** Forget the session. The store key is cleared too, so a reload does not resurrect it. */
  reset(state: SimState): void {
    this.#state = state;
    this.#store.remove(this.#key);
  }

  /**
   * The operator's lobby, faked: issue — or **renew** — the demo session (docs/protocol.md §7).
   *
   * Renewal is the point. The token re-attaches to the same balance and the same `pendingRound`,
   * which is what makes the §5 mid-round recovery playable: an expired session re-authenticates
   * with a token from here and resumes exactly where the round was. Not a wire call, so it does not
   * advance `seq` — the lobby is outside the game contract.
   */
  issueSession(ttlMs: number = DEMO_SESSION_TTL_MS): { token: string } {
    this.#state = {
      ...this.#state,
      session: { ...this.#state.session, expiresAt: this.#now() + ttlMs },
    };
    this.#persist();
    return { token: this.#state.token };
  }

  /**
   * End the session now — the producer the expiry path needs on demand.
   *
   * A test or the debug panel calls this mid-round and the next call fails `SESSION_EXPIRED`,
   * which is otherwise a twelve-hour wait.
   */
  expireSession(): void {
    this.#state = {
      ...this.#state,
      session: { ...this.#state.session, expiresAt: this.#now() },
    };
    this.#persist();
  }

  /**
   * The fault-aware entry point.
   *
   * Note the ordering, which is the whole design: a `FAIL` is decided **before** the handler runs,
   * so nothing happened and a retry is a fresh attempt; a `DROP` runs the handler **first**, so the
   * round is real and a retry with the same key must replay it.
   */
  deliver<N extends CallName>(call: N, request: unknown): SimDelivery<CallResponse<N>> {
    const verdict = decideFault(this.#faults, this.#state.serverSeed, this.#state.seq + 1);

    if (verdict.kind === 'FAIL') {
      const seq = this.#state.seq + 1;
      this.#state = { ...this.#state, seq };
      this.#persist();
      const payload = errorPayload(seq, verdict.code, `injected fault on ${call}`);
      const advice = retryAdvice(verdict.code, verdict.delayMs);
      return {
        kind: 'REJECT',
        delayMs: verdict.delayMs,
        error: SlotError.fromPayload(
          advice === undefined ? payload : { ...payload, retryAfterMs: advice },
        ),
      };
    }

    const executed = this.#execute(call, request);
    if (verdict.kind === 'DROP') return { kind: 'DROP' };

    return executed.ok
      ? { kind: 'DELIVER', delayMs: verdict.delayMs, response: executed.response }
      : { kind: 'REJECT', delayMs: verdict.delayMs, error: executed.error };
  }

  #direct<N extends CallName>(call: N, request: unknown): CallResponse<N> {
    const executed = this.#execute(call, request);
    if (!executed.ok) throw executed.error;
    return executed.response;
  }

  #execute<N extends CallName>(call: N, request: unknown): Executed<CallResponse<N>> {
    const now = this.#now();
    const parsed = CALLS[call].req.safeParse(request);

    if (!parsed.success) {
      // The counter still advances: a malformed request is a call that happened, and its
      // correlation id has to appear in the log like any other.
      this.#state = { ...this.#state, seq: this.#state.seq + 1 };
      this.#persist();
      return {
        ok: false,
        error: new SlotError(
          'SCHEMA_MISMATCH',
          `${call} request failed validation: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.')} ${issue.message}`)
            .join('; ')}`,
          { correlationId: correlationIdFor(this.#state.seq) },
        ),
      };
    }

    const context = { config: this.config, now };
    const state = this.#state;

    // A switch rather than a handler map: the four calls take four different request types, and a
    // map would type them as a union no call site could satisfy. The casts are safe because each
    // branch parses with that call's own schema, one line above.
    const outcome =
      call === 'authenticate'
        ? authenticate(state, parsed.data as AuthenticateReq, context)
        : call === 'spin'
          ? spin(state, parsed.data as SpinReq, context)
          : call === 'featureSpin'
            ? featureSpin(state, parsed.data as FeatureSpinReq, context)
            : call === 'settle'
              ? settle(state, parsed.data as SettleReq, context)
              : history(state, parsed.data as HistoryReq, context);

    this.#state = outcome.state;
    this.#persist();

    return outcome.ok
      ? { ok: true, response: outcome.response as CallResponse<N> }
      : { ok: false, error: SlotError.fromPayload(outcome.error) };
  }

  #persist(): void {
    saveState(this.#store, this.#key, this.#state, this.#now());
  }
}
