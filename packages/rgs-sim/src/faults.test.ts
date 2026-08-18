import { describe, expect, it } from 'vitest';
import type { ErrorCode } from '@slot/protocol';
import { NO_FAULTS, decideFault, retryAdvice } from './faults.js';
import type { FaultConfig, FaultVerdict } from './faults.js';
import { SimServer } from './server.js';
import { InMemoryStore } from './store.js';
import { START_BALANCE, STAKE, roundId, testConfig, testState } from './__fixtures__/harness.js';

const SEED = 'fault-seed';

/** The verdicts for the first `count` calls of a session — a fault run, deterministically. */
const run = (config: FaultConfig, count: number, seed = SEED): FaultVerdict[] =>
  Array.from({ length: count }, (_unused, index) => decideFault(config, seed, index + 1));

const rateOf = (verdicts: FaultVerdict[], kind: FaultVerdict['kind']): number =>
  verdicts.filter((verdict) => verdict.kind === kind).length / verdicts.length;

describe('decideFault', () => {
  it('passes everything through when nothing is configured', () => {
    for (const verdict of run(NO_FAULTS, 100)) {
      expect(verdict).toEqual({ kind: 'PASS', delayMs: 0 });
    }
  });

  /**
   * The property the whole design is for. A randomly-timed failure is a test you cannot re-run, and
   * a bug you cannot re-run is a bug you do not fix — so the verdict is a pure function of the seed
   * and the call number, and a faulty session replays down to *which* call failed.
   */
  it('replays identically from the same seed', () => {
    const config: FaultConfig = { latencyMs: 40, jitterMs: 120, dropRate: 0.2 };
    expect(run(config, 200)).toEqual(run(config, 200));
  });

  it('fails in different places under a different seed', () => {
    const config: FaultConfig = { dropRate: 0.3 };
    expect(run(config, 200, 'seed-a')).not.toEqual(run(config, 200, 'seed-b'));
  });

  describe('latency', () => {
    it('applies a fixed delay to every call', () => {
      for (const verdict of run({ latencyMs: 80 }, 50)) {
        expect(verdict.kind === 'DROP' ? 0 : verdict.delayMs).toBe(80);
      }
    });

    it('keeps jitter inside its band', () => {
      for (const verdict of run({ latencyMs: 80, jitterMs: 200 }, 500)) {
        if (verdict.kind === 'DROP') continue;
        expect(verdict.delayMs).toBeGreaterThanOrEqual(80);
        expect(verdict.delayMs).toBeLessThanOrEqual(280);
      }
    });

    it('actually varies the delay rather than pinning it', () => {
      const delays = new Set(
        run({ latencyMs: 80, jitterMs: 200 }, 200).map((verdict) =>
          verdict.kind === 'DROP' ? -1 : verdict.delayMs,
        ),
      );
      expect(delays.size).toBeGreaterThan(50);
    });

    /** The slow-response fault: a call that succeeds, eventually — the client's spin timeout bait. */
    it('substitutes the slow delay at the configured rate', () => {
      const verdicts = run({ latencyMs: 50, slowMs: 9_000, slowRate: 1 }, 50);
      for (const verdict of verdicts) {
        expect(verdict.kind === 'DROP' ? 0 : verdict.delayMs).toBe(9_000);
      }
    });
  });

  describe('error rates', () => {
    it('always fails at a rate of 1', () => {
      for (const verdict of run({ errorRates: { TIMEOUT: 1 } }, 50)) {
        expect(verdict.kind).toBe('FAIL');
        if (verdict.kind === 'FAIL') expect(verdict.code).toBe('TIMEOUT');
      }
    });

    it('never fails at a rate of 0', () => {
      expect(rateOf(run({ errorRates: { TIMEOUT: 0 } }, 200), 'FAIL')).toBe(0);
    });

    it('lands near the configured rate over a long run', () => {
      const observed = rateOf(run({ errorRates: { WALLET_UNAVAILABLE: 0.25 } }, 4_000), 'FAIL');
      expect(Math.abs(observed - 0.25)).toBeLessThan(0.03);
    });

    it.each(['TIMEOUT', 'INSUFFICIENT_FUNDS', 'ROUND_CONFLICT'] as ErrorCode[])(
      'can inject %s — every class is reachable',
      (code) => {
        // Injecting a FATAL is how you find out whether the client really freezes the reels rather
        // than retrying into a loop. Restricting this to RECOVERABLE would hide the interesting half.
        const verdict = run({ errorRates: { [code]: 1 } }, 1)[0];
        expect(verdict?.kind).toBe('FAIL');
        if (verdict?.kind === 'FAIL') expect(verdict.code).toBe(code);
      },
    );
  });

  describe('dropped responses', () => {
    it('drops everything at a rate of 1', () => {
      expect(rateOf(run({ dropRate: 1 }, 50), 'DROP')).toBe(1);
    });

    it('lands near the configured rate over a long run', () => {
      const observed = rateOf(run({ dropRate: 0.15 }, 4_000), 'DROP');
      expect(Math.abs(observed - 0.15)).toBeLessThan(0.03);
    });

    it('takes precedence over an injected error', () => {
      // A response that never arrives cannot also be an error the client sees.
      expect(rateOf(run({ dropRate: 1, errorRates: { TIMEOUT: 1 } }, 20), 'DROP')).toBe(1);
    });
  });
});

