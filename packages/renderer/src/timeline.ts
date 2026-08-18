/**
 * A timeline, and the one operation that makes the interruption contract real: `complete()`.
 *
 * The engine decides that a skip is *legal*; this is the layer that implements it, and the whole
 * difficulty is in one sentence — **skipping must leave exactly the state that finishing would.** A
 * presentation that half-finishes is how a player ends up with a payline still lit over the next
 * spin, or a counter frozen at nine tenths of a win they were actually paid.
 *
 * So the timeline is a list of steps with durations, and `complete()` runs every remaining step to
 * its end, in order, calling the same callbacks with the same final values that the clock would
 * have. That property is asserted directly in `timeline.test.ts`: two identical timelines, one run
 * frame by frame and one completed instantly, must record the same trace.
 *
 * Pure, so it is testable without Pixi — the same split as the spin curve.
 */

export interface TimelineStep {
  /** Milliseconds. Zero is legal: a step that only enters and leaves. */
  readonly durationMs: number;
  /** Called once, before the first progress tick. */
  readonly onEnter?: () => void;
  /** `progress` runs 0 → 1 and is *always* called with exactly 1 before the step is left. */
  readonly onProgress?: (progress: number) => void;
  readonly onLeave?: () => void;
}

export class Timeline {
  readonly #steps: readonly TimelineStep[];
  #index = 0;
  #elapsed = 0;
  #entered = false;

  constructor(steps: readonly TimelineStep[]) {
    this.#steps = steps;
  }

  get finished(): boolean {
    return this.#index >= this.#steps.length;
  }

  /** Total planned duration, which turbo scales and the caller may want for a status readout. */
  get durationMs(): number {
    return this.#steps.reduce((total, step) => total + step.durationMs, 0);
  }

  /**
   * One frame. Returns `true` on the frame the timeline finishes.
   *
   * A single frame may cross several steps — a 300 ms stall on a slow device must not stretch the
   * presentation, it must consume it — so the leftover time carries into the next step rather than
   * being dropped.
   */
  advance(deltaMs: number): boolean {
    if (this.finished) return false;

    let remaining = Math.max(0, deltaMs);

    for (;;) {
      const step = this.#steps[this.#index];
      if (step === undefined) return true;

      if (!this.#entered) {
        this.#entered = true;
        step.onEnter?.();
        step.onProgress?.(0);
      }

      const left = step.durationMs - this.#elapsed;
      if (remaining < left) {
        this.#elapsed += remaining;
        step.onProgress?.(step.durationMs === 0 ? 1 : this.#elapsed / step.durationMs);
        return false;
      }

      remaining -= left;
      this.#leaveCurrent(step);
      if (this.finished) return true;
    }
  }

  /**
   * Snap to the end. Every remaining step enters, reaches `1`, and leaves — in order.
   *
   * Not "jump to the last step": a step that only *enters* (a banner that must be hidden again, a
   * highlight that must be cleared) would be skipped, and the presentation would leak its state into
   * the next round.
   */
  complete(): void {
    while (!this.finished) {
      const step = this.#steps[this.#index];
      if (step === undefined) return;

      if (!this.#entered) {
        this.#entered = true;
        step.onEnter?.();
      }
      this.#leaveCurrent(step);
    }
  }

  #leaveCurrent(step: TimelineStep): void {
    step.onProgress?.(1);
    step.onLeave?.();
    this.#index += 1;
    this.#elapsed = 0;
    this.#entered = false;
  }
}

/** An empty timeline is finished from the start — the shape a dead spin produces. */
export const EMPTY_TIMELINE = (): Timeline => new Timeline([]);
