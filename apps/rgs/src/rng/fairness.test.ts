import { describe, expect, it } from 'vitest';
import type { Minor, SpinRes } from '@slot/protocol';
import { commitmentOf, sha256Hex, stopsForStep } from '@slot/game-math';
import { createGameConfig } from '../config.js';
import { MemoryRoundStore } from '../persistence/memory.js';
import { MemoryLedger } from '../ledger/memory.js';
import { MockWallet } from '../wallet/mock.js';
import { MemorySessionStore, createSessionService } from '../domain/sessions.js';
import { boundTo, createRoundService } from '../domain/rounds.js';
import { spinFingerprint } from '../domain/fingerprint.js';
import { committingSeedProvider, seededBytes } from './seeds.js';

/**
 * The R4 gate: a player can independently recompute a round's `stops[]` from the revealed seed
 * and their own inputs. The "player" below holds nothing but what the wire handed them — the
 * commitment before the bet, the config from `authenticate`, their own `roundId` and
 * `clientSeed`, and the reveal at the close — and `@slot/game-math` in their pocket. Every check
 * is theirs: the hash, the chain, and the grid of every step.
 */

const NOW = 1_700_000_000_000;
const PLAYER = 'demo-player';
const TOKEN = 'fairness-token';
const STAKE = 100 as Minor;
const CLIENT_SEED = 'my-own-luck';

let minted = 0;
const nextRoundId = (): string =>
  `01900000-0000-7000-8000-${(minted += 1).toString(16).padStart(12, '0')}`;

const world = () => {
  const store = new MemoryRoundStore({ retention: 10_000 });
  const wallet = new MockWallet({ [PLAYER]: 10_000_000 as Minor });
  const sessionStore = new MemorySessionStore();
  void sessionStore.put(TOKEN, { playerId: PLAYER, currency: 'EUR', expiresAt: 4_102_444_800_000 });
  const sessions = createSessionService({
    store: sessionStore,
    randomBytes: seededBytes('fairness-tokens'),
    now: () => NOW,
  });
  const service = boundTo(
    createRoundService({
      store,
      wallet,
      ledger: new MemoryLedger(),
      sessions,
      seeds: committingSeedProvider(seededBytes('fairness-chain')),
      config: createGameConfig(),
      now: () => NOW,
    }),
    { token: TOKEN },
  );
  return { store, wallet, service };
};

describe('the committing provider', () => {
  it('chains pairs whose commitment is the hash of the seed, and replays under one label', () => {
    const chain = committingSeedProvider(seededBytes('label'));
    const first = chain.current();
    expect(first.commitment).toBe(sha256Hex(first.seed));
    expect(first.seed).toMatch(/^[0-9a-f]{64}$/);

    const second = chain.rotate();
    expect(second).toEqual(chain.current());
    expect(second.commitment).not.toBe(first.commitment);

    // Deterministic bytes, deterministic chain — the property every test in this app leans on.
    const twin = committingSeedProvider(seededBytes('label'));
    expect(twin.current()).toEqual(first);
    expect(twin.rotate()).toEqual(second);
  });
});

