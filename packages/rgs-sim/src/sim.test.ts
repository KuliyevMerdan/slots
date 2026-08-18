import { describe, expect, it } from 'vitest';
import type { ErrorCode, FeatureSpinRes, SpinRes } from '@slot/protocol';
import { minor } from '@slot/money';
import { viewMatchesStops } from '@slot/game-math';
import { authenticate, featureSpin, history, settle, spin } from './sim.js';
import type { SimContext } from './sim.js';
import type { SimOutcome, SimState } from './state.js';
import { MAX_ROUND_HISTORY, findRound } from './state.js';
import {
  EXPIRES_AT,
  START_BALANCE,
  STAKE,
  deadSpin,
  payingSpin,
  roundId,
  spinWinningOver,
  stopsForScatters,
  testConfig,
  testContext,
  testState,
  triggeringSpin,
} from './__fixtures__/harness.js';

/* ── helpers ──────────────────────────────────────────────────────────────────────────────── */

/** Unwrap a successful outcome, or fail the test with the error the sim actually returned. */
function ok<T>(outcome: SimOutcome<T>): { state: SimState; response: T } {
  if (!outcome.ok) {
    throw new Error(`expected success, got ${outcome.error.code}: ${outcome.error.message}`);
  }
  return { state: outcome.state, response: outcome.response };
}

function expectError<T>(outcome: SimOutcome<T>, code: ErrorCode) {
  if (outcome.ok) throw new Error(`expected ${code}, got a successful response`);
  expect(outcome.error.code).toBe(code);
  return outcome.error;
}

const config = testConfig();
const devConfig = testConfig({ devMode: true });

/** Play a base spin through to the point a feature is open, returning the state and the round id. */
function openFeature(context: SimContext = testContext(config)) {
  const { roundId: id } = triggeringSpin(context.config);
  const { state, response } = ok(spin(testState(), { roundId: id, stake: STAKE }, context));
  return { state, response, roundId: id };
}

/** Drive an open feature to its last free spin. */
function playFeatureOut(
  start: SimState,
  id: string,
  context: SimContext,
): { state: SimState; last: FeatureSpinRes; steps: FeatureSpinRes[] } {
  let state = start;
  const steps: FeatureSpinRes[] = [];
  let step = 1;

  // Bounded so a retrigger bug becomes a failing test rather than a hanging one.
  for (; step <= 500; step += 1) {
    const played = ok(featureSpin(state, { roundId: id, step }, context));
    state = played.state;
    steps.push(played.response);
    if (played.response.next === 'SETTLE') break;
  }

  const last = steps[steps.length - 1];
  if (last === undefined) throw new Error('the feature produced no free spins');
  return { state, last, steps };
}

/* ── authenticate ─────────────────────────────────────────────────────────────────────────── */

