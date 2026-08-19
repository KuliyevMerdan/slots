import type { Minor } from '@slot/protocol';
import { ZERO, add, max, subtract } from '@slot/money';

/**
 * Player-protective session limits: time, loss, stake.
 *
 * These are the player's own limits (or a jurisdiction's defaults), tracked client-side and applied
 * *conservatively* — a breach stops play; it never decides what play pays. That distinction is why
 * this package may sum stakes and credits at all: every amount below arrived from the server, the
 * sums exist only to halt the game, and no summed figure is ever presented as money the player has
 * (ADR-0001). The server remains the only authority on balances and wins.
 */

export interface SessionLimits {
  /** End play after this long, regardless of anything else. Absent = no time limit. */
  readonly maxSessionMs?: number;
  /** Stop when the session's net loss exceeds this. Absent = no loss limit. */
  readonly maxLoss?: Minor;
  /** Refuse any single stake above this. Absent = the table limits alone apply. */
  readonly maxSingleStake?: Minor;
}

/** What the session has done so far. Amounts are recorded from server responses, never computed. */
export interface SessionTally {
  readonly startedAt: number;
  readonly spins: number;
  /** Total debited: every stake the server accepted. */
  readonly staked: Minor;
  /** Total credited: every settle's `totalWin`. */
  readonly credited: Minor;
}

export type LimitBreach = 'SESSION_TIME' | 'LOSS';

export const startTally = (now: number): SessionTally => ({
  startedAt: now,
  spins: 0,
  staked: ZERO,
  credited: ZERO,
});

export const recordStake = (tally: SessionTally, stake: Minor): SessionTally => ({
  ...tally,
  spins: tally.spins + 1,
  staked: add(tally.staked, stake),
});

export const recordCredit = (tally: SessionTally, credit: Minor): SessionTally => ({
  ...tally,
  credited: add(tally.credited, credit),
});

/** Net loss so far, floored at zero — a session in profit has lost nothing. */
export const netLoss = (tally: SessionTally): Minor =>
  max(ZERO, subtract(tally.staked, tally.credited));

/**
 * The first limit the session has crossed, or `null`.
 *
 * Time is checked before loss: a session that has crossed both is over for the stronger reason,
 * and the message the player sees should say so.
 */
export const limitBreached = (
  limits: SessionLimits,
  tally: SessionTally,
  now: number,
): LimitBreach | null => {
  if (limits.maxSessionMs !== undefined && now - tally.startedAt >= limits.maxSessionMs) {
    return 'SESSION_TIME';
  }
  if (limits.maxLoss !== undefined && netLoss(tally) > limits.maxLoss) return 'LOSS';
  return null;
};

/** Whether a stake passes the player's own ceiling. The table's `betLevels` are checked elsewhere. */
export const stakeWithinLimit = (limits: SessionLimits, stake: Minor): boolean =>
  limits.maxSingleStake === undefined || stake <= limits.maxSingleStake;