describe('the R4 gate — the player verifies every round from wire data alone', () => {
  it('recomputes stops for dead, won and feature rounds, and the chain never skips', async () => {
    const { service } = world();
    const auth = await service.authenticate({ token: TOKEN });
    const config = auth.config;

    // What the player holds before their next bet: the commitment on offer.
    let held = auth.fairness?.next;
    expect(held).toMatch(/^[0-9a-f]{64}$/);

    const seen = { DEAD: false, WIN: false, FEATURE: false };
    for (let round = 0; round < 2_000 && !(seen.DEAD && seen.WIN && seen.FEATURE); round += 1) {
      const roundId = nextRoundId();
      const spin = await service.spin({ roundId, stake: STAKE, clientSeed: CLIENT_SEED });

      // The bet bound exactly the commitment the player was holding — nothing was swapped.
      expect(spin.fairness?.commitment).toBe(held);

      const stopsByStep: number[][] = [spin.result.stops];
      let action = spin.next;
      let step = 0;
      while (action === 'FEATURE_SPIN') {
        const played = await service.featureSpin({ roundId, step: (step += 1) });
        stopsByStep.push(played.result.stops);
        action = played.next;
      }

      // The reveal rides the response that closes the round — and no earlier.
      let reveal: string;
      if (action === 'SETTLE') {
        expect(spin.fairness?.reveal).toBeUndefined();
        const settled = await service.settle({ roundId });
        expect(settled.fairness?.commitment).toBe(held);
        reveal = settled.fairness?.reveal as string;
        held = settled.fairness?.next;
      } else {
        reveal = spin.fairness?.reveal as string;
        held = spin.fairness?.next;
      }

      // The player's own arithmetic: the hash, then every step's grid.
      expect(sha256Hex(reveal)).toBe(spin.fairness?.commitment);
      stopsByStep.forEach((stops, index) => {
        expect(stopsForStep(config, reveal, roundId, CLIENT_SEED, index)).toEqual(stops);
      });

      const kind = step > 0 ? 'FEATURE' : spin.next === 'SETTLE' ? 'WIN' : 'DEAD';
      seen[kind] = true;
    }
    expect(seen).toEqual({ DEAD: true, WIN: true, FEATURE: true });
  });

  it('replays reveal exactly on a duplicate settle — idempotent fairness included', async () => {
    const { service } = world();
    await service.authenticate({ token: TOKEN });

    // Hunt a win round (no clientSeed: the reveal must verify with the absent-seed derivation).
    let win: SpinRes | undefined;
    for (let round = 0; round < 2_000 && win === undefined; round += 1) {
      const spin = await service.spin({ roundId: nextRoundId(), stake: STAKE });
      let action = spin.next;
      let step = 0;
      while (action === 'FEATURE_SPIN') {
        const played = await service.featureSpin({ roundId: spin.roundId, step: (step += 1) });
        action = played.next;
      }
      if (action === 'SETTLE') {
        if (step === 0) win = spin;
        else await service.settle({ roundId: spin.roundId });
      }
    }
    if (win === undefined) throw new Error('no win round found');

    const first = await service.settle({ roundId: win.roundId });
    const again = await service.settle({ roundId: win.roundId });
    expect(again.fairness).toEqual(first.fairness);
    expect(sha256Hex(first.fairness?.reveal as string)).toBe(win.fairness?.commitment);
    expect(
      stopsForStep(createGameConfig(), first.fairness?.reveal as string, win.roundId, undefined, 0),
    ).toEqual(win.result.stops);
  });

  it('re-learns the binding of a stranded round from authenticate, and the resume reveals it', async () => {
    const { store, wallet, service } = world();
    const roundId = nextRoundId();
    const serverSeed = 'stranded-round-seed';
    await wallet.debit(PLAYER, STAKE, roundId);
    await store.open({
      roundId,
      playerId: PLAYER,
      state: 'OPEN',
      stake: STAKE,
      serverSeed,
      commitment: commitmentOf(serverSeed),
      fingerprint: spinFingerprint(STAKE, undefined, undefined),
      cumulativeWin: 0 as Minor,
      capped: false,
      steps: 0,
      openedAt: NOW,
    });

    const pending = (await service.authenticate({ token: TOKEN })).pendingRound;
    expect(pending?.fairness?.commitment).toBe(commitmentOf(serverSeed));

    // The honest retry resolves under the bound pair, and the close reveals that pair — the
    // restart did not get to re-roll anything.
    const spin = await service.spin({ roundId, stake: STAKE });
    expect(spin.fairness?.commitment).toBe(commitmentOf(serverSeed));
    expect(stopsForStep(createGameConfig(), serverSeed, roundId, undefined, 0)).toEqual(
      spin.result.stops,
    );
  });
});
