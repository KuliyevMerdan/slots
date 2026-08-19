import { describe, expect, it } from 'vitest';
import type { Minor, RoundId } from '@slot/protocol';
import { isStoreConflict } from './store.js';
import type { RoundStore, StoredRound } from './store.js';

/**
 * The store port's semantics, as one suite both implementations run.
 *
 * The in-memory store *defines* the behaviour and Postgres is held to it — which is the only
 * arrangement under which "the contract suite runs on the memory store" proves anything about a
 * deployment that runs on the database. Every rule here is one the domain leans on: the uniqueness
 * of a round, the insert-only records, the guarded transition, and the recovery/history reads.
 */

const PLAYER = 'demo-player';
const OTHER = 'someone-else';

let minted = 0;
const nextRoundId = (): RoundId =>
  `018a0000-0000-7000-8000-${(minted += 1).toString(16).padStart(12, '0')}`;

const roundOf = (overrides: Partial<StoredRound> = {}): StoredRound => ({
  roundId: nextRoundId(),
  playerId: PLAYER,
  state: 'OPEN',
  stake: 100 as Minor,
  serverSeed: 'contract-server-seed',
  commitment: 'contract-commitment',
  fingerprint: 'fp',
  cumulativeWin: 0 as Minor,
  capped: false,
  steps: 0,
  openedAt: 1_700_000_000_000,
  ...overrides,
});

const conflictOf = async (promise: Promise<unknown>): Promise<string> => {
  const caught: unknown = await promise.then(() => undefined).catch((error: unknown) => error);
  expect(isStoreConflict(caught)).toBe(true);
  return (caught as { conflict: string }).conflict;
};

export function runStoreContract(name: string, makeStore: () => Promise<RoundStore>): void {
  describe(`store contract · ${name}`, () => {
    it('stores and finds a round, and does not invent one', async () => {
      const store = await makeStore();
      const round = roundOf();

      await store.open(round);

      expect(await store.find(round.roundId)).toMatchObject({
        roundId: round.roundId,
        state: 'OPEN',
        stake: 100,
        // The fairness pair survives the round trip: a seed that does not is a round that cannot
        // resolve after a restart, let alone reveal (R4).
        serverSeed: 'contract-server-seed',
        commitment: 'contract-commitment',
      });
      expect(await store.find(nextRoundId())).toBeUndefined();
    });

    it('refuses a duplicate round — that failure is the replay path', async () => {
      const store = await makeStore();
      const round = roundOf();
      await store.open(round);

      expect(await conflictOf(store.open(round))).toBe('DUPLICATE_ROUND');
    });

    it('commits a transition with its records, atomically', async () => {
      const store = await makeStore();
      const round = roundOf();
      await store.open(round);

      await store.commit({
        roundId: round.roundId,
        from: 'OPEN',
        patch: { state: 'RESOLVED', cumulativeWin: 500 as Minor },
        records: [
          {
            roundId: round.roundId,
            call: 'spin',
            step: 0,
            fingerprint: 'fp',
            response: { answer: 42 },
          },
        ],
      });

      expect(await store.find(round.roundId)).toMatchObject({
        state: 'RESOLVED',
        cumulativeWin: 500,
      });
      expect(await store.record(round.roundId, 'spin', 0)).toMatchObject({
        fingerprint: 'fp',
        response: { answer: 42 },
      });
      expect(await store.record(round.roundId, 'spin', 1)).toBeUndefined();
    });

    it('refuses a transition whose precondition no longer holds', async () => {
      const store = await makeStore();
      const round = roundOf();
      await store.open(round);
      await store.commit({
        roundId: round.roundId,
        from: 'OPEN',
        patch: { state: 'RESOLVED' },
        records: [],
      });

      expect(
        await conflictOf(
          store.commit({
            roundId: round.roundId,
            from: 'OPEN',
            patch: { state: 'SETTLED' },
            records: [],
          }),
        ),
      ).toBe('STALE_TRANSITION');
      // The round is exactly where the first transition left it.
      expect((await store.find(round.roundId))?.state).toBe('RESOLVED');
    });

    it('refuses a duplicate record, and the failed commit changes nothing', async () => {
      const store = await makeStore();
      const round = roundOf();
      await store.open(round);
      const record = {
        roundId: round.roundId,
        call: 'spin' as const,
        step: 0,
        fingerprint: 'fp',
        response: { first: true },
      };
      await store.commit({
        roundId: round.roundId,
        from: 'OPEN',
        patch: { state: 'RESOLVED' },
        records: [record],
      });

      expect(
        await conflictOf(
          store.commit({
            roundId: round.roundId,
            from: 'RESOLVED',
            patch: { state: 'SETTLED' },
            records: [{ ...record, response: { second: true } }],
          }),
        ),
      ).toBe('DUPLICATE_RECORD');

      // All or nothing: the transition the failed commit carried must not have happened.
      expect((await store.find(round.roundId))?.state).toBe('RESOLVED');
      expect(await store.record(round.roundId, 'spin', 0)).toMatchObject({
        response: { first: true },
      });
    });

    it('reports the oldest in-flight round as pending, and none when all are settled', async () => {
      const store = await makeStore();
      const first = roundOf({ openedAt: 1_700_000_000_000 });
      const second = roundOf({ openedAt: 1_700_000_000_001 });
      await store.open(first);
      await store.open(second);

      expect((await store.pendingFor(PLAYER))?.roundId).toBe(first.roundId);
      expect(await store.pendingFor(OTHER)).toBeUndefined();

      for (const round of [first, second]) {
        await store.commit({
          roundId: round.roundId,
          from: 'OPEN',
          patch: { state: 'SETTLED' },
          records: [],
        });
      }
      expect(await store.pendingFor(PLAYER)).toBeUndefined();
    });

    it('lists settled rounds newest first, honouring the limit, one player at a time', async () => {
      const store = await makeStore();
      const mine = [roundOf(), roundOf(), roundOf()];
      const theirs = roundOf({ playerId: OTHER });
      for (const round of [...mine, theirs]) {
        await store.open(round);
        await store.commit({
          roundId: round.roundId,
          from: 'OPEN',
          patch: { state: 'SETTLED' },
          records: [],
        });
      }

      const listed = await store.settledFor(PLAYER, 10);
      expect(listed.map((round) => round.roundId)).toEqual(
        [...mine].reverse().map((round) => round.roundId),
      );
      expect(await store.settledFor(PLAYER, 2)).toHaveLength(2);
      expect((await store.settledFor(OTHER, 10)).map((r) => r.roundId)).toEqual([theirs.roundId]);
    });

    it('never lists a round still in flight', async () => {
      const store = await makeStore();
      const open = roundOf();
      await store.open(open);

      expect(await store.settledFor(PLAYER, 10)).toEqual([]);
    });

    it('reports when the newest round opened, per player — the pacing read (R5)', async () => {
      const store = await makeStore();

      expect(await store.lastOpenedAt(PLAYER)).toBeUndefined();

      await store.open(roundOf({ openedAt: 1_700_000_000_000 }));
      await store.open(roundOf({ openedAt: 1_700_000_005_000 }));
      await store.open(roundOf({ playerId: OTHER, openedAt: 1_700_000_009_000 }));

      expect(await store.lastOpenedAt(PLAYER)).toBe(1_700_000_005_000);
      expect(await store.lastOpenedAt(OTHER)).toBe(1_700_000_009_000);
    });
  });
}
