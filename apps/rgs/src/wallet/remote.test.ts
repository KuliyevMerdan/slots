import { describe, expect, it } from 'vitest';
import type { Minor } from '@slot/protocol';
import { RemoteWallet } from './remote.js';
import { WalletError } from './provider.js';

/**
 * The resilience policy, driven without a socket: every failure mode is a scripted fetch, every
 * backoff an injected no-op sleep. The wire itself is proven in `sim.test.ts` over a real
 * connection; this file is about *when the client asks again* — the difference between a wallet
 * that said no and a wallet that could not answer.
 */

interface Scripted {
  status?: number;
  body?: unknown;
  reject?: string;
  /** Never settle until the caller's timeout aborts the attempt. */
  hang?: boolean;
}

const scripted = (steps: Scripted[]) => {
  const calls: { url: string; body: unknown }[] = [];
  const fetch = (
    url: string,
    init: { body: string; signal: AbortSignal },
  ): Promise<{ status: number; ok: boolean; json(): Promise<unknown> }> => {
    calls.push({ url, body: JSON.parse(init.body) });
    const step = steps.shift() ?? { status: 200, body: { balance: 0 } };
    if (step.hang === true) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    }
    if (step.reject !== undefined) return Promise.reject(new Error(step.reject));
    const status = step.status ?? 200;
    return Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      json: () => Promise.resolve(step.body),
    });
  };
  return { fetch, calls };
};

const wallet = (steps: Scripted[], overrides: { attempts?: number; timeoutMs?: number } = {}) => {
  const { fetch, calls } = scripted(steps);
  return {
    calls,
    wallet: new RemoteWallet({
      baseUrl: 'http://wallet.test',
      fetch,
      sleep: () => Promise.resolve(),
      timeoutMs: overrides.timeoutMs ?? 20,
      attempts: overrides.attempts ?? 3,
    }),
  };
};

const failure = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(() => undefined).catch((error: unknown) => error);

describe('the happy path', () => {
  it('posts the call and answers the balance, branded', async () => {
    const { wallet: w, calls } = wallet([{ status: 200, body: { balance: 900 } }]);

    await expect(w.debit('alice', 100 as Minor, 'round-1')).resolves.toBe(900);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://wallet.test/wallet/debit');
    expect(calls[0]?.body).toEqual({ playerId: 'alice', amount: 100, ref: 'round-1' });
  });
});

describe('what gets retried', () => {
  it('retries a 503 and succeeds on the answer that finally arrives', async () => {
    const { wallet: w, calls } = wallet([{ status: 503 }, { status: 200, body: { balance: 900 } }]);

    await expect(w.debit('alice', 100 as Minor, 'round-1')).resolves.toBe(900);
    expect(calls).toHaveLength(2);
  });

  it('retries a network rejection', async () => {
    const { wallet: w, calls } = wallet([
      { reject: 'ECONNREFUSED' },
      { status: 200, body: { balance: 1_000 } },
    ]);

    await expect(w.getBalance('alice')).resolves.toBe(1_000);
    expect(calls).toHaveLength(2);
  });

  it('retries an attempt its own deadline ended', async () => {
    const { wallet: w, calls } = wallet([{ hang: true }, { status: 200, body: { balance: 5 } }], {
      timeoutMs: 5,
    });

    await expect(w.getBalance('alice')).resolves.toBe(5);
    expect(calls).toHaveLength(2);
  });

  it('retries a shape it cannot read — drift is unavailability, not a refusal', async () => {
    const { wallet: w, calls } = wallet([
      { status: 200, body: { unexpected: true } },
      { status: 200, body: { balance: 7 } },
    ]);

    await expect(w.getBalance('alice')).resolves.toBe(7);
    expect(calls).toHaveLength(2);
  });

  it('gives up after the bounded attempts and says how it failed', async () => {
    const { wallet: w, calls } = wallet([{ status: 503 }, { status: 503 }, { status: 503 }]);

    const error = await failure(w.debit('alice', 100 as Minor, 'round-1'));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(WalletError);
    expect((error as Error).message).toContain('after 3 attempts');
    expect(calls).toHaveLength(3);
  });
});

describe('what never gets retried', () => {
  it.each([
    [422, 'INSUFFICIENT_FUNDS'],
    [404, 'UNKNOWN_PLAYER'],
    [409, 'REF_CONFLICT'],
  ] as const)('a %i %s is a refusal — surfaced once, asked once', async (status, code) => {
    const { wallet: w, calls } = wallet([{ status, body: { code, message: 'no' } }]);

    const error = await failure(w.debit('alice', 100 as Minor, 'round-1'));

    expect(error).toBeInstanceOf(WalletError);
    expect((error as WalletError).code).toBe(code);
    expect(calls).toHaveLength(1);
  });

  it('treats a 4xx without a readable wallet code as unavailability instead of guessing', async () => {
    const { wallet: w, calls } = wallet([
      { status: 400, body: 'not json shaped' },
      { status: 200, body: { balance: 3 } },
    ]);

    await expect(w.getBalance('alice')).resolves.toBe(3);
    expect(calls).toHaveLength(2);
  });
});
