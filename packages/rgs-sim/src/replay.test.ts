import { describe, expect, it } from 'vitest';
import type { FeatureSpinRes, SettleRes, SpinRes } from '@slot/protocol';
import { viewMatchesStops } from '@slot/game-math';
import { featureSpin, settle, spin } from './sim.js';
import type { SimState } from './state.js';
import {
  START_BALANCE,
  STAKE,
  roundId,
  testConfig,
  testContext,
  testState,
} from './__fixtures__/harness.js';

/**
 * Block S0's done-when, as tests.
 *
 * > Two runs from the same seed produce byte-identical round sequences, and a replayed `roundId`
 * > never debits twice.
 *
 * Everything else in this package is a detail; these two properties are what make the simulator
 * usable as a specification — for the contract suite (S3), the E2E run (C8) and the published RTP
 * figure (S4) alike.
 */

const config = testConfig();

type Entry = SpinRes | FeatureSpinRes | SettleRes;

interface Session {
  state: SimState;
  log: Entry[];
  staked: number;
  credited: number;
}

/**
 * Play `rounds` complete rounds, following `next` exactly as a client must — never inferring the
 * next call from the result.
 */
function playSession(serverSeed: string, rounds: number, stake = STAKE): Session {
  const context = testContext(config);
  let state = testState({ serverSeed });
  const log: Entry[] = [];
  let staked = 0;
  let credited = 0;

  for (let index = 1; index <= rounds; index += 1) {
    const id = roundId(index);

    const spun = spin(state, { roundId: id, stake }, context);
    if (!spun.ok) throw new Error(`round ${index} was rejected: ${spun.error.code}`);
    state = spun.state;
    log.push(spun.response);
    staked += stake;

    let next = spun.response.next;
    let step = 0;

    while (next === 'FEATURE_SPIN') {
      step += 1;
      if (step > 500) throw new Error(`round ${index} never finished its feature`);
      const played = featureSpin(state, { roundId: id, step }, context);
      if (!played.ok) throw new Error(`step ${step} was rejected: ${played.error.code}`);
      state = played.state;
      log.push(played.response);
      next = played.response.next;
    }

    if (next === 'SETTLE') {
      const settled = settle(state, { roundId: id }, context);
      if (!settled.ok) throw new Error(`settle was rejected: ${settled.error.code}`);
      state = settled.state;
      log.push(settled.response);
      credited += settled.response.totalWin;
    }
  }

  return { state, log, staked, credited };
}

describe('determinism', () => {
  it('replays a 200-round session byte for byte from the same seed', () => {
    const first = playSession('replay-seed', 200);
    const second = playSession('replay-seed', 200);

    // JSON, not `toEqual`: "byte-identical" is the claim, so compare the bytes.
    expect(JSON.stringify(second.log)).toBe(JSON.stringify(first.log));
    expect(second.state.balance).toBe(first.state.balance);
  });

  it('produces a different session from a different server seed', () => {
    const first = playSession('seed-one', 50);
    const second = playSession('seed-two', 50);

    expect(JSON.stringify(second.log)).not.toBe(JSON.stringify(first.log));
  });

  it('keeps every view consistent with its own stops across the whole session', () => {
    const { log } = playSession('consistency', 200);

    for (const entry of log) {
      if (!('result' in entry)) continue;
      expect(viewMatchesStops(config.strips, entry.result.stops, entry.result.view)).toBe(true);
    }
  });
});

describe('the money invariant', () => {
  /**
   * The balance is never computed by adding up what the client thinks happened — but it must still
   * *agree* with it. One debit per round, one credit per settle, and nothing else moves money.
   */
  it('accounts for every minor unit across 200 rounds', () => {
    const { state, staked, credited } = playSession('accounting', 200);

    expect(state.balance).toBe(START_BALANCE - staked + credited);
  });

  it('leaves no round unfinished', () => {
    const { state } = playSession('accounting', 200);

    expect(state.rounds.every((round) => round.state === 'SETTLED')).toBe(true);
  });

  it('bounds the stored history rather than growing forever', () => {
    // A browser store has a quota, and an autoplay session reaches thousands of spins. Only
    // finished rounds are evicted, so recovery is never the thing that gets dropped.
    const { state } = playSession('eviction', 200);

    expect(state.rounds).toHaveLength(50);
  });
});

describe('a retry never moves money twice', () => {
  it('survives every call being sent twice', () => {
    const context = testContext(config);
    let state = testState({ serverSeed: 'retry-everything' });
    let staked = 0;
    let credited = 0;

    for (let index = 1; index <= 60; index += 1) {
      const id = roundId(index);
      const request = { roundId: id, stake: STAKE };

      // The transport retries with the same key — so the server sees the same call twice, and the
      // second one must replay rather than re-spin.
      const first = spin(state, request, context);
      if (!first.ok) throw new Error(first.error.code);
      const retried = spin(first.state, request, context);
      if (!retried.ok) throw new Error(retried.error.code);
      expect(retried.response).toEqual(first.response);
      state = retried.state;
      staked += STAKE;

      let next = first.response.next;
      let step = 0;

      while (next === 'FEATURE_SPIN') {
        step += 1;
        const played = featureSpin(state, { roundId: id, step }, context);
        if (!played.ok) throw new Error(played.error.code);
        const replayed = featureSpin(played.state, { roundId: id, step }, context);
        if (!replayed.ok) throw new Error(replayed.error.code);
        expect(replayed.response).toEqual(played.response);
        state = replayed.state;
        next = played.response.next;
      }

      if (next === 'SETTLE') {
        const settled = settle(state, { roundId: id }, context);
        if (!settled.ok) throw new Error(settled.error.code);
        const again = settle(settled.state, { roundId: id }, context);
        if (!again.ok) throw new Error(again.error.code);
        expect(again.response).toEqual(settled.response);
        state = again.state;
        credited += settled.response.totalWin;
      }
    }

    // Every call was made twice; exactly one debit and one credit per round reached the balance.
    expect(state.balance).toBe(START_BALANCE - staked + credited);
  });
});
