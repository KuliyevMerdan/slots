import { describe, expect, it } from 'vitest';
import { createPrng, deriveSpinSeed, hashSeed } from './prng.js';

const draws = (seed: string, count: number): number[] => {
  const prng = createPrng(seed);
  return Array.from({ length: count }, () => prng.nextUint32());
};

describe('hashSeed', () => {
  it('is deterministic', () => {
    expect(hashSeed('abc')).toBe(hashSeed('abc'));
  });

  it('separates seeds that differ only in their last character', () => {
    // The spin seeds are `…|step-1`, `…|step-2`, … — if near-identical strings collapsed to nearby
    // states, consecutive free spins would correlate.
    expect(hashSeed('round|1')).not.toBe(hashSeed('round|2'));
  });

  it('stays inside the unsigned 32-bit range', () => {
    for (const input of ['', 'a', 'a longer seed string', 'ÿþ']) {
      const hash = hashSeed(input);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThan(2 ** 32);
    }
  });
});

describe('createPrng', () => {
  it('replays an identical sequence from the same seed', () => {
    expect(draws('replay-me', 32)).toEqual(draws('replay-me', 32));
  });

  it('produces a different sequence from a different seed', () => {
    expect(draws('seed-a', 16)).not.toEqual(draws('seed-b', 16));
  });

  /**
   * The golden sequence. Recorded output, pinned so that a "harmless" refactor of the generator is
   * a test failure rather than a silently different game — every seeded fixture, contract test and
   * published RTP figure downstream is anchored to these exact numbers.
   */
  it('matches the recorded xoshiro128** output', () => {
    expect(draws('@slot/rgs-sim', 8)).toEqual([
      3819458322, 119933435, 3012035920, 2620172989, 3354262971, 3505435516, 777750467, 2728140976,
    ]);
  });

  it('never repeats its state within a long run', () => {
    const seen = new Set(draws('long-run', 10_000));
    // 10k draws from a 2³² space: collisions are possible but a *cluster* of them means the state
    // is degenerate. A handful is fine; a few hundred is a broken generator.
    expect(seen.size).toBeGreaterThan(9_900);
  });

  describe('nextUint32', () => {
    it('stays inside the unsigned 32-bit range', () => {
      for (const draw of draws('range', 1_000)) {
        expect(Number.isInteger(draw)).toBe(true);
        expect(draw).toBeGreaterThanOrEqual(0);
        expect(draw).toBeLessThan(2 ** 32);
      }
    });
  });

  describe('nextFloat', () => {
    it('stays in [0, 1)', () => {
      const prng = createPrng('floats');
      for (let index = 0; index < 1_000; index += 1) {
        const value = prng.nextFloat();
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    });
  });

  describe('nextBelow', () => {
    it('stays in [0, bound)', () => {
      const prng = createPrng('bounded');
      for (let index = 0; index < 2_000; index += 1) {
        const value = prng.nextBelow(40);
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(40);
      }
    });

    it('always returns 0 for a bound of 1', () => {
      const prng = createPrng('one');
      expect(Array.from({ length: 20 }, () => prng.nextBelow(1))).toEqual(Array(20).fill(0));
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects a bound of %s',
      (bound) => {
        expect(() => createPrng('bad').nextBelow(bound)).toThrow(RangeError);
      },
    );

    /**
     * The reason `nextBelow` rejects rather than taking a modulo.
     *
     * 40 does not divide 2³², so `draw % 40` would over-represent the low stops permanently — a
     * tilt of a fraction of a percent in the reel distribution, invisible in play and directly
     * wrong in the published RTP. This is the test that would catch someone "simplifying" it.
     */
    it('distributes evenly across a bound that does not divide 2³²', () => {
      const prng = createPrng('uniformity');
      const bound = 40;
      const samples = 400_000;
      const buckets = new Array<number>(bound).fill(0);

      for (let index = 0; index < samples; index += 1) {
        const bucket = prng.nextBelow(bound);
        buckets[bucket] = (buckets[bucket] ?? 0) + 1;
      }

      // 10,000 expected per bucket; ±3% is far inside sampling noise and far outside the ~0.5%
      // systematic skew a modulo would introduce at this bound.
      const expected = samples / bound;
      for (const count of buckets) {
        expect(Math.abs(count - expected) / expected).toBeLessThan(0.03);
      }
    });
  });
});

describe('deriveSpinSeed', () => {
  it('separates the base spin from every free spin in the same round', () => {
    const seeds = [0, 1, 2, 3].map((step) => deriveSpinSeed('server', 'round', undefined, step));
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it('separates rounds within the same session', () => {
    expect(deriveSpinSeed('server', 'round-a', undefined, 0)).not.toBe(
      deriveSpinSeed('server', 'round-b', undefined, 0),
    );
  });

  it('lets the client seed change the outcome', () => {
    expect(deriveSpinSeed('server', 'round', 'player-entropy', 0)).not.toBe(
      deriveSpinSeed('server', 'round', undefined, 0),
    );
  });

  it('is stable for the same inputs', () => {
    expect(deriveSpinSeed('server', 'round', 'seed', 2)).toBe(
      deriveSpinSeed('server', 'round', 'seed', 2),
    );
  });
});
