import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Minor } from '@slot/protocol';
import { RemoteWallet } from './remote.js';
import { WalletError } from './provider.js';
import { WalletSim, buildWalletSimApp } from './sim.js';

/**
 * `RemoteWallet` against the wallet sim, over a real socket — the wallet wire proven end to end,
 * and the two §4 failure shapes produced for real: an outage the bounded retry outlives, and a
 * lost confirmation the idempotent ref heals. This pair is what the domain composes in every
 * production-shaped run, so this file is the integration test of the R2 seam itself.
 */

const PLAYER = 'alice';

let sim: WalletSim;
let app: FastifyInstance;
let wallet: RemoteWallet;

beforeEach(async () => {
  sim = new WalletSim({ [PLAYER]: 1_000 as Minor });
  app = buildWalletSimApp(sim);
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  wallet = new RemoteWallet({ baseUrl, timeoutMs: 500, backoffMs: 1 });
});

afterEach(async () => {
  await app.close();
});

const failure = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(() => undefined).catch((error: unknown) => error);

describe('the wire, working', () => {
  it('moves money and reads balances over the socket', async () => {
    await expect(wallet.debit(PLAYER, 100 as Minor, 'round-1')).resolves.toBe(900);
    await expect(wallet.credit(PLAYER, 500 as Minor, 'round-1:settle')).resolves.toBe(1_400);
    await expect(wallet.getBalance(PLAYER)).resolves.toBe(1_400);
    await expect(wallet.rollback('round-1')).resolves.toBe(1_500);
  });

  it('carries a refusal across the wire with its code intact', async () => {
    const error = await failure(wallet.debit(PLAYER, 5_000 as Minor, 'round-1'));

    expect(error).toBeInstanceOf(WalletError);
    expect((error as WalletError).code).toBe('INSUFFICIENT_FUNDS');
    await expect(wallet.getBalance(PLAYER)).resolves.toBe(1_000);
  });
});

describe('the §4 failure shapes, produced for real', () => {
  it('outlives an outage that ends within its bounded retries — nothing moved during it', async () => {
    sim.setFaults({ refuse: true });
    const refused = await failure(wallet.debit(PLAYER, 100 as Minor, 'round-1'));
    expect(refused).toBeInstanceOf(Error);
    expect(refused).not.toBeInstanceOf(WalletError);
    await expect(sim.wallet.getBalance(PLAYER)).resolves.toBe(1_000);

    // The outage ends; the same call, same ref, succeeds as a first attempt.
    sim.setFaults({});
    await expect(wallet.debit(PLAYER, 100 as Minor, 'round-1')).resolves.toBe(900);
  });

  it('heals a lost confirmation by replaying the ref — one debit, however many requests', async () => {
    sim.setFaults({ loseResponses: 1 });

    // The first attempt executes and its answer is eaten; the client's retry replays by ref and
    // gets the recorded balance. The player was debited exactly once.
    await expect(wallet.debit(PLAYER, 100 as Minor, 'round-1')).resolves.toBe(900);
    await expect(sim.wallet.getBalance(PLAYER)).resolves.toBe(900);
  });

  it('heals a lost rollback confirmation the same way', async () => {
    await wallet.debit(PLAYER, 100 as Minor, 'round-1');
    sim.setFaults({ loseResponses: 1 });

    await expect(wallet.rollback('round-1')).resolves.toBe(1_000);
    await expect(sim.wallet.getBalance(PLAYER)).resolves.toBe(1_000);
  });
});
