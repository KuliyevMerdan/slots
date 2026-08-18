import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CURVE,
  advance,
  isBlurred,
  isStopped,
  parked,
  reducedMotionCurve,
  slam,
  startSpin,
  target,
} from './curve.js';
import type { ReelMotion, SpinCurve } from './curve.js';

/**
 * The feel of a slot is the thing you cannot review by reading, so what is asserted here is what
 * must be *true* underneath it: the reel lands on the server's stop exactly, it goes through all
 * five stages in order, and a slam changes only how long it takes.
 *
 * The whole module is pure, so a "frame" is just a number of milliseconds and 1,000 spins take
 * milliseconds to test.
 */

const STRIP = 40;
const options = (curve: SpinCurve = DEFAULT_CURVE) => ({ stripLength: STRIP, curve });

/** Run the machine at a fixed frame time until it stops, or until the budget runs out. */
const run = (
  motion: ReelMotion,
  { frameMs = 16.67, budgetMs = 20_000, curve = DEFAULT_CURVE } = {},
): { motion: ReelMotion; elapsedMs: number; phases: string[] } => {
  const phases: string[] = [motion.phase];
  let current = motion;
  let elapsedMs = 0;

  while (!isStopped(current) && elapsedMs < budgetMs) {
    current = advance(current, frameMs, options(curve));
    elapsedMs += frameMs;
    if (phases[phases.length - 1] !== current.phase) phases.push(current.phase);
  }

  return { motion: current, elapsedMs, phases };
};

const spinning = (
  stop: number,
  { reel = 0, anticipated = false, isSlam = false } = {},
): ReelMotion =>
  target(startSpin(parked(0), { reel, slam: isSlam, anticipated }, DEFAULT_CURVE), stop, isSlam);

describe('landing', () => {
  it.each([0, 1, 7, 17, 39])('comes to rest exactly on stop %i', (stop) => {
    const { motion } = run(spinning(stop));

    expect(motion.phase).toBe('STOPPED');
    expect(motion.position % STRIP).toBeCloseTo(stop, 10);
    expect(Number.isInteger(Math.round(motion.position))).toBe(true);
  });

  /** A frame budget is not a promise. The landing must not depend on the frame rate. */
  it.each([8, 16.67, 33.4, 50])('lands on the same stop at a %ims frame time', (frameMs) => {
    const { motion } = run(spinning(23), { frameMs });

    expect(motion.position % STRIP).toBeCloseTo(23, 10);
  });

  it('never lands short: the reel always travels at least the minimum deceleration', () => {
    const { motion } = run(spinning(1));

    // Stop 1 is barely ahead of the start, so the reel must go round rather than stop on a sixpence.
    expect(motion.position).toBeGreaterThan(DEFAULT_CURVE.minDecelerateSymbols);
  });

  it('overshoots the stop and comes back to it', () => {
    let motion = spinning(11);
    let maximum = 0;

    while (!isStopped(motion)) {
      motion = advance(motion, 16.67, options());
      maximum = Math.max(maximum, motion.position);
    }

    expect(maximum).toBeGreaterThan(motion.position);
    expect(maximum - motion.position).toBeLessThanOrEqual(DEFAULT_CURVE.overshoot + 1e-9);
  });
});

