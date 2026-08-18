import { describe, expect, it } from 'vitest';
import type { ForceOutcomeScenario } from '@slot/protocol';
import { SCATTER, viewMatchesStops } from '@slot/game-math';
import { scenarioOutcome, scenarioStops } from './scenarios.js';
import { resolveStops } from './outcome.js';
import { createPrng } from './prng.js';
import { STAKE, testConfig } from './__fixtures__/harness.js';

/**
 * Every scenario is asserted on the property it is *named for*, not on a recorded stop array.
 *
 * The difference matters: when S4 re-tunes the strips for RTP, a test pinned to `[7, 12, 3, 31, 18]`
 * fails and gets "fixed" by pasting in whatever the new numbers are — which proves nothing. A test
 * that says "MAX_WIN pays more than a thousand times the line bet" keeps meaning the same thing.
 */

const config = testConfig({ devMode: true });
const SEED = 'scenario-seed';
const ALL: ForceOutcomeScenario[] = ['NEAR_MISS', 'FREE_SPINS_TRIGGER', 'MAX_WIN', 'DEAD_SPIN'];

const scattersPerReel = (view: readonly (readonly string[])[]): number[] =>
  view.map((reel) => reel.filter((symbol) => symbol === SCATTER).length);

describe('scenarioStops', () => {
  it.each(ALL)('%s produces one legal stop per reel', (scenario) => {
    const stops = scenarioStops(config, scenario, SEED);

    expect(stops).toHaveLength(config.reels);
    stops.forEach((stop, reel) => {
      expect(Number.isInteger(stop)).toBe(true);
      expect(stop).toBeGreaterThanOrEqual(0);
      expect(stop).toBeLessThan(config.strips[reel]?.length ?? 0);
    });
  });

  it.each(ALL)('%s produces a view that agrees with its own stops', (scenario) => {
    const outcome = scenarioOutcome(config, scenario, SEED, STAKE);
    expect(viewMatchesStops(config.strips, outcome.stops, outcome.view)).toBe(true);
  });

  it.each(ALL)('%s is stable across calls', (scenario) => {
    expect(scenarioStops(config, scenario, SEED)).toEqual(scenarioStops(config, scenario, SEED));
  });
});

describe('FREE_SPINS_TRIGGER', () => {
  it('lands enough scatters to award free spins', () => {
    const outcome = scenarioOutcome(config, 'FREE_SPINS_TRIGGER', SEED, STAKE);
    expect(outcome.scatters).toBeGreaterThanOrEqual(3);
  });
});

describe('NEAR_MISS', () => {
  /**
   * The tease, precisely: scatters on the reels that decide the feature, nothing on the ones that
   * would deliver it. This is what the anticipation slowdown in C4 exists to dramatise, so the
   * scenario has to put the scatters on the *leading* reels rather than merely land two of them.
   */
  it('puts scatters on the first two reels and none after', () => {
    const outcome = scenarioOutcome(config, 'NEAR_MISS', SEED, STAKE);
    const perReel = scattersPerReel(outcome.view);

    expect(perReel[0]).toBeGreaterThanOrEqual(1);
    expect(perReel[1]).toBeGreaterThanOrEqual(1);
    expect(perReel.slice(2)).toEqual([0, 0, 0]);
  });

  it('does not actually trigger the feature', () => {
    const outcome = scenarioOutcome(config, 'NEAR_MISS', SEED, STAKE);
    expect(outcome.scatters).toBeLessThan(3);
  });
});

describe('DEAD_SPIN', () => {
  it('pays nothing and triggers nothing', () => {
    const outcome = scenarioOutcome(config, 'DEAD_SPIN', SEED, STAKE);

    expect(outcome.totalWin).toBe(0);
    expect(outcome.wins).toHaveLength(0);
    expect(outcome.scatters).toBeLessThan(3);
  });

  it('varies with the seed, being a search rather than a construction', () => {
    const first = scenarioStops(config, 'DEAD_SPIN', 'seed-a');
    const second = scenarioStops(config, 'DEAD_SPIN', 'seed-b');
    expect(first).not.toEqual(second);
  });
});

describe('MAX_WIN', () => {
  it('lines a paying symbol across every reel', () => {
    const outcome = scenarioOutcome(config, 'MAX_WIN', SEED, STAKE);
    const fullWidth = outcome.wins.filter((win) => win.count === config.reels);

    expect(fullWidth.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * The assertion that survives an S4 re-tune: whatever the paytable becomes, the scenario has to
   * beat what the reels actually produce. Pinning a number here would just record today's paytable.
   */
  it('beats every one of two thousand real spins', () => {
    const forced = scenarioOutcome(config, 'MAX_WIN', SEED, STAKE);
    const prng = createPrng('max-win-comparison');

    let bestNatural = 0;
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const stops = config.strips.map((strip) => prng.nextBelow(strip.length));
      bestNatural = Math.max(bestNatural, resolveStops(config, stops, STAKE).totalWin);
    }

    expect(forced.totalWin).toBeGreaterThan(bestNatural);
  });

  it('pays many times the stake', () => {
    const outcome = scenarioOutcome(config, 'MAX_WIN', SEED, STAKE);
    expect(outcome.totalWin).toBeGreaterThan(STAKE * 20);
  });
});