describe('authenticate', () => {
  it('returns the session, the authoritative balance and the config', () => {
    const state = testState();
    const { response } = ok(authenticate(state, { token: state.token }, testContext(config)));

    expect(response.session).toEqual(state.session);
    expect(response.balance).toBe(START_BALANCE);
    expect(response.config).toBe(config);
    expect(response.pendingRound).toBeUndefined();
  });

  it('rejects a token it did not issue', () => {
    const error = expectError(
      authenticate(testState(), { token: 'someone-elses-token' }, testContext(config)),
      'SESSION_EXPIRED',
    );
    expect(error.class).toBe('PLAYER');
  });

  it('rejects a session that has expired', () => {
    const state = testState();
    const outcome = authenticate(
      state,
      { token: state.token },
      testContext(config, EXPIRES_AT + 1),
    );
    expectError(outcome, 'SESSION_EXPIRED');
  });

  it('carries a correlation id on every error', () => {
    const error = expectError(
      authenticate(testState(), { token: 'wrong' }, testContext(config)),
      'SESSION_EXPIRED',
    );
    expect(error.correlationId).toMatch(/^sim-\d{6}$/);
  });

  describe('pendingRound — the whole recovery story', () => {
    it('is absent when nothing is in flight', () => {
      const state = testState();
      const { response } = ok(authenticate(state, { token: state.token }, testContext(config)));
      expect(response.pendingRound).toBeUndefined();
    });

    it('reports a RESOLVED round and asks for a settle', () => {
      const context = testContext(config);
      const { roundId: id } = payingSpin(config);
      const { state } = ok(spin(testState(), { roundId: id, stake: STAKE }, context));

      const { response } = ok(authenticate(state, { token: state.token }, context));

      expect(response.pendingRound).toMatchObject({
        roundId: id,
        state: 'RESOLVED',
        stake: STAKE,
        next: 'SETTLE',
      });
      expect(response.pendingRound?.feature).toBeUndefined();
    });

    it('reports an OPEN feature round and asks for the next free spin', () => {
      const context = testContext(config);
      const { state, roundId: id } = openFeature(context);

      const { response } = ok(authenticate(state, { token: state.token }, context));

      expect(response.pendingRound).toMatchObject({
        roundId: id,
        state: 'OPEN',
        next: 'FEATURE_SPIN',
      });
      expect(response.pendingRound?.feature?.step).toBe(0);
    });

    it('resumes mid-feature at the step after the last one played', () => {
      const context = testContext(config);
      const opened = openFeature(context);
      const afterOne = ok(featureSpin(opened.state, { roundId: opened.roundId, step: 1 }, context));

      const { response } = ok(
        authenticate(afterOne.state, { token: afterOne.state.token }, context),
      );

      expect(response.pendingRound?.feature?.step).toBe(1);
      expect(response.pendingRound?.result).toEqual(afterOne.response.result);
    });

    it('reports the authoritative balance, not a client-side guess', () => {
      const context = testContext(config);
      const { roundId: id } = payingSpin(config);
      const { state } = ok(spin(testState(), { roundId: id, stake: STAKE }, context));

      const { response } = ok(authenticate(state, { token: state.token }, context));
      // Post-debit, pre-credit: the win is real but uncredited until `settle`.
      expect(response.balance).toBe(START_BALANCE - STAKE);
    });
  });
});

/* ── spin ─────────────────────────────────────────────────────────────────────────────────── */

