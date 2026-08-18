import { describe, expect, it, vi } from 'vitest';
import type { AuthenticateRes, ErrorCode, SpinReq, SpinRes } from '@slot/protocol';
import { SlotError } from '@slot/protocol';
import { ResilientTransport, withRetry } from './retry.js';
import type { RetryAttempt, ResilientTransportOptions } from './retry.js';
import type { RgsTransport } from './transport.js';

/**
 * The policy is tested against a stub, not a server.
 *
 * That is the reason it is a decorator: "retry only RECOVERABLE, reuse the request, never leak raw
 * network noise" are rules about failure, and the only way to test rules about failure is to be able
 * to fail on demand and in order.
 */

type Attempt = () => Promise<unknown>;

/** A transport whose every call takes its answer from a queue. */
class StubTransport implements RgsTransport {
  readonly requests: unknown[] = [];
  #queue: Attempt[] = [];

  queue(...attempts: Attempt[]): void {
    this.#queue = [...attempts];
  }

  get remaining(): number {
    return this.#queue.length;
  }

  get calls(): number {
    return this.requests.length;
  }

  #next(request: unknown): Promise<never> {
    this.requests.push(request);
    const attempt = this.#queue.shift();
    if (attempt === undefined) throw new Error('the stub ran out of queued answers');
    return attempt() as Promise<never>;
  }

  authenticate(request: unknown): Promise<AuthenticateRes> {
    return this.#next(request);
  }

  spin(request: unknown): Promise<SpinRes> {
    return this.#next(request);
  }

  featureSpin(request: unknown): Promise<never> {
    return this.#next(request);
  }

  settle(request: unknown): Promise<never> {
    return this.#next(request);
  }
}

const fails =
  (code: ErrorCode, context?: { retryAfterMs?: number }): Attempt =>
  () =>
    Promise.reject(new SlotError(code, `injected ${code}`, context));

const succeeds =
  (value: unknown): Attempt =>
  () =>
    Promise.resolve(value);

const hangs = (): Attempt => () => new Promise<never>(() => {});

const SPIN: SpinReq = { roundId: 'round-1', stake: 100 } as SpinReq;

/**
 * A transport with a flat, predictable policy: no clock, 100 ms base, no jitter. Each test overrides
 * only what it is about — note that `policy` is *merged*, not replaced, which is a mistake worth not
 * making twice: spreading it wholesale silently reinstates the production defaults underneath.
 */
const wrap = (inner: RgsTransport, options: ResilientTransportOptions = {}) =>
  new ResilientTransport(inner, {
    sleep: vi.fn(async (_ms: number) => {}),
    random: () => 0.5,
    ...options,
    policy: {
      timeoutMs: 0,
      maxRetries: 3,
      baseDelayMs: 100,
      factor: 2,
      maxDelayMs: 5_000,
      jitter: 0,
      ...options.policy,
    },
  });

describe('retrying', () => {
  it('passes a successful call straight through', async () => {
    const stub = new StubTransport();
    stub.queue(succeeds({ balance: 100 }));

    await expect(wrap(stub).spin(SPIN)).resolves.toEqual({ balance: 100 });
    expect(stub.calls).toBe(1);
  });

  it('retries a RECOVERABLE failure and returns the eventual success', async () => {
    const stub = new StubTransport();
    stub.queue(fails('WALLET_UNAVAILABLE'), fails('TIMEOUT'), succeeds({ balance: 42 }));

    await expect(wrap(stub).spin(SPIN)).resolves.toEqual({ balance: 42 });
    expect(stub.calls).toBe(3);
  });

  /**
   * Rule 2, and the reason a network failure mid-spin is not a money problem: the retry re-sends the
   * identical request, so the `roundId` is unchanged and the server replays instead of spinning
   * again. A transport that minted a fresh id here would debit the player twice.
   */
  it('re-sends the identical request every time', async () => {
    const stub = new StubTransport();
    stub.queue(fails('TIMEOUT'), fails('TIMEOUT'), succeeds({}));

    await wrap(stub).spin(SPIN);

    expect(stub.requests).toHaveLength(3);
    for (const request of stub.requests) expect(request).toBe(SPIN);
  });

  it('gives up after the configured number of retries', async () => {
    const stub = new StubTransport();
    stub.queue(...Array.from({ length: 4 }, () => fails('RATE_LIMITED')));

    await expect(wrap(stub).spin(SPIN)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    // One attempt plus three retries.
    expect(stub.calls).toBe(4);
  });

  it('tries exactly once when retries are disabled', async () => {
    const stub = new StubTransport();
    stub.queue(fails('TIMEOUT'));

    await expect(
      wrap(stub, { policy: { timeoutMs: 0, maxRetries: 0 } }).spin(SPIN),
    ).rejects.toThrow();
    expect(stub.calls).toBe(1);
  });

  describe('classes that must not be retried', () => {
    it.each(['INSUFFICIENT_FUNDS', 'STAKE_NOT_ALLOWED', 'LIMIT_REACHED'] as ErrorCode[])(
      'gives up immediately on %s — the player is the reason, and retrying changes nothing',
      async (code) => {
        const stub = new StubTransport();
        stub.queue(fails(code));

        await expect(wrap(stub).spin(SPIN)).rejects.toMatchObject({ code, errorClass: 'PLAYER' });
        expect(stub.calls).toBe(1);
      },
    );

    it.each(['ROUND_CONFLICT', 'SCHEMA_MISMATCH', 'ILLEGAL_TRANSITION'] as ErrorCode[])(
      'gives up immediately on %s — hammering an endpoint cannot fix a disagreement about reality',
      async (code) => {
        const stub = new StubTransport();
        stub.queue(fails(code));

        await expect(wrap(stub).spin(SPIN)).rejects.toMatchObject({ code, errorClass: 'FATAL' });
        expect(stub.calls).toBe(1);
      },
    );
  });
});

describe('backoff', () => {
  it('grows exponentially', async () => {
    const stub = new StubTransport();
    stub.queue(fails('TIMEOUT'), fails('TIMEOUT'), fails('TIMEOUT'), succeeds({}));
    const sleep = vi.fn(async (_ms: number) => {});

    await wrap(stub, { sleep }).spin(SPIN);

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 400]);
  });

  it('never exceeds the ceiling', async () => {
    const stub = new StubTransport();
    stub.queue(...Array.from({ length: 5 }, () => fails('TIMEOUT')), succeeds({}));
    const sleep = vi.fn(async (_ms: number) => {});

    await wrap(stub, { sleep, policy: { maxRetries: 5, maxDelayMs: 250 } }).spin(SPIN);

    for (const [ms] of sleep.mock.calls) expect(ms).toBeLessThanOrEqual(250);
  });

  it('applies jitter within the configured band', async () => {
    const stub = new StubTransport();
    stub.queue(fails('TIMEOUT'), succeeds({}));
    const sleep = vi.fn(async (_ms: number) => {});

    await wrap(stub, { sleep, policy: { jitter: 0.5 }, random: () => 0 }).spin(SPIN);

    // jitter 0.5 with the lowest possible roll: half the nominal 100 ms.
    expect(sleep).toHaveBeenCalledWith(50);
  });

  /**
   * A server that says `retryAfterMs` knows something the client does not — a rate-limit window, a
   * wallet coming back at a known time. Second-guessing it is how a client turns a brief outage into
   * a sustained one.
   */
  it('obeys the server’s retryAfterMs over its own arithmetic', async () => {
    const stub = new StubTransport();
    stub.queue(fails('RATE_LIMITED', { retryAfterMs: 2_500 }), succeeds({}));
    const sleep = vi.fn(async (_ms: number) => {});

    await wrap(stub, { sleep }).spin(SPIN);

    expect(sleep).toHaveBeenCalledWith(2_500);
  });

  it('reports every retry, so a log can show what the player never saw', async () => {
    const stub = new StubTransport();
    stub.queue(fails('TIMEOUT'), fails('WALLET_UNAVAILABLE'), succeeds({}));
    const seen: RetryAttempt[] = [];

    await wrap(stub, { onRetry: (attempt) => seen.push(attempt) }).spin(SPIN);

    expect(seen.map((entry) => [entry.call, entry.attempt, entry.error.code])).toEqual([
      ['spin', 1, 'TIMEOUT'],
      ['spin', 2, 'WALLET_UNAVAILABLE'],
    ]);
  });
});

