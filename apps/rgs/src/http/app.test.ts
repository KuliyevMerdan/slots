import { describe, expect, it } from 'vitest';
import type { CallName } from '@slot/protocol';
import { CALL_NAMES, CORRELATION_HEADER, ProtocolErrorSchema, routeFor } from '@slot/protocol';
import { buildApp } from './app.js';

/**
 * R0's behavioural claims, tested where they live.
 *
 * The contract suite holds this server to the same gate from the outside (through
 * `HttpTransport`, in `tests/contract/`); these tests hold the two claims the suite cannot see
 * from there — that the refusal ordering is validation-first, and that the wire form of the
 * refusal is byte-honest — close enough to the code that a regression names the file.
 */

/** A well-formed request per call — every one of these must get past validation to the stub. */
const WELL_FORMED: Record<CallName, unknown> = {
  authenticate: { token: 'demo-token' },
  spin: { roundId: '01890000-0000-7000-8000-000000000001', stake: 100 },
  featureSpin: { roundId: '01890000-0000-7000-8000-000000000001', step: 1 },
  settle: { roundId: '01890000-0000-7000-8000-000000000001' },
  history: {},
};

const inject = (call: CallName, body: unknown, headers: Record<string, string> = {}) =>
  buildApp().inject({
    method: 'POST',
    url: routeFor(call),
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });

describe('every game route exists and answers NOT_IMPLEMENTED', () => {
  it.each(CALL_NAMES.map((call) => [call] as const))('%s', async (call) => {
    const response = await inject(call, WELL_FORMED[call]);

    expect(response.statusCode).toBe(501);
    // The parse is the assertion: the refusal is a valid protocol error, not a bespoke shape only
    // this repository's tests understand (D10's second rejected alternative).
    const payload = ProtocolErrorSchema.parse(response.json());
    expect(payload.code).toBe('NOT_IMPLEMENTED');
    expect(payload.class).toBe('FATAL');
    // The message names the missing surface and the block that builds it.
    expect(payload.message).toContain(`domain/rounds.${call}`);
  });
});

describe('validation runs before the stub', () => {
  it('refuses a malformed spin as SCHEMA_MISMATCH, never NOT_IMPLEMENTED', async () => {
    const response = await inject('spin', { roundId: 'not-a-uuid', stake: -1 });

    expect(response.statusCode).toBe(400);
    const payload = ProtocolErrorSchema.parse(response.json());
    expect(payload.code).toBe('SCHEMA_MISMATCH');
  });

  it('refuses a body the JSON parser cannot read the same way', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: routeFor('spin'),
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });

    expect(response.statusCode).toBe(400);
    expect(ProtocolErrorSchema.parse(response.json()).code).toBe('SCHEMA_MISMATCH');
  });

  it('refuses an oversized body as SCHEMA_MISMATCH — a payload no honest client produces', async () => {
    const response = await inject('spin', {
      ...(WELL_FORMED.spin as object),
      clientSeed: 'x'.repeat(20_000),
    });

    expect(response.statusCode).toBe(413);
    expect(ProtocolErrorSchema.parse(response.json()).code).toBe('SCHEMA_MISMATCH');
  });
});

describe('the routes the contract does not have', () => {
  it('answers an unknown route with SCHEMA_MISMATCH, keeping it distinguishable from NOT_IMPLEMENTED', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'POST', url: '/rgs/jackpot', payload: {} });

    expect(response.statusCode).toBe(404);
    expect(ProtocolErrorSchema.parse(response.json()).code).toBe('SCHEMA_MISMATCH');
  });

  it('has no /dev surface — a production server is not driveable', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/dev/state' });

    expect(response.statusCode).toBe(404);
  });

  it('has no /demo/session — tokens come from the operator lobby (§7, R5)', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'POST', url: '/demo/session', payload: {} });

    expect(response.statusCode).toBe(404);
  });
});

describe('the operational surface', () => {
  it('is alive before it is useful', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports itself not ready, with the math version a deploy could get wrong', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    const body = response.json() as { ready: boolean; mathVersion: string };
    expect(body.ready).toBe(false);
    expect(body.mathVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('adopts and echoes the client correlation id, in the header and in the body', async () => {
    const response = await inject('settle', WELL_FORMED.settle, {
      [CORRELATION_HEADER]: 'client-cid-42',
    });

    expect(response.headers[CORRELATION_HEADER]).toBe('client-cid-42');
    expect(ProtocolErrorSchema.parse(response.json()).correlationId).toBe('client-cid-42');
  });
});
