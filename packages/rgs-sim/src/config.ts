import type { GameConfig, JurisdictionId, Minor } from '@slot/protocol';
import { minor } from '@slot/money';
import { BET_LEVELS, MATH_CONFIG } from '@slot/game-math';

/**
 * The `GameConfig` this simulator serves.
 *
 * `@slot/game-math` owns the math half — strips, paylines, paytable, `mathVersion` — and this file
 * adds the commercial half: what a player may stake, what they can win at most, which regime they
 * are under, and whether this server will honour `forceOutcome` at all. That split is not
 * decoration; it is the same seam `apps/rgs` will have, where the math is a shipped artefact and
 * the limits come from the operator's configuration.
 */

export const SIM_GAME_ID = 'aurora-reels';

const firstBetLevel = BET_LEVELS[0];
const lastBetLevel = BET_LEVELS[BET_LEVELS.length - 1];

/* `BET_LEVELS` is non-empty by construction, but `noUncheckedIndexedAccess` does not know that and
 * a silently-undefined stake limit is precisely the bug that flag exists to catch. */
if (firstBetLevel === undefined || lastBetLevel === undefined) {
  throw new RangeError('@slot/game-math exported an empty BET_LEVELS');
}

/**
 * The absolute payout ceiling, in minor units — 5,000× the largest bet level.
 *
 * Note that the protocol makes this an *absolute* amount rather than a multiple of the stake the
 * player actually placed, so a minimum-stake player shares the ceiling with a maximum-stake one.
 * That is not how real max-win caps work; it is logged in the gaps registry rather than quietly
 * worked around here.
 */
export const SIM_MAX_WIN: Minor = minor(lastBetLevel * 5_000);

export interface SimConfigOptions {
  gameId?: string;
  jurisdiction?: JurisdictionId;
  /** Whether this server honours `forceOutcome`. Never true in production — docs/protocol.md §8. */
  devMode?: boolean;
  minStake?: Minor;
  maxStake?: Minor;
  maxWin?: Minor;
}

export const createSimConfig = ({
  gameId = SIM_GAME_ID,
  jurisdiction = 'DEFAULT',
  devMode = false,
  minStake = firstBetLevel,
  maxStake = lastBetLevel,
  maxWin = SIM_MAX_WIN,
}: SimConfigOptions = {}): GameConfig => ({
  gameId,
  ...MATH_CONFIG,
  strips: MATH_CONFIG.strips.map((strip) => [...strip]),
  paytable: MATH_CONFIG.paytable.map((entry) => ({ ...entry, pays: [...entry.pays] })),
  paylines: MATH_CONFIG.paylines.map((line) => [...line]),
  betLevels: [...BET_LEVELS],
  limits: { minStake, maxStake, maxWin },
  jurisdiction,
  devMode,
});