describe('spin', () => {
  it('debits the stake and reports the post-debit balance', () => {
    const context = testContext(config);
    const { response, state } = ok(
      spin(testState(), { roundId: roundId(1), stake: STAKE }, context),
    );

    expect(response.balance).toBe(START_BALANCE - STAKE);
    expect(state.balance).toBe(START_BALANCE - STAKE);
  });

  it('sends a view that agrees with its own stops', () => {
    const context = testContext(config);
    const { response } = ok(spin(testState(), { roundId: roundId(2), stake: STAKE }, context));

    // The dev-build assertion and the contract suite both run this check. A server whose view
    // disagrees with its stops has a strip-alignment bug, and this is where it surfaces.
    expect(viewMatchesStops(config.strips, response.result.stops, response.result.view)).toBe(true);
  });

  it('settles a zero-win round atomically', () => {
    const context = testContext(config);
    const { roundId: id } = deadSpin(config);
    const { response, state } = ok(spin(testState(), { roundId: id, stake: STAKE }, context));

    expect(response.result.totalWin).toBe(0);
    expect(response.next).toBe('IDLE');
    expect(findRound(state, id)?.state).toBe('SETTLED');
  });

  it('leaves a winning round RESOLVED and asks for a settle', () => {
    const context = testContext(config);
    const { roundId: id } = payingSpin(config);
    const { response, state } = ok(spin(testState(), { roundId: id, stake: STAKE }, context));

    expect(response.result.totalWin).toBeGreaterThan(0);
    expect(response.next).toBe('SETTLE');
    expect(findRound(state, id)?.state).toBe('RESOLVED');
    // Still uncredited — the balance moved by the debit only.
    expect(response.balance).toBe(START_BALANCE - STAKE);
  });

  it('opens the round when a feature triggers', () => {
    const context = testContext(config);
    const { response, state, roundId: id } = openFeature(context);

    expect(response.next).toBe('FEATURE_SPIN');
    expect(response.feature?.kind).toBe('FREE_SPINS');
    expect(response.feature?.remaining).toBe(response.feature?.total);
    expect(response.feature?.step).toBe(0);
    expect(response.feature?.stakeRef).toBe(STAKE);
    expect(response.result.features[0]).toMatchObject({ kind: 'FREE_SPINS' });
    expect(findRound(state, id)?.state).toBe('OPEN');
  });

  describe('stake validation — the PLAYER error class, with a real producer', () => {
    it('refuses a stake that is not a bet level', () => {
      const outcome = spin(
        testState(),
        { roundId: roundId(3), stake: minor(37) },
        testContext(config),
      );
      expect(expectError(outcome, 'STAKE_NOT_ALLOWED').class).toBe('PLAYER');
    });

    it('refuses a stake above the table maximum', () => {
      const capped = testConfig({ maxStake: minor(100) });
      const outcome = spin(
        testState(),
        { roundId: roundId(4), stake: minor(4_000) },
        testContext(capped),
      );
      expectError(outcome, 'STAKE_NOT_ALLOWED');
    });

    it('refuses a stake below the table minimum', () => {
      const raised = testConfig({ minStake: minor(200) });
      const outcome = spin(
        testState(),
        { roundId: roundId(5), stake: minor(100) },
        testContext(raised),
      );
      expectError(outcome, 'STAKE_NOT_ALLOWED');
    });

    it('refuses a stake the balance does not cover', () => {
      const broke = testState({ balance: minor(10) });
      const outcome = spin(broke, { roundId: roundId(6), stake: STAKE }, testContext(config));
      expect(expectError(outcome, 'INSUFFICIENT_FUNDS').class).toBe('PLAYER');
    });

    it('does not debit a rejected spin', () => {
      const outcome = spin(
        testState(),
        { roundId: roundId(7), stake: minor(37) },
        testContext(config),
      );
      expect(outcome.state.balance).toBe(START_BALANCE);
      expect(outcome.state.rounds).toHaveLength(0);
    });
  });

  describe('idempotency', () => {
    it('replays the original response for a duplicate roundId', () => {
      const context = testContext(config);
      const request = { roundId: roundId(8), stake: STAKE };
      const first = ok(spin(testState(), request, context));
      const second = ok(spin(first.state, request, context));

      expect(second.response).toEqual(first.response);
    });

    it('does not debit twice', () => {
      const context = testContext(config);
      const request = { roundId: roundId(9), stake: STAKE };
      const first = ok(spin(testState(), request, context));
      const second = ok(spin(first.state, request, context));
      const third = ok(spin(second.state, request, context));

      expect(third.state.balance).toBe(START_BALANCE - STAKE);
      expect(third.state.rounds).toHaveLength(1);
    });

    it('ignores key order when comparing a duplicate', () => {
      const context = testContext(config);
      const id = roundId(10);
      const first = ok(
        spin(testState(), { roundId: id, stake: STAKE, clientSeed: 'abc' }, context),
      );
      // Same request, written the other way round. An honest retry must not become ROUND_CONFLICT.
      const second = ok(
        spin(first.state, { clientSeed: 'abc', stake: STAKE, roundId: id }, context),
      );

      expect(second.response).toEqual(first.response);
    });

    it('rejects a duplicate roundId carrying a different stake', () => {
      const context = testContext(config);
      const id = roundId(11);
      const first = ok(spin(testState(), { roundId: id, stake: STAKE }, context));
      const outcome = spin(first.state, { roundId: id, stake: minor(200) }, context);

      const error = expectError(outcome, 'ROUND_CONFLICT');
      expect(error.class).toBe('FATAL');
      expect(error.roundId).toBe(id);
    });

    it('rejects a duplicate roundId carrying a different client seed', () => {
      const context = testContext(config);
      const id = roundId(12);
      const first = ok(spin(testState(), { roundId: id, stake: STAKE, clientSeed: 'a' }, context));
      expectError(
        spin(first.state, { roundId: id, stake: STAKE, clientSeed: 'b' }, context),
        'ROUND_CONFLICT',
      );
    });
  });

  describe('forceOutcome — gate two of two', () => {
    it('refuses the field outright when devMode is off', () => {
      const outcome = spin(
        testState(),
        { roundId: roundId(13), stake: STAKE, forceOutcome: { stops: [0, 0, 0, 0, 0] } },
        testContext(config),
      );
      expect(expectError(outcome, 'FORCE_OUTCOME_REFUSED').class).toBe('FATAL');
    });

    it('refuses it before validating anything else about the request', () => {
      // A tampered request does not get to find out whether its stake was acceptable.
      const outcome = spin(
        testState(),
        { roundId: roundId(14), stake: minor(37), forceOutcome: { stops: [0, 0, 0, 0, 0] } },
        testContext(config),
      );
      expectError(outcome, 'FORCE_OUTCOME_REFUSED');
    });

    it('honours explicit stops in devMode', () => {
      const stops = stopsForScatters(devConfig, 3);
      const { response } = ok(
        spin(
          testState(),
          { roundId: roundId(15), stake: STAKE, forceOutcome: { stops } },
          testContext(devConfig),
        ),
      );

      expect(response.result.stops).toEqual(stops);
      expect(response.feature?.total).toBe(10);
    });

    it('refuses stops that do not name every reel', () => {
      const outcome = spin(
        testState(),
        { roundId: roundId(16), stake: STAKE, forceOutcome: { stops: [0, 0] } },
        testContext(devConfig),
      );
      expectError(outcome, 'FORCE_OUTCOME_REFUSED');
    });

    it('refuses a stop past the end of its strip', () => {
      const outcome = spin(
        testState(),
        { roundId: roundId(17), stake: STAKE, forceOutcome: { stops: [0, 0, 0, 0, 9_999] } },
        testContext(devConfig),
      );
      expectError(outcome, 'FORCE_OUTCOME_REFUSED');
    });

    it('honours a named scenario in devMode', () => {
      const { response } = ok(
        spin(
          testState(),
          { roundId: roundId(18), stake: STAKE, forceOutcome: { scenario: 'FREE_SPINS_TRIGGER' } },
          testContext(devConfig),
        ),
      );
      expect(response.next).toBe('FEATURE_SPIN');
    });

    it('refuses a named scenario when devMode is off', () => {
      const outcome = spin(
        testState(),
        { roundId: roundId(19), stake: STAKE, forceOutcome: { scenario: 'MAX_WIN' } },
        testContext(config),
      );
      expectError(outcome, 'FORCE_OUTCOME_REFUSED');
    });
  });
});

