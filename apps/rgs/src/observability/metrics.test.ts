import { describe, expect, it } from 'vitest';
import { MetricsRegistry, createRgsMetrics } from './metrics.js';

/**
 * The registry's arithmetic and its exposition format, held to what a Prometheus scraper expects —
 * hand-rolled instruments earn their keep the same way the R5 token bucket did: by being tested
 * where a library would have been trusted.
 */

describe('the metrics registry', () => {
  it('counts by label set, and renders each set as its own line', async () => {
    const registry = new MetricsRegistry();
    const errors = registry.counter('rgs_errors_total', 'errors by class');

    errors.inc({ class: 'PLAYER', code: 'STAKE_NOT_ALLOWED' });
    errors.inc({ code: 'STAKE_NOT_ALLOWED', class: 'PLAYER' }); // key-order independent
    errors.inc({ class: 'FATAL', code: 'SCHEMA_MISMATCH' });

    expect(errors.value({ class: 'PLAYER', code: 'STAKE_NOT_ALLOWED' })).toBe(2);

    const text = await registry.render();
    expect(text).toContain('# TYPE rgs_errors_total counter');
    expect(text).toContain('rgs_errors_total{class="PLAYER",code="STAKE_NOT_ALLOWED"} 2');
    expect(text).toContain('rgs_errors_total{class="FATAL",code="SCHEMA_MISMATCH"} 1');
  });

  it('escapes label values the exposition format cannot carry raw', async () => {
    const registry = new MetricsRegistry();
    registry.counter('rgs_test_total', 'escaping').inc({ detail: 'a "quoted"\nback\\slash' });

    const text = await registry.render();
    expect(text).toContain('rgs_test_total{detail="a \\"quoted\\"\\nback\\\\slash"} 1');
  });

  it('renders a histogram with cumulative buckets, +Inf, sum and count', async () => {
    const registry = new MetricsRegistry();
    const duration = registry.histogram('rgs_call_duration_seconds', 'latency', [0.1, 1]);

    duration.observe({ call: 'spin' }, 0.05);
    duration.observe({ call: 'spin' }, 0.5);
    duration.observe({ call: 'spin' }, 5);

    expect(duration.count({ call: 'spin' })).toBe(3);

    const text = await registry.render();
    expect(text).toContain('rgs_call_duration_seconds_bucket{call="spin",le="0.1"} 1');
    expect(text).toContain('rgs_call_duration_seconds_bucket{call="spin",le="1"} 2');
    expect(text).toContain('rgs_call_duration_seconds_bucket{call="spin",le="+Inf"} 3');
    expect(text).toContain('rgs_call_duration_seconds_sum{call="spin"} 5.55');
    expect(text).toContain('rgs_call_duration_seconds_count{call="spin"} 3');
  });

  it('asks a collected gauge at scrape time, and drops stale label sets first', async () => {
    const registry = new MetricsRegistry();
    let states: Record<string, number> = { OPEN: 2, SETTLED: 1 };
    registry.gauge('rgs_rounds', 'rounds by state', (gauge) => {
      for (const [state, count] of Object.entries(states)) gauge.set({ state }, count);
    });

    expect(await registry.render()).toContain('rgs_rounds{state="OPEN"} 2');

    states = { SETTLED: 3 };
    const text = await registry.render();
    expect(text).toContain('rgs_rounds{state="SETTLED"} 3');
    expect(text).not.toContain('state="OPEN"'); // the stale set vanished rather than lingering
  });

  it('creates the RGS bundle with the rounds gauge wired to the store reader', async () => {
    const metrics = createRgsMetrics({
      roundsByState: () => Promise.resolve({ OPEN: 1, RESOLVED: 0, SETTLED: 4 }),
    });

    metrics.callDuration.observe({ call: 'spin' }, 0.02);
    metrics.callsTotal.inc({ call: 'spin', outcome: 'ok' });
    metrics.moneyWriteFailures.inc({ kind: 'ledger.record_failed' });

    const text = await metrics.registry.render();
    expect(text).toContain('rgs_rounds{state="OPEN"} 1');
    expect(text).toContain('rgs_rounds{state="SETTLED"} 4');
    expect(text).toContain('rgs_calls_total{call="spin",outcome="ok"} 1');
    expect(text).toContain('rgs_money_write_failures_total{kind="ledger.record_failed"} 1');
    expect(text).toContain('rgs_call_duration_seconds_count{call="spin"} 1');
  });
});
