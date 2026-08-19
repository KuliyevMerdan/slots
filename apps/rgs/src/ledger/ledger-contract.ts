import { describe, expect, it } from 'vitest';
import type { Minor, RoundId } from '@slot/protocol';
import { LedgerConflictError, balancesOf, playerDeltaOf } from './ledger.js';
import type { Ledger, Movement } from './ledger.js';

/**
 * The ledger port's semantics, as one suite both implementations run — the store-contract
 * arrangement, applied to the journal. The in-memory ledger *defines* the behaviour and Postgres
 * is held to it. Every rule here is one the money story leans on: the pair of legs, the
 * append-only sequence, and the idempotency that mirrors the wallet's movement for movement.
 */

const PLAYER = 'demo-player';

let minted = 0;
const nextRoundId = (): RoundId =>
  `018c0000-0000-7000-8000-${(minted += 1).toString(16).padStart(12, '0')}`;

const stakeOf = (roundId: RoundId, overrides: Partial<Movement> = {}): Movement => ({
  kind: 'STAKE',
  roundId,
  playerId: PLAYER,
  amount: 100 as Minor,
  ref: roundId,
  at: 1_700_000_000_000,
  ...overrides,
});

const winOf = (roundId: RoundId, overrides: Partial<Movement> = {}): Movement => ({
  kind: 'WIN',
  roundId,
  playerId: PLAYER,
  amount: 500 as Minor,
  ref: `${roundId}:settle`,
  at: 1_700_000_000_001,
  ...overrides,
});

const rollbackOf = (roundId: RoundId, overrides: Partial<Movement> = {}): Movement => ({
  kind: 'ROLLBACK',
  roundId,
  playerId: PLAYER,
  amount: 100 as Minor,
  ref: roundId,
  at: 1_700_000_000_002,
  ...overrides,
});

const conflictOf = async (promise: Promise<unknown>): Promise<LedgerConflictError> => {
  const caught: unknown = await promise.then(() => undefined).catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(LedgerConflictError);
  return caught as LedgerConflictError;
};

export function runLedgerContract(name: string, makeLedger: () => Promise<Ledger>): void {
  describe(`ledger contract · ${name}`, () => {
    it('journals a movement as one entry with two legs, seq monotonic', async () => {
      const ledger = await makeLedger();
      const roundId = nextRoundId();

      await ledger.record(stakeOf(roundId));
      await ledger.record(winOf(roundId));

      const entries = await ledger.entriesFor(roundId);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        kind: 'STAKE',
        debit: 'PLAYER_BALANCE',
        credit: 'GAME_ROUNDS',
        amount: 100,
      });
      expect(entries[1]).toMatchObject({
        kind: 'WIN',
        debit: 'GAME_ROUNDS',
        credit: 'PLAYER_BALANCE',
        amount: 500,
      });
      expect(entries[1]?.seq).toBeGreaterThan(entries[0]?.seq ?? Number.NaN);
    });

    it('replays an identical duplicate — one movement, one entry, however often it is reported', async () => {
      const ledger = await makeLedger();
      const roundId = nextRoundId();

      await ledger.record(stakeOf(roundId));
      await ledger.record(stakeOf(roundId));
      await ledger.record(winOf(roundId));
      await ledger.record(winOf(roundId));

      expect(await ledger.entriesFor(roundId)).toHaveLength(2);
    });

    it('refuses a duplicate ref carrying different parameters — a replay is never a rewrite', async () => {
      const ledger = await makeLedger();
      const roundId = nextRoundId();
      await ledger.record(stakeOf(roundId));
      await ledger.record(winOf(roundId));

      await conflictOf(ledger.record(stakeOf(roundId, { amount: 200 as Minor })));
      await conflictOf(ledger.record(winOf(roundId, { amount: 1 as Minor })));

      expect(await ledger.entriesFor(roundId)).toHaveLength(2);
    });

    it('appends stake → rollback → stake as three movements: a rolled-back ref is stakeable again', async () => {
      const ledger = await makeLedger();
      const roundId = nextRoundId();

      await ledger.record(stakeOf(roundId));
      await ledger.record(rollbackOf(roundId));
      await ledger.record(stakeOf(roundId));

      const entries = await ledger.entriesFor(roundId);
      expect(entries.map((entry) => entry.kind)).toEqual(['STAKE', 'ROLLBACK', 'STAKE']);
      // The corrected history nets to exactly one standing debit.
      expect(playerDeltaOf(entries, PLAYER)).toBe(-100);
    });

    it('replays a duplicate rollback, and refuses a rollback of nothing', async () => {
      const ledger = await makeLedger();
      const roundId = nextRoundId();
      await ledger.record(stakeOf(roundId));
      await ledger.record(rollbackOf(roundId));
      await ledger.record(rollbackOf(roundId));
      expect(await ledger.entriesFor(roundId)).toHaveLength(2);

      await conflictOf(ledger.record(rollbackOf(nextRoundId())));
    });

    it('refuses a rollback that does not match the standing stake', async () => {
      const ledger = await makeLedger();
      const roundId = nextRoundId();
      await ledger.record(stakeOf(roundId));

      await conflictOf(ledger.record(rollbackOf(roundId, { amount: 999 as Minor })));

      expect(await ledger.entriesFor(roundId)).toHaveLength(1);
    });

    it('records a zero-amount win — a feature round can settle with nothing to pay', async () => {
      const ledger = await makeLedger();
      const roundId = nextRoundId();
      await ledger.record(stakeOf(roundId));

      await ledger.record(winOf(roundId, { amount: 0 as Minor }));

      const entries = await ledger.entriesFor(roundId);
      expect(entries[1]).toMatchObject({ kind: 'WIN', amount: 0 });
    });

    it('reads the whole journal in seq order, and scopes it with since', async () => {
      const ledger = await makeLedger();
      const early = nextRoundId();
      const late = nextRoundId();
      await ledger.record(stakeOf(early, { at: 1_000 }));
      await ledger.record(stakeOf(late, { at: 2_000 }));

      const all = await ledger.entries();
      const seqs = all.map((entry) => entry.seq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      expect(all.map((entry) => entry.roundId)).toEqual([early, late]);

      expect((await ledger.entries({ since: 2_000 })).map((e) => e.roundId)).toEqual([late]);
    });

    it('conserves money: every journal folds to accounts that sum to zero', async () => {
      const ledger = await makeLedger();
      const settled = nextRoundId();
      const aborted = nextRoundId();
      await ledger.record(stakeOf(settled));
      await ledger.record(winOf(settled, { amount: 40 as Minor }));
      await ledger.record(stakeOf(aborted));
      await ledger.record(rollbackOf(aborted));

      const balances = balancesOf(await ledger.entries());
      expect(balances.PLAYER_BALANCE + balances.GAME_ROUNDS).toBe(0);
      // And the accounts say what happened: the player is down one settled stake less its win.
      expect(balances.PLAYER_BALANCE).toBe(-60);
      expect(balances.GAME_ROUNDS).toBe(60);
    });
  });
}