describe('retryAdvice', () => {
  it('advises a wait for a RECOVERABLE code', () => {
    expect(retryAdvice('TIMEOUT', 500)).toBe(500);
  });

  it('never drops below a floor', () => {
    expect(retryAdvice('RATE_LIMITED', 0)).toBe(100);
  });

  it.each(['INSUFFICIENT_FUNDS', 'ROUND_CONFLICT'] as ErrorCode[])(
    'advises nothing for %s — retrying it changes nothing',
    (code) => {
      expect(retryAdvice(code, 500)).toBeUndefined();
    },
  );
});

/* ── through the server ───────────────────────────────────────────────────────────────────── */

const config = testConfig();
const NOW = 1_700_000_000_000;

const server = (faults: FaultConfig = NO_FAULTS, store = new InMemoryStore()) =>
  new SimServer({ initialState: testState(), config, store, now: () => NOW, faults });

describe('SimServer.deliver', () => {
  it('delivers normally when no fault fires', () => {
    const sim = server();
    const delivery = sim.deliver('spin', { roundId: roundId(1), stake: STAKE });

    expect(delivery.kind).toBe('DELIVER');
    if (delivery.kind === 'DELIVER') {
      expect(delivery.response.balance).toBe(START_BALANCE - STAKE);
      expect(delivery.delayMs).toBe(0);
    }
  });

  it('reports the delay rather than sleeping — a pure package cannot wait', () => {
    const sim = server({ latencyMs: 250 });
    const delivery = sim.deliver('authenticate', { token: sim.state.token });

    expect(delivery.kind).toBe('DELIVER');
    if (delivery.kind === 'DELIVER') expect(delivery.delayMs).toBe(250);
  });

  describe('an injected error', () => {
    it('rejects with the classified error', () => {
      const sim = server({ errorRates: { WALLET_UNAVAILABLE: 1 } });
      const delivery = sim.deliver('spin', { roundId: roundId(2), stake: STAKE });

      expect(delivery.kind).toBe('REJECT');
      if (delivery.kind === 'REJECT') {
        expect(delivery.error.code).toBe('WALLET_UNAVAILABLE');
        expect(delivery.error.errorClass).toBe('RECOVERABLE');
        expect(delivery.error.isRetryable).toBe(true);
        expect(delivery.error.retryAfterMs).toBeGreaterThan(0);
      }
    });

    /**
     * Decided **before** the handler runs, so nothing happened: no debit, no round, and a retry with
     * the same key is a fresh attempt rather than a replay. This is the "request never arrived"
     * failure, and it is the boring half of the pair.
     */
    it('leaves the state untouched apart from the call counter', () => {
      const sim = server({ errorRates: { TIMEOUT: 1 } });
      sim.deliver('spin', { roundId: roundId(3), stake: STAKE });

      expect(sim.state.balance).toBe(START_BALANCE);
      expect(sim.state.rounds).toHaveLength(0);
      expect(sim.state.seq).toBe(1);
    });
  });

  describe('a dropped response', () => {
    /**
     * The fault worth having. The server did the work and the answer vanished, so there is a real
     * debited round the client knows nothing about — exactly what idempotency exists to survive.
     */
    it('still performs the call', () => {
      const sim = server({ dropRate: 1 });
      const delivery = sim.deliver('spin', { roundId: roundId(4), stake: STAKE });

      expect(delivery.kind).toBe('DROP');
      expect(sim.state.balance).toBe(START_BALANCE - STAKE);
      expect(sim.state.rounds).toHaveLength(1);
    });

    it('is recovered by retrying the same roundId, and does not debit twice', () => {
      const sim = server({ dropRate: 1 });
      const id = roundId(5);
      sim.deliver('spin', { roundId: id, stake: STAKE });

      // The transport retries with the same key. Faults off, as if the link recovered.
      sim.setFaults(NO_FAULTS);
      const retried = sim.spin({ roundId: id, stake: STAKE });

      expect(retried.roundId).toBe(id);
      expect(sim.state.balance).toBe(START_BALANCE - STAKE);
      expect(sim.state.rounds).toHaveLength(1);
    });

    it('is visible to authenticate as a pending round', () => {
      // The player reloads after the disconnect. `pendingRound` is the whole recovery story.
      const sim = server({ dropRate: 1 });
      sim.deliver('spin', { roundId: roundId(6), stake: STAKE });

      sim.setFaults(NO_FAULTS);
      const resumed = sim.authenticate({ token: sim.state.token });

      expect(resumed.balance).toBe(START_BALANCE - STAKE);
      // A zero-win round settles atomically and leaves nothing pending; anything else must be
      // reported so the client can finish it.
      if (sim.state.rounds[0]?.state !== 'SETTLED') {
        expect(resumed.pendingRound?.roundId).toBe(roundId(6));
      }
    });
  });

  it('can be switched on and off mid-session', () => {
    const sim = server();
    expect(sim.deliver('spin', { roundId: roundId(7), stake: STAKE }).kind).toBe('DELIVER');

    sim.setFaults({ errorRates: { RATE_LIMITED: 1 } });
    expect(sim.deliver('spin', { roundId: roundId(8), stake: STAKE }).kind).toBe('REJECT');

    sim.setFaults(NO_FAULTS);
    expect(sim.deliver('spin', { roundId: roundId(9), stake: STAKE }).kind).toBe('DELIVER');
  });

  it('leaves the direct methods fault-free, so tests and math-sim are unaffected', () => {
    const sim = server({ dropRate: 1, errorRates: { TIMEOUT: 1 } });
    expect(sim.spin({ roundId: roundId(10), stake: STAKE }).balance).toBe(START_BALANCE - STAKE);
  });
});
