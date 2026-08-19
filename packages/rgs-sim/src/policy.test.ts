import { describe, expect, it } from 'vitest';
import type { ErrorCode } from '@slot/protocol';
import { featureSpin, history, settle, spin } from './sim.js';
import type { SimContext } from './sim.js';
import { SimServer } from './server.js';
import { InMemoryStore } from './store.js';
import type { SimOutcome, SimState } from './state.js';
import {
  EXPIRES_AT,
  STAKE,
  payingSpin,
  roundId,
  testConfig,
  testContext,
  testState,
  triggeringSpin,
} from './__fixtures__/harness.js';

/**
 * The policy surface (C6): the jurisdiction's pacing rule, and session expiry as something every
 * call checks rather than only `authenticate`.
 *
 * Both exist so the client's compliance layer is built against a server that pushes back
 * (docs/protocol.md §2.1, §5). The pacing tests run against the UK preset because that is the regime
 * that has a floor; the expiry tests are the producer the engine's transparent re-authenticate
 * (C6-3) is tested against.
 */

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

const NOW = 1_700_000_000_000;
const uk = testConfig({ jurisdiction: 'UK' });
const at = (now: number, config = uk): SimContext => testContext(config, now);

describe('the pacing rule — the half of a jurisdiction the server can see', () => {
  it('serves the rules with the config, taken from the preset for the declared id', () => {
    expect(uk.jurisdictionRules).toEqual({
      minSpinIntervalMs: 2_500,
      turboAllowed: false,
      autoplayAllowed: false,
      realityCheckIntervalMs: 3_600_000,
    });
  });

  it('refuses a spin arriving before minSpinIntervalMs, and accepts one arriving on time', () => {
    const { state } = ok(spin(testState(), { roundId: roundId(1), stake: STAKE }, at(NOW)));

    expectError(
      spin(state, { roundId: roundId(2), stake: STAKE }, at(NOW + 1_000)),
      'LIMIT_REACHED',
    );
    ok(spin(state, { roundId: roundId(2), stake: STAKE }, at(NOW + 2_500)));
  });

  it('replays a duplicate roundId untouched by the pacing rule — a retry is not a second spin', () => {
    const first = ok(spin(testState(), { roundId: roundId(1), stake: STAKE }, at(NOW)));

    const replay = ok(spin(first.state, { roundId: roundId(1), stake: STAKE }, at(NOW + 100)));
    expect(replay.response).toEqual(first.response);
  });

  it('measures from the last accepted spin — a refused call did not start a game cycle', () => {
    const { state } = ok(spin(testState(), { roundId: roundId(1), stake: STAKE }, at(NOW)));

    // Refused at +1000; if the refusal moved the window, +2600 would be 1600ms after it and fail.
    expectError(
      spin(state, { roundId: roundId(2), stake: STAKE }, at(NOW + 1_000)),
      'LIMIT_REACHED',
    );
    ok(spin(state, { roundId: roundId(3), stake: STAKE }, at(NOW + 2_600)));
  });

  it('does not pace free spins — a step inside a round is presentation-paced, not cycle-paced', () => {
    const { roundId: id } = triggeringSpin(uk);
    const opened = ok(spin(testState(), { roundId: id, stake: STAKE }, at(NOW)));

    // Immediately, same clock reading: the feature step is not a base-game cycle.
    ok(featureSpin(opened.state, { roundId: id, step: 1 }, at(NOW)));
  });

  it('never fires under DEFAULT rules — the floor is zero', () => {
    const config = testConfig();
    const context = at(NOW, config);
    const { state } = ok(spin(testState(), { roundId: roundId(1), stake: STAKE }, context));

    ok(spin(state, { roundId: roundId(2), stake: STAKE }, context));
  });
});

describe('session expiry — checked on every call, so the mid-round recovery has a producer', () => {
  const config = testConfig();
  const expired = at(EXPIRES_AT, config);

  it('refuses a spin on an expired session', () => {
    expectError(
      spin(testState(), { roundId: roundId(1), stake: STAKE }, expired),
      'SESSION_EXPIRED',
    );
  });

  it('refuses a feature spin mid-round — the case the transparent re-authenticate exists for', () => {
    const { roundId: id } = triggeringSpin(config);
    const opened = ok(spin(testState(), { roundId: id, stake: STAKE }, at(NOW, config)));

    const error = expectError(
      featureSpin(opened.state, { roundId: id, step: 1 }, expired),
      'SESSION_EXPIRED',
    );
    expect(error.class).toBe('PLAYER');
  });

  it('refuses a settle with a credit still owed', () => {
    const { roundId: id } = payingSpin(config);
    const resolved = ok(spin(testState(), { roundId: id, stake: STAKE }, at(NOW, config)));

    expectError(settle(resolved.state, { roundId: id }, expired), 'SESSION_EXPIRED');
  });

  it('refuses history too — an expired caller is not authenticated for anything', () => {
    expectError(history(testState(), {}, expired), 'SESSION_EXPIRED');
  });

  it('refuses even an idempotent replay — the session check comes before every answer', () => {
    const { state } = ok(spin(testState(), { roundId: roundId(1), stake: STAKE }, at(NOW, config)));

    expectError(spin(state, { roundId: roundId(1), stake: STAKE }, expired), 'SESSION_EXPIRED');
  });
});

describe('the demo lobby renews — issue, expire, recover', () => {
  it('walks the whole §5 expiry recovery: strand a credit, renew, resume, settle', () => {
    const config = testConfig();
    const sim = new SimServer({
      initialState: testState(),
      config,
      store: new InMemoryStore(),
      now: () => NOW,
    });

    // A round with money on the table.
    const { roundId: id } = payingSpin(config);
    sim.spin({ roundId: id, stake: STAKE });

    // The session dies before the settle.
    sim.expireSession();
    expect(() => sim.settle({ roundId: id })).toThrow(
      expect.objectContaining({ code: 'SESSION_EXPIRED' }) as Error,
    );

    // The lobby renews; the fresh token re-attaches to the same round.
    const { token } = sim.issueSession();
    const auth = sim.authenticate({ token });
    expect(auth.pendingRound?.roundId).toBe(id);
    expect(auth.pendingRound?.state).toBe('RESOLVED');

    // And the ordinary path carries it home.
    const settled = sim.settle({ roundId: id });
    expect(settled.totalWin).toBe(auth.pendingRound?.roundWin);
  });

  it('expireSession ends the session at the injected clock, not a real one', () => {
    const sim = new SimServer({
      initialState: testState(),
      config: testConfig(),
      store: new InMemoryStore(),
      now: () => NOW,
    });

    sim.expireSession();
    expect(sim.state.session.expiresAt).toBe(NOW);
  });

  it('issueSession extends expiresAt by the ttl it was given', () => {
    const sim = new SimServer({
      initialState: testState(),
      config: testConfig(),
      store: new InMemoryStore(),
      now: () => NOW,
    });

    sim.issueSession(60_000);
    expect(sim.state.session.expiresAt).toBe(NOW + 60_000);
  });

  it('authenticate still refuses until the lobby has renewed', () => {
    const sim = new SimServer({
      initialState: testState({ expiresAt: NOW }),
      config: testConfig(),
      store: new InMemoryStore(),
      now: () => NOW,
    });

    expect(() => sim.authenticate({ token: sim.state.token })).toThrow(
      expect.objectContaining({ code: 'SESSION_EXPIRED' }) as Error,
    );

    const { token } = sim.issueSession();
    expect(sim.authenticate({ token }).balance).toBe(sim.state.balance);
  });
});
