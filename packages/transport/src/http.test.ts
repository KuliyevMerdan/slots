import { describe, expect, it, vi } from 'vitest';
import { CORRELATION_HEADER, SlotError } from '@slot/protocol';
import { HttpTransport } from './http.js';
import type { FetchLike, HttpRequestLike, HttpResponseLike } from './http.js';

/**
 * Driven by a fake `fetch`, not by a server.
 *
 * What is under test here is the *classification*: which failure becomes which error class, and what
 * happens when the thing on the other end is not the server we think it is. A real round over a real
 * socket is proven at the wiring site (`tests/http.test.ts`), where an actual `apps/mock-rgs`
 * answers — the two suites deliberately do not overlap.
 */

const ROUND_ID = '01890000-0000-7000-8000-000000000001';

const SETTLED = {
  roundId: ROUND_ID,
  balance: 1_000_500,
  totalWin: 500,
  capped: false,
  next: 'IDLE',
};

interface Answer {
  status?: number;
  body?: unknown;
  /** Sent verbatim, for the bodies a proxy would return. */
  raw?: string;
  headers?: Record<string, string>;
}

const answering = (...answers: Answer[]) => {
  const sent: Array<{ url: string; init: HttpRequestLike }> = [];
  let index = 0;

  const fetch: FetchLike = (url, init) => {
    sent.push({ url, init });
    const answer = answers[Math.min(index, answers.length - 1)] ?? {};
    index += 1;
    const status = answer.status ?? 200;
    const headers = answer.headers ?? {};

    const response: HttpResponseLike = {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      text: () => Promise.resolve(answer.raw ?? JSON.stringify(answer.body ?? SETTLED)),
    };
    return Promise.resolve(response);
  };

  return { fetch, sent };
};

const transportOver = (fetch: FetchLike, correlationId = () => 'cid-1') =>
  new HttpTransport({ baseUrl: 'http://rgs.test/', fetch, correlationId });

describe('HttpTransport', () => {
  it('posts one route per call, and trims the base URL', async () => {
    const { fetch, sent } = answering({});
    const transport = transportOver(fetch);

    await transport.settle({ roundId: ROUND_ID });

    expect(sent[0]?.url).toBe('http://rgs.test/rgs/settle');
    expect(sent[0]?.init.method).toBe('POST');
    expect(JSON.parse(sent[0]?.init.body ?? '')).toEqual({ roundId: ROUND_ID });
  });

  it('carries a correlation id, and the caller can add headers', async () => {
    const { fetch, sent } = answering({});
    const transport = new HttpTransport({
      baseUrl: 'http://rgs.test',
      fetch,
      correlationId: () => 'cid-42',
      headers: () => ({ authorization: 'Bearer demo' }),
    });

    await transport.settle({ roundId: ROUND_ID });

    expect(sent[0]?.init.headers[CORRELATION_HEADER]).toBe('cid-42');
    expect(sent[0]?.init.headers['authorization']).toBe('Bearer demo');
  });

  it('returns the parsed response when the server speaks the protocol', async () => {
    const { fetch } = answering({ body: SETTLED });

    await expect(transportOver(fetch).settle({ roundId: ROUND_ID })).resolves.toEqual(SETTLED);
  });

  /**
   * Both sides validate against the same schema. A response the client cannot read is `FATAL` and
   * not retryable: asking a server that speaks a different protocol a second time cannot help.
   */
  it('rejects a well-formed but wrong-shaped response as SCHEMA_MISMATCH', async () => {
    const { fetch } = answering({ body: { roundId: ROUND_ID, balance: 'lots' } });

    const failure = await transportOver(fetch)
      .settle({ roundId: ROUND_ID })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SlotError);
    expect((failure as SlotError).code).toBe('SCHEMA_MISMATCH');
    expect((failure as SlotError).isRetryable).toBe(false);
  });

  it('replays the protocol error the server sent', async () => {
    const { fetch } = answering({
      status: 422,
      body: {
        class: 'PLAYER',
        code: 'INSUFFICIENT_FUNDS',
        message: 'balance 10 < stake 100',
        correlationId: 'srv-7',
        roundId: ROUND_ID,
      },
    });

    const failure = await transportOver(fetch)
      .spin({ roundId: ROUND_ID, stake: 100 as never })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      errorClass: 'PLAYER',
      correlationId: 'srv-7',
      roundId: ROUND_ID,
    });
  });

  /**
   * The class is derived from the code, never read off the wire — so a server that mislabels a
   * `PLAYER` error as `RECOVERABLE` cannot talk this client into retrying a spin the player cannot
   * afford.
   */
  it('ignores a class the server got wrong', async () => {
    const { fetch } = answering({
      status: 500,
      body: {
        class: 'RECOVERABLE',
        code: 'INSUFFICIENT_FUNDS',
        message: 'mislabelled',
        correlationId: 'srv-8',
      },
    });

    const failure = await transportOver(fetch)
      .spin({ roundId: ROUND_ID, stake: 100 as never })
      .catch((error: unknown) => error);

    expect((failure as SlotError).errorClass).toBe('PLAYER');
    expect((failure as SlotError).isRetryable).toBe(false);
  });

  it.each([
    [503, 'UPSTREAM_UNAVAILABLE', true],
    [504, 'TIMEOUT', true],
    [429, 'RATE_LIMITED', true],
    [404, 'SCHEMA_MISMATCH', false],
  ])('maps a bodyless HTTP %i onto %s', async (status, code, retryable) => {
    const { fetch } = answering({ status, raw: '<html>gateway</html>' });

    const failure = await transportOver(fetch)
      .settle({ roundId: ROUND_ID })
      .catch((error: unknown) => error);

    expect((failure as SlotError).code).toBe(code);
    expect((failure as SlotError).isRetryable).toBe(retryable);
  });

  it('honours Retry-After over its own arithmetic', async () => {
    const { fetch } = answering({ status: 429, raw: 'slow down', headers: { 'retry-after': '2' } });

    const failure = await transportOver(fetch)
      .settle({ roundId: ROUND_ID })
      .catch((error: unknown) => error);

    expect((failure as SlotError).retryAfterMs).toBe(2_000);
  });

  it('turns a dead connection into a RECOVERABLE error, not a thrown TypeError', async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));

    const failure = await transportOver(fetch)
      .settle({ roundId: ROUND_ID })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SlotError);
    expect((failure as SlotError).code).toBe('UPSTREAM_UNAVAILABLE');
    expect((failure as SlotError).isRetryable).toBe(true);
  });

  it('prefers the id the server echoed when reporting an unreadable answer', async () => {
    const { fetch } = answering({
      status: 500,
      raw: 'nope',
      headers: { [CORRELATION_HEADER]: 'srv-99' },
    });

    const failure = await transportOver(fetch)
      .settle({ roundId: ROUND_ID })
      .catch((error: unknown) => error);

    expect((failure as SlotError).correlationId).toBe('srv-99');
  });

  it('hands the abort signal down so a timed-out attempt is actually cancelled', async () => {
    const { fetch, sent } = answering({});
    const controller = new AbortController();

    await transportOver(fetch).settle({ roundId: ROUND_ID }, { signal: controller.signal });

    expect(sent[0]?.init.signal).toBe(controller.signal);
  });
});