describe('the five stages', () => {
  it('passes through all of them, in order', () => {
    const { phases } = run(spinning(5));

    expect(phases).toEqual([
      'ANTICIPATION',
      'ACCELERATING',
      'CRUISING',
      'DECELERATING',
      'SETTLING',
      'STOPPED',
    ]);
  });

  it('dips backwards before it launches, and returns to where it started', () => {
    let motion = startSpin(parked(4), { reel: 0, slam: false, anticipated: false }, DEFAULT_CURVE);
    let lowest = 4;

    while (motion.phase === 'ANTICIPATION') {
      motion = advance(motion, 8, options());
      lowest = Math.min(lowest, motion.position);
    }

    expect(lowest).toBeLessThan(4);
    expect(4 - lowest).toBeLessThanOrEqual(DEFAULT_CURVE.dipSymbols + 1e-9);
    expect(motion.position).toBeCloseTo(4, 2);
  });

  /**
   * The response can arrive before the reel has finished accelerating — `MockTransport` answers in
   * under a millisecond. The target is stored, and the reel still spins for as long as it looks
   * like a spin.
   */
  it('cruises for the minimum even when the outcome is already known', () => {
    const { elapsedMs } = run(spinning(9));

    expect(elapsedMs).toBeGreaterThanOrEqual(
      DEFAULT_CURVE.anticipationMs + DEFAULT_CURVE.accelerateMs + DEFAULT_CURVE.minCruiseMs,
    );
  });

  it('waits for a target it has not been given', () => {
    let motion = startSpin(parked(0), { reel: 0, slam: false, anticipated: false }, DEFAULT_CURVE);
    for (let frame = 0; frame < 300; frame += 1) motion = advance(motion, 16.67, options());

    expect(motion.phase).toBe('CRUISING');

    motion = target(motion, 12, false);
    const { motion: stopped } = run(motion);

    expect(stopped.position % STRIP).toBeCloseTo(12, 10);
  });
});

describe('the stagger', () => {
  it('stops later the further right the reel is', () => {
    const times = [0, 1, 2, 3, 4].map((reel) => run(spinning(3, { reel })).elapsedMs);

    for (let index = 1; index < times.length; index += 1) {
      expect(times[index] as number).toBeGreaterThan(times[index - 1] as number);
    }
  });

  it('holds a reel under scatter anticipation noticeably longer', () => {
    const ordinary = run(spinning(3, { reel: 2 })).elapsedMs;
    const anticipated = run(spinning(3, { reel: 2, anticipated: true })).elapsedMs;

    expect(anticipated - ordinary).toBeGreaterThanOrEqual(DEFAULT_CURVE.anticipationHoldMs - 50);
  });
});

describe('the slam stop', () => {
  it('lands on the same stop, sooner', () => {
    const ordinary = run(spinning(21, { reel: 4 }));
    const slammed = run(spinning(21, { reel: 4, isSlam: true }));

    expect(slammed.motion.position % STRIP).toBeCloseTo(21, 10);
    expect(slammed.elapsedMs).toBeLessThan(ordinary.elapsedMs);
  });

  it('can be asked for mid-spin, and drops the remaining hold', () => {
    let motion = spinning(30, { reel: 4, anticipated: true });
    for (let frame = 0; frame < 40; frame += 1) motion = advance(motion, 16.67, options());

    const slammed = run(slam(motion, DEFAULT_CURVE));

    expect(slammed.motion.position % STRIP).toBeCloseTo(30, 10);
    expect(slammed.motion.holdMs).toBe(0);
  });

  it('is ignored once the reel is already coming to rest — a landing is not re-planned', () => {
    let motion = spinning(6);
    while (motion.phase !== 'DECELERATING') motion = advance(motion, 16.67, options());

    expect(slam(motion, DEFAULT_CURVE)).toBe(motion);
  });
});

describe('the blur threshold', () => {
  it('is off at rest, on at speed, and off again by the time the reel stops', () => {
    let motion = spinning(15);
    expect(isBlurred(motion, DEFAULT_CURVE)).toBe(false);

    let blurredAtSpeed = false;
    while (!isStopped(motion)) {
      motion = advance(motion, 16.67, options());
      if (motion.phase === 'CRUISING') blurredAtSpeed = isBlurred(motion, DEFAULT_CURVE);
    }

    expect(blurredAtSpeed).toBe(true);
    expect(isBlurred(motion, DEFAULT_CURVE)).toBe(false);
  });
});

