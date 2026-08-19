import { describe, expect, it } from 'vitest';
import type { Minor, SpinRes } from '@slot/protocol';
import {
  AuthenticateResSchema,
  FeatureSpinResSchema,
  SettleResSchema,
  SlotError,
  SpinResSchema,
} from '@slot/protocol';
import { createGameConfig } from '../config.js';
import { MemoryRoundStore } from '../persistence/memory.js';
import { MockWallet } from '../wallet/mock.js';
import { staticSeedProvider } from '../rng/seeds.js';
import { SingleSessionHost } from './sessions.js';
import { createRoundService } from './rounds.js';
import { spinFingerprint } from './fingerprint.js';

/**
 * The round lifecycle, tested at the domain seam — no HTTP, no schemas in the way. The contract
 * suite proves the same behaviour over the wire; these tests exist so a regression names the file
 * it lives in, and so the cases the suite reaches by *hunting* (a feature trigger) are pinned here
 * against the same deterministic seed the hunt would find them with.
 */

const NOW = 1_700_000_000_000;
const EXPIRES = 4_102_444_800_000;
const PLAYER = 'demo-player';
const TOKEN = 'test-token';
const STAKE = 100 as Minor;

let minted = 0;
const nextRoundId = (): string =>
  `018b0000-0000-7000-8000-${(minted += 1).toString(16).padStart(12, '0')}`;

const harness = ({ balance = 1_000_000 as Minor, now = NOW } = {}) => {
  const store = new MemoryRoundStore();
  const wallet = new MockWallet({ [PLAYER]: balance });
  const sessions = new SingleSessionHost();
  sessions.issue(TOKEN, { playerId: PLAYER, currency: 'EUR', expiresAt: EXPIRES });
  const clock = { now };
  const service = createRoundService({
    store,
    wallet,
    sessions,
    seeds: staticSeedProvider('rgs-test-seed'),
    config: createGameConfig(),
    now: () => clock.now,
  });
  return { store, wallet, sessions, service, clock };
};

const rejection = async (promise: Promise<unknown>): Promise<SlotError> => {
  const caught: unknown = await promise.then(() => undefined).catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(SlotError);
  return caught as SlotError;
};

/** Play rounds until one matches; deterministic under the fixed seed, so never flaky. */
const spinUntil = async (
  service: ReturnType<typeof harness>['service'],
  want: (spin: SpinRes) => boolean,
  limit = 2_000,
): Promise<SpinRes> => {
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const spin = await service.spin({ roundId: nextRoundId(), stake: STAKE });
    if (want(spin)) return spin;
    let action = spin.next;
    let step = 0;
    while (action === 'FEATURE_SPIN') {
      const played = await service.featureSpin({ roundId: spin.roundId, step: (step += 1) });
      action = played.next;
    }
    if (action === 'SETTLE') await service.settle({ roundId: spin.roundId });
  }
  throw new Error(`no round matched in ${limit} spins`);
};

describe('authenticate', () => {
  it('answers the session, the balance and the config, shaped as the wire requires', async () => {
    const { service } = harness();

    const response = await service.authenticate({ token: TOKEN });

    expect(() => AuthenticateResSchema.parse(response)).not.toThrow();
    expect(response.balance).toBe(1_000_000);
    expect(response.pendingRound).toBeUndefined();
  });

  it('refuses a token it never issued', async () => {
    const { service } = harness();

    const error = await rejection(service.authenticate({ token: 'stolen' }));

    expect(error.code).toBe('SESSION_EXPIRED');
    expect(error.errorClass).toBe('PLAYER');
  });
});

