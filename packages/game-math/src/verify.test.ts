import { describe, expect, it } from 'vitest';
import { MATH_CONFIG } from './config.js';
import { deriveSpinSeed } from './prng.js';
import { drawStops } from './outcome.js';
import { commitmentOf, sha256Hex, stopsForStep, utf8BytesOf } from './verify.js';
import type { GameConfig } from '@slot/protocol';

/**
 * The hash is held to published vectors, not to itself — a home-grown SHA-256 that only agrees
 * with its own tests would be worse than none. Vectors: FIPS 180-4 / NIST CAVP, plus the one
 * everybody knows by heart.
 */
describe('sha256Hex', () => {
  it('matches the NIST vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    // Two blocks: exercises padding that spills into a second block.
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256Hex('The quick brown fox jumps over the lazy dog')).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    );
  });

  it('hashes every padding boundary consistently with itself only via vectors', () => {
    // 55, 56 and 64 bytes are the classic off-by-one padding traps. These are pinned from a
    // reference implementation (node:crypto), regenerated only deliberately.
    expect(sha256Hex('a'.repeat(55))).toBe(
      '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
    );
    expect(sha256Hex('a'.repeat(56))).toBe(
      'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
    );
    expect(sha256Hex('a'.repeat(64))).toBe(
      'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
    );
  });
});

describe('utf8BytesOf', () => {
  it('encodes one to four byte sequences exactly', () => {
    expect(utf8BytesOf('A')).toEqual([0x41]);
    expect(utf8BytesOf('é')).toEqual([0xc3, 0xa9]);
    expect(utf8BytesOf('€')).toEqual([0xe2, 0x82, 0xac]);
    expect(utf8BytesOf('😀')).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });
});

describe('the fairness arithmetic', () => {
  // Only `strips` is read on this path; the cast states that rather than inventing a server.
  const config = { strips: MATH_CONFIG.strips.map((strip) => [...strip]) } as GameConfig;

  it('commitmentOf is the hash the reveal must answer to', () => {
    const seed = 'a-server-seed';
    expect(commitmentOf(seed)).toBe(sha256Hex(seed));
    expect(commitmentOf(seed)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stopsForStep recomputes exactly what the engine drew', () => {
    const roundId = '018f0000-0000-7000-8000-000000000001';
    for (const step of [0, 1, 7]) {
      expect(stopsForStep(config, 'revealed-seed', roundId, 'my-luck', step)).toEqual(
        drawStops(config, deriveSpinSeed('revealed-seed', roundId, 'my-luck', step)),
      );
    }
    // The client seed genuinely matters: a different one is a different grid.
    expect(stopsForStep(config, 'revealed-seed', roundId, 'other', 0)).not.toEqual(
      stopsForStep(config, 'revealed-seed', roundId, 'my-luck', 0),
    );
  });
});
