import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { context } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import type { CallName, Minor } from '@slot/protocol';
import { CORRELATION_HEADER, routeFor, statusOf } from '@slot/protocol';
import { createGameConfig } from '../config.js';
import { createRoundService } from '../domain/rounds.js';
import { MemorySessionStore, createSessionService } from '../domain/sessions.js';
import { buildApp } from '../http/app.js';
import { MemoryLedger } from '../ledger/memory.js';
import type { Ledger } from '../ledger/ledger.js';
import { MemoryRoundStore } from '../persistence/memory.js';
import type { RoundStore } from '../persistence/store.js';
import { committingSeedProvider, seededBytes } from '../rng/seeds.js';
import { MockWallet } from '../wallet/mock.js';
import { WalletError } from '../wallet/provider.js';
import type { WalletProvider } from '../wallet/provider.js';
import { createRgsMetrics } from './metrics.js';
import { fanoutObserver, meteredObserver, pinoObserver } from './observer.js';
import { tracedWallet } from './tracing.js';

/**
 * The R6 gate: **one `roundId` retrieves the full story of a round across logs, traces and
 * metrics.** A composition wired exactly as `main.ts` wires it — one pino instance under Fastify
 * and the observer, the OTel tracer over an in-memory exporter, the metrics bundle with the
 * store-backed gauge — plays real rounds over the real HTTP binding, and then the story is
 * *retrieved*: log lines filtered by `roundId`, spans filtered by `rgs.round_id`, instruments
 * read back off `/metrics`.
 *
 * The second half is the gap R6 owed (ADR-0005): the two money-side failures the domain swallows
 * by design — a rollback that cannot be delivered, a ledger entry that cannot be written — are
 * asserted to be *loud* at the failure site: an `error`-level line with the `roundId` and the
 * correlation id on it, and a metric an alert can fire on.
 */

const NOW = 1_700_000_000_000;
const TOKEN = 'story-test-token';
const PLAYER = 'demo-player';

let minted = 0;
const nextRoundId = (): string =>
  `018b0000-0000-7000-8000-${(minted += 1).toString(16).padStart(12, '0')}`;

/* The active-context plumbing OTel nests spans through — global by the API's design, so it is
 * registered once for the file and torn down after. */
const contextManager = new AsyncLocalStorageContextManager();
beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
});
afterAll(() => {
  context.disable();
});

interface WorldOverrides {
  store?: RoundStore;
  wallet?: WalletProvider;
  ledger?: Ledger;
}

const world = (overrides: WorldOverrides = {}) => {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'info' },
    {
      write: (chunk: string) => {
        lines.push(JSON.parse(chunk) as Record<string, unknown>);
      },
    },
  );

  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer('story-test');

  const store = overrides.store ?? new MemoryRoundStore();
  const wallet = tracedWallet(
    overrides.wallet ?? new MockWallet({ [PLAYER]: 100_000_000 as Minor }),
    tracer,
  );
  const metrics = createRgsMetrics({ roundsByState: () => store.countByState() });
  const observe = fanoutObserver(pinoObserver(logger), meteredObserver(metrics));

  const sessionStore = new MemorySessionStore();
  void sessionStore.put(TOKEN, {
    playerId: PLAYER,
    currency: 'EUR',
    expiresAt: 4_102_444_800_000,
  });
  const sessions = createSessionService({
    store: sessionStore,
    randomBytes: seededBytes('story-test-tokens'),
    now: () => NOW,
  });

  const app = buildApp({
    loggerInstance: logger,
    rounds: createRoundService({
      store,
      wallet,
      ledger: overrides.ledger ?? new MemoryLedger(),
      sessions,
      seeds: committingSeedProvider(seededBytes('story-test-seed')),
      config: createGameConfig(),
      now: () => NOW,
      observe,
    }),
    observability: {
      tracer,
      metrics,
      readiness: [
        { name: 'store', check: () => store.countByState() },
        {
          name: 'wallet',
          check: () =>
            wallet.getBalance(PLAYER).catch((error: unknown) => {
              if (error instanceof WalletError) return;
              throw error;
            }),
        },
      ],
    },
    now: () => NOW,
  });

  const call = async (name: CallName, body: unknown, correlationId?: string) => {
    const response = await app.inject({
      method: 'POST',
      url: routeFor(name),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        ...(correlationId === undefined ? {} : { [CORRELATION_HEADER]: correlationId }),
      },
      payload: JSON.stringify(body),
    });
    return { status: response.statusCode, body: response.json() as Record<string, unknown> };
  };

  return { app, call, lines, exporter, metrics };
};