/* ── featureSpin ──────────────────────────────────────────────────────────────────────────── */

describe('featureSpin', () => {
  it('never debits', () => {
    const context = testContext(config);
    const opened = openFeature(context);
    const { response, state } = ok(
      featureSpin(opened.state, { roundId: opened.roundId, step: 1 }, context),
    );

    expect(response.balance).toBe(START_BALANCE - STAKE);
    expect(state.balance).toBe(START_BALANCE - STAKE);
  });

  it('resolves multipliers against the triggering stake', () => {
    const context = testContext(config);
    const opened = openFeature(context);
    const { response } = ok(
      featureSpin(opened.state, { roundId: opened.roundId, step: 1 }, context),
    );

    expect(response.feature.stakeRef).toBe(STAKE);
  });

  it('counts down and ends the round RESOLVED', () => {
    const context = testContext(config);
    const opened = openFeature(context);
    const { state, last, steps } = playFeatureOut(opened.state, opened.roundId, context);

    expect(last.next).toBe('SETTLE');
    expect(last.feature.remaining).toBe(0);
    expect(steps).toHaveLength(last.feature.total);
    expect(findRound(state, opened.roundId)?.state).toBe('RESOLVED');
  });

  it('keeps remaining = total - step through every spin, retriggers included', () => {
    const context = testContext(config);
    const opened = openFeature(context);
    const { steps } = playFeatureOut(opened.state, opened.roundId, context);

    for (const step of steps) {
      expect(step.feature.remaining).toBe(step.feature.total - step.feature.step);
    }
  });

  it('accumulates every win into cumulativeWin, uncredited', () => {
    const context = testContext(config);
    const opened = openFeature(context);
    const { state, last, steps } = playFeatureOut(opened.state, opened.roundId, context);

    const expected =
      opened.response.result.totalWin +
      steps.reduce((total, step) => total + step.result.totalWin, 0);

    expect(last.roundWin).toBe(expected);
    expect(findRound(state, opened.roundId)?.cumulativeWin).toBe(expected);
    // Still not in the balance. That is what makes `settle` an explicit call.
    expect(state.balance).toBe(START_BALANCE - STAKE);
  });

  it('folds a retrigger into total and remaining', () => {
    const context = testContext(devConfig);
    const stops = stopsForScatters(devConfig, 3);
    const opened = ok(
      spin(testState(), { roundId: roundId(20), stake: STAKE, forceOutcome: { stops } }, context),
    );
    const awarded = opened.response.feature?.total ?? 0;

    const retriggered = ok(
      featureSpin(
        opened.state,
        { roundId: roundId(20), step: 1, forceOutcome: { stops } },
        context,
      ),
    );

    // Three scatters award ten more, and the server has already done the arithmetic.
    expect(retriggered.response.feature.total).toBe(awarded + 10);
    expect(retriggered.response.feature.remaining).toBe(awarded + 10 - 1);
    expect(retriggered.response.result.features[0]).toEqual({
      kind: 'FREE_SPINS_RETRIGGER',
      awarded: 10,
    });
  });

  describe('illegal transitions', () => {
    it('rejects an unknown round', () => {
      const outcome = featureSpin(
        testState(),
        { roundId: roundId(21), step: 1 },
        testContext(config),
      );
      expect(expectError(outcome, 'UNKNOWN_ROUND').class).toBe('FATAL');
    });

    it('rejects a round that awarded no feature', () => {
      const context = testContext(config);
      const { roundId: id } = payingSpin(config);
      const { state } = ok(spin(testState(), { roundId: id, stake: STAKE }, context));

      expectError(featureSpin(state, { roundId: id, step: 1 }, context), 'ILLEGAL_TRANSITION');
    });

    it('rejects a step that skips ahead', () => {
      const context = testContext(config);
      const opened = openFeature(context);
      expectError(
        featureSpin(opened.state, { roundId: opened.roundId, step: 3 }, context),
        'ILLEGAL_TRANSITION',
      );
    });

    it('rejects a spin after the feature is spent', () => {
      const context = testContext(config);
      const opened = openFeature(context);
      const { state, last } = playFeatureOut(opened.state, opened.roundId, context);

      expectError(
        featureSpin(state, { roundId: opened.roundId, step: last.step + 1 }, context),
        'ILLEGAL_TRANSITION',
      );
    });
  });

  describe('idempotency', () => {
    it('replays a duplicate (roundId, step)', () => {
      const context = testContext(config);
      const opened = openFeature(context);
      const request = { roundId: opened.roundId, step: 1 };
      const first = ok(featureSpin(opened.state, request, context));
      const second = ok(featureSpin(first.state, request, context));

      expect(second.response).toEqual(first.response);
      expect(second.state.rounds[0]?.steps).toHaveLength(1);
    });

    it('replays an earlier step without rewinding the feature', () => {
      const context = testContext(config);
      const opened = openFeature(context);
      const one = ok(featureSpin(opened.state, { roundId: opened.roundId, step: 1 }, context));
      const two = ok(featureSpin(one.state, { roundId: opened.roundId, step: 2 }, context));

      const replayed = ok(featureSpin(two.state, { roundId: opened.roundId, step: 1 }, context));

      expect(replayed.response).toEqual(one.response);
      expect(findRound(replayed.state, opened.roundId)?.feature?.step).toBe(2);
    });

    it('rejects a replayed step carrying a different forceOutcome', () => {
      const context = testContext(devConfig);
      const stops = stopsForScatters(devConfig, 3);
      const opened = ok(
        spin(testState(), { roundId: roundId(22), stake: STAKE, forceOutcome: { stops } }, context),
      );
      const first = ok(featureSpin(opened.state, { roundId: roundId(22), step: 1 }, context));

      expectError(
        featureSpin(
          first.state,
          { roundId: roundId(22), step: 1, forceOutcome: { stops: [0, 0, 0, 0, 0] } },
          context,
        ),
        'ROUND_CONFLICT',
      );
    });
  });
});

