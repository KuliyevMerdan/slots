import { describe, expect, it } from 'vitest';
import type { Minor } from '@slot/protocol';
import { MemoryRoundStore } from '../persistence/memory.js';
import { MockWallet } from '../wallet/mock.js';
import { MemoryLedger } from './memory.js';
import { reconcile } from './reconcile.js';

/**
 * The reconciliation job's two axes, each against the failure mode it exists for: balance drift
 * (a movement the journal never learned of) and the orphaned stake (a standing debit whose round
 * never came to exist — the state where the wallet and the ledger *agree* and only the missing
 * round gives the orphan away).
 */

const PLAYER = 'demo-player';
const OPENING = 10_000 as Minor;

let minted = 0;
const nextRoundId = (): string =>
  `018d0000-0000-7000-8000-${(minted += 1).toString(16).padStart(12, '0')}`;

const world = () => ({
  ledger: new MemoryLedger(),
  wallet: new MockWallet({ [PLAYER]: OPENING }),
  store: new MemoryRoundStore(),
});

const openRound = async (store: MemoryRoundStore, roundId: string, stake: Minor): Promise<void> => {
  await store.open({
    roundId,
    playerId: PLAYER,
    state: 'OPEN',
    stake,
    fingerprint: 'fp',
    cumulativeWin: 0 as Minor,
    capped: false,
    steps: 0,
    openedAt: 1_700_000_000_000,
  });
};

describe('reconcile', () => {
  it('answers clean when the wallet, the journal and the store tell one story', async () => {
    const { ledger, wallet, store } = world();
    const roundId = nextRoundId();
    const stake = 100 as Minor;
    const win = 250 as Minor;

    await wallet.debit(PLAYER, stake, roundId);
    await ledger.record({
      kind: 'STAKE',
      roundId,
      playerId: PLAYER,
      amount: stake,
      ref: roundId,
      at: 1,
    });
    await openRound(store, roundId, stake);
    await wallet.credit(PLAYER, win, `${roundId}:settle`);
    await ledger.record({
      kind: 'WIN',
      roundId,
      playerId: PLAYER,
      amount: win,
      ref: `${roundId}:settle`,
      at: 2,
    });

    const report = await reconcile({
      ledger,
      wallet,
      store,
      players: [{ playerId: PLAYER, opening: OPENING }],
    });

    expect(report.clean).toBe(true);
    expect(report.players[0]).toMatchObject({
      ledgerDelta: win - stake,
      expected: OPENING + win - stake,
      actual: OPENING + win - stake,
      drift: 0,
    });
    expect(report.orphans).toEqual([]);
  });

  it('reports a movement the journal never learned of, as signed drift', async () => {
    const { ledger, wallet, store } = world();
    const roundId = nextRoundId();
    // The wallet moved; the ledger write was lost — the crash window the swallow policy accepts.
    await wallet.debit(PLAYER, 300 as Minor, roundId);
    await openRound(store, roundId, 300 as Minor);

    const report = await reconcile({
      ledger,
      wallet,
      store,
      players: [{ playerId: PLAYER, opening: OPENING }],
    });

    expect(report.clean).toBe(false);
    expect(report.players[0]?.drift).toBe(-300);
  });

  it('finds the orphaned stake even though the wallet and the ledger agree', async () => {
    const { ledger, wallet, store } = world();
    const roundId = nextRoundId();
    // Debit confirmed and journaled; the open failed; the rollback could not be delivered. Both
    // sides are down one stake — zero drift — and only the missing round says anything is wrong.
    await wallet.debit(PLAYER, 500 as Minor, roundId);
    await ledger.record({
      kind: 'STAKE',
      roundId,
      playerId: PLAYER,
      amount: 500 as Minor,
      ref: roundId,
      at: 7,
    });

    const report = await reconcile({
      ledger,
      wallet,
      store,
      players: [{ playerId: PLAYER, opening: OPENING }],
    });

    expect(report.clean).toBe(false);
    expect(report.players[0]?.drift).toBe(0);
    expect(report.orphans).toEqual([{ roundId, playerId: PLAYER, amount: 500, at: 7 }]);
  });

  it('does not call a delivered rollback an orphan, nor a round the store still holds', async () => {
    const { ledger, wallet, store } = world();
    const aborted = nextRoundId();
    const inFlight = nextRoundId();

    // Aborted cleanly: debit, rollback, both journaled — net zero, no round, no orphan.
    await wallet.debit(PLAYER, 100 as Minor, aborted);
    await ledger.record({
      kind: 'STAKE',
      roundId: aborted,
      playerId: PLAYER,
      amount: 100 as Minor,
      ref: aborted,
      at: 1,
    });
    await wallet.rollback(aborted);
    await ledger.record({
      kind: 'ROLLBACK',
      roundId: aborted,
      playerId: PLAYER,
      amount: 100 as Minor,
      ref: aborted,
      at: 2,
    });

    // In flight: a standing stake whose round the store knows — a game, not an orphan.
    await wallet.debit(PLAYER, 200 as Minor, inFlight);
    await ledger.record({
      kind: 'STAKE',
      roundId: inFlight,
      playerId: PLAYER,
      amount: 200 as Minor,
      ref: inFlight,
      at: 3,
    });
    await openRound(store, inFlight, 200 as Minor);

    const report = await reconcile({
      ledger,
      wallet,
      store,
      players: [{ playerId: PLAYER, opening: OPENING }],
    });

    expect(report.orphans).toEqual([]);
    expect(report.clean).toBe(true);
  });

  it('scopes the balance axis with since, so an opening that already contains history is not double-counted', async () => {
    const { ledger, wallet, store } = world();
    const before = nextRoundId();
    const after = nextRoundId();

    // History from a previous window: moved and journaled before the baseline was captured.
    await wallet.debit(PLAYER, 1_000 as Minor, before);
    await ledger.record({
      kind: 'STAKE',
      roundId: before,
      playerId: PLAYER,
      amount: 1_000 as Minor,
      ref: before,
      at: 10,
    });
    await openRound(store, before, 1_000 as Minor);
    const opening = await wallet.getBalance(PLAYER);

    // The window under reconciliation.
    await wallet.debit(PLAYER, 200 as Minor, after);
    await ledger.record({
      kind: 'STAKE',
      roundId: after,
      playerId: PLAYER,
      amount: 200 as Minor,
      ref: after,
      at: 20,
    });
    await openRound(store, after, 200 as Minor);

    const report = await reconcile({
      ledger,
      wallet,
      store,
      players: [{ playerId: PLAYER, opening, since: 15 }],
    });

    expect(report.players[0]).toMatchObject({ ledgerDelta: -200, drift: 0 });
    expect(report.clean).toBe(true);
  });
});
