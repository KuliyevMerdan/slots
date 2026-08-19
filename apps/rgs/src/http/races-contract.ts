import { describe, expect, it } from 'vitest';
import type { CallName, Minor, SettleRes, SpinRes } from '@slot/protocol';
import { routeFor } from '@slot/protocol';
import { buildApp } from './app.js';
import { createGameConfig } from '../config.js';
import { createRoundService } from '../domain/rounds.js';
import { MemorySessionStore, createSessionService } from '../domain/sessions.js';
import type { Ledger } from '../ledger/ledger.js';
import type { RoundStore } from '../persistence/store.js';
import { committingSeedProvider, seededBytes } from '../rng/seeds.js';
import { MockWallet } from '../wallet/mock.js';

/**
 * Idempotency under races, over the real HTTP binding — R7's load-correctness gate.
 *
 * Everything the domain promises about duplicates was proven sequentially by the unit and
 * contract suites; production duplicates are not sequential. Here every request in a case is in
 * flight *at once*, so the guarantees have to come from where they claim to live — the store's
 * insert-only records and compare-and-swap transitions, the ledger's per-ref verdict, the
 * wallet's idempotent refs — not from the accident of one-at-a-time test traffic. Run against
 * both stores: the memory twin always, Postgres in `postgres.test.ts` (in CI on every push),
 * where the races land on real row locks and real unique violations.
 */

const NOW = 1_700_000_000_000;
const TOKEN = 'races-test-token';
const PLAYER = 'demo-player';
const OPENING = 100_000_000 as Minor;

let minted = 0;
const nextRoundId = (): string =>
  `018d0000-0000-7000-8000-${(minted += 1).toString(16).padStart(12, '0')}`;

export interface RaceDeps {
  store: RoundStore;
  ledger: Ledger;
}

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

const world = (deps: RaceDeps, label: string) => {
  const sessionStore = new MemorySessionStore();
  void sessionStore.put(TOKEN, {
    playerId: PLAYER,
    currency: 'EUR',
    expiresAt: 4_102_444_800_000,
  });
  const app = buildApp({
    rounds: createRoundService({
      store: deps.store,
      wallet: new MockWallet({ [PLAYER]: OPENING }),
      ledger: deps.ledger,
      sessions: createSessionService({
        store: sessionStore,
        randomBytes: seededBytes(`races-tokens-${label}`),
        now: () => NOW,
      }),
      seeds: committingSeedProvider(seededBytes(`races-seed-${label}`)),
      config: createGameConfig(),
      now: () => NOW,
    }),
    now: () => NOW,
  });

  const call = async (name: CallName, body: unknown): Promise<Answer> => {
    const response = await app.inject({
      method: 'POST',
      url: routeFor(name),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      payload: JSON.stringify(body),
    });
    return { status: response.statusCode, body: response.json() as Record<string, unknown> };
  };

  const balance = async (): Promise<number> => {
    const authed = await call('authenticate', { token: TOKEN });
    expect(authed.status).toBe(200);
    return authed.body['balance'] as number;
  };

  return { app, call, balance };
};

/** Play one full round to its close; answer what the round cost and what it credited. */
const playRound = async (
  w: ReturnType<typeof world>,
  stake: number,
): Promise<{ staked: number; credited: number }> => {
  const roundId = nextRoundId();
  const spun = await w.call('spin', { roundId, stake });
  expect(spun.status).toBe(200);
  const spin = spun.body as unknown as SpinRes;

  let next: string = spin.next;
  let step = 0;
  while (next === 'FEATURE_SPIN') {
    step += 1;
    const feature = await w.call('featureSpin', { roundId, step });
    expect(feature.status).toBe(200);
    next = feature.body['next'] as string;
  }
  if (next === 'SETTLE') {
    const settled = await w.call('settle', { roundId });
    expect(settled.status).toBe(200);
    return { staked: stake, credited: (settled.body as unknown as SettleRes).totalWin };
  }
  // A dead round settled atomically — nothing was ever owed.
  return { staked: stake, credited: 0 };
};

