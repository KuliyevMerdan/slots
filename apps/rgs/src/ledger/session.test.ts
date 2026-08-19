import { describe, expect, it } from 'vitest';
import type { Minor, SpinRes } from '@slot/protocol';
import { createGameConfig } from '../config.js';
import { MemoryRoundStore } from '../persistence/memory.js';
import type { RoundStore } from '../persistence/store.js';
import { MockWallet } from '../wallet/mock.js';
import { committingSeedProvider, seededBytes } from '../rng/seeds.js';
import { MemorySessionStore, createSessionService } from '../domain/sessions.js';
import { boundTo, createRoundService } from '../domain/rounds.js';
import { MemoryLedger } from './memory.js';
import { balancesOf } from './ledger.js';
import { reconcile } from './reconcile.js';

/**
 * The R3 gate: a scripted session's ledger sums to zero and reproduces the exact balance history.
 *
 * The session is played through the real domain — dead rounds, a settled win, a full feature, and
 * a spin whose store open fails and is retried — while the script records, movement for movement,
 * the balance the wire reported. Afterwards the journal alone must tell the same story: fold the
 * player legs from the opening balance and every reported figure reappears, in order; the two
 * accounts cancel; the house's take is the stakes less the rollbacks less the wins; and the
 * reconciliation job answers clean.
 */

const NOW = 1_700_000_000_000;
const PLAYER = 'demo-player';
const TOKEN = 'gate-token';
const OPENING = 1_000_000 as Minor;
const STAKE = 100 as Minor;

let minted = 0;
const nextRoundId = (): string =>
  `018e0000-0000-7000-8000-${(minted += 1).toString(16).padStart(12, '0')}`;

const world = () => {
  // Retention far above what the script plays: the orphan scan is sound only while the store
  // still holds every round it opened, which is the deployed (Postgres) shape.
  const store = new MemoryRoundStore({ retention: 10_000 });
  const wallet = new MockWallet({ [PLAYER]: OPENING });
  const ledger = new MemoryLedger();
  const sessionStore = new MemorySessionStore();
  void sessionStore.put(TOKEN, { playerId: PLAYER, currency: 'EUR', expiresAt: 4_102_444_800_000 });
  const sessions = createSessionService({
    store: sessionStore,
    randomBytes: seededBytes('ledger-tokens'),
    now: () => NOW,
  });
  const chaos = { failNextOpen: false, failNextRollback: false };

  const flakyStore: RoundStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'open' && chaos.failNextOpen) {
        return () => {
          chaos.failNextOpen = false;
          return Promise.reject(new Error('store refused the open'));
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as CallableFunction).bind(target) : value;
    },
  });
  const flakyWallet = new Proxy(wallet, {
    get(target, property, receiver) {
      if (property === 'rollback' && chaos.failNextRollback) {
        return () => {
          chaos.failNextRollback = false;
          return Promise.reject(new Error('the rollback could not be delivered'));
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as CallableFunction).bind(target) : value;
    },
  });

  const service = boundTo(
    createRoundService({
      store: flakyStore,
      wallet: flakyWallet,
      ledger,
      sessions,
      seeds: committingSeedProvider(seededBytes('rgs-test-seed')),
      config: createGameConfig(),
      now: () => NOW,
    }),
    { token: TOKEN },
  );
  return { store, wallet, ledger, service, chaos };
};

