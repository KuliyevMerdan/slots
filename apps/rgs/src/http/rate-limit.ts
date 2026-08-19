/**
 * Rate limiting on the game routes (R5) — a token bucket per key, two keyings: the session token
 * (one player cannot monopolize the server) and the client IP (one machine cannot either, tokens
 * or not). Hand-rolled rather than a plugin for the usual reasons in this codebase: the clock is
 * injected so the tests replay, the refusal speaks the protocol's own `RATE_LIMITED` shape with
 * `retryAfterMs` the client's retry policy already honours, and the whole policy is thirty lines
 * someone can read.
 *
 * The bucket: `capacity` calls may arrive at once; they refill at `refillPerSecond`. A refused
 * call consumes nothing and reports when the next token lands — the server knows something the
 * client does not (§6), so it says so.
 */

export interface RateLimitVerdict {
  allowed: boolean;
  /** When refused: how long until a token is available. 0 when allowed. */
  retryAfterMs: number;
}

export interface TokenBucketOptions {
  capacity: number;
  refillPerSecond: number;
  /** Epoch ms. Injected — tests replay; `main.ts` hands in the wall clock. */
  now: () => number;
  /** Keys tracked before full buckets are swept. A bound, not a behaviour. */
  maxKeys?: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class TokenBucketLimiter {
  readonly #capacity: number;
  readonly #refillPerSecond: number;
  readonly #now: () => number;
  readonly #maxKeys: number;
  #buckets = new Map<string, Bucket>();

  constructor({ capacity, refillPerSecond, now, maxKeys = 10_000 }: TokenBucketOptions) {
    if (capacity < 1 || refillPerSecond <= 0) {
      throw new RangeError('a limiter needs capacity >= 1 and a positive refill rate');
    }
    this.#capacity = capacity;
    this.#refillPerSecond = refillPerSecond;
    this.#now = now;
    this.#maxKeys = maxKeys;
  }

  take(key: string): RateLimitVerdict {
    const at = this.#now();
    const bucket = this.#buckets.get(key) ?? { tokens: this.#capacity, at };

    const refilled = Math.min(
      this.#capacity,
      bucket.tokens + ((at - bucket.at) / 1_000) * this.#refillPerSecond,
    );

    if (refilled < 1) {
      // Consume nothing: a refused call must not push the window it is being refused for.
      this.#buckets.set(key, { tokens: refilled, at });
      return {
        allowed: false,
        retryAfterMs: Math.ceil(((1 - refilled) / this.#refillPerSecond) * 1_000),
      };
    }

    if (!this.#buckets.has(key)) this.#sweep(at);
    this.#buckets.set(key, { tokens: refilled - 1, at });
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Drop keys whose buckets would read full — refilled long ago, holding memory for nobody. */
  #sweep(at: number): void {
    if (this.#buckets.size < this.#maxKeys) return;
    const fullAfterMs = (this.#capacity / this.#refillPerSecond) * 1_000;
    for (const [key, bucket] of this.#buckets) {
      if (at - bucket.at >= fullAfterMs) this.#buckets.delete(key);
    }
  }
}
