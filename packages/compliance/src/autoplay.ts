import type { JurisdictionRules, Minor } from '@slot/protocol';
import { ZERO, add, max, subtract } from '@slot/money';

/**
 * Autoplay's decision core: when the next automatic press is allowed, and when the run must stop.
 *
 * Pure on purpose. The controller that actually presses lives in the client, *above* the engine —
 * it sends `PRESS` on `IDLE` and feeds `ROUND_SETTLED` back in here — so the engine never learns
 * autoplay exists, which is itself the demonstration that the FSM's input contract is right. This
 * module is the half a regulator cares about: the stop conditions, evaluated after every round.
 */

export interface AutoplayPlan {
  /** How many rounds the player asked for. */
  readonly spins: number;
  /** Stop when a single round pays more than this. Absent = no win stop. */
  readonly stopOnSingleWinOver?: Minor;
  /** Stop when the run's net loss exceeds this. Absent = no loss stop. */
  readonly stopOnLossExceeding?: Minor;
  /** Stop when a round triggers a feature — the player should watch what they won. */
  readonly stopOnFeature?: boolean;
}

export interface AutoplayState {
  readonly remaining: number;
  /** The run's own tally, separate from the session's: limits apply to what *this run* did. */
  readonly staked: Minor;
  readonly credited: Minor;
}

export type AutoplayStop =
  | 'COMPLETE'
  | 'WIN_LIMIT'
  | 'LOSS_LIMIT'
  | 'FEATURE'
  /** The jurisdiction forbids autoplay — the run never starts. */
  | 'NOT_ALLOWED';

/** What one settled round did, as the controller read it off the engine's events. */
export interface AutoplayRound {
  readonly stake: Minor;
  /** The round's credited total — `ROUND_SETTLED.totalWin`, a server number. */
  readonly totalWin: Minor;
  readonly triggeredFeature: boolean;
}

export const autoplayPermitted = (rules: JurisdictionRules): boolean => rules.autoplayAllowed;

export const startAutoplay = (plan: AutoplayPlan): AutoplayState => ({
  remaining: Math.max(0, plan.spins),
  staked: ZERO,
  credited: ZERO,
});

/**
 * Fold one settled round into the run and decide whether it goes on.
 *
 * Stop reasons are checked from most specific to least: a max-win round that was also the last
 * planned spin stops as `WIN_LIMIT`, because that is the reason the player will want explained.
 */
export const afterRound = (
  state: AutoplayState,
  plan: AutoplayPlan,
  round: AutoplayRound,
): { state: AutoplayState; stop: AutoplayStop | null } => {
  const next: AutoplayState = {
    remaining: Math.max(0, state.remaining - 1),
    staked: add(state.staked, round.stake),
    credited: add(state.credited, round.totalWin),
  };

  const loss = max(ZERO, subtract(next.staked, next.credited));

  const stop: AutoplayStop | null =
    plan.stopOnSingleWinOver !== undefined && round.totalWin > plan.stopOnSingleWinOver
      ? 'WIN_LIMIT'
      : plan.stopOnLossExceeding !== undefined && loss > plan.stopOnLossExceeding
        ? 'LOSS_LIMIT'
        : plan.stopOnFeature === true && round.triggeredFeature
          ? 'FEATURE'
          : next.remaining === 0
            ? 'COMPLETE'
            : null;

  return { state: next, stop };
};
