import type { GameConfig, Minor } from '@slot/protocol';
import { createPrng, freeSpinsFor, resolveStops } from '@slot/game-math';

/**
 * The RTP simulation — **the same math the game plays on**.
 *
 * Every number this reports comes from `@slot/rgs-sim`'s own outcome derivation over
 * `@slot/game-math`'s strips, paytable and award table: the same `evaluate`, the same wild and
 * scatter rules, the same free-spin awards. That is the whole argument for the tool existing rather
 * than a spreadsheet — **the RTP published is the RTP played**, because there is only one
 * implementation of it.
 *
 * The one thing it does not reproduce is the *seed plumbing*. The server derives a spin seed from
 * `(serverSeed, roundId, clientSeed, step)` so a round can be replayed; a batch of fifty million
 * spins has no rounds to replay, so stops are drawn from one seeded stream instead. The derivation
 * from stops to outcome — which is what "the math" means — is untouched.
 */

/** Win size, in multiples of the total stake. The last bucket is open-ended. */
export const WIN_BUCKETS = [0, 1, 2, 5, 10, 25, 50, 100, 250, 500] as const;

export interface SimulationOptions {
  config: GameConfig;
  /** Rounds to play. A round is one paid spin plus any free spins it awards. */
  spins: number;
  seed: string;
  stake: Minor;
  /**
   * A safety bound on one feature. A retriggering feature is a branching process: tuned properly it
   * dies out, and mis-tuned it does not — so the simulation refuses to hang and *reports* the fact
   * rather than discovering it as a stuck CLI.
   */
  maxFeatureSpins?: number;
  /** Called every `progressEvery` rounds so a long run can say how it is getting on. */
  onProgress?: (played: number) => void;
  progressEvery?: number;
}

export interface Simulation {
  spins: number;
  staked: number;
  returned: number;
  /** `returned / staked`. The headline. */
  rtp: number;
  /** Share of rounds that returned anything at all. */
  hitFrequency: number;
  /** Standard deviation of a round's return, in stakes. The industry's volatility measure. */
  volatility: number;
  /** The largest single round, in multiples of the stake. */
  maxWinMultiple: number;
  /** Rounds per feature trigger. `Infinity` when nothing triggered. */
  spinsPerTrigger: number;
  triggers: number;
  freeSpinsPlayed: number;
  /** Longest feature seen, in free spins — the number that exposes a runaway retrigger. */
  longestFeature: number;
  /** Share of all returns that came from inside a feature. */
  featureShare: number;
  /** How much RTP the base game and the feature each contribute. */
  baseRtp: number;
  featureRtp: number;
  /** Rounds whose win fell in `[WIN_BUCKETS[i], WIN_BUCKETS[i + 1])`, in stakes. */
  distribution: number[];
  /** Features that hit the safety bound. Anything but zero means the math is not tuned. */
  runaways: number;
}

const bucketFor = (multiple: number): number => {
  if (multiple <= 0) return 0;
  let index = 1;
  while (index < WIN_BUCKETS.length && multiple >= (WIN_BUCKETS[index] as number)) index += 1;
  return index;
};

/**
 * Play `spins` complete rounds and report what happened.
 *
 * A *round* is the unit that matters for RTP: one stake buys the base spin and every free spin it
 * leads to, so the feature's return belongs to the round that paid for it. Reporting per-spin RTP
 * with free spins counted as spins is the classic way to publish a number nobody can reproduce.
 */
export function simulate({
  config,
  spins,
  seed,
  stake,
  maxFeatureSpins = 500,
  onProgress,
  progressEvery = 1_000_000,
}: SimulationOptions): Simulation {
  const prng = createPrng(seed);
  const distribution = new Array<number>(WIN_BUCKETS.length + 1).fill(0);

  let staked = 0;
  let returned = 0;
  let baseReturned = 0;
  let featureReturned = 0;
  let hits = 0;
  let triggers = 0;
  let freeSpinsPlayed = 0;
  let longestFeature = 0;
  let runaways = 0;
  let maxWinMultiple = 0;
  // Welford would be more elegant; the sum of squares is exact enough here and much faster, and the
  // magnitudes stay well inside double precision for a run of any size a CLI will do.
  let sumOfSquares = 0;

  const drawStops = (): number[] => config.strips.map((strip) => prng.nextBelow(strip.length));

  for (let round = 0; round < spins; round += 1) {
    staked += stake;

    const base = resolveStops(config, drawStops(), stake);
    // Plain `number`, not `Minor`: this is an accumulator over many rounds, and the branded type
    // exists to stop money arithmetic happening by accident — which is exactly what this is doing on
    // purpose, in a tool, where nothing is paid to anybody.
    let roundWin: number = base.totalWin;
    baseReturned += base.totalWin;

    let remaining = freeSpinsFor(base.scatters);
    if (remaining > 0) {
      triggers += 1;
      let played = 0;

      while (remaining > 0 && played < maxFeatureSpins) {
        remaining -= 1;
        played += 1;
        // A free spin resolves against the *triggering* stake — it carries none of its own.
        const free = resolveStops(config, drawStops(), stake);
        roundWin += free.totalWin;
        featureReturned += free.totalWin;
        remaining += freeSpinsFor(free.scatters);
      }

      if (played >= maxFeatureSpins) runaways += 1;
      freeSpinsPlayed += played;
      if (played > longestFeature) longestFeature = played;
    }

    returned += roundWin;
    if (roundWin > 0) hits += 1;

    const multiple = roundWin / stake;
    if (multiple > maxWinMultiple) maxWinMultiple = multiple;
    sumOfSquares += multiple * multiple;
    const bucket = bucketFor(multiple);
    distribution[bucket] = (distribution[bucket] ?? 0) + 1;

    if (onProgress !== undefined && (round + 1) % progressEvery === 0) onProgress(round + 1);
  }

  const mean = returned / staked;

  return {
    spins,
    staked,
    returned,
    rtp: mean,
    hitFrequency: hits / spins,
    // Var(X) = E[X²] − E[X]², over the per-round return measured in stakes.
    volatility: Math.sqrt(Math.max(0, sumOfSquares / spins - mean * mean)),
    maxWinMultiple,
    triggers,
    spinsPerTrigger: triggers === 0 ? Infinity : spins / triggers,
    freeSpinsPlayed,
    longestFeature,
    featureShare: returned === 0 ? 0 : featureReturned / returned,
    baseRtp: baseReturned / staked,
    featureRtp: featureReturned / staked,
    distribution,
    runaways,
  };
}