/* ── settle ───────────────────────────────────────────────────────────────────────────────── */

describe('settle', () => {
  it('credits the win and reports the post-credit balance', () => {
    const context = testContext(config);
    const { roundId: id } = payingSpin(config);
    const spun = ok(spin(testState(), { roundId: id, stake: STAKE }, context));

    const { response, state } = ok(settle(spun.state, { roundId: id }, context));

    const expected = START_BALANCE - STAKE + spun.response.result.totalWin;
    expect(response.balance).toBe(expected);
    expect(response.totalWin).toBe(spun.response.result.totalWin);
    expect(response.capped).toBe(false);
    expect(response.next).toBe('IDLE');
    expect(state.balance).toBe(expected);
    expect(findRound(state, id)?.state).toBe('SETTLED');
  });

  it('credits a feature round once, for the whole accrued win', () => {
    const context = testContext(config);
    const opened = openFeature(context);
    const played = playFeatureOut(opened.state, opened.roundId, context);

    const { response } = ok(settle(played.state, { roundId: opened.roundId }, context));

    expect(response.totalWin).toBe(played.last.roundWin);
    expect(response.balance).toBe(START_BALANCE - STAKE + played.last.roundWin);
  });

  it('replays rather than crediting twice', () => {
    const context = testContext(config);
    const { roundId: id } = payingSpin(config);
    const spun = ok(spin(testState(), { roundId: id, stake: STAKE }, context));
    const first = ok(settle(spun.state, { roundId: id }, context));
    const second = ok(settle(first.state, { roundId: id }, context));

    expect(second.response).toEqual(first.response);
    expect(second.state.balance).toBe(first.state.balance);
  });

  it('replays for a round that already settled atomically', () => {
    const context = testContext(config);
    const { roundId: id } = deadSpin(config);
    const spun = ok(spin(testState(), { roundId: id, stake: STAKE }, context));

    const { response, state } = ok(settle(spun.state, { roundId: id }, context));

    expect(response.totalWin).toBe(0);
    expect(response.capped).toBe(false);
    expect(state.balance).toBe(START_BALANCE - STAKE);
  });

  it('rejects an unknown round', () => {
    expectError(
      settle(testState(), { roundId: roundId(30) }, testContext(config)),
      'UNKNOWN_ROUND',
    );
  });

  it('rejects a round that is still mid-feature', () => {
    const context = testContext(config);
    const opened = openFeature(context);
    const error = expectError(
      settle(opened.state, { roundId: opened.roundId }, context),
      'ILLEGAL_TRANSITION',
    );
    expect(error.class).toBe('FATAL');
  });

  /**
   * The ceiling is `stake × maxWinMultiplier` and it is applied as the round accrues, so the number
   * the client counts up to and the number that reaches the balance are the same number by
   * construction rather than by agreement (docs/protocol.md D7).
   */
  describe('the max-win ceiling', () => {
    /** One stake exactly, so any real win clips. */
    const tiny = { maxWinMultiplier: 1 };

    it('states the payable total on the way in, not the raw one', () => {
      const capped = testConfig(tiny);
      const context = testContext(capped);
      const { roundId: id } = spinWinningOver(capped, 1);

      const spun = ok(spin(testState(), { roundId: id, stake: STAKE }, context));

      expect(spun.response.result.totalWin).toBeGreaterThan(STAKE);
      // The outcome is what the math paid; the money is what the round will pay.
      expect(spun.response.roundWin).toBe(STAKE);
      expect(spun.response.capped).toBe(true);
    });

    it('credits exactly what it last showed', () => {
      const capped = testConfig(tiny);
      const context = testContext(capped);
      const { roundId: id } = spinWinningOver(capped, 1);
      const spun = ok(spin(testState(), { roundId: id, stake: STAKE }, context));

      const { response, state } = ok(settle(spun.state, { roundId: id }, context));

      expect(response.totalWin).toBe(spun.response.roundWin);
      expect(response.capped).toBe(true);
      expect(state.balance).toBe(START_BALANCE - STAKE + STAKE);
    });

    it('stops a feature accruing past the ceiling, and stays capped', () => {
      const capped = testConfig({ ...tiny, devMode: true });
      const context = testContext(capped);
      const opened = openFeature(context);
      const played = playFeatureOut(opened.state, opened.roundId, context);
      const ceiling = STAKE * 1;

      for (const step of played.steps) {
        expect(step.roundWin).toBeLessThanOrEqual(ceiling);
      }
      expect(played.last.capped).toBe(true);

      const { response } = ok(settle(played.state, { roundId: opened.roundId }, context));
      expect(response.totalWin).toBe(played.last.roundWin);
    });

    it('leaves a win under the ceiling alone', () => {
      const context = testContext(config);
      const { roundId: id } = payingSpin(config);
      const spun = ok(spin(testState(), { roundId: id, stake: STAKE }, context));

      expect(spun.response.roundWin).toBe(spun.response.result.totalWin);
      expect(spun.response.capped).toBe(false);
      expect(ok(settle(spun.state, { roundId: id }, context)).response.capped).toBe(false);
    });
  });
});

