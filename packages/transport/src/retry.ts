import type {
  AuthenticateReq,
  AuthenticateRes,
  ErrorCode,
  FeatureSpinReq,
  FeatureSpinRes,
  SettleReq,
  SettleRes,
  SpinReq,
  SpinRes,
} from '@slot/protocol';
import { SlotError, isSlotError } from '@slot/protocol';
import type { CallOptions, RgsTransport } from './transport.js';

/**
 * Timeout, retry and error classification — the policy half of the seam.
 *
 * A decorator rather than a base class, so `MockTransport` and `HttpTransport` share one
 * implementation of the rules instead of two that agree until they don't. It is also why the rules
 * are testable without a server: wrap a stub, make it misbehave, watch what comes out.
 *
 * Three rules, and they are the whole point:
 *
 * 1. **Only `RECOVERABLE` errors are retried.** A `PLAYER` error means retrying changes nothing —
 *    the player still has no funds. A `FATAL` error means the client and server disagree about
 *    reality, and hammering the endpoint cannot fix that.
 * 2. **A retry re-sends the identical request**, so the `roundId` is unchanged and the server
 *    replays rather than re-spins. That single fact is what makes a network failure mid-spin a
 *    presentation problem rather than a money problem.
 * 3. **The engine never sees raw network noise.** A rejected `fetch`, an aborted request, a parse
 *    failure — all of it is mapped onto the taxonomy here, so the state machine downstream can
 *    branch on a class and never on a message string.
 *
 * It also owns cancellation, because it owns the clock: each attempt gets its own `AbortSignal`,
 * aborted the moment that attempt times out. An implementation that talks to a network is expected
 * to hang the request off it; one that does not may ignore it.
 */

export interface RetryPolicy {
  /** How long one attempt may take before it is abandoned as a `TIMEOUT`. `0` disables the clock. */
  timeoutMs: number;
  /** Retries *after* the first attempt. `0` means try once. */
  maxRetries: number;
  /** The first backoff, doubled (by `factor`) on each subsequent retry. */
  baseDelayMs: number;
  factor: number;
  maxDelayMs: number;
  /** Fraction of the computed delay to randomise, in `[0, 1]`. */
  jitter: number;
}

/**
 * Tuned for a slot, where the player is watching reels spin while this happens.
 *
 * Eight seconds is long enough to survive a bad mobile handover and short enough that the reels do
 * not spin forever on a dead connection; three retries with a 300 ms base gives roughly 300 / 600 /
 * 1200 ms, so the worst case stays inside what a spin animation can plausibly cover.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  timeoutMs: 8_000,
  maxRetries: 3,
  baseDelayMs: 300,
  factor: 2,
  maxDelayMs: 5_000,
  jitter: 0.25,
};

export interface RetryAttempt {
  call: string;
  /** 1 for the first retry. */
  attempt: number;
  delayMs: number;
  error: SlotError;
}

export interface ResilientTransportOptions {
  policy?: Partial<RetryPolicy>;
  /** Injected so tests do not wait out a backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so a seeded test gets a deterministic jitter. */
  random?: () => number;
  /**
   * Called before each retry. The debug panel's event log (C7) and any telemetry seam hang here —
   * a retry the player never sees is exactly the thing you want in a log.
   */
  onRetry?: (attempt: RetryAttempt) => void;
}

const wait = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Race an attempt against the clock, cancelling the timer when the attempt wins.
 *
 * Leaving the timer running would keep a handle alive for every call the game ever makes, which on
 * a long session is a slow leak in the one place nobody looks.
 */