describe('spin', () => {
  it('debits the stake and answers a response the schema accepts', async () => {
    const { service, wallet } = harness();

    const spin = await service.spin({ roundId: nextRoundId(), stake: STAKE });

    expect(() => SpinResSchema.parse(spin)).not.toThrow();
    expect(spin.balance).toBe(1_000_000 - STAKE);
    await expect(wallet.getBalance(PLAYER)).resolves.toBe(1_000_000 - STAKE);
  });

  it('replays a duplicate instead of spinning again — one debit, identical bytes', async () => {
    const { service, wallet } = harness();
    const roundId = nextRoundId();

    const first = await service.spin({ roundId, stake: STAKE });
    const again = await service.spin({ roundId, stake: STAKE });

    expect(again).toEqual(first);
    await expect(wallet.getBalance(PLAYER)).resolves.toBe(1_000_000 - STAKE);
  });

  it('refuses the same roundId carrying different parameters', async () => {
    const { service } = harness();
    const roundId = nextRoundId();
    await service.spin({ roundId, stake: STAKE });

    const error = await rejection(service.spin({ roundId, stake: 200 as Minor }));

    expect(error.code).toBe('ROUND_CONFLICT');
  });

  it('refuses a stake off the ladder, and a stake the balance cannot cover', async () => {
    const { service } = harness({ balance: 20 as Minor });

    expect(
      (await rejection(service.spin({ roundId: nextRoundId(), stake: 37 as Minor }))).code,
    ).toBe('STAKE_NOT_ALLOWED');
    expect(
      (await rejection(service.spin({ roundId: nextRoundId(), stake: 4_000 as Minor }))).code,
    ).toBe('INSUFFICIENT_FUNDS');
    // Nothing moved either time.
    expect((await service.authenticate({ token: TOKEN })).balance).toBe(20);
  });

  it('refuses forceOutcome before anything else — there is no dev mode on this server', async () => {
    const { service, store } = harness();

    const error = await rejection(
      service.spin({
        roundId: nextRoundId(),
        stake: STAKE,
        forceOutcome: { scenario: 'MAX_WIN' },
      }),
    );

    expect(error.code).toBe('FORCE_OUTCOME_REFUSED');
    expect(store.snapshot()).toHaveLength(0);
  });

  it('refuses every call once the session has expired', async () => {
    const { service, clock } = harness();
    clock.now = EXPIRES + 1;

    for (const call of [
      service.spin({ roundId: nextRoundId(), stake: STAKE }),
      service.settle({ roundId: nextRoundId() }),
      service.history({}),
    ]) {
      expect((await rejection(call)).code).toBe('SESSION_EXPIRED');
    }
  });
});

describe('the stranded round — debited, never resolved (§5)', () => {
  /** What a crash between the wallet debit and the store commit leaves behind. */
  const strand = async (h: ReturnType<typeof harness>, stake: Minor): Promise<string> => {
    const roundId = nextRoundId();
    await h.wallet.debit(PLAYER, stake, roundId);
    await h.store.open({
      roundId,
      playerId: PLAYER,
      state: 'OPEN',
      stake,
      fingerprint: spinFingerprint(stake, undefined, undefined),
      cumulativeWin: 0 as Minor,
      capped: false,
      steps: 0,
      openedAt: NOW,
    });
    return roundId;
  };

  it('reports it as pending — OPEN, no result, and no next, exactly as §5 shapes it', async () => {
    const h = harness();
    const roundId = await strand(h, STAKE);

    const pending = (await h.service.authenticate({ token: TOKEN })).pendingRound;

    expect(pending?.roundId).toBe(roundId);
    expect(pending?.state).toBe('OPEN');
    expect(pending?.result).toBeUndefined();
    expect(pending?.feature).toBeUndefined();
    expect(pending?.next).toBeUndefined();
  });

  it('resolves it on the honest retry, without a second debit', async () => {
    const h = harness();
    const roundId = await strand(h, STAKE);

    const spin = await h.service.spin({ roundId, stake: STAKE });

    expect(spin.roundId).toBe(roundId);
    expect(spin.balance).toBe(1_000_000 - STAKE);
    // And the round is now an ordinary round: replay works, recovery no longer reports it OPEN.
    expect(await h.service.spin({ roundId, stake: STAKE })).toEqual(spin);
  });

  it('still refuses a retry whose parameters differ from the debited round', async () => {
    const h = harness();
    const roundId = await strand(h, STAKE);

    const error = await rejection(h.service.spin({ roundId, stake: 200 as Minor }));

    expect(error.code).toBe('ROUND_CONFLICT');
  });
});

