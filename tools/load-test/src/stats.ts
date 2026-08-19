/**
 * The load report's arithmetic — pure, and tested, because a load tool whose percentiles are
 * wrong is worse than none: it hands out confidence calibrated to a bug. Hand-rolled for the same
 * reason the RGS's metrics registry is (ADR-0008): this is a page of arithmetic, not a dependency.
 */

export interface LatencySummary {
  readonly count: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

/**
 * Nearest-rank percentile over a sorted sample — the conventional definition: the smallest value
 * with at least `p` of the sample at or below it. Never interpolates, so the answer is always a
 * latency that actually happened.
 */
export const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return 0;
  if (p <= 0) return sorted[0] as number;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1] as number;
};

export const summarize = (samples: readonly number[]): LatencySummary => {
  const sorted = [...samples].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count,
    meanMs: count === 0 ? 0 : sum / count,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: count === 0 ? 0 : (sorted[count - 1] as number),
  };
};

export interface LoadReport {
  readonly url: string;
  readonly connections: number;
  readonly roundsPlayed: number;
  readonly featuresPlayed: number;
  readonly elapsedMs: number;
  readonly callsAnswered: number;
  readonly retries: number;
  readonly byCall: Readonly<Record<string, LatencySummary>>;
  readonly errorsByCode: Readonly<Record<string, number>>;
  /** The closing argument: the server's final balance against our own account of the session. */
  readonly balance: {
    readonly opening: number;
    readonly closing: number;
    readonly expected: number;
  };
}

const ms = (value: number): string => value.toFixed(1).padStart(8);

/** The report as text — pure formatting, so the test can hold the whole surface. */
export const formatReport = (report: LoadReport): string => {
  const lines: string[] = [];
  const seconds = report.elapsedMs / 1_000;
  lines.push(`load-test against ${report.url}`);
  lines.push(
    `  ${report.connections} connections · ${report.roundsPlayed} rounds ` +
      `(${report.featuresPlayed} features) · ${seconds.toFixed(1)}s · ` +
      `${(report.callsAnswered / Math.max(seconds, 0.001)).toFixed(1)} calls/s · ` +
      `${report.retries} retries`,
  );
  lines.push('  call            count   mean ms    p50 ms    p95 ms    p99 ms    max ms');
  for (const [call, s] of Object.entries(report.byCall)) {
    lines.push(
      `  ${call.padEnd(12)} ${String(s.count).padStart(8)} ${ms(s.meanMs)}  ${ms(s.p50Ms)}  ` +
        `${ms(s.p95Ms)}  ${ms(s.p99Ms)}  ${ms(s.maxMs)}`,
    );
  }
  const errors = Object.entries(report.errorsByCode);
  lines.push(
    errors.length === 0
      ? '  errors: none'
      : `  errors: ${errors.map(([code, count]) => `${code}×${count}`).join(', ')}`,
  );
  const { opening, closing, expected } = report.balance;
  const drift = closing - expected;
  lines.push(
    `  balance: opening ${opening} → closing ${closing}, expected ${expected} — ` +
      (drift === 0 ? 'exact' : `DRIFT ${drift}`),
  );
  return lines.join('\n');
};

/** What the process exits with: drift is a failure, however pretty the latency was. */
export const reportIsClean = (report: LoadReport): boolean =>
  report.balance.closing === report.balance.expected;
