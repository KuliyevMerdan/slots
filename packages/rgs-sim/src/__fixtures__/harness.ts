import type { GameConfig, Minor, RoundId, SymbolId } from '@slot/protocol';
import { minor } from '@slot/money';
import { SCATTER } from '@slot/game-math';
import { createSimConfig } from '../config.js';
import { deriveSpinSeed } from '../prng.js';
import { spinOutcome } from '../outcome.js';
import type { SpinOutcome } from '../outcome.js';
import { createSimState } from '../state.js';
import type { SimState } from '../state.js';

/**
 * Shared test scaffolding.
 *
 * Two ideas do most of the work here. `roundId(n)` mints ids the protocol's UUIDv7 schema accepts,
 * so tests exercise the real validation rather than a relaxed one. `findRoundWhere` *searches* the
 * seeded outcome space for a round of a given shape instead of hard-coding stop indices — which
 * means a future strip change makes these tests find different rounds, not fail.
 */

/** A UUIDv7-shaped id: version nibble `7`, variant `8`, the rest an index. */
export const roundId = (index: number): RoundId =>
  `01890000-0000-7000-8000-${index.toString(16).padStart(12, '0')}`;

export const SEED = 'block-s0-fixture-seed';
export const START_BALANCE: Minor = minor(1_000_000);
export const STAKE: Minor = minor(100);
export const EXPIRES_AT = 4_102_444_800_000; // 2100-01-01, so no test expires by accident.

export const testConfig = (overrides: Parameters<typeof createSimConfig>[0] = {}): GameConfig =>
  createSimConfig(overrides);

export const testState = (
  overrides: Partial<Parameters<typeof createSimState>[0]> = {},
): SimState =>
  createSimState({
    serverSeed: SEED,
    balance: START_BALANCE,
    expiresAt: EXPIRES_AT,
    ...overrides,
  });

export const testContext = (config: GameConfig = testConfig(), now = 1_700_000_000_000) => ({
  config,
  now,
});

/**
 * The first round id whose base-game outcome matches `predicate`.
 *
 * Cheap because it goes straight to the outcome engine rather than through the handlers: no state,
 * no debit, no round record. A test that needs "a spin that wins nothing" says exactly that.
 */
export function findRoundWhere(
  config: GameConfig,
  predicate: (outcome: SpinOutcome) => boolean,
  { serverSeed = SEED, stake = STAKE, limit = 20_000 } = {},
): { roundId: RoundId; outcome: SpinOutcome } {
  for (let index = 1; index <= limit; index += 1) {
    const id = roundId(index);
    const outcome = spinOutcome(config, deriveSpinSeed(serverSeed, id, undefined, 0), stake);
    if (predicate(outcome)) return { roundId: id, outcome };
  }
  throw new Error(`no outcome matched the predicate within ${limit} rounds`);
}

/** A spin that pays nothing and triggers nothing — the round that settles atomically. */
export const deadSpin = (config: GameConfig) =>
  findRoundWhere(config, (outcome) => outcome.totalWin === 0 && outcome.scatters < 3);

/** A spin that pays but awards no feature — the round that needs an explicit `settle`. */
export const payingSpin = (config: GameConfig) =>
  findRoundWhere(config, (outcome) => outcome.totalWin > 0 && outcome.scatters < 3);

/** A spin that triggers free spins. */
export const triggeringSpin = (config: GameConfig) =>
  findRoundWhere(config, (outcome) => outcome.scatters >= 3);

/**
 * A base spin paying more than `multiple × STAKE` — the raw material for max-win ceiling tests.
 *
 * Searched on the real strips rather than forced, so a re-tune moves which round it finds instead of
 * leaving the test pointing at a screen that no longer pays what it used to.
 */
export const spinWinningOver = (config: GameConfig, multiple: number) =>
  findRoundWhere(config, (outcome) => outcome.totalWin > multiple * STAKE && outcome.scatters < 3);

const windowAt = (strip: readonly SymbolId[], stop: number, rows: number): SymbolId[] =>
  Array.from({ length: rows }, (_unused, row) => strip[(stop + row) % strip.length] ?? '');

/**
 * Stops that put exactly `target` scatters on screen — the raw material for `forceOutcome` tests.
 *
 * Built by picking, per reel, the first stop whose visible window holds one scatter or none. That
 * is a search over the real strips, so it keeps working when the strips are re-tuned in S4.
 */
export function stopsForScatters(config: GameConfig, target: number): number[] {
  const firstStopWith = (strip: readonly SymbolId[], scatters: number): number => {
    const stop = strip.findIndex(
      (_unused, index) =>
        windowAt(strip, index, config.rows).filter((symbol) => symbol === SCATTER).length ===
        scatters,
    );
    if (stop === -1) throw new Error(`no stop on this strip shows exactly ${scatters} scatters`);
    return stop;
  };

  return config.strips.map((strip, reel) => firstStopWith(strip, reel < target ? 1 : 0));
}
