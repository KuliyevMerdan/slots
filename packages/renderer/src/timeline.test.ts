import { describe, expect, it, vi } from 'vitest';
import { Timeline } from './timeline.js';
import type { TimelineStep } from './timeline.js';
import { WIN_TIERS, tierFor } from './tiers.js';
import { DEFAULT_CURVE, TURBO_FACTOR, scaleCurve } from './curve.js';
import type { Minor } from '@slot/protocol';

/**
 * The interruption contract, at the level that implements it.
 *
 * The engine's tests already prove that skipping and completing produce an identical *state*. These
 * prove the other half: that skipping and completing produce an identical *presentation* — same
 * callbacks, same final values, nothing left lit.
 */

/** Records everything a timeline does, so two runs can be compared as data. */
const recording = () => {
  const trace: string[] = [];
  const steps: TimelineStep[] = [
    {
      durationMs: 100,
      onEnter: () => trace.push('a:enter'),
      onProgress: (p) => trace.push(`a:${p === 1 ? 'end' : 'tick'}`),
      onLeave: () => trace.push('a:leave'),
    },
    {
      durationMs: 0,
      onEnter: () => trace.push('b:enter'),
      onLeave: () => trace.push('b:leave'),
    },
    {
      durationMs: 250,
      onEnter: () => trace.push('c:enter'),
      onProgress: (p) => trace.push(`c:${p === 1 ? 'end' : 'tick'}`),
      onLeave: () => trace.push('c:leave'),
    },
  ];
  return { trace, steps };
};

const withoutTicks = (trace: readonly string[]): string[] =>
  trace.filter((entry) => !entry.endsWith(':tick'));

describe('Timeline', () => {
  it('runs its steps in order and finishes exactly once', () => {
    const { trace, steps } = recording();
    const timeline = new Timeline(steps);

    let finishes = 0;
    for (let frame = 0; frame < 100; frame += 1) {
      if (timeline.advance(16.67)) finishes += 1;
    }

    expect(finishes).toBe(1);
    expect(timeline.finished).toBe(true);
    expect(withoutTicks(trace)).toEqual([
      'a:enter',
      'a:end',
      'a:leave',
      // `b` has no `onProgress` — a step may be nothing but an enter and a leave.
      'b:enter',
      'b:leave',
      'c:enter',
      'c:end',
      'c:leave',
    ]);
  });

  /** The assertion this whole class exists for. */
  it('completes to exactly the state finishing would have left', () => {
    const played = recording();
    const skipped = recording();

    const timeline = new Timeline(played.steps);
    while (!timeline.finished) timeline.advance(16.67);

    new Timeline(skipped.steps).complete();

    expect(withoutTicks(skipped.trace)).toEqual(withoutTicks(played.trace));
  });

  it('completes from the middle without replaying what already ran', () => {
    const { trace, steps } = recording();
    const timeline = new Timeline(steps);

    timeline.advance(120); // through step a, into step b/c
    const before = trace.length;
    timeline.complete();

    expect(timeline.finished).toBe(true);
    expect(trace.slice(before)).not.toContain('a:enter');
    expect(withoutTicks(trace)).toContain('c:leave');
  });

  /**
   * A long frame — a stall, a background tab returning — must consume the presentation rather than
   * stretch it. Anything else and a hitch mid-spin silently delays the next round.
   */
  it('carries leftover time across steps in a single long frame', () => {
    const { trace, steps } = recording();
    const timeline = new Timeline(steps);

    expect(timeline.advance(10_000)).toBe(true);
    expect(withoutTicks(trace)).toContain('c:leave');
  });

  it('always reports progress 1 before leaving a step', () => {
    const seen: number[] = [];
    const timeline = new Timeline([{ durationMs: 50, onProgress: (p) => seen.push(p) }]);

    timeline.advance(16);
    timeline.advance(16);
    timeline.advance(100);

    expect(seen.at(-1)).toBe(1);
  });

  it('is finished from the start when there is nothing to present', () => {
    const timeline = new Timeline([]);

    expect(timeline.finished).toBe(true);
    expect(timeline.advance(16)).toBe(false);
  });

  it('does nothing when completed twice', () => {
    const onLeave = vi.fn();
    const timeline = new Timeline([{ durationMs: 10, onLeave }]);

    timeline.complete();
    timeline.complete();

    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});

describe('win tiers', () => {
  const stake = 100 as Minor;

  it.each([
    [0, null],
    [99, null],
    [499, null],
    [500, 'NICE'],
    [1_499, 'NICE'],
    [1_500, 'BIG'],
    [4_999, 'BIG'],
    [5_000, 'MEGA'],
    [500_000, 'MEGA'],
  ])('a win of %i on a stake of 100 is %s', (win, expected) => {
    expect(tierFor(win as Minor, stake)?.id ?? null).toBe(expected);
  });

  /**
   * Tiers are multiples of the stake, so the same *ratio* tiers the same way at every bet level —
   * which is the entire reason they are not absolute amounts.
   */
  it('tiers the same ratio identically at every bet level', () => {
    for (const bet of [20, 100, 4_000] as Minor[]) {
      expect(tierFor((bet * 15) as Minor, bet)?.id).toBe('BIG');
      expect(tierFor((bet * 15 - 1) as Minor, bet)?.id).toBe('NICE');
    }
  });

  it('has thresholds and durations that increase together', () => {
    for (let index = 1; index < WIN_TIERS.length; index += 1) {
      const previous = WIN_TIERS[index - 1];
      const tier = WIN_TIERS[index];
      if (previous === undefined || tier === undefined) continue;
      expect(tier.atLeastTimesStake).toBeGreaterThan(previous.atLeastTimesStake);
      expect(tier.countUpMs).toBeGreaterThan(previous.countUpMs);
    }
  });
});

describe('turbo', () => {
  it('shortens every duration and changes nothing else', () => {
    const turbo = scaleCurve(DEFAULT_CURVE, TURBO_FACTOR);

    expect(turbo.decelerateMs).toBeCloseTo(DEFAULT_CURVE.decelerateMs * TURBO_FACTOR);
    expect(turbo.staggerMs).toBeCloseTo(DEFAULT_CURVE.staggerMs * TURBO_FACTOR);
    // The reel still behaves like a reel: same speed, same overshoot, same blur threshold.
    expect(turbo.maxSpeed).toBe(DEFAULT_CURVE.maxSpeed);
    expect(turbo.overshoot).toBe(DEFAULT_CURVE.overshoot);
    expect(turbo.blurAboveSpeed).toBe(DEFAULT_CURVE.blurAboveSpeed);
    expect(turbo.minDecelerateSymbols).toBe(DEFAULT_CURVE.minDecelerateSymbols);
  });

  it('refuses a factor that would stop time', () => {
    expect(() => scaleCurve(DEFAULT_CURVE, 0)).toThrow(RangeError);
  });
});
