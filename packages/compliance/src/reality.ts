import type { JurisdictionRules } from '@slot/protocol';

/**
 * The reality check: a jurisdiction-mandated interruption that tells the player how long they have
 * been playing and makes them choose to continue.
 *
 * Pure schedule arithmetic — when one is due, and what the overlay says. What the overlay *is* and
 * when it may interrupt (never mid-round) are the client's; a check that fires between rounds is a
 * presentation decision this package only times.
 *
 * Deliberately time-only: the overlay states minutes played, not money won or lost. A money figure
 * would have this package summing amounts into a player-facing number, and the one rule this
 * codebase does not bend is that money the player sees comes from the server (ADR-0001). Session
 * totals for *limit enforcement* live in limits.ts, where they stop play rather than describe it.
 */

export interface RealityCheckState {
  /** When play began. Fixed for the session; the overlay's "you have been playing for" anchor. */
  readonly startedAt: number;
  /** When the player last acknowledged a check. Starts equal to `startedAt`. */
  readonly acknowledgedAt: number;
}

export const startRealityCheck = (now: number): RealityCheckState => ({
  startedAt: now,
  acknowledgedAt: now,
});

/** Whether a check is due. Never true when the rules set no interval. */
export const realityCheckDue = (
  rules: JurisdictionRules,
  state: RealityCheckState,
  now: number,
): boolean =>
  rules.realityCheckIntervalMs > 0 && now - state.acknowledgedAt >= rules.realityCheckIntervalMs;

/** The player chose to continue. The next check is one interval from now. */
export const acknowledgeRealityCheck = (
  state: RealityCheckState,
  now: number,
): RealityCheckState => ({ ...state, acknowledgedAt: now });

/** Whole minutes since play began — the number the overlay states. */
export const minutesPlayed = (state: RealityCheckState, now: number): number =>
  Math.max(0, Math.floor((now - state.startedAt) / 60_000));
