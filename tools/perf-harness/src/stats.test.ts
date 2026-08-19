import { describe, expect, it } from 'vitest';
import { drawStats, frameStats, heapStats, percentile } from './stats.js';

describe('percentile', () => {
  it('is nearest-rank: the p95 of a hundred frames is the 95th worst, not an interpolation', () => {
    const durations = Array.from({ length: 100 }, (_, index) => index + 1); // 1..100
    expect(percentile(durations, 50)).toBe(50);
    expect(percentile(durations, 95)).toBe(95);
    expect(percentile(durations, 99)).toBe(99);
  });

  it('does not sort the caller’s array', () => {
    const durations = [30, 10, 20];
    percentile(durations, 50);
    expect(durations).toEqual([30, 10, 20]);
  });

  it('answers 0 for an empty capture rather than NaN', () => {
    expect(percentile([], 95)).toBe(0);
  });

  it('clamps to the worst frame for a tiny sample', () => {
    expect(percentile([16.7], 99)).toBe(16.7);
  });
});

describe('frameStats', () => {
  it('reports fps from the time the frames actually took', () => {
    const stats = frameStats(Array.from({ length: 60 }, () => 16.666));
    expect(stats.avgFps).toBeCloseTo(60, 0);
    expect(stats.frames).toBe(60);
    expect(stats.dropped).toBe(0);
  });

  it('counts a frame past 25 ms as dropped', () => {
    const stats = frameStats([16.7, 16.7, 40, 16.7]);
    expect(stats.dropped).toBe(1);
    expect(stats.droppedShare).toBeCloseTo(0.25);
    expect(stats.worstMs).toBe(40);
  });

  it('survives an empty capture', () => {
    expect(frameStats([]).avgFps).toBe(0);
  });
});

describe('drawStats', () => {
  it('averages draws per frame and keeps the worst frame', () => {
    const stats = drawStats([2, 2, 2, 10]);
    expect(stats.avg).toBe(4);
    expect(stats.max).toBe(10);
  });
});

describe('heapStats', () => {
  it('reports start, peak and end in megabytes', () => {
    const mb = 1024 * 1024;
    const stats = heapStats([10 * mb, 30 * mb, 20 * mb]);
    expect(stats.startMb).toBe(10);
    expect(stats.peakMb).toBe(30);
    expect(stats.endMb).toBe(20);
  });
});
