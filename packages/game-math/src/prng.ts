/**
 * The game's random source: **xoshiro128\*\***, seeded from a string.
 *
 * Determinism is a feature, not a testing convenience. A given seed replays an identical session,
 * which is what makes the dev loop, the contract suite and the 50-million-spin RTP report (S4) all
 * describe the same game. `Math.random()` is a lint error in this package for exactly that reason.
 * It lived in `@slot/rgs-sim` until R1; it lives here now so that both servers — the simulator and
 * `apps/rgs` — draw from one implementation (see `outcome.ts` for the whole argument).
 *
 * xoshiro128\*\* rather than a linear congruential generator: it passes the statistical batteries a
 * slot's RTP claim implicitly rests on, and it needs only four 32-bit words of state — so a round's
 * seed is a short string rather than a serialised generator.
 */

/** 2³², as a float. The modulus of every draw below. */
const UINT32_RANGE = 0x1_0000_0000;

/**
 * FNV-1a, 32-bit. Turns the seed string into one word of entropy.
 *
 * Not a cryptographic hash and not pretending to be one — R4 replaces this with a real
 * commit/reveal scheme. Its only job here is to spread similar seed strings (`…-step-1`,
 * `…-step-2`) to unrelated states.
 */
export const hashSeed = (input: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash >>> 0;
};

/**
 * splitmix32 — the standard way to expand one seed word into xoshiro's four.
 *
 * Seeding all four words from the same value would leave the generator in a low-entropy state for
 * its first few draws, which on a slot is visible as correlated opening spins.
 */
const splitmix32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e37_79b9) | 0;
    let next = state ^ (state >>> 16);
    next = Math.imul(next, 0x21f0_aaad);
    next ^= next >>> 15;
    next = Math.imul(next, 0x735a_2d97);
    return (next ^ (next >>> 15)) >>> 0;
  };
};

export interface Prng {
  /** A uniform draw in `[0, 2³²)`. */
  nextUint32(): number;
  /** A uniform integer in `[0, bound)`. */
  nextBelow(bound: number): number;
  /** A uniform float in `[0, 1)`. */
  nextFloat(): number;
}

/**
 * Build a generator from a seed string. The same string always yields the same sequence — that is
 * the entire contract, and `prng.test.ts` pins it against recorded output.
 */
export function createPrng(seed: string): Prng {
  const expand = splitmix32(hashSeed(seed));
  let a = expand();
  let b = expand();
  let c = expand();
  let d = expand();

  const nextUint32 = (): number => {
    // xoshiro128** — the `**` is the output scrambler: rotl(s1 * 5, 7) * 9.
    const scrambled = Math.imul(b, 5);
    const result = Math.imul(((scrambled << 7) | (scrambled >>> 25)) >>> 0, 9) >>> 0;

    const shifted = b << 9;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= shifted;
    d = ((d << 11) | (d >>> 21)) >>> 0;

    return result;
  };

  const nextBelow = (bound: number): number => {
    if (!Number.isInteger(bound) || bound < 1) {
      throw new RangeError(`nextBelow expects a positive integer bound, got ${bound}`);
    }

    // Rejection sampling, not `% bound`. A plain modulo over-represents the low residues whenever
    // `bound` does not divide 2³² — with a 40-stop strip that is a permanent, invisible tilt in the
    // reel distribution, and therefore in the published RTP. Rejecting the ragged top slice costs
    // one extra draw about once in 10⁸ and removes the bias entirely.
    const limit = Math.floor(UINT32_RANGE / bound) * bound;
    let draw = nextUint32();
    while (draw >= limit) draw = nextUint32();
    return draw % bound;
  };

  return {
    nextUint32,
    nextBelow,
    nextFloat: () => nextUint32() / UINT32_RANGE,
  };
}

/**
 * The seed for one spin, derived rather than stored.
 *
 * No generator state is ever persisted: a spin's seed is a pure function of the session's server
 * seed, the round it belongs to, the player's optional contribution and the step within the round.
 * Two consequences worth the design — a round replays to the identical outcome even from a store
 * that only kept the round id, and the shape is already the one R4's commit/reveal needs.
 *
 * `step` is `0` for the base spin and the 1-based free-spin index inside a feature.
 */
export const deriveSpinSeed = (
  serverSeed: string,
  roundId: string,
  clientSeed: string | undefined,
  step: number,
): string => `${serverSeed}|${roundId}|${clientSeed ?? ''}|${step}`;
