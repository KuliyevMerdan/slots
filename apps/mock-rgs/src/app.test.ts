import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CORRELATION_HEADER, ProtocolErrorSchema } from '@slot/protocol';
import type { Minor } from '@slot/protocol';
import { SimServer, createSimConfig, createSimState } from '@slot/rgs-sim';
import { buildApp } from './app.js';

/**
 * Driven through `app.inject()` — no port, no sockets, the whole route stack.
 *
 * What is under test is only the part this app owns: routing, status codes, the error body, the
 * correlation id and the enactment of a fault verdict. Nothing here re-tests the round machine or
 * idempotency; those are `@slot/rgs-sim`'s and are proven where they live. A real socket, a real
 * `HttpTransport` and a full round appear once, at the wiring site (`tests/http.test.ts`).
 */

const NOW = 1_700_000_000_000;
const STAKE = 100 as Minor;
const START_BALANCE = 1_000_000 as Minor;
const roundId = (index: number): string =>
  `01890000-0000-7000-8000-${index.toString(16).padStart(12, '0')}`;

const simulator = (devMode = false): SimServer =>
  new SimServer({
    initialState: createSimState({
      serverSeed: 'mock-rgs-test-seed',
      balance: START_BALANCE,
      expiresAt: 4_102_444_800_000,
    }),
    config: createSimConfig({ devMode }),
    now: () => NOW,
  });

const open = (options: { devMode?: boolean; devRoutes?: boolean } = {}) => {
  const sim = simulator(options.devMode ?? false);
  const slept: number[] = [];
  const app = buildApp({
    sim,
    devRoutes: options.devRoutes ?? true,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  apps.push(app);
  return { sim, app, slept };
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const post = (app: FastifyInstance, url: string, payload: unknown, headers = {}) =>
  app.inject({ method: 'POST', url, payload: payload as object, headers });

describe('the four calls', () => {
  it('routes every call in the protocol table', async () => {
    const { sim, app } = open();

    const authenticated = await post(app, '/rgs/authenticate', { token: sim.state.token });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json()).toMatchObject({ balance: START_BALANCE });

    const id = roundId(1);
    const spun = await post(app, '/rgs/spin', { roundId: id, stake: STAKE });
    expect(spun.statusCode).toBe(200);
    expect(spun.json()).toMatchObject({ roundId: id, balance: START_BALANCE - STAKE });

    let next = spun.json<{ next: string }>().next;
    let step = 0;
    while (next === 'FEATURE_SPIN') {
      step += 1;
      const played = await post(app, '/rgs/featureSpin', { roundId: id, step });
      expect(played.statusCode).toBe(200);
      next = played.json<{ next: string }>().next;
    }

    if (next === 'SETTLE') {
      const settled = await post(app, '/rgs/settle', { roundId: id });
      expect(settled.statusCode).toBe(200);
      expect(settled.json()).toMatchObject({ next: 'IDLE' });
    }
  });

  /** The idempotency guarantee, over the wire: one debit, the original bytes back. */
  it('replays a duplicate spin rather than spinning again', async () => {
    const { sim, app } = open();
    const id = roundId(2);

    const first = await post(app, '/rgs/spin', { roundId: id, stake: STAKE });
    const second = await post(app, '/rgs/spin', { roundId: id, stake: STAKE });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(sim.state.balance).toBe(START_BALANCE - STAKE);
  });
});

describe('the error body', () => {
  it('gives a PLAYER error the status of a refusal, not of a mistake', async () => {
    const { app } = open();

    const response = await post(app, '/rgs/spin', { roundId: roundId(3), stake: 37 });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ class: 'PLAYER', code: 'STAKE_NOT_ALLOWED' });
  });

  it('answers a malformed body with SCHEMA_MISMATCH', async () => {
    const { app } = open();

    const response = await app.inject({
      method: 'POST',
      url: '/rgs/spin',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ class: 'FATAL', code: 'SCHEMA_MISMATCH' });
  });

  it('answers a body of the wrong shape with SCHEMA_MISMATCH', async () => {
    const { app } = open();

    const response = await post(app, '/rgs/spin', { roundId: 'not-a-uuid', stake: -5 });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'SCHEMA_MISMATCH' });
  });

  /**
   * The body-size cap, proven rather than configured-and-hoped. Every real request in this protocol
   * is hundreds of bytes; a client that produces more is not this client, and a retry would only
   * send the same payload again — so the refusal is FATAL, not RECOVERABLE.
   */
  it('refuses an oversized body with SCHEMA_MISMATCH, not a retry invitation', async () => {
    const { app } = open();

    const response = await app.inject({
      method: 'POST',
      url: '/rgs/spin',
      headers: { 'content-type': 'application/json' },
      payload: `{"roundId":"${roundId(3)}","stake":100,"clientSeed":"${'x'.repeat(20 * 1024)}"}`,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ class: 'FATAL', code: 'SCHEMA_MISMATCH' });
  });

  /** A client asking for a route this server does not have is built against a different contract. */
  it('answers an unknown route in the protocol error shape', async () => {
    const { app } = open();

    const response = await app.inject({ method: 'POST', url: '/rgs/doubleOrNothing' });

    expect(response.statusCode).toBe(404);
    expect(ProtocolErrorSchema.safeParse(response.json()).success).toBe(true);
  });

  it('refuses forceOutcome when the server is not in dev mode', async () => {
    const { app } = open({ devMode: false });

    const response = await post(app, '/rgs/spin', {
      roundId: roundId(4),
      stake: STAKE,
      forceOutcome: { scenario: 'MAX_WIN' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ class: 'FATAL', code: 'FORCE_OUTCOME_REFUSED' });
  });

  it('honours forceOutcome when it is', async () => {
    const { app } = open({ devMode: true });

    const response = await post(app, '/rgs/spin', {
      roundId: roundId(5),
      stake: STAKE,
      forceOutcome: { scenario: 'FREE_SPINS_TRIGGER' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ next: 'FEATURE_SPIN' });
  });

  it('parses as a ProtocolError, every time', async () => {
    const { app } = open();

    const response = await post(app, '/rgs/settle', { roundId: roundId(9) });

    expect(response.statusCode).toBe(404);
    expect(ProtocolErrorSchema.parse(response.json())).toMatchObject({ code: 'UNKNOWN_ROUND' });
  });
});