export function runRaceSuite(name: string, makeDeps: () => Promise<RaceDeps>): void {
  describe(`idempotency under races · ${name}`, () => {
    it('collapses identical concurrent spins to one round, one debit, one answer', async () => {
      const deps = await makeDeps();
      const w = world(deps, `identical-${name}`);
      const roundId = nextRoundId();

      const answers = await Promise.all(
        Array.from({ length: 24 }, () => w.call('spin', { roundId, stake: 100 })),
      );

      const first = answers[0] as Answer;
      expect(first.status).toBe(200);
      for (const answer of answers) {
        expect(answer.status).toBe(200);
        // Identical to the byte: every racer was answered with the one recorded outcome.
        expect(answer.body).toEqual(first.body);
      }

      // One debit at the wallet, however many requests went out: the balance moved exactly once.
      expect(await w.balance()).toBe(OPENING - 100);

      // One movement, one journal entry — the ledger's verdict held under the same race.
      const stakes = (await deps.ledger.entriesFor(roundId)).filter(
        (entry) => entry.kind === 'STAKE',
      );
      expect(stakes).toHaveLength(1);
      expect(stakes[0]?.amount).toBe(100);
    });

    it('lets exactly one fingerprint win a conflicting race; every other racer is ROUND_CONFLICT', async () => {
      const deps = await makeDeps();
      const w = world(deps, `conflict-${name}`);
      const roundId = nextRoundId();

      const answers = await Promise.all([
        ...Array.from({ length: 8 }, () => w.call('spin', { roundId, stake: 100 })),
        ...Array.from({ length: 8 }, () => w.call('spin', { roundId, stake: 200 })),
      ]);

      const winners = answers.filter((answer) => answer.status === 200);
      const losers = answers.filter((answer) => answer.status !== 200);

      // One family wins whole — the recorded fingerprint answers its own retries and no others.
      expect(winners).toHaveLength(8);
      expect(losers).toHaveLength(8);
      const won = winners[0] as Answer;
      for (const winner of winners) expect(winner.body).toEqual(won.body);
      for (const loser of losers) expect(loser.body['code']).toBe('ROUND_CONFLICT');

      // The one standing debit is the winner's stake — whichever family won the race.
      const stakes = (await deps.ledger.entriesFor(roundId)).filter(
        (entry) => entry.kind === 'STAKE',
      );
      expect(stakes).toHaveLength(1);
      expect(await w.balance()).toBe(OPENING - (stakes[0]?.amount ?? 0));
    });

    it('credits a resolved round exactly once under concurrent settles', async () => {
      const deps = await makeDeps();
      const w = world(deps, `settles-${name}`);

      // Play until a round resolves owing money, then leave it unsettled for the storm.
      let roundId = '';
      let owed = 0;
      for (let attempt = 0; attempt < 60 && owed === 0; attempt += 1) {
        roundId = nextRoundId();
        const spun = await w.call('spin', { roundId, stake: 100 });
        expect(spun.status).toBe(200);
        const spin = spun.body as unknown as SpinRes;
        let next: string = spin.next;
        let step = 0;
        while (next === 'FEATURE_SPIN') {
          step += 1;
          const feature = await w.call('featureSpin', { roundId, step });
          next = feature.body['next'] as string;
        }
        if (next === 'SETTLE') owed = spin.roundWin > 0 ? spin.roundWin : 1;
      }
      expect(owed).toBeGreaterThan(0);

      const before = await w.balance();
      const answers = await Promise.all(
        Array.from({ length: 16 }, () => w.call('settle', { roundId })),
      );

      const first = answers[0] as Answer;
      expect(first.status).toBe(200);
      for (const answer of answers) {
        expect(answer.status).toBe(200);
        expect(answer.body).toEqual(first.body);
      }

      // Credited once: the balance moved by exactly the round's payable total.
      const credited = (first.body as unknown as SettleRes).totalWin;
      expect(await w.balance()).toBe(before + credited);

      const wins = (await deps.ledger.entriesFor(roundId)).filter((entry) => entry.kind === 'WIN');
      expect(wins).toHaveLength(1);
    });

    it('keeps the balance exact under a storm of parallel rounds', async () => {
      const w = world(await makeDeps(), `storm-${name}`);

      const rounds = await Promise.all(Array.from({ length: 20 }, () => playRound(w, 100)));

      const staked = rounds.reduce((sum, round) => sum + round.staked, 0);
      const credited = rounds.reduce((sum, round) => sum + round.credited, 0);
      expect(await w.balance()).toBe(OPENING - staked + credited);

      // Every round came home: nothing is left open for recovery to find.
      const authed = await w.call('authenticate', { token: TOKEN });
      expect(authed.body['pendingRound']).toBeUndefined();
    });
  });
}
