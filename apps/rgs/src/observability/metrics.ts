import type { RoundState } from '@slot/protocol';

/**
 * Metrics, hand-rolled — the R5 rate limiter's argument applied to the other operational surface:
 * three instrument kinds and one exposition format are a page of arithmetic, unit-tested, with no
 * dependency to version-chase. The registry renders the Prometheus text format because that is
 * what every scraper on earth reads; nothing here is clever, which is the point (ADR-0008).
 *
 * The one non-obvious shape is the gauge: it takes a `collect` callback and is *asked* at scrape
 * time, because the honest number of rounds in each state is the store's to answer — a gauge
 * tracked incrementally in this process forgets every open round a restart inherited, and an
 * observability layer that lies after a crash is worse than none.
 */

type LabelValues = Readonly<Record<string, string>>;

/** `a="b",c="d"` with values escaped per the exposition format — one key per distinct label set. */
const labelKey = (labels: LabelValues): string =>
  Object.keys(labels)
    .sort()
    .map(
      (name) =>
        `${name}="${labels[name]?.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') ?? ''}"`,
    )
    .join(',');

const line = (name: string, labels: string, value: number): string =>
  labels === '' ? `${name} ${value}` : `${name}{${labels}} ${value}`;

const header = (name: string, help: string, type: 'counter' | 'histogram' | 'gauge'): string[] => [
  `# HELP ${name} ${help}`,
  `# TYPE ${name} ${type}`,
];

export class Counter {
  readonly #values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: LabelValues = {}, by = 1): void {
    const key = labelKey(labels);
    this.#values.set(key, (this.#values.get(key) ?? 0) + by);
  }

  /** The current count for one label set — what tests and dashboards-in-a-hurry read. */
  value(labels: LabelValues = {}): number {
    return this.#values.get(labelKey(labels)) ?? 0;
  }

  render(): string[] {
    return [
      ...header(this.name, this.help, 'counter'),
      ...[...this.#values.entries()].map(([labels, value]) => line(this.name, labels, value)),
    ];
  }
}

export class Histogram {
  readonly #buckets: readonly number[];
  readonly #counts = new Map<string, number[]>();
  readonly #sums = new Map<string, number>();
  readonly #totals = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
    /** Upper bounds, ascending. The latency defaults span 5ms to 10s — a spin lives in there. */
    buckets: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  ) {
    this.#buckets = buckets;
  }

  observe(labels: LabelValues, value: number): void {
    const key = labelKey(labels);
    const counts = this.#counts.get(key) ?? this.#buckets.map(() => 0);
    for (const [index, bound] of this.#buckets.entries()) {
      if (value <= bound) counts[index] = (counts[index] ?? 0) + 1;
    }
    this.#counts.set(key, counts);
    this.#sums.set(key, (this.#sums.get(key) ?? 0) + value);
    this.#totals.set(key, (this.#totals.get(key) ?? 0) + 1);
  }

  count(labels: LabelValues = {}): number {
    return this.#totals.get(labelKey(labels)) ?? 0;
  }

  render(): string[] {
    const lines = header(this.name, this.help, 'histogram');
    for (const [labels, counts] of this.#counts.entries()) {
      const withLe = (bound: string): string =>
        labels === '' ? `le="${bound}"` : `${labels},le="${bound}"`;
      for (const [index, bound] of this.#buckets.entries()) {
        lines.push(line(`${this.name}_bucket`, withLe(String(bound)), counts[index] ?? 0));
      }
      lines.push(line(`${this.name}_bucket`, withLe('+Inf'), this.#totals.get(labels) ?? 0));
      lines.push(line(`${this.name}_sum`, labels, this.#sums.get(labels) ?? 0));
      lines.push(line(`${this.name}_count`, labels, this.#totals.get(labels) ?? 0));
    }
    return lines;
  }
}

export class Gauge {
  #values = new Map<string, number>();
  readonly #collect: ((gauge: Gauge) => Promise<void> | void) | undefined;

  constructor(
    readonly name: string,
    readonly help: string,
    /** Asked at scrape time; the previous values are dropped first, so stale label sets vanish. */
    collect?: (gauge: Gauge) => Promise<void> | void,
  ) {
    this.#collect = collect;
  }

  set(labels: LabelValues, value: number): void {
    this.#values.set(labelKey(labels), value);
  }

  value(labels: LabelValues = {}): number | undefined {
    return this.#values.get(labelKey(labels));
  }

  async collect(): Promise<void> {
    if (this.#collect === undefined) return;
    this.#values = new Map();
    await this.#collect(this);
  }

  render(): string[] {
    return [
      ...header(this.name, this.help, 'gauge'),
      ...[...this.#values.entries()].map(([labels, value]) => line(this.name, labels, value)),
    ];
  }
}

export class MetricsRegistry {
  readonly #instruments: (Counter | Histogram | Gauge)[] = [];

  counter(name: string, help: string): Counter {
    const counter = new Counter(name, help);
    this.#instruments.push(counter);
    return counter;
  }

  histogram(name: string, help: string, buckets?: readonly number[]): Histogram {
    const histogram = new Histogram(name, help, buckets);
    this.#instruments.push(histogram);
    return histogram;
  }

  gauge(name: string, help: string, collect?: (gauge: Gauge) => Promise<void> | void): Gauge {
    const gauge = new Gauge(name, help, collect);
    this.#instruments.push(gauge);
    return gauge;
  }

  /** The exposition text. Async because a gauge may have to ask the store. */
  async render(): Promise<string> {
    for (const instrument of this.#instruments) {
      if (instrument instanceof Gauge) await instrument.collect();
    }
    return `${this.#instruments.flatMap((instrument) => instrument.render()).join('\n')}\n`;
  }
}

/* ── the RGS's own instruments ─────────────────────────────────────────────────────────────────
 * One bundle, created once per composition, threaded to the HTTP layer (durations, errors) and
 * the observer (money-write failures). Names follow the Prometheus conventions: seconds, `_total`.
 */

export interface RgsMetricsOptions {
  /** The store's own account of how many rounds sit in each state — the gauge asks at scrape. */
  roundsByState?: () => Promise<Record<RoundState, number>>;
}

export interface RgsMetrics {
  readonly registry: MetricsRegistry;
  /** Per-call latency — `{call="spin"}` is the spin latency histogram R6 names. */
  readonly callDuration: Histogram;
  readonly callsTotal: Counter;
  /** Error rate by class (and code, and call) — the taxonomy, counted. */
  readonly errorsTotal: Counter;
  /** The money-side writes that fail after the wallet already moved (ADR-0005's swallowed sites). */
  readonly moneyWriteFailures: Counter;
}

export const createRgsMetrics = ({ roundsByState }: RgsMetricsOptions = {}): RgsMetrics => {
  const registry = new MetricsRegistry();
  if (roundsByState !== undefined) {
    registry.gauge('rgs_rounds', 'rounds currently held by the store, by state', async (gauge) => {
      const counts = await roundsByState();
      for (const [state, count] of Object.entries(counts)) gauge.set({ state }, count);
    });
  }
  return {
    registry,
    callDuration: registry.histogram(
      'rgs_call_duration_seconds',
      'wall-clock duration of each game call, by call name',
    ),
    callsTotal: registry.counter('rgs_calls_total', 'game calls answered, by call and outcome'),
    errorsTotal: registry.counter(
      'rgs_errors_total',
      'game calls refused or failed, by call, code and class',
    ),
    moneyWriteFailures: registry.counter(
      'rgs_money_write_failures_total',
      'money-side writes that failed after the wallet confirmed — reconciliation will report the drift; this counter is the bang, not the echo',
    ),
  };
};
