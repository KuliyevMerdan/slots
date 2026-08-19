import { describe, expect, it } from 'vitest';
import { formatReport, percentile, reportIsClean, summarize } from './stats.js';
import type { LoadReport } from './stats.js';
import { uuidV7 } from './uuid.js';

/**
 * The pure half of the load tool, held to its arithmetic — a percentile off by one rank hands
 * out confidence calibrated to a bug, and a malformed roundId would make the tool test the
 * server's validator instead of its lifecycle.
 */

describe('percentiles (nearest rank)', () => {
  it('answers values that actually happened, never interpolations', () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(100);
    expect(percentile(sorted, 99)).toBe(100);
    expect(percentile(sorted, 0)).toBe(10);
  });

  it('handles tiny and empty samples without inventing numbers', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 99)).toBe(7);
  });

  it('summarizes an unsorted sample correctly', () => {
    const summary = summarize([30, 10, 20]);

    expect(summary.count).toBe(3);
    expect(summary.meanMs).toBe(20);
    expect(summary.p50Ms).toBe(20);
    expect(summary.maxMs).toBe(30);
  });
});

describe('the report', () => {
  const report = (closing: number): LoadReport => ({
    url: 'http://127.0.0.1:8788',
    connections: 2,
    roundsPlayed: 4,
    featuresPlayed: 1,
    elapsedMs: 2_000,
    callsAnswered: 10,
    retries: 1,
    byCall: { spin: summarize([5, 10]) },
    errorsByCode: { RATE_LIMITED: 1 },
    balance: { opening: 1_000, closing, expected: 900 },
  });

  it('is clean exactly when the closing balance matches the session played', () => {
    expect(reportIsClean(report(900))).toBe(true);
    expect(reportIsClean(report(890))).toBe(false);
  });

  it('formats the drift loudly and the clean run plainly', () => {
    expect(formatReport(report(900))).toContain('exact');
    expect(formatReport(report(890))).toContain('DRIFT -10');
    expect(formatReport(report(900))).toContain('RATE_LIMITED×1');
  });
});

describe('uuidV7', () => {
  it('lays out the timestamp, version and variant bits the spec requires', () => {
    const id = uuidV7(
      () => 0x0189_0000_0000, // a fixed 48-bit millisecond timestamp
      (count) => Uint8Array.from({ length: count }, () => 0xff),
    );

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id.startsWith('01890000-0000-7')).toBe(true);
  });
});
