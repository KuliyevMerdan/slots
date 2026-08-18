import type { GameConfig, SymbolId } from '@slot/protocol';
import type { ForceOutcomeScenario } from '@slot/protocol';
import { SCATTER } from '@slot/game-math';
import { createPrng } from './prng.js';
import { resolveStops } from './outcome.js';
import type { SpinOutcome } from './outcome.js';

/**
 * The named `forceOutcome` scenarios, resolved to real stops.
 *
 * Every one of them is **found on the actual strips** rather than hard-coded, which is the property
 * that matters: when S4 re-tunes the reels for RTP, these keep working instead of silently pointing
 * at whatever symbol moved into index 7. A scenario that has to be re-derived by hand after every
 * math change is a scenario nobody keeps using.
 *
 * They exist to make presentation testable on demand — a designer clicking `MAX_WIN` in the debug
 * panel (C7) should not have to spin for an hour. They are refused unless `GameConfig.devMode`, and
 * the refusal is enforced in `sim.ts` before anything else about the request is considered.
 */

/** The visible window on one reel for a given stop. */
const windowAt = (strip: readonly SymbolId[], stop: number, rows: number): SymbolId[] =>
  Array.from({ length: rows }, (_unused, row) => strip[(stop + row) % strip.length] ?? '');

/** The first stop on this reel whose window satisfies `matches`, or `-1`. */
const findStop = (
  strip: readonly SymbolId[],
  rows: number,
  matches: (window: readonly SymbolId[]) => boolean,
): number => strip.findIndex((_unused, stop) => matches(windowAt(strip, stop, rows)));

const scatterCount = (window: readonly SymbolId[]): number =>
  window.filter((symbol) => symbol === SCATTER).length;

/**
 * Stops placing exactly one scatter on the first `reels` reels and none on the rest.
 *
 * Both the trigger and the near-miss are this function with a different count — which is exactly
 * the relationship the two have on screen, and why the tease works.
 */
const scatterStops = (config: GameConfig, reelsWithScatter: number): number[] =>
  config.strips.map((strip, reel) => {
    const wanted = reel < reelsWithScatter ? 1 : 0;
    const stop = findStop(strip, config.rows, (window) => scatterCount(window) === wanted);
    if (stop === -1) {
      throw new RangeError(`reel ${reel} has no stop showing exactly ${wanted} scatters`);
    }
    return stop;
  });

/**
 * The best screen these strips can actually produce.
 *
 * **Coordinate ascent over the real objective**, not a heuristic over line symbols. The first
 * attempt at this maximised "target symbols visible per reel" and lost to an ordinary spin, for two
 * reasons worth recording: a payline needs the symbol on a *particular row*, so two hits on the
 * wrong rows beat none of the lines a single centre hit does; and scatters pay on the total stake
 * from anywhere, so the best screen on this paytable is often five scatters rather than a lined-up
 * high symbol. Optimising the thing you actually want avoids having to predict either.
 *
 * Each pass tries all forty stops on each reel in turn and keeps any improvement, repeating until a
 * pass changes nothing. Two starting points — a flat one and an all-scatter one — because ascent
 * finds a local optimum and those two sit in different basins. Roughly two thousand evaluations,
 * which is a millisecond and runs on a button press in the debug panel.
 *
 * **This is the best screen, not necessarily a capped payout.** Whether it reaches `limits.maxWin`
 * depends on the stake and on a paytable nobody has tuned yet — that is S4's job.
 */
const maxWinStops = (config: GameConfig): number[] => {
  // A nominal stake, used only to rank arrangements against each other. Every win scales linearly
  // with the stake, so it cannot change which arrangement wins.
  const probe = config.limits.minStake;
  const score = (stops: readonly number[]): number =>
    resolveStops(config, [...stops], probe).totalWin;

  const ascend = (from: readonly number[]): { stops: number[]; win: number } => {
    let current = [...from];
    let best = score(current);

    for (let pass = 0; pass < 8; pass += 1) {
      let improved = false;

      config.strips.forEach((strip, reel) => {
        for (let stop = 0; stop < strip.length; stop += 1) {
          if (current[reel] === stop) continue;
          const candidate = [...current];
          candidate[reel] = stop;
          const win = score(candidate);
          if (win > best) {
            current = candidate;
            best = win;
            improved = true;
          }
        }
      });

      if (!improved) break;
    }

    return { stops: current, win: best };
  };

  const starts: number[][] = [config.strips.map(() => 0)];
  try {
    // Scatters pay from anywhere and often beat any line, so start one ascent already holding them.
    starts.push(scatterStops(config, config.reels));
  } catch {
    // Some strip has no single-scatter stop. The flat start still works.
  }

  let best: { stops: number[]; win: number } | null = null;
  for (const start of starts) {
    const found = ascend(start);
    if (best === null || found.win > best.win) best = found;
  }

  if (best === null) throw new RangeError('no arrangement produced a win');
  return best.stops;
};

/**
 * A spin that pays nothing and teases nothing — the most common outcome in any real slot, and the
 * one the idle and near-miss presentation has to look right against.
 *
 * Searched with the seeded generator rather than constructed, because "nothing happens" is a
 * property of the whole screen and there is no arrangement to build toward. Bounded so a paytable
 * where every grid pays something fails loudly instead of hanging.
 */
const deadSpinStops = (config: GameConfig, seed: string): number[] => {
  const prng = createPrng(`${seed}|DEAD_SPIN`);

  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    const stops = config.strips.map((strip) => prng.nextBelow(strip.length));
    const outcome = resolveStops(config, stops, config.limits.minStake);
    if (outcome.totalWin === 0 && outcome.scatters < 3) return stops;
  }

  throw new RangeError('no dead spin found in 5,000 attempts — is the paytable paying everything?');
};

/**
 * Resolve a scenario to the stops that produce it.
 *
 * `seed` only matters for `DEAD_SPIN`, which searches; the other three are constructed, so they are
 * the same screen every time — which is what a designer comparing two builds actually wants.
 */
export function scenarioStops(
  config: GameConfig,
  scenario: ForceOutcomeScenario,
  seed: string,
): number[] {
  switch (scenario) {
    case 'DEAD_SPIN':
      return deadSpinStops(config, seed);
    case 'FREE_SPINS_TRIGGER':
      return scatterStops(config, 3);
    case 'NEAR_MISS':
      // Two scatters on the leading reels and nothing after them: the reels that decide the feature
      // are exactly the ones the anticipation slowdown is built for (C4).
      return scatterStops(config, 2);
    case 'MAX_WIN':
      return maxWinStops(config);
  }
}

/** What a scenario produces, for tests and for the debug panel's preview. */
export const scenarioOutcome = (
  config: GameConfig,
  scenario: ForceOutcomeScenario,
  seed: string,
  stake: GameConfig['limits']['minStake'],
): SpinOutcome => resolveStops(config, scenarioStops(config, scenario, seed), stake);
