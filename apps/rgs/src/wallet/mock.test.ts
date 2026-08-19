import { describe, expect, it } from 'vitest';
import type { Minor } from '@slot/protocol';
import { MockWallet } from './mock.js';
import { WalletError } from './provider.js';

/**
 * The wallet seam's semantics, written down — these tests are the specification R2's real
 * provider integration is held to, which is why the subtle cases (replay vs. conflict, the
 * idempotent rollback) get more lines than the happy path.
 */

const minor = (value: number): Minor => value as Minor;

const wallet = () => new MockWallet({ alice: minor(1_000) });

const failure = async (promise: Promise<unknown>): Promise<WalletError> => {
  const caught: unknown = await promise.then(() => undefined).catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(WalletError);
  return caught as WalletError;
};

describe('balances and movements', () => {
  it('debits the stake and answers the post-debit balance', async () => {
    const w = wallet();

    await expect(w.debit('alice', minor(100), 'round-1')).resolves.toBe(900);
    await expect(w.getBalance('alice')).resolves.toBe(900);
  });

  it('credits the win and answers the post-credit balance', async () => {
    const w = wallet();
    await w.debit('alice', minor(100), 'round-1');

    await expect(w.credit('alice', minor(500), 'round-1-win')).resolves.toBe(1_400);
  });

  it('refuses a debit the balance cannot cover, moving nothing', async () => {
    const w = wallet();

    const error = await failure(w.debit('alice', minor(2_000), 'round-1'));

    expect(error.code).toBe('INSUFFICIENT_FUNDS');
    await expect(w.getBalance('alice')).resolves.toBe(1_000);
  });

  it('knows nobody it was not constructed with', async () => {
    const error = await failure(wallet().debit('mallory', minor(1), 'round-1'));

    expect(error.code).toBe('UNKNOWN_PLAYER');
  });
});

describe('idempotency on ref — the reason the seam is shaped this way', () => {
  it('replays a duplicate debit instead of debiting twice', async () => {
    const w = wallet();

    const first = await w.debit('alice', minor(100), 'round-1');
    const again = await w.debit('alice', minor(100), 'round-1');

    expect(again).toBe(first);
    await expect(w.getBalance('alice')).resolves.toBe(900);
  });

  it('replays the recorded answer even after later movements changed the balance', async () => {
    const w = wallet();
    await w.debit('alice', minor(100), 'round-1');
    await w.debit('alice', minor(100), 'round-2');

    // The retry of round-1's debit answers what round-1 was told, not today's balance — the same
    // rule as the game wire's idempotent replay (docs/protocol.md §4).
    await expect(w.debit('alice', minor(100), 'round-1')).resolves.toBe(900);
  });

  it('refuses the same ref carrying different parameters', async () => {
    const w = wallet();
    await w.debit('alice', minor(100), 'round-1');

    const error = await failure(w.debit('alice', minor(200), 'round-1'));

    expect(error.code).toBe('REF_CONFLICT');
    await expect(w.getBalance('alice')).resolves.toBe(900);
  });
});

describe('rollback — the recovery path for a debit whose round never resolved', () => {
  it('returns the stake and answers the restored balance', async () => {
    const w = wallet();
    await w.debit('alice', minor(100), 'round-1');

    await expect(w.rollback('round-1')).resolves.toBe(1_000);
  });

  it('is idempotent: reversing twice is one reversal, replayed', async () => {
    const w = wallet();
    await w.debit('alice', minor(100), 'round-1');
    await w.rollback('round-1');
    await w.debit('alice', minor(100), 'round-2');

    // The replayed answer is the balance the reversal produced, not a second refund and not
    // today's balance.
    await expect(w.rollback('round-1')).resolves.toBe(1_000);
    await expect(w.getBalance('alice')).resolves.toBe(900);
  });

  it('refuses to reverse a credit — that correction is the ledger conversation (R3)', async () => {
    const w = wallet();
    await w.credit('alice', minor(500), 'round-1-win');

    const error = await failure(w.rollback('round-1-win'));

    expect(error.code).toBe('REF_CONFLICT');
  });

  it('refuses a ref it never saw', async () => {
    const error = await failure(wallet().rollback('never-happened'));

    expect(error.code).toBe('UNKNOWN_REF');
  });

  it('accepts a fresh debit on a rolled-back ref — the retry after a rollback takes the stake again', async () => {
    const w = wallet();
    await w.debit('alice', minor(100), 'round-1');
    await w.rollback('round-1');

    // wallet-api.md §3: debit → rollback → debit converges to exactly one standing debit.
    await expect(w.debit('alice', minor(100), 'round-1')).resolves.toBe(900);
    await expect(w.getBalance('alice')).resolves.toBe(900);

    // And the fresh transaction is an ordinary one: its own replay, its own reversibility.
    await expect(w.debit('alice', minor(100), 'round-1')).resolves.toBe(900);
    await expect(w.rollback('round-1')).resolves.toBe(1_000);
  });

  it('does not open a reversed debit ref to a credit — only a debit may reuse it', async () => {
    const w = wallet();
    await w.debit('alice', minor(100), 'round-1');
    await w.rollback('round-1');

    const error = await failure(w.credit('alice', minor(100), 'round-1'));

    expect(error.code).toBe('REF_CONFLICT');
  });
});