describe('the session binding (docs/protocol.md §2.7, D12)', () => {
  const AUTH_RES = {
    session: { playerId: 'demo-player', currency: 'EUR', expiresAt: 4_102_444_800_000 },
    balance: 1_000_000,
    config: {
      gameId: 'demo',
      mathVersion: '1.0.0',
      reels: 3,
      rows: 3,
      strips: [
        ['A', 'B', 'C'],
        ['A', 'B', 'C'],
        ['A', 'B', 'C'],
      ],
      paytable: [{ symbol: 'A', kind: 'LINE', pays: [{ count: 3, multiplier: 10 }] }],
      paylines: [[1, 1, 1]],
      betLevels: [50, 100],
      limits: { minStake: 50, maxStake: 10_000, maxWinMultiplier: 5_000 },
      jurisdiction: 'DEFAULT',
      jurisdictionRules: {
        minSpinIntervalMs: 0,
        turboAllowed: true,
        autoplayAllowed: true,
        realityCheckIntervalMs: 0,
      },
      devMode: false,
    },
  };

  it('remembers the token authenticate carried and binds every later call with it', async () => {
    const { fetch, sent } = answering({ body: AUTH_RES }, { body: SETTLED });
    const transport = transportOver(fetch);

    await transport.authenticate({ token: 'session-token-1' });
    await transport.settle({ roundId: ROUND_ID });

    // The establishing call itself carries no binding — the token is in its body.
    expect(sent[0]?.init.headers['authorization']).toBeUndefined();
    expect(sent[1]?.init.headers['authorization']).toBe('Bearer session-token-1');
  });

  it('sends nothing before any authenticate has succeeded', async () => {
    const { fetch, sent } = answering({ body: SETTLED });

    await transportOver(fetch).settle({ roundId: ROUND_ID });

    expect(sent[0]?.init.headers['authorization']).toBeUndefined();
  });

  it('does not adopt a token the server refused', async () => {
    const { fetch, sent } = answering(
      { body: AUTH_RES },
      {
        status: 401,
        body: {
          class: 'PLAYER',
          code: 'SESSION_EXPIRED',
          message: 'the token is not valid for this session',
          correlationId: 'srv-1',
        },
      },
      { body: SETTLED },
    );
    const transport = transportOver(fetch);

    await transport.authenticate({ token: 'good-token' });
    await expect(transport.authenticate({ token: 'bad-token' })).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
    await transport.settle({ roundId: ROUND_ID });

    expect(sent[2]?.init.headers['authorization']).toBe('Bearer good-token');
  });

  it('re-binds on a renewal — the fresh token replaces the old', async () => {
    const { fetch, sent } = answering({ body: AUTH_RES }, { body: AUTH_RES }, { body: SETTLED });
    const transport = transportOver(fetch);

    await transport.authenticate({ token: 'first' });
    await transport.authenticate({ token: 'renewed' });
    await transport.settle({ roundId: ROUND_ID });

    expect(sent[2]?.init.headers['authorization']).toBe('Bearer renewed');
  });

  it('lets a caller-supplied header win over the remembered binding', async () => {
    const { fetch, sent } = answering({ body: AUTH_RES }, { body: SETTLED });
    const transport = new HttpTransport({
      baseUrl: 'http://rgs.test',
      fetch,
      correlationId: () => 'cid-1',
      headers: () => ({ authorization: 'Bearer operator-managed' }),
    });

    await transport.authenticate({ token: 'remembered' });
    await transport.settle({ roundId: ROUND_ID });

    expect(sent[1]?.init.headers['authorization']).toBe('Bearer operator-managed');
  });
});
