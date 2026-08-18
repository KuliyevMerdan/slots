import { describe, expect, it, vi } from 'vitest';
import { consoleTelemetry, guarded, noopTelemetry } from './telemetry.js';
import type { Telemetry, TelemetryEvent } from './telemetry.js';

const sink = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('the console adapter', () => {
  it('routes by level, so an error is findable among the noise', () => {
    const out = sink();
    const telemetry = consoleTelemetry(out);

    telemetry.report({ name: 'a', level: 'INFO' });
    telemetry.report({ name: 'b', level: 'WARN' });
    telemetry.report({ name: 'c', level: 'ERROR' });

    expect(out.info).toHaveBeenCalledTimes(1);
    expect(out.warn).toHaveBeenCalledTimes(1);
    expect(out.error).toHaveBeenCalledTimes(1);
  });

  it('carries the two ids every investigation starts from', () => {
    const out = sink();

    consoleTelemetry(out).report({
      name: 'error_raised',
      level: 'ERROR',
      message: 'no such round',
      roundId: 'r-1',
      correlationId: 'sim-000042',
      detail: { code: 'UNKNOWN_ROUND' },
    });

    expect(out.error).toHaveBeenCalledWith(expect.stringContaining('error_raised'), {
      roundId: 'r-1',
      correlationId: 'sim-000042',
      code: 'UNKNOWN_ROUND',
    });
  });

  it('leaves out what it does not have, rather than reporting undefined', () => {
    const out = sink();

    consoleTelemetry(out).report({ name: 'boot_failed', level: 'ERROR' });

    expect(out.error).toHaveBeenCalledWith(expect.any(String), {});
  });
});

/**
 * The property that matters more than any field: telemetry sits on the error path, so a reporter
 * that throws while reporting would turn a frozen reel set into a blank page.
 */
describe('the guard', () => {
  it('swallows a reporter that throws', () => {
    const broken: Telemetry = {
      report: () => {
        throw new Error('the collector is down');
      },
    };

    expect(() => guarded(broken).report({ name: 'x', level: 'ERROR' })).not.toThrow();
  });

  it('still delivers what the reporter can take', () => {
    const seen: TelemetryEvent[] = [];
    guarded({ report: (event) => seen.push(event) }).report({ name: 'x', level: 'INFO' });

    expect(seen).toHaveLength(1);
  });
});

describe('the no-op sink', () => {
  it('accepts everything and does nothing', () => {
    expect(() => noopTelemetry().report({ name: 'x', level: 'ERROR' })).not.toThrow();
  });
});
