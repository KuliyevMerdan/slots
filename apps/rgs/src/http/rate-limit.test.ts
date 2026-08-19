import { describe, expect, it } from 'vitest';
import { TokenBucketLimiter } from './rate-limit.js';

const NOW = 1_700_000_000_000;

describe('the token bucket', () => {
  it('admits the burst, then refuses with the time to the next token', () => {
    const clock = { now: NOW };
    const limiter = new TokenBucketLimiter({
      capacity: 3,
      refillPerSecond: 2,
      now: () => clock.now,
    });

    for (let i = 0; i < 3; i += 1) {
      expect(limiter.take('key').allowed).toBe(true);
    }
    const refused = limiter.take('key');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBe(500); // one token at 2/s

    clock.now += 500;
    expect(limiter.take('key').allowed).toBe(true);
  });

  it('refills only up to capacity — an idle hour does not buy an hour of burst', () => {
    const clock = { now: NOW };
    const limiter = new TokenBucketLimiter({
      capacity: 2,
      refillPerSecond: 1,
      now: () => clock.now,
    });

    clock.now += 3_600_000;
    expect(limiter.take('key').allowed).toBe(true);
    expect(limiter.take('key').allowed).toBe(true);
    expect(limiter.take('key').allowed).toBe(false);
  });

  it('a refused call consumes nothing — the window it waits for does not stretch', () => {
    const clock = { now: NOW };
    const limiter = new TokenBucketLimiter({
      capacity: 1,
      refillPerSecond: 1,
      now: () => clock.now,
    });

    expect(limiter.take('key').allowed).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.take('key').allowed).toBe(false);
    }
    clock.now += 1_000;
    expect(limiter.take('key').allowed).toBe(true);
  });

  it('keys are independent — one flooding caller starves nobody else', () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1, now: () => NOW });

    expect(limiter.take('loud').allowed).toBe(true);
    expect(limiter.take('loud').allowed).toBe(false);
    expect(limiter.take('quiet').allowed).toBe(true);
  });

  it('refuses a nonsensical configuration at construction', () => {
    expect(
      () => new TokenBucketLimiter({ capacity: 0, refillPerSecond: 1, now: () => NOW }),
    ).toThrow(RangeError);
    expect(
      () => new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0, now: () => NOW }),
    ).toThrow(RangeError);
  });
});
