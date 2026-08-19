import type { JurisdictionRules } from '@slot/protocol';

/**
 * The client's half of the wire's pacing rule (docs/protocol.md §2.1).
 *
 * The server refuses a spin that arrives before `minSpinIntervalMs` has passed; these functions are
 * how a compliant client never sends one. Everything takes `now` as an argument — this package has
 * no clock, which is what makes a 2.5-second rule testable in a millisecond.
 */

/**
 * When the next base-game spin may start. `0` — the epoch, i.e. immediately — when the rules set no
 * floor or no spin has happened yet.
 */
export const nextSpinAllowedAt = (
  rules: JurisdictionRules,
  lastSpinStartedAt: number | undefined,
): number =>
  rules.minSpinIntervalMs <= 0 || lastSpinStartedAt === undefined
    ? 0
    : lastSpinStartedAt + rules.minSpinIntervalMs;

/** How long the button must stay held back, in ms. `0` when a spin is allowed now. */
export const spinDelay = (
  rules: JurisdictionRules,
  lastSpinStartedAt: number | undefined,
  now: number,
): number => Math.max(0, nextSpinAllowedAt(rules, lastSpinStartedAt) - now);

export const canSpin = (
  rules: JurisdictionRules,
  lastSpinStartedAt: number | undefined,
  now: number,
): boolean => spinDelay(rules, lastSpinStartedAt, now) === 0;