/** Play rounds until one ends in an explicit settle; answer its roundId. */
const playUntilSettled = async (w: ReturnType<typeof world>): Promise<string> => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const roundId = nextRoundId();
    const spin = await w.call('spin', { roundId, stake: 100 }, `story-spin-${attempt}`);
    expect(spin.status).toBe(200);

    let next = spin.body['next'] as string;
    let step = 0;
    while (next === 'FEATURE_SPIN') {
      step += 1;
      const feature = await w.call('featureSpin', { roundId, step }, `story-feature-${step}`);
      expect(feature.status).toBe(200);
      next = feature.body['next'] as string;
    }
    if (next === 'SETTLE') {
      const settle = await w.call('settle', { roundId }, `story-settle-${attempt}`);
      expect(settle.status).toBe(200);
      return roundId;
    }
    // A dead round settled atomically — not the story we need; play on.
  }
  throw new Error('sixty rounds without a win — the seeded strips do not do that');
};

const spansForRound = (spans: readonly ReadableSpan[], roundId: string): ReadableSpan[] =>
  spans.filter((span) => span.attributes['rgs.round_id'] === roundId);

/** The store, with `open` refusing — explicit delegation, because §5's window is `open`'s. */
const failingOpen = (store: RoundStore): RoundStore => ({
  open: () => Promise.reject(new Error('the disk fell off')),
  find: (roundId) => store.find(roundId),
  record: (roundId, call, step) => store.record(roundId, call, step),
  commit: (commit) => store.commit(commit),
  pendingFor: (playerId) => store.pendingFor(playerId),
  settledFor: (playerId, limit) => store.settledFor(playerId, limit),
  lastOpenedAt: (playerId) => store.lastOpenedAt(playerId),
  countByState: () => store.countByState(),
  retention: store.retention,
});

const parentIdOf = (span: ReadableSpan): string | undefined => span.parentSpanContext?.spanId;

describe('the R6 gate: one roundId retrieves the full story', () => {
  it('logs, spans and metrics all answer to the same roundId', async () => {
    const w = world();
    await w.call('authenticate', { token: TOKEN }, 'story-auth');
    const roundId = await playUntilSettled(w);

    /* ── logs: every line of the round carries the roundId and the correlation id ── */
    const roundLines = w.lines.filter((line) => line['roundId'] === roundId);
    const calls = roundLines.map((line) => line['call']);
    expect(calls).toContain('spin');
    expect(calls).toContain('settle');
    for (const line of roundLines) {
      expect(typeof line['reqId']).toBe('string'); // the correlation id, on every line
      expect(typeof line['durationMs']).toBe('number');
    }

    /* ── traces: the round's spans, retrieved by the rgs.round_id attribute ── */
    const spans = spansForRound(w.exporter.getFinishedSpans(), roundId);
    const names = spans.map((span) => span.name);
    expect(names).toContain('rgs.spin');
    expect(names).toContain('wallet.debit');
    expect(names).toContain('rgs.settle');
    expect(names).toContain('wallet.credit');

    // The wallet spans are children of the calls that made them — one picture, not two.
    const spinSpan = spans.find((span) => span.name === 'rgs.spin');
    const debitSpan = spans.find((span) => span.name === 'wallet.debit');
    const settleSpan = spans.find((span) => span.name === 'rgs.settle');
    const creditSpan = spans.find((span) => span.name === 'wallet.credit');
    expect(parentIdOf(debitSpan!)).toBe(spinSpan!.spanContext().spanId);
    expect(debitSpan!.spanContext().traceId).toBe(spinSpan!.spanContext().traceId);
    expect(parentIdOf(creditSpan!)).toBe(settleSpan!.spanContext().spanId);

    // The span joins the same correlation id the log lines carry.
    expect(typeof spinSpan!.attributes['rgs.correlation_id']).toBe('string');

    /* ── metrics: the instruments, read back off the endpoint every scraper reads ── */
    const scrape = await w.app.inject({ method: 'GET', url: '/metrics' });
    expect(scrape.statusCode).toBe(200);
    expect(scrape.headers['content-type']).toContain('text/plain');
    expect(scrape.body).toMatch(/rgs_call_duration_seconds_count\{call="spin"\} [1-9]/);
    expect(scrape.body).toMatch(/rgs_calls_total\{call="settle",outcome="ok"\} [1-9]/);
    expect(scrape.body).toMatch(/rgs_rounds\{state="SETTLED"\} [1-9]/);
  });

  it('counts a refused call into the error-rate series, classified', async () => {
    const w = world();
    const roundId = nextRoundId();

    const refused = await w.call('spin', { roundId, stake: 7 }, 'story-refusal');
    expect(refused.status).toBe(statusOf('STAKE_NOT_ALLOWED'));

    expect(
      w.metrics.errorsTotal.value({ call: 'spin', code: 'STAKE_NOT_ALLOWED', class: 'PLAYER' }),
    ).toBe(1);
    const scrape = await w.app.inject({ method: 'GET', url: '/metrics' });
    expect(scrape.body).toContain(
      'rgs_errors_total{call="spin",class="PLAYER",code="STAKE_NOT_ALLOWED"} 1',
    );

    // The refusal's log line still names the round and the code — errors join the story too.
    const line = w.lines.find((entry) => entry['code'] === 'STAKE_NOT_ALLOWED');
    expect(line?.['roundId']).toBe(roundId);
    expect(line?.['call']).toBe('spin');
  });

  it('reports readiness per dependency, and 503 names the check that failed', async () => {
    const w = world();
    const ready = await w.app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ ready: true, checks: { store: 'ok', wallet: 'ok' } });

    const broken = world({
      wallet: {
        getBalance: () => Promise.reject(new Error('the wallet hung up')),
        debit: () => Promise.reject(new Error('the wallet hung up')),
        credit: () => Promise.reject(new Error('the wallet hung up')),
        rollback: () => Promise.reject(new Error('the wallet hung up')),
      },
    });
    const notReady = await broken.app.inject({ method: 'GET', url: '/ready' });
    expect(notReady.statusCode).toBe(503);
    const body = notReady.json() as { ready: boolean; checks: Record<string, string> };
    expect(body.ready).toBe(false);
    expect(body.checks['wallet']).toContain('failed');
    expect(body.checks['store']).toBe('ok');
  });
});