describe('the R3 gate — the ledger of a scripted session', () => {
  it('sums to zero and reproduces the exact balance history from the entries alone', async () => {
    const { store, wallet, ledger, service, chaos } = world();

    // The balance the wire reported after each journaled movement, in journal order; null where
    // the wire reported nothing (the aborted spin's stake and its rollback).
    const expected: (Minor | null)[] = [];
    let stakes = 0;
    let rollbacks = 0;
    let wins = 0;

    /** Play a spun round to completion, recording what the wire says money did. */
    const finish = async (spin: SpinRes): Promise<'DEAD' | 'WIN' | 'FEATURE'> => {
      const kind =
        spin.next === 'FEATURE_SPIN' ? 'FEATURE' : spin.next === 'SETTLE' ? 'WIN' : 'DEAD';
      let action = spin.next;
      let step = 0;
      while (action === 'FEATURE_SPIN') {
        // Free spins move no money and journal nothing.
        const played = await service.featureSpin({ roundId: spin.roundId, step: (step += 1) });
        action = played.next;
      }
      if (action === 'SETTLE') {
        const settled = await service.settle({ roundId: spin.roundId });
        expected.push(settled.balance);
        wins += settled.totalWin;
      }
      return kind;
    };

    const seen = { DEAD: false, WIN: false, FEATURE: false };
    for (let round = 0; round < 2_000 && !(seen.DEAD && seen.WIN && seen.FEATURE); round += 1) {
      const spin = await service.spin({ roundId: nextRoundId(), stake: STAKE });
      expected.push(spin.balance);
      stakes += STAKE;
      seen[await finish(spin)] = true;
    }
    expect(seen).toEqual({ DEAD: true, WIN: true, FEATURE: true });

    // One spin aborts at the store and is retried with the same roundId — the wire's own rule.
    // Its stake stood for a moment and was rolled back; the wire reported neither movement.
    chaos.failNextOpen = true;
    const abortedId = nextRoundId();
    await expect(service.spin({ roundId: abortedId, stake: STAKE })).rejects.toThrow(
      'store refused the open',
    );
    expected.push(null);
    stakes += STAKE;
    expected.push(null);
    rollbacks += STAKE;

    const retried = await service.spin({ roundId: abortedId, stake: STAKE });
    expected.push(retried.balance);
    stakes += STAKE;
    await finish(retried);

    /* ── the gate proper: the journal alone must retell the session ─────────────────────────── */

    const entries = await ledger.entries();
    expect(entries).toHaveLength(expected.length);

    // Double entry conserves money: across accounts the journal sums to zero.
    const balances = balancesOf(entries);
    expect(balances.PLAYER_BALANCE + balances.GAME_ROUNDS).toBe(0);

    // Folding the player legs from the opening balance reproduces the exact balance history —
    // every figure the wire reported, in order, and nothing the journal cannot explain.
    let running: number = OPENING;
    entries.forEach((entry, index) => {
      if (entry.credit === 'PLAYER_BALANCE') running += entry.amount;
      if (entry.debit === 'PLAYER_BALANCE') running -= entry.amount;
      const reported = expected[index];
      if (reported !== null) expect(running).toBe(reported);
    });
    await expect(wallet.getBalance(PLAYER)).resolves.toBe(running);

    // The accounts say what happened: the house's take is stakes − rollbacks − wins.
    expect(balances.GAME_ROUNDS).toBe(stakes - rollbacks - wins);
    expect(balances.PLAYER_BALANCE).toBe(-(stakes - rollbacks - wins));

    // And the reconciliation job agrees with all of it.
    const report = await reconcile({
      ledger,
      wallet,
      store,
      players: [{ playerId: PLAYER, opening: OPENING }],
    });
    expect(report.clean).toBe(true);
    expect(report.players[0]?.drift).toBe(0);
  });

  it('reports the orphaned stake when the rollback cannot be delivered — and the honest retry heals it', async () => {
    const { store, wallet, ledger, service, chaos } = world();

    // Debit confirmed and journaled, open refused, rollback lost: the wallet and the ledger agree
    // (both down one stake), the round does not exist, and nobody has told the player anything.
    chaos.failNextOpen = true;
    chaos.failNextRollback = true;
    const roundId = nextRoundId();
    await expect(service.spin({ roundId, stake: STAKE })).rejects.toThrow('store refused the open');

    const orphaned = await reconcile({
      ledger,
      wallet,
      store,
      players: [{ playerId: PLAYER, opening: OPENING }],
    });
    expect(orphaned.clean).toBe(false);
    // Zero drift is the point: balance-truing alone can never see this state.
    expect(orphaned.players[0]?.drift).toBe(0);
    expect(orphaned.orphans).toEqual([{ roundId, playerId: PLAYER, amount: STAKE, at: NOW }]);

    // The client's same-roundId retry adopts the standing debit into a real round — the wallet
    // replays the debit, the journal replays the stake, the round opens — and the ledger comes
    // back clean without a correction ever being written.
    const retried = await service.spin({ roundId, stake: STAKE });
    let action = retried.next;
    let step = 0;
    while (action === 'FEATURE_SPIN') {
      const played = await service.featureSpin({ roundId, step: (step += 1) });
      action = played.next;
    }
    if (action === 'SETTLE') await service.settle({ roundId });

    const healed = await reconcile({
      ledger,
      wallet,
      store,
      players: [{ playerId: PLAYER, opening: OPENING }],
    });
    expect(healed.orphans).toEqual([]);
    expect(healed.clean).toBe(true);
  });
});