/* ── the lifecycle table, as one test ─────────────────────────────────────────────────────── */

describe('the round lifecycle (docs/protocol.md §3)', () => {
  const cases: Array<[string, () => SpinRes, 'SETTLED' | 'RESOLVED' | 'OPEN', string]> = [
    [
      'base spin, no win, no feature',
      () =>
        ok(
          spin(
            testState(),
            { roundId: deadSpin(config).roundId, stake: STAKE },
            testContext(config),
          ),
        ).response,
      'SETTLED',
      'IDLE',
    ],
    [
      'base spin, win, no feature',
      () =>
        ok(
          spin(
            testState(),
            { roundId: payingSpin(config).roundId, stake: STAKE },
            testContext(config),
          ),
        ).response,
      'RESOLVED',
      'SETTLE',
    ],
    [
      'base spin triggers a feature',
      () =>
        ok(
          spin(
            testState(),
            { roundId: triggeringSpin(config).roundId, stake: STAKE },
            testContext(config),
          ),
        ).response,
      'OPEN',
      'FEATURE_SPIN',
    ],
  ];

  it.each(cases)('%s → next is %s', (_label, run, _state, expectedNext) => {
    expect(run().next).toBe(expectedNext);
  });
});

/* ── history ──────────────────────────────────────────────────────────────────────────────── */

