import { commitmentOf, createPrng } from '@slot/game-math';

/**
 * Where server randomness comes from — the R4 half of provable fairness (docs/protocol.md §9,
 * D11; docs/fairness.md; ADR-0006).
 *
 * One pair per round: a fresh seed and its SHA-256, chained. The pair *on offer* is published as
 * a commitment before any bet can bind it (`authenticate`, and every closing response's `next`);
 * a spin binds the offered pair to its round at `open` — the seed is persisted on the round row,
 * so a restart can still resolve and reveal it — and the chain rotates only once the open
 * succeeds, which is what keeps a failed open retryable under the same commitment. The spin seed
 * itself stays *derived*, exactly as before: `deriveSpinSeed(pair.seed, roundId, clientSeed,
 * step)`, with `roundId` and `clientSeed` both client-minted — after the commitment, the server
 * has nothing left to choose.
 *
 * Randomness arrives injected (`RandomBytes`) for the same reason the clock does: `main.ts` hands
 * in `node:crypto`'s CSPRNG, tests hand in a seeded stream, and the provider cannot tell — so the
 * chain is replayable exactly where a test needs it to be and unpredictable exactly where a
 * player does.
 */

export interface SeedPair {
  /** 32 bytes of entropy, hex — the secret half, disclosed only at the round's close. */
  readonly seed: string;
  /** `sha256(seed)` — the public half, held by the player before the bet. */
  readonly commitment: string;
}

export type RandomBytes = (byteCount: number) => Uint8Array;

export interface ServerSeedProvider {
  /** The pair on offer for the next round to open. Stable until `rotate()`. */
  current(): SeedPair;
  /** Consume the offer: mint and publish a fresh pair. Called once a round has bound the old one. */
  rotate(): SeedPair;
}

const hexOf = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export const committingSeedProvider = (randomBytes: RandomBytes): ServerSeedProvider => {
  const mint = (): SeedPair => {
    const seed = hexOf(randomBytes(32));
    return { seed, commitment: commitmentOf(seed) };
  };
  let current = mint();
  return {
    current: () => current,
    rotate: () => (current = mint()),
  };
};

/**
 * A deterministic byte stream for tests and the dev loop: xoshiro over a label. Not a CSPRNG and
 * not pretending to be one — a test that cannot replay its chain is not finished, and a dev
 * server that surprises its own fixtures helps nobody. `main.ts` never constructs this.
 */
export const seededBytes = (label: string): RandomBytes => {
  const prng = createPrng(label);
  return (byteCount) => Uint8Array.from({ length: byteCount }, () => prng.nextBelow(256));
};
