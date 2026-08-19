import type {
  AuthenticateRes,
  FeatureProgress,
  FeatureSpinRes,
  GameConfig,
  Minor,
  NextAction,
  PendingRound,
  RoundResult,
  SettleRes,
  SpinRes,
} from '@slot/protocol';
import { JURISDICTION_PRESETS, SlotError } from '@slot/protocol';
import { minor } from '@slot/money';
import { BET_LEVELS, MATH_CONFIG } from '@slot/game-math';
import type { EngineState, Phase } from '../types.js';

/**
 * Hand-built responses, not a simulator.
 *
 * The engine may not depend on `@slot/rgs-sim` — and should not want to. These tests are about what
 * the machine does with a response, so the response is the input, and constructing it by hand is how
 * a test says "a spin that wins and awards nothing" in one line. The real simulator meets the engine
 * in the root soak suite, where the wiring lives.
 */

export const CONFIG: GameConfig = {
  gameId: 'engine-fixture',
  ...MATH_CONFIG,
  strips: MATH_CONFIG.strips.map((strip) => [...strip]),
  paytable: MATH_CONFIG.paytable.map((entry) => ({ ...entry, pays: [...entry.pays] })),
  paylines: MATH_CONFIG.paylines.map((line) => [...line]),
  betLevels: [...BET_LEVELS],
  limits: { minStake: minor(20), maxStake: minor(4_000), maxWinMultiplier: 5_000 },
  jurisdiction: 'DEFAULT',
  jurisdictionRules: JURISDICTION_PRESETS.DEFAULT,
  devMode: false,
};

export const STAKE: Minor = minor(100);
export const BALANCE: Minor = minor(10_000);
export const ROUND_ID = '01890000-0000-7000-8000-000000000001';

export const roundId = (index: number): string =>
  `01890000-0000-7000-8000-${index.toString(16).padStart(12, '0')}`;

export const result = (totalWin = 0): RoundResult => ({
  stops: [0, 0, 0, 0, 0],
  view: [
    ['L4', 'L3', 'H3'],
    ['L3', 'H2', 'L1'],
    ['H3', 'L2', 'L4'],
    ['L1', 'L2', 'H1'],
    ['L4', 'H3', 'L2'],
  ],
  wins:
    totalWin === 0
      ? []
      : [
          {
            kind: 'LINE',
            line: 0,
            symbol: 'H1',
            count: 3,
            positions: [
              [0, 1],
              [1, 1],
              [2, 1],
            ],
            amount: minor(totalWin),
          },
        ],
  totalWin: minor(totalWin),
  features: [],
});

export const feature = (over: Partial<FeatureProgress> = {}): FeatureProgress => ({
  kind: 'FREE_SPINS',
  total: 10,
  remaining: 10,
  step: 0,
  stakeRef: STAKE,
  ...over,
});

export const spinRes = (
  over: {
    totalWin?: number;
    roundWin?: number;
    capped?: boolean;
    feature?: FeatureProgress;
    next?: NextAction;
    balance?: number;
  } = {},
): SpinRes => ({
  roundId: ROUND_ID,
  balance: minor(over.balance ?? BALANCE - STAKE),
  // Uncapped by default, so `roundWin` follows the win unless a test is about the ceiling.
  roundWin: minor(over.roundWin ?? over.totalWin ?? 0),
  capped: over.capped ?? false,
  result: result(over.totalWin ?? 0),
  ...(over.feature === undefined ? {} : { feature: over.feature }),
  next: over.next ?? 'IDLE',
});

export const featureSpinRes = (
  step: number,
  over: {
    totalWin?: number;
    roundWin?: number;
    capped?: boolean;
    feature?: FeatureProgress;
    next?: NextAction;
  } = {},
): FeatureSpinRes => ({
  roundId: ROUND_ID,
  step,
  balance: minor(BALANCE - STAKE),
  roundWin: minor(over.roundWin ?? over.totalWin ?? 0),
  capped: over.capped ?? false,
  result: result(over.totalWin ?? 0),
  feature: over.feature ?? feature({ step, remaining: 10 - step }),
  next: over.next ?? 'FEATURE_SPIN',
});

export const settleRes = (over: { totalWin?: number; capped?: boolean } = {}): SettleRes => ({
  roundId: ROUND_ID,
  balance: minor(BALANCE - STAKE + (over.totalWin ?? 0)),
  totalWin: minor(over.totalWin ?? 0),
  capped: over.capped ?? false,
  next: 'IDLE',
});

export const authRes = (pendingRound?: PendingRound): AuthenticateRes => ({
  session: { playerId: 'p', currency: 'EUR', expiresAt: 4_102_444_800_000 },
  balance: BALANCE,
  config: CONFIG,
  ...(pendingRound === undefined ? {} : { pendingRound }),
});

const session = { config: CONFIG, balance: BALANCE, stake: STAKE };
const round = {
  roundId: ROUND_ID,
  result: result(500),
  roundWin: minor(500),
  capped: false,
  feature: undefined,
};

/** One representative state per phase — the raw material for the exhaustiveness table. */
export const STATES: Record<Phase, EngineState> = {
  BOOTING: { phase: 'BOOTING' },
  IDLE: { phase: 'IDLE', ...session },
  SPINNING: { phase: 'SPINNING', ...session, roundId: ROUND_ID, slam: false },
  STOPPING: { phase: 'STOPPING', ...session, ...round, next: 'SETTLE', slam: false },
  WIN_PRESENTATION: {
    phase: 'WIN_PRESENTATION',
    ...session,
    ...round,
    next: 'SETTLE',
    wins: result(500).wins,
  },
  FEATURE_INTRO: { phase: 'FEATURE_INTRO', ...session, ...round, feature: feature() },
  FEATURE_SPINNING: {
    phase: 'FEATURE_SPINNING',
    ...session,
    ...round,
    feature: feature({ step: 1, remaining: 9 }),
    step: 2,
    slam: false,
  },
  FEATURE_OUTRO: {
    phase: 'FEATURE_OUTRO',
    ...session,
    ...round,
    feature: feature({ step: 10, remaining: 0 }),
  },
  SETTLING: { phase: 'SETTLING', ...session, ...round },
  REAUTHENTICATING: {
    phase: 'REAUTHENTICATING',
    resume: { phase: 'SETTLING', ...session, ...round },
    error: new SlotError('SESSION_EXPIRED', 'fixture'),
  },
  ERROR: {
    phase: 'ERROR',
    error: new SlotError('SCHEMA_MISMATCH', 'fixture'),
    recovery: 'FROZEN',
    resume: { phase: 'IDLE', ...session },
  },
};
