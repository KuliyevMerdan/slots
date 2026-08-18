import type { Feature, GameConfig, Minor, RoundResult, SymbolId, Win } from '@slot/protocol';
import { FREE_SPIN_AWARDS, SCATTER, evaluate, viewFrom } from '@slot/game-math';
import { createPrng } from './prng.js';

/**
 * Where an outcome comes from — and the only place in the system that decides one.
 *
 * The order is deliberate and is the order every real RGS uses: **draw the stops, then derive
 * everything else from them.** `view`, `wins` and `totalWin` are consequences of `stops`, never
 * inputs to it. That is what makes the client's dev-build assertion meaningful (ADR-0001): if the
 * server ever computed a win first and dressed a grid around it, `viewMatchesStops` would be the
 * only thing standing between that and production, and it would pass.
 */

export interface SpinOutcome {
  stops: number[];
  view: SymbolId[][];
  wins: Win[];
  totalWin: Minor;
  /** Scatters on screen. The free-spin award reads this, not the scatter *win*. */
  scatters: number;
}

/** One uniform stop per reel, each an index into that reel's strip. */
export const drawStops = (config: GameConfig, seed: string): number[] => {
  const prng = createPrng(seed);
  return config.strips.map((strip) => prng.nextBelow(strip.length));
};

const countScatters = (view: readonly (readonly SymbolId[])[]): number =>
  view.reduce((total, reel) => total + reel.filter((symbol) => symbol === SCATTER).length, 0);

/**
 * Derive the presentable outcome from stops that are already decided.
 *
 * `stake` is what the wins resolve against: the placed stake in the base game, and the triggering
 * stake (`FeatureProgress.stakeRef`) inside a feature, since a free spin carries none of its own.
 */
export function resolveStops(config: GameConfig, stops: number[], stake: Minor): SpinOutcome {
  const view = viewFrom(config.strips, stops, config.rows);
  const { wins, totalWin } = evaluate({
    view,
    paylines: config.paylines,
    paytable: config.paytable,
    stake,
  });

  return { stops, view, wins, totalWin, scatters: countScatters(view) };
}

export const spinOutcome = (config: GameConfig, seed: string, stake: Minor): SpinOutcome =>
  resolveStops(config, drawStops(config, seed), stake);

/**
 * How many free spins this many scatters award, or `0`.
 *
 * The table lives in `@slot/game-math` beside the paytable it belongs with; the *award* is the
 * server's decision, which is why this function is here and not there.
 */
export const freeSpinsFor = (scatters: number): number => FREE_SPIN_AWARDS[scatters] ?? 0;

/** What a base spin awarded: a fresh feature, or nothing. */
export const baseFeatures = (scatters: number): Feature[] => {
  const awarded = freeSpinsFor(scatters);
  if (awarded === 0) return [];
  return [{ kind: 'FREE_SPINS', awarded, trigger: { symbol: SCATTER, count: scatters } }];
};

/** What a free spin awarded: a retrigger, or nothing. */
export const retriggerFeatures = (scatters: number): Feature[] => {
  const awarded = freeSpinsFor(scatters);
  if (awarded === 0) return [];
  return [{ kind: 'FREE_SPINS_RETRIGGER', awarded }];
};

export const toRoundResult = (outcome: SpinOutcome, features: Feature[]): RoundResult => ({
  stops: outcome.stops,
  view: outcome.view,
  wins: outcome.wins,
  totalWin: outcome.totalWin,
  features,
});
