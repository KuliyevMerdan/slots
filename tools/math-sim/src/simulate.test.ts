import { describe, expect, it } from 'vitest';
import { createSimConfig } from '@slot/rgs-sim';
import type { Minor } from '@slot/protocol';
import { simulate } from './simulate.js';
import { DESIGN, formatReport, meetsDesign } from './report.js';

/**
 * The math, guarded.
 *
 * A quarter of a million rounds is not enough to *publish* an RTP — the report's own runs are twenty
 * million — but it is enough to catch the thing this suite exists for: a strip or paytable edit that
 * moves the game somewhere it was not designed to be. The band here is deliberately wider than the
 * design tolerance, because the sampling error at this size is around a third of a percentage point
 * and a test that fails on noise teaches people to ignore it.
 */

const config = createSimConfig();
const STAKE = 100 as Minor;
const SPINS = 250_000;

const run = (seed: string, spins = SPINS) => simulate({ config, spins, seed, stake: STAKE });

describe('the shipped math', () => {
  const simulation = run('guard');

  it('returns about 96% of what it takes', () => {
    // ±1.5pp: the design tolerance is ±0.5pp, and the rest is the sampling error of 250k rounds.
    expect(simulation.rtp).toBeGreaterThan(0.945);
    expect(simulation.rtp).toBeLessThan(0.975);
  });

  it('pays something about two rounds in five', () => {
    expect(simulation.hitFrequency).toBeGreaterThan(DESIGN.hitFrequency[0]);
    expect(simulation.hitFrequency).toBeLessThan(DESIGN.hitFrequency[1]);
  });

  it('triggers the feature about once every hundred rounds', () => {
    expect(simulation.spinsPerTrigger).toBeGreaterThan(DESIGN.spinsPerTrigger[0]);
    expect(simulation.spinsPerTrigger).toBeLessThan(DESIGN.spinsPerTrigger[1]);
  });

  /**
   * The failure that started S4: with three scatters a reel, a retrigger was likelier than not to
   * arrive before the feature ran out, so the feature was a branching process that did not die —
   * 150 free spins, and a 125% RTP. This is the assertion that would have caught it.
   */
  it('has a feature that converges', () => {
    expect(simulation.runaways).toBe(0);
    expect(simulation.longestFeature).toBeLessThanOrEqual(DESIGN.longestFeature);
    // Below one: every free spin awards fewer than one further free spin, on average.
    const branching = simulation.freeSpinsPlayed / simulation.triggers;
    expect(branching).toBeLessThan(20);
  });

  it('earns most of its return in the base game, and a real slice from the feature', () => {
    expect(simulation.featureShare).toBeGreaterThan(0.03);
    expect(simulation.featureShare).toBeLessThan(0.3);
  });

  it('is volatile enough to be a slot and not so volatile it is a lottery', () => {
    expect(simulation.volatility).toBeGreaterThan(1);
    expect(simulation.volatility).toBeLessThan(10);
  });
});

describe('the simulation itself', () => {
  it('replays exactly from a seed', () => {
    expect(run('replay', 20_000)).toEqual(run('replay', 20_000));
  });

  it('gives different seeds different sessions', () => {
    expect(run('one', 20_000).returned).not.toBe(run('two', 20_000).returned);
  });

  it('accounts for every unit it staked', () => {
    const simulation = run('accounting', 20_000);

    expect(simulation.staked).toBe(20_000 * STAKE);
    expect(simulation.rtp).toBeCloseTo(simulation.returned / simulation.staked, 12);
    expect(simulation.distribution.reduce((total, count) => total + count, 0)).toBe(20_000);
  });

  /** A round is one stake and everything it buys — the free spins belong to the round that paid. */
  it('counts a feature’s free spins inside the round that triggered them', () => {
    const simulation = run('rounds', 50_000);

    expect(simulation.staked).toBe(50_000 * STAKE);
    expect(simulation.freeSpinsPlayed).toBeGreaterThan(0);
    expect(simulation.featureRtp + simulation.baseRtp).toBeCloseTo(simulation.rtp, 12);
  });

  it('refuses to hang on a feature that will not end', () => {
    // A strip of exactly three symbols, one of them the scatter, so every spin shows one scatter per
    // reel — five scatters, a fresh award, forever. The S4 failure taken to its limit, on purpose.
    const scattered = {
      ...config,
      strips: config.strips.map(() => ['SCAT', 'L1', 'L2']),
    };
    const simulation = simulate({
      config: scattered,
      spins: 20,
      seed: 'runaway',
      stake: STAKE,
      maxFeatureSpins: 50,
    });

    expect(simulation.runaways).toBe(20);
    expect(simulation.longestFeature).toBe(50);
    expect(meetsDesign(simulation)).toBe(false);
  });
});

describe('the report', () => {
  it('prints the design beside the result, and says which rows are out of band', () => {
    const scattered = simulate({
      config: { ...config, strips: config.strips.map(() => ['SCAT', 'L1', 'L2']) },
      spins: 10,
      seed: 'report',
      stake: STAKE,
      maxFeatureSpins: 20,
    });

    const report = formatReport(scattered, {
      mathVersion: '9.9.9',
      seed: 'report',
      elapsedMs: 1_000,
    });

    expect(report).toContain('math 9.9.9');
    expect(report).toContain('OUT OF BAND');
    expect(report).toContain('Win distribution');
  });

  it('passes the shipped math', () => {
    expect(meetsDesign(simulate({ config, spins: SPINS, seed: 'verdict', stake: STAKE }))).toBe(
      true,
    );
  });
});
