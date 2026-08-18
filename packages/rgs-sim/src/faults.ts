import type { ErrorCode } from '@slot/protocol';
import { classOf } from '@slot/protocol';
import { createPrng } from './prng.js';

/**
 * Fault injection — **decided here, enacted by the caller.**
 *
 * A pure package cannot sleep and cannot drop a connection, so this module does the part that has to
 * be deterministic (which fault, how long) and hands the rest out as data. `MockTransport` awaits the
 * delay and swallows the dropped response; `apps/mock-rgs` (S2) will do the same thing to a real
 * HTTP response. One policy, two enactments, no second implementation to drift.
 *
 * The verdict is drawn from the seeded generator keyed on the session's call counter, so **a session
 * with faults replays exactly** — including which call failed. Randomly-timed failures are the kind
 * of test you cannot re-run, and a bug you cannot re-run is a bug you do not fix.
 */

export interface FaultConfig {
  /** Applied to every call, in ms. Models a plain slow link. */
  latencyMs?: number;
  /** Uniform jitter on top of `latencyMs`: the delay is `latency + [0, jitter)`. */
  jitterMs?: number;
  /**
   * Probability per call, per code, in `[0, 1]`. Evaluated in the order given; the first hit wins.
   *
   * Any code in the taxonomy is allowed, which is deliberate: injecting a `FATAL` such as
   * `ROUND_CONFLICT` is how you find out whether the client really does freeze the reels instead of
   * retrying into a loop.
   */
  errorRates?: Partial<Record<ErrorCode, number>>;
  /**
   * Probability per mutating call that the **response is lost after the server did the work**.
   *
   * This is the fault worth having. A request that never arrived is uninteresting — nothing
   * happened. A response that vanished leaves a real, debited round on the server and a client that
   * has to retry the same `roundId` and be given the original answer. It is the exact scenario the
   * whole idempotency design exists for, and the only way to exercise it on demand.
   */
  dropRate?: number;
  /**
   * Extra delay, in ms, applied instead of `latencyMs` when a call is chosen to be slow. Set with
   * `slowRate` to exercise the client's spin timeout without failing the call outright.
   */
  slowMs?: number;
  /** Probability per call of taking `slowMs` instead of the usual delay. */
  slowRate?: number;
}

export const NO_FAULTS: FaultConfig = {};

export type FaultVerdict =
  /** Deliver normally, after `delayMs`. */
  | { readonly kind: 'PASS'; readonly delayMs: number }
  /** Reject before the handler runs, after `delayMs`. No state change beyond the call counter. */
  | { readonly kind: 'FAIL'; readonly delayMs: number; readonly code: ErrorCode }
  /** Run the handler, then deliver nothing, ever. The round happened; the answer did not arrive. */
  | { readonly kind: 'DROP' };

/** `retryAfterMs` is advisory and `RECOVERABLE`-only — the client's backoff is its own business. */
const retryAdviceFor = (code: ErrorCode, delayMs: number): number | undefined =>
  classOf(code) === 'RECOVERABLE' ? Math.max(delayMs, 100) : undefined;

export const retryAdvice = retryAdviceFor;

/**
 * Decide what happens to one call.
 *
 * `seq` is the session's call counter, so the verdict is a pure function of (seed, call number) and
 * the same session always fails in the same places.
 */
export function decideFault(config: FaultConfig, serverSeed: string, seq: number): FaultVerdict {
  const {
    latencyMs = 0,
    jitterMs = 0,
    errorRates,
    dropRate = 0,
    slowMs = 0,
    slowRate = 0,
  } = config;

  const prng = createPrng(`${serverSeed}|fault|${seq}`);

  // Drawn in a fixed order so adding a fault type later cannot silently change which call fails in
  // an existing seeded scenario.
  const dropRoll = prng.nextFloat();
  const slowRoll = prng.nextFloat();
  const jitterRoll = prng.nextFloat();

  if (dropRate > 0 && dropRoll < dropRate) return { kind: 'DROP' };

  const base = slowRate > 0 && slowRoll < slowRate ? slowMs : latencyMs;
  const delayMs = Math.round(base + jitterRoll * jitterMs);

  for (const [code, rate] of Object.entries(errorRates ?? {})) {
    if (rate !== undefined && rate > 0 && prng.nextFloat() < rate) {
      return { kind: 'FAIL', delayMs, code: code as ErrorCode };
    }
  }

  return { kind: 'PASS', delayMs };
}
