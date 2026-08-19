import { describe, expect, it } from 'vitest';
import type { CallName, Minor } from '@slot/protocol';
import {
  AuthenticateResSchema,
  CALL_NAMES,
  CORRELATION_HEADER,
  ProtocolErrorSchema,
  SpinResSchema,
  routeFor,
} from '@slot/protocol';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { createGameConfig } from '../config.js';
import { createRoundService, notImplementedRounds } from '../domain/rounds.js';
import { SingleSessionHost } from '../domain/sessions.js';
import { staticSeedProvider } from '../rng/seeds.js';
import { MemoryRoundStore } from '../persistence/memory.js';
import { MockWallet } from '../wallet/mock.js';

/**
 * The HTTP binding's own claims, tested where they live. The contract suite proves the wire
 * behaviour from outside (through `HttpTransport`); these tests hold what the suite cannot see —
 * that validation runs before the domain is reached, that the stubbed composition still refuses
 * honestly (the R0 gate, kept green because taking an endpoint dark again must stay tested), and
 * that the operational surface tells the truth about which composition it is.
 */

const NOW = 1_700_000_000_000;
const TOKEN = 'app-test-token';

/** A well-formed request per call — every one of these must get past validation to the domain. */
const WELL_FORMED: Record<CallName, unknown> = {
  authenticate: { token: TOKEN },
  spin: { roundId: '01890000-0000-7000-8000-000000000001', stake: 100 },
  featureSpin: { roundId: '01890000-0000-7000-8000-000000000001', step: 1 },
  settle: { roundId: '01890000-0000-7000-8000-000000000001' },
  history: {},
};

const stubApp = (): FastifyInstance => buildApp({ rounds: notImplementedRounds(), ready: false });

const realApp = (): FastifyInstance => {
  const sessions = new SingleSessionHost();
  sessions.issue(TOKEN, {
    playerId: 'demo-player',
    currency: 'EUR',
    expiresAt: 4_102_444_800_000,
  });
  return buildApp({
    rounds: createRoundService({
      store: new MemoryRoundStore(),
      wallet: new MockWallet({ 'demo-player': 1_000_000 as Minor }),
      sessions,
      seeds: staticSeedProvider('app-test-seed'),
      config: createGameConfig(),
      now: () => NOW,
    }),
  });
};

const inject = (
  app: FastifyInstance,
  call: CallName,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method: 'POST',
    url: routeFor(call),
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });

describe('the stubbed composition still refuses honestly (the R0 gate, kept)', () => {
  it.each(CALL_NAMES.map((call) => [call] as const))('%s — NOT_IMPLEMENTED', async (call) => {
    const response = await inject(stubApp(), call, WELL_FORMED[call]);

    expect(response.statusCode).toBe(501);
    const payload = ProtocolErrorSchema.parse(response.json());
    expect(payload.code).toBe('NOT_IMPLEMENTED');
    expect(payload.class).toBe('FATAL');
    expect(payload.message).toContain(`domain/rounds.${call}`);
  });

  it('reports itself not ready', async () => {
    const response = await stubApp().inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect((response.json() as { ready: boolean }).ready).toBe(false);
  });
});

describe('validation runs before the domain', () => {
  it('refuses a malformed spin as SCHEMA_MISMATCH on both compositions', async () => {
    for (const app of [stubApp(), realApp()]) {
      const response = await inject(app, 'spin', { roundId: 'not-a-uuid', stake: -1 });

      expect(response.statusCode).toBe(400);
      expect(ProtocolErrorSchema.parse(response.json()).code).toBe('SCHEMA_MISMATCH');
    }
  });

  it('refuses a body the JSON parser cannot read the same way', async () => {
    const response = await stubApp().inject({
      method: 'POST',
      url: routeFor('spin'),
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });

    expect(response.statusCode).toBe(400);
    expect(ProtocolErrorSchema.parse(response.json()).code).toBe('SCHEMA_MISMATCH');
  });

  it('refuses an oversized body as SCHEMA_MISMATCH — a payload no honest client produces', async () => {
    const response = await inject(stubApp(), 'spin', {
      ...(WELL_FORMED.spin as object),
      clientSeed: 'x'.repeat(20_000),
    });

    expect(response.statusCode).toBe(413);
    expect(ProtocolErrorSchema.parse(response.json()).code).toBe('SCHEMA_MISMATCH');
  });
});

describe('the real composition plays', () => {
  it('authenticates and spins over the wire, answering shapes the schemas accept', async () => {
    const app = realApp();

    const authenticated = await inject(app, 'authenticate', { token: TOKEN });
    expect(authenticated.statusCode).toBe(200);
    const session = AuthenticateResSchema.parse(authenticated.json());
    expect(session.balance).toBe(1_000_000);

    const spun = await inject(app, 'spin', WELL_FORMED.spin);
    expect(spun.statusCode).toBe(200);
    const spin = SpinResSchema.parse(spun.json());
    expect(spin.balance).toBe(1_000_000 - 100);
  });

  it('reports itself ready, with the math version a deploy could get wrong', async () => {
    const response = await realApp().inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { ready: boolean; mathVersion: string };
    expect(body.ready).toBe(true);
    expect(body.mathVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('the routes the contract does not have', () => {
  it('answers an unknown route with SCHEMA_MISMATCH, keeping it distinguishable from NOT_IMPLEMENTED', async () => {
    const response = await stubApp().inject({ method: 'POST', url: '/rgs/jackpot', payload: {} });

    expect(response.statusCode).toBe(404);
    expect(ProtocolErrorSchema.parse(response.json()).code).toBe('SCHEMA_MISMATCH');
  });

  it('has no /dev surface — a production server is not driveable', async () => {
    const response = await stubApp().inject({ method: 'GET', url: '/dev/state' });

    expect(response.statusCode).toBe(404);
  });

  it('has no /demo/session — tokens come from the operator lobby (§7, R5)', async () => {
    const response = await stubApp().inject({
      method: 'POST',
      url: '/demo/session',
      payload: {},
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('the operational surface', () => {
  it('is alive whichever composition it is', async () => {
    const response = await stubApp().inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('adopts and echoes the client correlation id, in the header and in the body', async () => {
    const response = await inject(stubApp(), 'settle', WELL_FORMED.settle, {
      [CORRELATION_HEADER]: 'client-cid-42',
    });

    expect(response.headers[CORRELATION_HEADER]).toBe('client-cid-42');
    expect(ProtocolErrorSchema.parse(response.json()).correlationId).toBe('client-cid-42');
  });
});
