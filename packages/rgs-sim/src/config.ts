import type { GameConfig, JurisdictionId, JurisdictionRules, Minor } from '@slot/protocol';
import { JURISDICTION_PRESETS } from '@slot/protocol';
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
 * The payout ceiling, as a multiple of the stake the player actually placed.
 *
 * 5,000× is the industry-conventional headline figure, and the measured game reaches 304× in twenty
 * million rounds — so the ceiling is real but rare, which is what a max-win cap is for. It applies
 * per round, as the round accrues (docs/protocol.md §3, D7).
 */
export const SIM_MAX_WIN_MULTIPLIER = 5_000;

export interface SimConfigOptions {
  gameId?: string;
  jurisdiction?: JurisdictionId;
  /**
   * What the declared jurisdiction requires. Defaults to the protocol's baseline preset for the id —
   * overriding it is the operator-configuration seam (docs/protocol.md D8), and what lets a test
   * pin one rule without impersonating a whole regime.
   */
  jurisdictionRules?: JurisdictionRules;
  /** Whether this server honours `forceOutcome`. Never true in production — docs/protocol.md §8. */
  devMode?: boolean;
  minStake?: Minor;
  maxStake?: Minor;
  maxWinMultiplier?: number;
}

export const createSimConfig = ({
  gameId = SIM_GAME_ID,
  jurisdiction = 'DEFAULT',
  jurisdictionRules = JURISDICTION_PRESETS[jurisdiction],
  devMode = false,
  minStake = firstBetLevel,
  maxStake = lastBetLevel,
  maxWinMultiplier = SIM_MAX_WIN_MULTIPLIER,
}: SimConfigOptions = {}): GameConfig => ({
  gameId,
  ...MATH_CONFIG,
  strips: MATH_CONFIG.strips.map((strip) => [...strip]),
  paytable: MATH_CONFIG.paytable.map((entry) => ({ ...entry, pays: [...entry.pays] })),
  paylines: MATH_CONFIG.paylines.map((line) => [...line]),
  betLevels: [...BET_LEVELS],
  limits: { minStake, maxStake, maxWinMultiplier },
  jurisdiction,
  jurisdictionRules: { ...jurisdictionRules },
  devMode,
});