describe('the correlation id', () => {
  it('adopts the one the client sent and echoes it back', async () => {
    const { sim, app } = open();

    const response = await post(
      app,
      '/rgs/authenticate',
      { token: sim.state.token },
      { [CORRELATION_HEADER]: 'client-000001' },
    );

    expect(response.headers[CORRELATION_HEADER]).toBe('client-000001');
  });

  /**
   * The simulator numbers its own calls (`sim-000042`) so a replayed seed replays its ids. Over HTTP
   * that is no longer unique between sessions, so the request id is what the body carries.
   */
  it('mints one when the client sent none, and puts it in the error body', async () => {
    const { app } = open();

    const response = await post(app, '/rgs/spin', { roundId: roundId(6), stake: 37 });
    const echoed = response.headers[CORRELATION_HEADER];

    expect(echoed).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.json<{ correlationId: string }>().correlationId).toBe(echoed);
  });
});

describe('faults, enacted on HTTP', () => {
  it('waits out the latency the simulator decided', async () => {
    const { sim, app, slept } = open();
    sim.setFaults({ latencyMs: 220 });

    await post(app, '/rgs/authenticate', { token: sim.state.token });

    expect(slept).toEqual([220]);
  });

  it('maps an injected RECOVERABLE fault onto a 503 with retry advice', async () => {
    const { sim, app } = open();
    sim.setFaults({ errorRates: { WALLET_UNAVAILABLE: 1 } });

    const response = await post(app, '/rgs/spin', { roundId: roundId(7), stake: STAKE });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      class: 'RECOVERABLE',
      code: 'WALLET_UNAVAILABLE',
      retryAfterMs: expect.any(Number) as number,
    });
    // A FAIL is decided before the handler runs: nothing happened, so a retry is a fresh attempt.
    expect(sim.state.balance).toBe(START_BALANCE);
  });

  /**
   * The fault worth having, and the one that only exists over a socket: the round is played, the
   * money moves, and the answer never arrives. `MockTransport` models this as a promise that never
   * settles; here it is a hijacked reply — a connection held open, saying nothing.
   */
  it('drops a response by never answering, having done the work', async () => {
    const { sim, app } = open();
    sim.setFaults({ dropRate: 1 });

    const outcome = await Promise.race([
      post(app, '/rgs/spin', { roundId: roundId(8), stake: STAKE }).then(() => 'answered'),
      new Promise((resolve) => setTimeout(() => resolve('never answered'), 50)),
    ]);

    expect(outcome).toBe('never answered');
    expect(sim.state.balance).toBe(START_BALANCE - STAKE);
    expect(sim.state.rounds).toHaveLength(1);
  });
});