describe('the feature — steps inside one round', () => {
  it('holds the round open across free spins, folds retriggers, and credits exactly once', async () => {
    const { service } = harness();
    const trigger = await spinUntil(service, (spin) => spin.next === 'FEATURE_SPIN');

    const awarded = trigger.feature?.total ?? 0;
    expect(awarded).toBeGreaterThan(0);
    expect(trigger.feature?.remaining).toBe(awarded);

    let step = 0;
    let action = trigger.next;
    let lastRoundWin = trigger.roundWin;
    while (action === 'FEATURE_SPIN') {
      const played = await service.featureSpin({ roundId: trigger.roundId, step: (step += 1) });
      expect(() => FeatureSpinResSchema.parse(played)).not.toThrow();
      // The invariant that keeps total/remaining honest under retrigger.
      expect(played.feature.remaining).toBe(played.feature.total - played.feature.step);
      // A free spin neither debits nor credits.
      expect(played.balance).toBe(trigger.balance);
      lastRoundWin = played.roundWin;
      action = played.next;
    }

    const settled = await service.settle({ roundId: trigger.roundId });
    expect(() => SettleResSchema.parse(settled)).not.toThrow();
    expect(settled.totalWin).toBe(lastRoundWin);
    expect(settled.balance).toBe(trigger.balance + settled.totalWin);
  });

  it('refuses a step out of order, and a step for a round that never had a feature', async () => {
    const { service } = harness();
    const trigger = await spinUntil(service, (spin) => spin.next === 'FEATURE_SPIN');
    expect((await rejection(service.featureSpin({ roundId: trigger.roundId, step: 2 }))).code).toBe(
      'ILLEGAL_TRANSITION',
    );

    const plain = await spinUntil(service, (spin) => spin.next === 'SETTLE');
    expect((await rejection(service.featureSpin({ roundId: plain.roundId, step: 1 }))).code).toBe(
      'ILLEGAL_TRANSITION',
    );
    await service.settle({ roundId: plain.roundId });
  });

  it('replays a duplicate free spin at the same step', async () => {
    const { service } = harness();
    const trigger = await spinUntil(service, (spin) => spin.next === 'FEATURE_SPIN');

    const first = await service.featureSpin({ roundId: trigger.roundId, step: 1 });
    const again = await service.featureSpin({ roundId: trigger.roundId, step: 1 });

    expect(again).toEqual(first);
  });
});

describe('settle', () => {
  it('refuses a round it never saw, and one that has nothing to settle yet', async () => {
    const { service } = harness();
    expect((await rejection(service.settle({ roundId: nextRoundId() }))).code).toBe(
      'UNKNOWN_ROUND',
    );

    const trigger = await spinUntil(service, (spin) => spin.next === 'FEATURE_SPIN');
    expect((await rejection(service.settle({ roundId: trigger.roundId }))).code).toBe(
      'ILLEGAL_TRANSITION',
    );
  });

  it('settles an atomically-settled round as a replay rather than an error', async () => {
    const { service } = harness();
    const dead = await spinUntil(service, (spin) => spin.next === 'IDLE');

    const settled = await service.settle({ roundId: dead.roundId });

    expect(settled.totalWin).toBe(0);
    expect(settled.balance).toBe(dead.balance);
  });

  it('replays a duplicate settle instead of crediting twice', async () => {
    const { service } = harness();
    const win = await spinUntil(service, (spin) => spin.next === 'SETTLE');

    const first = await service.settle({ roundId: win.roundId });
    const again = await service.settle({ roundId: win.roundId });

    expect(again).toEqual(first);
    expect((await service.authenticate({ token: TOKEN })).balance).toBe(first.balance);
  });
});

describe('history', () => {
  it('lists settled rounds newest first and never one in flight', async () => {
    const { service } = harness();
    const dead = await spinUntil(service, (spin) => spin.next === 'IDLE');
    const open = await spinUntil(service, (spin) => spin.next === 'SETTLE');

    const listed = await service.history({});

    expect(listed.retention).toBeGreaterThan(0);
    expect(listed.rounds.some((round) => round.roundId === open.roundId)).toBe(false);
    expect(listed.rounds.some((round) => round.roundId === dead.roundId)).toBe(true);

    await service.settle({ roundId: open.roundId });
    expect((await service.history({})).rounds[0]?.roundId).toBe(open.roundId);
  });
});

describe('the wallet as an upstream', () => {
  it('surfaces a wallet outage as WALLET_UNAVAILABLE, having moved nothing', async () => {
    const h = harness();
    const broken = createRoundService({
      store: h.store,
      wallet: {
        getBalance: () => Promise.reject(new Error('wallet is down')),
        debit: () => Promise.reject(new Error('wallet is down')),
        credit: () => Promise.reject(new Error('wallet is down')),
        rollback: () => Promise.reject(new Error('wallet is down')),
      },
      sessions: h.sessions,
      seeds: staticSeedProvider('rgs-test-seed'),
      config: createGameConfig(),
      now: () => NOW,
    });

    const error = await rejection(broken.spin({ roundId: nextRoundId(), stake: STAKE }));

    expect(error.code).toBe('WALLET_UNAVAILABLE');
    expect(error.isRetryable).toBe(true);
    expect(h.store.snapshot()).toHaveLength(0);
  });
});