describe('the timeout', () => {
  /**
   * The answer to a dropped response. `MockTransport` models one as a promise that never settles,
   * which is honest and, on its own, a hang — this is the layer that ends the wait.
   */
  it('ends a call that never answers, and retries it', async () => {
    const stub = new StubTransport();
    stub.queue(hangs(), succeeds({ balance: 7 }));

    const transport = wrap(stub, { policy: { timeoutMs: 5, maxRetries: 1 } });

    await expect(transport.spin(SPIN)).resolves.toEqual({ balance: 7 });
    expect(stub.calls).toBe(2);
  });

  it('surfaces a TIMEOUT once the retries are spent', async () => {
    const stub = new StubTransport();
    stub.queue(hangs(), hangs());

    await expect(
      wrap(stub, { policy: { timeoutMs: 5, maxRetries: 1 } }).spin(SPIN),
    ).rejects.toMatchObject({ code: 'TIMEOUT', errorClass: 'RECOVERABLE' });
  });

  it('does not fire for a call that answers in time', async () => {
    const stub = new StubTransport();
    stub.queue(succeeds({ ok: true }));

    await expect(
      wrap(stub, { policy: { timeoutMs: 1_000 } }).authenticate({ token: 't' }),
    ).resolves.toEqual({ ok: true });
  });
});

describe('classification', () => {
  /**
   * Rule 3. A rejected `fetch` is a `TypeError`; an aborted request is a `DOMException`. The engine
   * must never have to know that, so everything becomes a classified error at this boundary.
   */
  it('turns raw network noise into a RECOVERABLE SlotError', async () => {
    const stub = new StubTransport();
    stub.queue(() => Promise.reject(new TypeError('Failed to fetch')), succeeds({ balance: 1 }));

    await expect(wrap(stub).spin(SPIN)).resolves.toEqual({ balance: 1 });
  });

  it('keeps the original error as the cause', async () => {
    const original = new TypeError('Failed to fetch');
    const stub = new StubTransport();
    stub.queue(...Array.from({ length: 4 }, () => () => Promise.reject(original)));

    const failure = await wrap(stub)
      .spin(SPIN)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SlotError);
    expect((failure as SlotError).code).toBe('UPSTREAM_UNAVAILABLE');
    expect((failure as SlotError).cause).toBe(original);
  });

  it('leaves an already-classified error alone', async () => {
    const stub = new StubTransport();
    stub.queue(fails('SESSION_EXPIRED'));

    await expect(wrap(stub).spin(SPIN)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
      errorClass: 'PLAYER',
    });
  });
});

describe('withRetry', () => {
  it('wraps any transport', async () => {
    const stub = new StubTransport();
    stub.queue(succeeds({ ok: true }));

    await expect(
      withRetry(stub, { sleep: async () => {} }).settle({ roundId: 'r' }),
    ).resolves.toEqual({ ok: true });
  });
});