/**
 * The server half of a player-visible round history — required in most regulated markets, and
 * nearly free here because the idempotency store already keeps the responses.
 */
describe('history', () => {
  const config = testConfig();

  /** Play `count` base rounds through the real handlers, returning the state they left behind. */
  const playRounds = (count: number): SimState => {
    const context = testContext(config);
    let state = testState();

    for (let index = 0; index < count; index += 1) {
      const id = roundId(500 + index);
      const spun = ok(spin(state, { roundId: id, stake: STAKE }, context));
      state = spun.state;
      if (spun.response.next === 'SETTLE') {
        state = ok(settle(state, { roundId: id }, context)).state;
      }
    }

    return state;
  };

  it('is empty for a session that has played nothing', () => {
    const { response } = ok(history(testState(), {}, testContext(config)));

    expect(response.rounds).toEqual([]);
    expect(response.retention).toBe(MAX_ROUND_HISTORY);
  });

  it('lists settled rounds newest first', () => {
    const { response } = ok(history(playRounds(4), {}, testContext(config)));

    expect(response.rounds).toHaveLength(4);
    const ids = response.rounds.map((round) => round.roundId);
    expect(ids).toEqual([...ids].sort().reverse());
  });

  it('summarises the round in the terms a player reads', () => {
    const context = testContext(config);
    const { roundId: id } = payingSpin(config);
    const spun = ok(spin(testState(), { roundId: id, stake: STAKE }, context));
    const settled = ok(settle(spun.state, { roundId: id }, context));

    const [summary] = ok(history(settled.state, {}, context)).response.rounds;

    expect(summary).toMatchObject({
      roundId: id,
      stake: STAKE,
      totalWin: settled.response.totalWin,
      capped: false,
      freeSpins: 0,
    });
  });

  it('counts the free spins a round contained', () => {
    const context = testContext(devConfig);
    const opened = openFeature(context);
    const played = playFeatureOut(opened.state, opened.roundId, context);
    const settled = ok(settle(played.state, { roundId: opened.roundId }, context));

    const [summary] = ok(history(settled.state, {}, context)).response.rounds;

    expect(summary?.freeSpins).toBe(played.steps.length);
    expect(summary?.totalWin).toBe(settled.response.totalWin);
  });

  /** A round in flight is `pendingRound`. Listing it here would invite a client to present it. */
  it('leaves an unfinished round out', () => {
    const context = testContext(config);
    const { roundId: id } = payingSpin(config);
    const spun = ok(spin(testState(), { roundId: id, stake: STAKE }, context));

    expect(ok(history(spun.state, {}, context)).response.rounds).toEqual([]);
  });

  it('honours a limit, and takes the newest', () => {
    const state = playRounds(6);

    const { response } = ok(history(state, { limit: 2 }, testContext(config)));
    const all = ok(history(state, {}, testContext(config))).response;

    expect(response.rounds).toHaveLength(2);
    expect(response.rounds).toEqual(all.rounds.slice(0, 2));
  });
});
