import { GameConfigSchema, JURISDICTION_PRESETS } from '@slot/protocol';
import { describe, expect, it } from 'vitest';
import { BET_LEVELS, MATH_CONFIG, MATH_VERSION } from './config.js';
import { PAYLINES } from './paylines.js';
import { FREE_SPIN_AWARDS, PAYTABLE } from './paytable.js';
import { STRIPS } from './strips.js';
import { SCATTER, SYMBOLS, WILD, isGameSymbol } from './symbols.js';

describe('bet levels', () => {
  it('all divide evenly into the line count — this is why no money operation ever rounds', () => {
    for (const level of BET_LEVELS) {
      expect(level % PAYLINES.length).toBe(0);
    }
  });

  it('are ordered and positive', () => {
    expect(BET_LEVELS.every((level) => level > 0)).toBe(true);
    expect([...BET_LEVELS]).toEqual([...BET_LEVELS].sort((a, b) => a - b));
  });
});

describe('the math half of GameConfig', () => {
  it('validates against the wire schema once the server adds its half', () => {
    // The simulator (S0) and the real RGS both compose exactly this way. If this stops parsing,
    // the strips or the paytable have drifted away from the contract.
    const config = GameConfigSchema.parse({
      ...MATH_CONFIG,
      gameId: 'demo-slot',
      betLevels: BET_LEVELS,
      limits: { minStake: 20, maxStake: 4_000, maxWinMultiplier: 5_000 },
      jurisdiction: 'DEFAULT',
      jurisdictionRules: JURISDICTION_PRESETS.DEFAULT,
      devMode: false,
    });

    expect(config.mathVersion).toBe(MATH_VERSION);
    expect(config.strips).toHaveLength(config.reels);
  });

  it('names a version, because a client drawing the wrong reels must be able to notice', () => {
    expect(MATH_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('the strips', () => {
  it('use only symbols this math model can pay', () => {
    for (const strip of STRIPS) {
      for (const symbol of strip) {
        expect(isGameSymbol(symbol)).toBe(true);
      }
    }
  });

  it('keep wilds off reel one — a wild there inflates RTP and ruins near-misses', () => {
    const reelsWithWilds = STRIPS.map((strip) => strip.includes(WILD));

    expect(reelsWithWilds[0]).toBe(false);
    expect(reelsWithWilds[STRIPS.length - 1]).toBe(false);
    expect(reelsWithWilds.slice(1, -1).every(Boolean)).toBe(true);
  });

  /**
   * One or two per reel, and the *upper* bound is the load-bearing half.
   *
   * Scatters are what trigger the feature and what retrigger it, so their count is the single number
   * that decides whether the retrigger converges. Fifteen scatters (three a reel) made it a
   * supercritical branching process — features of 150 free spins and a 125% RTP — which is what S4
   * found and `tools/math-sim` now guards.
   */
  it('carry one or two scatters per reel, so the feature triggers from anywhere and converges', () => {
    for (const strip of STRIPS) {
      const scatters = strip.filter((symbol) => symbol === SCATTER).length;
      expect(scatters).toBeGreaterThanOrEqual(1);
      expect(scatters).toBeLessThanOrEqual(2);
    }
  });
});

describe('the paytable', () => {
  it('prices every symbol except the wild-substituted lows it shares', () => {
    const priced = new Set(PAYTABLE.map((entry) => entry.symbol));

    for (const symbol of SYMBOLS) {
      expect(priced.has(symbol)).toBe(true);
    }
  });

  it('pays the scatter as a scatter and nothing else', () => {
    const scatterEntries = PAYTABLE.filter((entry) => entry.kind === 'SCATTER');

    expect(scatterEntries).toHaveLength(1);
    expect(scatterEntries[0]?.symbol).toBe(SCATTER);
  });

  it('pays more for longer runs, for every symbol', () => {
    for (const entry of PAYTABLE) {
      const multipliers = entry.pays.map((pay) => pay.multiplier);
      expect([...multipliers]).toEqual([...multipliers].sort((a, b) => a - b));
    }
  });

  it('awards free spins exactly where the scatter starts paying', () => {
    const scatterCounts = (PAYTABLE.find((entry) => entry.kind === 'SCATTER')?.pays ?? []).map(
      (pay) => pay.count,
    );

    expect(Object.keys(FREE_SPIN_AWARDS).map(Number)).toEqual(scatterCounts);
  });
});
