import type { GameConfig } from '@slot/protocol';
import { deriveSpinSeed } from './prng.js';
import { drawStops } from './outcome.js';

/**
 * The player's half of provable fairness (docs/protocol.md §9, D11; docs/fairness.md).
 *
 * Everything needed to check a revealed round lives in this package on purpose: the client ships
 * it, a test can drive it, and a sceptical player can run it in a browser console with nothing but
 * the wire's own numbers. `sha256Hex` is implemented here rather than imported because this
 * package runs wherever the client runs — no `node:crypto`, no DOM, no dependency — and a
 * fairness check that needs the server's environment would be a joke at its own expense.
 *
 * The procedure: hold `commitment` before betting; after the close, check
 * `sha256Hex(reveal) === commitment`, then `stopsForStep(config, reveal, roundId, clientSeed, k)`
 * for every step `k` the round played — each must equal the `result.stops` that step reported.
 */

/* ── SHA-256, FIPS 180-4 — pure, synchronous, dependency-free ────────────────────────────────── */

/** The first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
// prettier-ignore
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

/** UTF-8, by hand — this package compiles with neither the DOM lib nor Node types. */
export const utf8BytesOf = (input: string): number[] => {
  const bytes: number[] = [];
  for (const character of input) {
    const point = character.codePointAt(0) as number;
    if (point < 0x80) bytes.push(point);
    else if (point < 0x800) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    else if (point < 0x1_0000) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
    }
  }
  return bytes;
};

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

/** SHA-256 of the UTF-8 encoding of `input`, as 64 lowercase hex characters. */
export const sha256Hex = (input: string): string => {
  const bytes = utf8BytesOf(input);
  const bitLength = bytes.length * 8;

  // Padding: 0x80, zeros to 56 mod 64, then the length as a 64-bit big-endian integer.
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // Message lengths here are far below 2³² bits, so the high word is arithmetic, not bigint.
  bytes.push(
    0,
    0,
    0,
    Math.floor(bitLength / 0x1_0000_0000) & 0xff,
    (bitLength >>> 24) & 0xff,
    (bitLength >>> 16) & 0xff,
    (bitLength >>> 8) & 0xff,
    bitLength & 0xff,
  );

  // The first 32 bits of the fractional parts of the square roots of the first 8 primes.
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Array<number>(64);
  for (let block = 0; block < bytes.length; block += 64) {
    for (let t = 0; t < 16; t += 1) {
      const i = block + t * 4;
      w[t] =
        (((bytes[i] as number) << 24) |
          ((bytes[i + 1] as number) << 16) |
          ((bytes[i + 2] as number) << 8) |
          (bytes[i + 3] as number)) >>>
        0;
    }
    for (let t = 16; t < 64; t += 1) {
      const w15 = w[t - 15] as number;
      const w2 = w[t - 2] as number;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let t = 0; t < 64; t += 1) {
      const bigSigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + bigSigma1 + choose + (K[t] as number) + (w[t] as number)) >>> 0;
      const bigSigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (bigSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
};

/* ── the fairness arithmetic ─────────────────────────────────────────────────────────────────── */

/** What a committing server publishes before the round: the hash of the seed it will play. */
export const commitmentOf = (serverSeed: string): string => sha256Hex(serverSeed);

/**
 * Recompute one step's `stops[]` from the revealed seed and the player's own inputs — the R4
 * gate, as a function. `step` is 0 for the base spin, the 1-based index for a free spin.
 */
export const stopsForStep = (
  config: GameConfig,
  revealedSeed: string,
  roundId: string,
  clientSeed: string | undefined,
  step: number,
): number[] => drawStops(config, deriveSpinSeed(revealedSeed, roundId, clientSeed, step));
