import type { SlotEngine } from '@slot/engine';
import type { EngineEvent } from '@slot/engine';
import type { JurisdictionRules, Minor } from '@slot/protocol';
import { ZERO } from '@slot/money';
import { afterRound, autoplayPermitted, spinDelay, startAutoplay } from '@slot/compliance';
import type { AutoplayPlan, AutoplayState, AutoplayStop } from '@slot/compliance';

/**
 * The autoplay controller — a player above the engine, never inside it.
 *
 * It does exactly what a human does: sends `PRESS` when the table is idle, watches the round finish,
 * decides whether to press again. The engine is untouched — it cannot tell this press from a
 * player's, which is the demonstration that the FSM's input contract is right. The decisions — stop
 * conditions, pacing — are `@slot/compliance`'s pure functions; this class is the loop around them.
 *
 * Two rules a regulator would read first: the run never starts where the jurisdiction forbids it
 * (`autoplayAllowed`), and every automatic press respects the same `minSpinIntervalMs` a human
 * press does — autoplay is not a way around the pacing rule.
 */

export interface AutoplayView {
  readonly active: boolean;
  readonly remaining: number | undefined;
  /** Why the last run ended, until a new one starts. */
  readonly stopped: AutoplayStop | null;
}

export interface AutoplayControllerOptions {
  engine: SlotEngine;
  rules: JurisdictionRules;
  /** Re-rendered on every change of the view — the AUTO button reflects it. */
  onChange: (view: AutoplayView) => void;
  /** Injected clock and timer, so a test can drive the loop without waiting through one. */
  now?: () => number;
  schedule?: (run: () => void, delayMs: number) => () => void;
}

const defaultSchedule = (run: () => void, delayMs: number): (() => void) => {
  const handle = setTimeout(run, delayMs);
  return () => clearTimeout(handle);
};

export class AutoplayController {
  readonly #engine: SlotEngine;
  readonly #rules: JurisdictionRules;
  readonly #onChange: (view: AutoplayView) => void;
  readonly #now: () => number;
  readonly #schedule: (run: () => void, delayMs: number) => () => void;
  readonly #unsubscribe: () => void;

  #plan: AutoplayPlan | null = null;
  #state: AutoplayState | null = null;
  #stopped: AutoplayStop | null = null;
  #cancelPress: (() => void) | null = null;

  /** The round in flight, as the events told it: what was staked, won, and whether it triggered. */
  #roundStake: Minor = ZERO;
  #roundWin: Minor = ZERO;
  #roundFeature = false;
  #roundInFlight = false;
  #lastSpinStartedAt: number | undefined;

  constructor({
    engine,
    rules,
    onChange,
    now = () => Date.now(),
    schedule = defaultSchedule,
  }: AutoplayControllerOptions) {
    this.#engine = engine;
    this.#rules = rules;
    this.#onChange = onChange;
    this.#now = now;
    this.#schedule = schedule;
    this.#unsubscribe = engine.on((event) => {
      this.#observe(event);
    });
  }

  get view(): AutoplayView {
    return {
      active: this.#plan !== null,
      remaining: this.#state?.remaining,
      stopped: this.#stopped,
    };
  }

  /** Start a run. Refused — `NOT_ALLOWED` — where the jurisdiction forbids autoplay. */
  start(plan: AutoplayPlan): boolean {
    if (!autoplayPermitted(this.#rules)) {
      this.#stopped = 'NOT_ALLOWED';
      this.#onChange(this.view);
      return false;
    }

    this.#plan = plan;
    this.#state = startAutoplay(plan);
    this.#stopped = null;
    this.#onChange(this.view);
    this.#pressWhenAllowed();
    return true;
  }

  /** Stop the run — the player pressed AUTO again, an error rose, or an overlay needs the table. */
  stop(reason: AutoplayStop | null = null): void {
    this.#cancelPress?.();
    this.#cancelPress = null;
    if (this.#plan === null && reason === null) return;
    this.#plan = null;
    this.#state = null;
    this.#stopped = reason;
    this.#onChange(this.view);
  }

  destroy(): void {
    this.stop();
    this.#unsubscribe();
  }

  #observe(event: EngineEvent): void {
    switch (event.type) {
      case 'SPIN_STARTED':
        // Every spin is watched, not only autoplay's own: the pacing anchor is the last spin the
        // session made, whoever pressed for it.
        this.#lastSpinStartedAt = this.#now();
        this.#roundStake = event.stake;
        this.#roundWin = ZERO;
        this.#roundFeature = false;
        this.#roundInFlight = true;
        return;

      case 'FEATURE_AWARDED':
        this.#roundFeature = true;
        return;

      case 'ROUND_SETTLED':
        // The settled path. Folded here, on the event that carries the credit, and NOT on the
        // phase change — `PHASE_CHANGED` is emitted first, and a fold built on it would read the
        // round's win as zero. The same ordering lesson the feature banner learned in C5.
        this.#roundWin = event.totalWin;
        if (this.#roundInFlight) {
          this.#roundInFlight = false;
          this.#roundFinished();
        }
        return;

      case 'PHASE_CHANGED':
        // The atomic path: a zero-win base round goes STOPPING → IDLE with no settle ever coming,
        // so the phase change is the only signal there is — and a zero win is exactly what it says.
        if (event.to === 'IDLE' && event.from === 'STOPPING' && this.#roundInFlight) {
          this.#roundInFlight = false;
          this.#roundFinished();
        }
        return;

      case 'ERROR_RAISED':
        // Any error ends the run. A modal with autoplay still firing behind it is the kind of bug
        // regulators write bulletins about.
        this.stop(null);
        return;

      default:
        return;
    }
  }

  #roundFinished(): void {
    const plan = this.#plan;
    const state = this.#state;
    if (plan === null || state === null) return;

    const { state: next, stop } = afterRound(state, plan, {
      stake: this.#roundStake,
      totalWin: this.#roundWin,
      triggeredFeature: this.#roundFeature,
    });
    this.#state = next;

    if (stop !== null) {
      this.stop(stop);
      return;
    }

    this.#onChange(this.view);
    this.#pressWhenAllowed();
  }

  #pressWhenAllowed(): void {
    this.#cancelPress?.();
    const delay = spinDelay(this.#rules, this.#lastSpinStartedAt, this.#now());
    this.#cancelPress = this.#schedule(() => {
      this.#cancelPress = null;
      // Only a table that is actually idle takes the press; anything else means the world moved
      // under the timer (an error, a reload) and the run has already been stopped or will be.
      if (this.#plan !== null && this.#engine.state.phase === 'IDLE') {
        this.#engine.send({ type: 'PRESS' });
      }
    }, delay);
  }
}