function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  timedOut: () => Error,
  onTimeout: () => void,
): Promise<T> {
  if (ms <= 0) return work;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Order matters only for readability: the caller is told first, and the attempt it is no
      // longer waiting for is cancelled behind it.
      reject(timedOut());
      onTimeout();
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Everything that is not already a `SlotError` becomes one.
 *
 * `UPSTREAM_UNAVAILABLE` rather than `TIMEOUT` because the request may well have arrived — this is
 * the "we do not know what happened" bucket, and it is `RECOVERABLE` precisely so the retry can find
 * out by asking again with the same key.
 */
const classify = (error: unknown, call: string): SlotError => {
  if (isSlotError(error)) return error;

  const detail = error instanceof Error ? error.message : String(error);
  return new SlotError(
    'UPSTREAM_UNAVAILABLE',
    `${call} failed before it reached the game: ${detail}`,
    {
      cause: error,
    },
  );
};

export class ResilientTransport implements RgsTransport {
  readonly #inner: RgsTransport;
  readonly #policy: RetryPolicy;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #onRetry: ((attempt: RetryAttempt) => void) | undefined;

  constructor(inner: RgsTransport, options: ResilientTransportOptions = {}) {
    this.#inner = inner;
    this.#policy = { ...DEFAULT_RETRY_POLICY, ...options.policy };
    this.#sleep = options.sleep ?? wait;
    this.#random = options.random ?? Math.random;
    this.#onRetry = options.onRetry;
  }

  authenticate(request: AuthenticateReq): Promise<AuthenticateRes> {
    return this.#call('authenticate', (options) => this.#inner.authenticate(request, options));
  }

  spin(request: SpinReq): Promise<SpinRes> {
    return this.#call('spin', (options) => this.#inner.spin(request, options));
  }

  featureSpin(request: FeatureSpinReq): Promise<FeatureSpinRes> {
    return this.#call('featureSpin', (options) => this.#inner.featureSpin(request, options));
  }

  settle(request: SettleReq): Promise<SettleRes> {
    return this.#call('settle', (options) => this.#inner.settle(request, options));
  }

  /**
   * The delay before retry `attempt` (1-based).
   *
   * A server that said `retryAfterMs` wins outright: it knows something we do not — a rate limit
   * window, a wallet coming back up — and second-guessing it is how a client turns a brief outage
   * into a sustained one.
   */
  #backoffFor(attempt: number, error: SlotError): number {
    if (error.retryAfterMs !== undefined) return error.retryAfterMs;

    const { baseDelayMs, factor, maxDelayMs, jitter } = this.#policy;
    const exponential = Math.min(baseDelayMs * factor ** (attempt - 1), maxDelayMs);
    return Math.round(exponential * (1 - jitter + this.#random() * jitter));
  }

  async #call<T>(call: string, attemptOnce: (options: CallOptions) => Promise<T>): Promise<T> {
    const timedOut = (): Error =>
      new SlotError('TIMEOUT', `${call} did not answer within ${this.#policy.timeoutMs}ms`);

    let failure: SlotError | undefined;

    for (let attempt = 0; attempt <= this.#policy.maxRetries; attempt += 1) {
      if (attempt > 0 && failure !== undefined) {
        const delayMs = this.#backoffFor(attempt, failure);
        this.#onRetry?.({ call, attempt, delayMs, error: failure });
        await this.#sleep(delayMs);
      }

      // One controller per attempt: aborting the attempt that ran out of clock must not cancel the
      // retry that replaces it.
      const controller = new AbortController();

      try {
        // `attemptOnce` closes over the *same* request object every time. That is the idempotency
        // guarantee in one line: no retry ever mints a new `roundId`.
        return await withTimeout(
          attemptOnce({ signal: controller.signal }),
          this.#policy.timeoutMs,
          timedOut,
          () => {
            controller.abort();
          },
        );
      } catch (error) {
        failure = classify(error, call);
        if (!failure.isRetryable) throw failure;
      }
    }

    throw failure ?? new SlotError('UPSTREAM_UNAVAILABLE' satisfies ErrorCode, `${call} failed`);
  }
}

/** Wrap any transport in the policy. The client composes `withRetry(new MockTransport(...))`. */
export const withRetry = (inner: RgsTransport, options?: ResilientTransportOptions): RgsTransport =>
  new ResilientTransport(inner, options);