describe('the machine is total', () => {
  it('survives a zero-length frame without moving or dividing by zero', () => {
    const motion = advance(spinning(4), 0, options());

    expect(Number.isFinite(motion.position)).toBe(true);
    expect(Number.isFinite(motion.velocity)).toBe(true);
  });

  it('does nothing to a parked reel', () => {
    const motion = advance(parked(3), 16.67, options());

    expect(motion.position).toBe(3);
    expect(motion.phase).toBe('IDLE');
  });

  /** A thousand spins, every stop on the strip, all of them landing where the server said. */
  it('lands correctly for every stop on the strip, at three frame rates', () => {
    for (const frameMs of [11, 16.67, 25]) {
      for (let stop = 0; stop < STRIP; stop += 1) {
        const { motion } = run(spinning(stop, { reel: stop % 5 }), { frameMs });
        expect(motion.position % STRIP).toBeCloseTo(stop, 9);
      }
    }
  });
});

/* ── prefers-reduced-motion ───────────────────────────────────────────────────────────────── */

/**
 * The preference removes the *travel*, not the outcome.
 *
 * Which is why it is tested here rather than looked at: a reduced-motion reel still has to land on
 * the stop the server committed to, exactly, at any frame rate — an accessibility mode that quietly
 * lands on the wrong symbol would be worse than not having one.
 */
describe('reduced motion', () => {
  const REDUCED = reducedMotionCurve(DEFAULT_CURVE);

  it.each([0, 1, 7, 17, 39])('still lands exactly on stop %i', (stop) => {
    const { motion } = run(
      target(
        startSpin(parked(0), { reel: 2, slam: false, anticipated: true }, REDUCED),
        stop,
        false,
      ),
      { curve: REDUCED },
    );

    expect(motion.phase).toBe('STOPPED');
    expect(motion.position % 40).toBeCloseTo(stop, 10);
  });

  it('lands within a couple of frames instead of a couple of seconds', () => {
    const ordinary = run(spinning(11));
    const reduced = run(
      target(
        startSpin(parked(0), { reel: 4, slam: false, anticipated: false }, REDUCED),
        11,
        false,
      ),
      { curve: REDUCED },
    );

    expect(reduced.elapsedMs).toBeLessThan(100);
    expect(reduced.elapsedMs).toBeLessThan(ordinary.elapsedMs);
  });

  it('never dips backwards, and never overshoots', () => {
    let motion = target(
      startSpin(parked(0), { reel: 0, slam: false, anticipated: false }, REDUCED),
      6,
      false,
    );
    let highest = motion.position;

    while (!isStopped(motion)) {
      const next = advance(motion, 16.67, { stripLength: 40, curve: REDUCED });
      // Monotonic: no backwards dip on the way out, no spring back on the way in.
      expect(next.position).toBeGreaterThanOrEqual(motion.position);
      highest = Math.max(highest, next.position);
      motion = next;
    }

    expect(motion.position).toBe(highest);
  });

  it('never blurs a symbol', () => {
    let motion = target(
      startSpin(parked(0), { reel: 0, slam: false, anticipated: false }, REDUCED),
      19,
      false,
    );

    while (!isStopped(motion)) {
      expect(isBlurred(motion, REDUCED)).toBe(false);
      motion = advance(motion, 16.67, { stripLength: 40, curve: REDUCED });
    }
  });

  it('stops every reel together — no stagger to watch', () => {
    const elapsed = [0, 1, 2, 3, 4].map(
      (reel) =>
        run(
          target(
            startSpin(parked(0), { reel, slam: false, anticipated: false }, REDUCED),
            5,
            false,
          ),
          { curve: REDUCED },
        ).elapsedMs,
    );

    expect(new Set(elapsed).size).toBe(1);
  });

  it('survives a zero-length frame, which a 1 ms stage makes newly possible', () => {
    const motion = advance(
      target(startSpin(parked(0), { reel: 0, slam: false, anticipated: false }, REDUCED), 4, false),
      0,
      { stripLength: 40, curve: REDUCED },
    );

    expect(Number.isFinite(motion.position)).toBe(true);
    expect(Number.isFinite(motion.velocity)).toBe(true);
  });
});
