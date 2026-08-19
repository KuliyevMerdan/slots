import type { RoundId } from '@slot/protocol';
import { NotImplementedError } from '../errors.js';

/**
 * Where server randomness comes from — the seam R4 fills with commit/reveal.
 *
 * The derivation discipline is the one the simulator proved: a spin's seed is *derived* from
 * `(serverSeed, roundId, clientSeed, step)` and never stored, so a round is replayable from its
 * inputs and no table of consumed randomness exists to leak or corrupt. R4 keeps that and adds the
 * provably-fair half: the server publishes `commitmentFor` (a hash of the seed material) *before*
 * the round, reveals the material after settlement, and the player can verify the outcome was
 * fixed before they pressed.
 */
export interface ServerSeedProvider {
  /** The per-round seed material. Deterministic — asking twice is the same answer. */
  seedFor(roundId: RoundId): Promise<string>;
  /** The hash published before the round plays — what makes the reveal checkable (R4). */
  commitmentFor(roundId: RoundId): Promise<string>;
}

/**
 * R1's provider: one configured server seed, the simulator's derivation, and no commitment —
 * `commitmentFor` throws `NotImplementedError` rather than answering something unverifiable,
 * because a commitment nobody can check is worse than an honest absence (R4).
 *
 * The material is `serverSeed|roundId`; the domain appends `|clientSeed|step` — together exactly
 * `deriveSpinSeed` in `@slot/game-math`, byte for byte, so the same seed and round id produce the
 * same outcome on this server and on the simulator. Nothing depends on that equality; it exists so
 * a divergence investigation can swap servers under a round and compare.
 */
export const staticSeedProvider = (serverSeed: string): ServerSeedProvider => ({
  seedFor: (roundId) => Promise.resolve(`${serverSeed}|${roundId}`),
  commitmentFor: () => Promise.reject(new NotImplementedError('rng.commitmentFor (R4)')),
});
