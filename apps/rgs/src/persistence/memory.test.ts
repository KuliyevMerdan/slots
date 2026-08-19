import { describe, expect, it } from 'vitest';
import type { Minor } from '@slot/protocol';
import { MemoryRoundStore } from './memory.js';
import { runStoreContract } from './store-contract.js';

runStoreContract('in memory', () => Promise.resolve(new MemoryRoundStore()));

describe('eviction', () => {
  it('evicts only the oldest settled rounds, never the one in flight', async () => {
    const store = new MemoryRoundStore({ retention: 2 });
    const rounds = Array.from({ length: 4 }, (_, index) => ({
      roundId: `018a0000-0000-7000-8000-00000000fe${index.toString(16).padStart(2, '0')}`,
      playerId: 'demo-player',
      state: 'OPEN' as const,
      stake: 100 as Minor,
      serverSeed: 'eviction-server-seed',
      commitment: 'eviction-commitment',
      fingerprint: 'fp',
      cumulativeWin: 0 as Minor,
      capped: false,
      steps: 0,
      openedAt: 1_700_000_000_000 + index,
    }));

    for (const round of rounds) await store.open(round);
    // Settle the first three; the fourth stays in flight.
    for (const round of rounds.slice(0, 3)) {
      await store.commit({
        roundId: round.roundId,
        from: 'OPEN',
        patch: { state: 'SETTLED' },
        records: [
          { roundId: round.roundId, call: 'settle', step: 0, fingerprint: 'fp', response: {} },
        ],
      });
    }

    // Retention 2: the oldest settled round is gone, its records with it; the open round survives.
    expect(await store.find(rounds[0]!.roundId)).toBeUndefined();
    expect(await store.record(rounds[0]!.roundId, 'settle', 0)).toBeUndefined();
    expect(await store.find(rounds[1]!.roundId)).toBeDefined();
    expect((await store.find(rounds[3]!.roundId))?.state).toBe('OPEN');
  });
});