describe('health, readiness and the demo lobby', () => {
  it('reports liveness without saying anything about the game', async () => {
    const { app } = open();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports which game and which math it is serving', async () => {
    const { sim, app } = open();

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.json()).toMatchObject({
      ready: true,
      gameId: sim.config.gameId,
      mathVersion: sim.config.mathVersion,
    });
  });

  it('issues the demo token the operator lobby would (§7)', async () => {
    const { sim, app } = open();

    const response = await app.inject({ method: 'POST', url: '/demo/session' });

    expect(response.json()).toEqual({ token: sim.state.token });
    const authenticated = await post(app, '/rgs/authenticate', response.json());
    expect(authenticated.statusCode).toBe(200);
  });
});

describe('the debug surface', () => {
  it('applies a fault config and reads it back', async () => {
    const { sim, app } = open();

    const applied = await app.inject({
      method: 'PUT',
      url: '/dev/faults',
      payload: { latencyMs: 40, errorRates: { RATE_LIMITED: 0.5 } },
    });

    expect(applied.statusCode).toBe(200);
    expect(sim.faults).toEqual({ latencyMs: 40, errorRates: { RATE_LIMITED: 0.5 } });

    const read = await app.inject({ method: 'GET', url: '/dev/faults' });
    expect(read.json()).toEqual(sim.faults);
  });

  it('refuses a fault config with a key it does not know', async () => {
    const { sim, app } = open();

    const response = await app.inject({
      method: 'PUT',
      url: '/dev/faults',
      payload: { dropRatio: 1 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'SCHEMA_MISMATCH' });
    expect(sim.faults).toEqual({});
  });

  it('refuses a rate outside [0, 1]', async () => {
    const { app } = open();

    const response = await app.inject({
      method: 'PUT',
      url: '/dev/faults',
      payload: { dropRate: 4 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('clears the faults', async () => {
    const { sim, app } = open();
    sim.setFaults({ dropRate: 1 });

    await app.inject({ method: 'DELETE', url: '/dev/faults' });

    expect(sim.faults).toEqual({});
  });

  it('resets the session to the balance the server booted with, keeping the token', async () => {
    const { sim, app } = open();
    const token = sim.state.token;
    await post(app, '/rgs/spin', { roundId: roundId(10), stake: STAKE });
    expect(sim.state.balance).toBe(START_BALANCE - STAKE);

    const response = await app.inject({ method: 'POST', url: '/dev/reset', payload: {} });

    expect(response.json()).toEqual({ token, balance: START_BALANCE });
    expect(sim.state.rounds).toEqual([]);
  });

  it('resets to a stated balance', async () => {
    const { sim, app } = open();

    await app.inject({ method: 'POST', url: '/dev/reset', payload: { balance: 500 } });

    expect(sim.state.balance).toBe(500);
  });

  it('summarises the session without dumping every stored response', async () => {
    const { sim, app } = open();
    await post(app, '/rgs/spin', { roundId: roundId(11), stake: STAKE });

    const response = await app.inject({ method: 'GET', url: '/dev/state' });

    expect(response.json()).toMatchObject({
      balance: sim.state.balance,
      rounds: [{ roundId: roundId(11), stake: STAKE }],
    });
    expect(JSON.stringify(response.json())).not.toContain('stops');
  });

  it('is absent when dev routes are off', async () => {
    const { app } = open({ devRoutes: false });

    const response = await app.inject({ method: 'GET', url: '/dev/faults' });

    expect(response.statusCode).toBe(404);
  });
});

describe('shutdown', () => {
  it('does not wait for a connection that is deliberately hanging', async () => {
    const { sim, app } = open();
    sim.setFaults({ dropRate: 1 });

    void post(app, '/rgs/spin', { roundId: roundId(12), stake: STAKE });
    await vi.waitUntil(() => sim.state.rounds.length === 1);

    await expect(app.close()).resolves.toBeUndefined();
  });
});
