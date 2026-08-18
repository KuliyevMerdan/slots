import { describe, expect, it } from 'vitest';
import { CALLS, SettleResSchema, SpinReqSchema, SpinResSchema } from './calls.js';
import { GameConfigSchema } from './config.js';
import { FeatureProgressSchema } from './round.js';

const ROUND_ID = '0192f0c4-6b7a-7c3d-8f21-2b1c9d4e5f60';

const gameConfig = {
  gameId: 'demo',
  mathVersion: '1.0.0',
  reels: 3,
  rows: 3,
  strips: [
    ['A', 'B', 'C'],
    ['A', 'B', 'C'],
    ['A', 'B', 'C'],
  ],
  paytable: [{ symbol: 'A', kind: 'LINE', pays: [{ count: 3, multiplier: 10 }] }],
  paylines: [[1, 1, 1]],
  betLevels: [50, 100],
  limits: { minStake: 50, maxStake: 10_000, maxWinMultiplier: 5_000 },
  jurisdiction: 'DEFAULT',
  devMode: false,
};

describe('spin', () => {
  it('accepts a well-formed request', () => {
    const parsed = SpinReqSchema.parse({ roundId: ROUND_ID, stake: 100 });

    expect(parsed.stake).toBe(100);
    expect(parsed.roundId).toBe(ROUND_ID);
  });

  it.each([
    ['a fractional stake', { roundId: ROUND_ID, stake: 1.5 }],
    ['a zero stake', { roundId: ROUND_ID, stake: 0 }],
    ['a negative stake', { roundId: ROUND_ID, stake: -100 }],
    ['a roundId that is not a UUIDv7', { roundId: 'round-1', stake: 100 }],
    ['a v4 roundId', { roundId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', stake: 100 }],
  ])('rejects %s', (_label, request) => {
    expect(SpinReqSchema.safeParse(request).success).toBe(false);
  });

  it('rejects a response whose balance is not an integer — money is minor units, always', () => {
    const result = SpinResSchema.safeParse({
      roundId: ROUND_ID,
      balance: 99.5,
      roundWin: 0,
      capped: false,
      result: {
        stops: [0, 0, 0],
        view: [['A'], ['A'], ['A']],
        wins: [],
        totalWin: 0,
        features: [],
      },
      next: 'IDLE',
    });

    expect(result.success).toBe(false);
  });
});

describe('settle', () => {
  it('always hands the client back to IDLE', () => {
    const parsed = SettleResSchema.parse({
      roundId: ROUND_ID,
      balance: 5_000,
      totalWin: 1_200,
      capped: false,
      next: 'IDLE',
    });

    expect(parsed.next).toBe('IDLE');
  });

  it('rejects a settle that tries to hand back anything else', () => {
    const result = SettleResSchema.safeParse({
      roundId: ROUND_ID,
      balance: 5_000,
      totalWin: 1_200,
      capped: false,
      next: 'FEATURE_SPIN',
    });

    expect(result.success).toBe(false);
  });
});

describe('feature progress', () => {
  const base = {
    kind: 'FREE_SPINS',
    total: 10,
    remaining: 4,
    step: 6,
    stakeRef: 100,
  };

  it('accepts a consistent snapshot', () => {
    expect(FeatureProgressSchema.parse(base).remaining).toBe(4);
  });

  it.each([
    ['more remaining than were ever awarded', { ...base, remaining: 11 }],
    ['a step past the total', { ...base, step: 11 }],
    ['a zero stake reference', { ...base, stakeRef: 0 }],
  ])('rejects %s', (_label, progress) => {
    expect(FeatureProgressSchema.safeParse(progress).success).toBe(false);
  });
});

describe('game config', () => {
  it('accepts a coherent config', () => {
    expect(GameConfigSchema.parse(gameConfig).gameId).toBe('demo');
  });

  it.each([
    ['fewer strips than reels', { ...gameConfig, strips: [['A'], ['B']] }],
    ['a payline that skips a reel', { ...gameConfig, paylines: [[1, 1]] }],
    ['a payline outside the visible window', { ...gameConfig, paylines: [[0, 0, 9]] }],
    [
      'a max-win multiplier of zero — a game nobody can win',
      { ...gameConfig, limits: { minStake: 50, maxStake: 10_000, maxWinMultiplier: 0 } },
    ],
    [
      'minStake above maxStake',
      { ...gameConfig, limits: { minStake: 999, maxStake: 100, maxWinMultiplier: 5_000 } },
    ],
  ])('rejects %s', (_label, config) => {
    expect(GameConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe('the call table', () => {
  it('names every call, and marks the three that mutate', () => {
    expect(Object.keys(CALLS)).toEqual([
      'authenticate',
      'spin',
      'featureSpin',
      'settle',
      'history',
    ]);
    expect(
      Object.entries(CALLS)
        .filter(([, call]) => call.mutating)
        .map(([name]) => name),
    ).toEqual(['spin', 'featureSpin', 'settle']);
  });
});
