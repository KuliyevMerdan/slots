import { describe, expect, it } from 'vitest';
import type { SlotError } from '@slot/protocol';
import { isSlotError } from '@slot/protocol';
import { SimServer } from './server.js';
import { InMemoryStore, SIM_STORE_KEY } from './store.js';
import { loadState } from './state.js';
import {
  START_BALANCE,
  STAKE,
  roundId,
  testConfig,
  testState,
  triggeringSpin,
} from './__fixtures__/harness.js';

/**
 * The stateful shell: validation in, persistence out, `SlotError` for callers who prefer throwing.
 *
 * The reload test is the one that matters. A player who refreshes mid-feature has to come back to a
 * game that still owes them free spins — that is the difference between a simulator and a demo.
 */

const config = testConfig();
const NOW = 1_700_000_000_000;

const server = (store = new InMemoryStore(), overrides = {}) =>
  new SimServer({ initialState: testState(), config, store, now: () => NOW, ...overrides });

describe('SimServer', () => {
  it('authenticates and returns the config it was built with', () => {
    const sim = server();
    const response = sim.authenticate({ token: sim.state.token });

    expect(response.balance).toBe(START_BALANCE);
    expect(response.config.gameId).toBe(config.gameId);
  });

  it('throws a classified SlotError instead of returning an error payload', () => {
    const sim = server();

    try {
      sim.authenticate({ token: 'wrong' });
      throw new Error('expected a SlotError');
    } catch (error) {
      expect(isSlotError(error)).toBe(true);
      expect((error as SlotError).code).toBe('SESSION_EXPIRED');
      expect((error as SlotError).errorClass).toBe('PLAYER');
      expect((error as SlotError).isRetryable).toBe(false);
    }
  });

  describe('request validation', () => {
    it.each([
      ['a missing field', { stake: 100 }],
      ['a roundId that is not a UUIDv7', { roundId: 'not-a-uuid', stake: 100 }],
      ['a fractional stake', { roundId: roundId(1), stake: 10.5 }],
      ['a zero stake', { roundId: roundId(1), stake: 0 }],
    ])('rejects %s with SCHEMA_MISMATCH', (_label, request) => {
      const sim = server();
      expect(() => sim.spin(request)).toThrow(
        expect.objectContaining({ code: 'SCHEMA_MISMATCH' }) as Error,
      );
    });

    it('classifies a schema mismatch as FATAL', () => {
      const sim = server();
      try {
        sim.spin({});
        throw new Error('expected a SlotError');
      } catch (error) {
        expect((error as SlotError).errorClass).toBe('FATAL');
        expect((error as SlotError).correlationId).toMatch(/^sim-\d{6}$/);
      }
    });

    it('does not move money on a malformed request', () => {
      const sim = server();
      expect(() => sim.spin({ roundId: 'nope', stake: 100 })).toThrow();
      expect(sim.state.balance).toBe(START_BALANCE);
      expect(sim.state.rounds).toHaveLength(0);
    });
  });

  describe('persistence', () => {
    it('resumes a feature round after a reload', () => {
      const store = new InMemoryStore();
      const id = triggeringSpin(config).roundId;

      const first = server(store);
      const spun = first.spin({ roundId: id, stake: STAKE });
      first.featureSpin({ roundId: id, step: 1 });

      // A new process, the same store — this is a page reload.
      const second = server(store);
      const resumed = second.authenticate({ token: second.state.token });

      expect(resumed.balance).toBe(START_BALANCE - STAKE);
      expect(resumed.pendingRound).toMatchObject({
        roundId: id,
        state: 'OPEN',
        next: 'FEATURE_SPIN',
      });
      expect(resumed.pendingRound?.feature?.step).toBe(1);
      expect(resumed.pendingRound?.feature?.total).toBe(spun.feature?.total);

      // And the feature genuinely continues rather than restarting.
      const continued = second.featureSpin({ roundId: id, step: 2 });
      expect(continued.step).toBe(2);
    });

    it('writes through on every call, including rejected ones', () => {
      const store = new InMemoryStore();
      const sim = server(store);

      expect(() => sim.authenticate({ token: 'wrong' })).toThrow();

      // The call counter advanced and was saved: a rejected call is still a call that happened,
      // and its correlation id has to survive into the log.
      expect(loadState(store, SIM_STORE_KEY)?.seq).toBe(1);
    });

    it('discards a saved session that belongs to a different server seed', () => {
      const store = new InMemoryStore();
      const first = server(store);
      first.spin({ roundId: roundId(2), stake: STAKE });
      expect(first.state.balance).toBe(START_BALANCE - STAKE);

      const second = new SimServer({
        initialState: testState({ serverSeed: 'a-different-game' }),
        config,
        store,
        now: () => NOW,
      });

      expect(second.state.balance).toBe(START_BALANCE);
      expect(second.state.rounds).toHaveLength(0);
    });

    it('forgets the session on reset', () => {
      const store = new InMemoryStore();
      const sim = server(store);
      sim.spin({ roundId: roundId(3), stake: STAKE });

      sim.reset(testState());

      expect(sim.state.balance).toBe(START_BALANCE);
      expect(loadState(store, SIM_STORE_KEY)).toBeNull();
    });
  });

  it('drives a whole round through the wrapper', () => {
    const sim = server();
    const id = roundId(4);
    const spun = sim.spin({ roundId: id, stake: STAKE });

    expect(spun.balance).toBe(START_BALANCE - STAKE);

    if (spun.next === 'SETTLE') {
      const settled = sim.settle({ roundId: id });
      expect(settled.next).toBe('IDLE');
      expect(settled.balance).toBe(START_BALANCE - STAKE + settled.totalWin);
    }
  });
});
