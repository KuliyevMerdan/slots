import type { RoundId } from '@slot/protocol';

/**
 * Where server randomness comes from — the seam R4 fills with commit/reveal.
 *
 * The simulator already proved the derivation discipline this interface assumes: a spin's seed is
 * *derived* from `(serverSeed, roundId, clientSeed, step)` and never stored, so a round is
 * replayable from its inputs and no table of consumed randomness exists to leak or corrupt. R4
 * keeps that and adds the provably-fair half: the server publishes `commitmentFor` (a hash of the
 * seed material) *before* the round, reveals the material after settlement, and the player can
 * verify the outcome was fixed before they pressed.
 */
export interface ServerSeedProvider {
  /** The seed material for a round. Deterministic per round — asking twice is the same answer. */
  seedFor(roundId: RoundId): Promise<string>;
  /** The hash published before the round plays — what makes the reveal checkable (R4). */
  commitmentFor(roundId: RoundId): Promise<string>;
}