describe('the money-side failures are loud at the failure site (the R6 debt)', () => {
  it('a lost ledger entry is an error line with the roundId and correlation id on it', async () => {
    const journal = new MemoryLedger();
    const failingLedger: Ledger = {
      record: () => Promise.reject(new Error('the journal is full')),
      entriesFor: (roundId) => journal.entriesFor(roundId),
      entries: (options) => journal.entries(options),
    };
    const w = world({ ledger: failingLedger });

    const roundId = nextRoundId();
    const spin = await w.call('spin', { roundId, stake: 100 }, 'story-lost-entry');
    // The call succeeds — the ledger observes, it never decides (ADR-0005).
    expect(spin.status).toBe(200);

    const line = w.lines.find((entry) => entry['event'] === 'ledger.record_failed');
    expect(line).toMatchObject({
      level: 50, // pino error — the bang, not the echo
      roundId,
      playerId: PLAYER,
      kind: 'STAKE',
      correlationId: 'story-lost-entry',
    });
    expect(w.metrics.moneyWriteFailures.value({ kind: 'ledger.record_failed' })).toBe(1);
  });

  it('an undeliverable rollback is an error line with the roundId and correlation id on it', async () => {
    const brokenStore = failingOpen(new MemoryRoundStore());
    const wallet = new MockWallet({ [PLAYER]: 100_000_000 as Minor });
    const brokenWallet: WalletProvider = {
      getBalance: (playerId) => wallet.getBalance(playerId),
      debit: (playerId, amount, ref) => wallet.debit(playerId, amount, ref),
      credit: (playerId, amount, ref) => wallet.credit(playerId, amount, ref),
      rollback: () => Promise.reject(new Error('the wallet hung up mid-reversal')),
    };
    const w = world({ store: brokenStore, wallet: brokenWallet });

    const roundId = nextRoundId();
    const spin = await w.call('spin', { roundId, stake: 100 }, 'story-orphan');
    // The original store failure surfaces (RECOVERABLE), never hidden behind the rollback's.
    expect(spin.status).toBeGreaterThanOrEqual(500);

    const line = w.lines.find((entry) => entry['event'] === 'wallet.rollback_failed');
    expect(line).toMatchObject({
      level: 50,
      roundId,
      playerId: PLAYER,
      amount: 100,
      correlationId: 'story-orphan',
    });
    expect(w.metrics.moneyWriteFailures.value({ kind: 'wallet.rollback_failed' })).toBe(1);
  });

  it('a delivered rollback tells its §4 story at warn, with the round attached', async () => {
    const w = world({ store: failingOpen(new MemoryRoundStore()) });

    const roundId = nextRoundId();
    await w.call('spin', { roundId, stake: 100 }, 'story-reversal');

    const line = w.lines.find((entry) => entry['event'] === 'wallet.rollback_delivered');
    expect(line).toMatchObject({ level: 40, roundId, correlationId: 'story-reversal' });
  });
});
