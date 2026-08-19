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
import { MemoryLedger } from '../ledger/memory.js';
import { MockWallet } from '../wallet/mock.js';
import { commitmentOf } from '@slot/game-math';
import { committingSeedProvider, seededBytes } from '../rng/seeds.js';
import { MemorySessionStore, createSessionService } from './sessions.js';
import { boundTo, createRoundService } from './rounds.js';
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

const harness = ({ balance = 1_000_000 as Minor, now = NOW, minSpinIntervalMs = 0 } = {}) => {
  const store = new MemoryRoundStore();
  const wallet = new MockWallet({ [PLAYER]: balance });
  const ledger = new MemoryLedger();
  const clock = { now };
  const config = createGameConfig(
    minSpinIntervalMs === 0
      ? {}
      : {
          jurisdictionRules: {
            minSpinIntervalMs,
            turboAllowed: true,
            autoplayAllowed: true,
            realityCheckIntervalMs: 0,
          },
        },
  );
  const sessionStore = new MemorySessionStore();
  void sessionStore.put(TOKEN, { playerId: PLAYER, currency: 'EUR', expiresAt: EXPIRES });
  const sessions = createSessionService({
    store: sessionStore,
    randomBytes: seededBytes('rgs-test-tokens'),
    now: () => clock.now,
  });
  const unbound = createRoundService({
    store,
    wallet,
    ledger,
    sessions,
    seeds: committingSeedProvider(seededBytes('rgs-test-seed')),
    config,
    now: () => clock.now,
  });
  // The domain's tests speak as one caller holding the issued token — exactly what the HTTP
  // layer resolves per request from the Authorization header (§2.7, D12).
  const service = boundTo(unbound, { token: TOKEN });
  return { store, wallet, ledger, sessions, service, unbound, clock };
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

  it('refuses a caller with no token, and one whose token names no session (§2.7, D12)', async () => {
    const { unbound } = harness();

    expect((await rejection(unbound.history({}, {}))).code).toBe('SESSION_EXPIRED');
    expect(
      (await rejection(unbound.spin({ roundId: nextRoundId(), stake: STAKE }, { token: 'nope' })))
        .code,
    ).toBe('SESSION_EXPIRED');
  });
});

describe('the pacing rule — the jurisdiction, enforced server-side (R5)', () => {
  it('refuses a spin inside the window as LIMIT_REACHED, and allows it once the window opens', async () => {
    const { service, clock } = harness({ minSpinIntervalMs: 2_500 });

    await service.spin({ roundId: nextRoundId(), stake: STAKE });

    const refused = await rejection(service.spin({ roundId: nextRoundId(), stake: STAKE }));
    expect(refused.code).toBe('LIMIT_REACHED');

    clock.now += 2_500;
    const allowed = await service.spin({ roundId: nextRoundId(), stake: STAKE });
    expect(allowed.roundId).toBeDefined();
  });

  it('exempts the idempotent replay, and a refused call does not push the window', async () => {
    const { service, clock } = harness({ minSpinIntervalMs: 2_500 });

    const first = await service.spin({ roundId: nextRoundId(), stake: STAKE });

    // The replay answers from the record — no pacing, no second debit (§4).
    const replayed = await service.spin({ roundId: first.roundId, stake: STAKE });
    expect(replayed).toEqual(first);

    // A refused fresh spin is measured against the *accepted* one, so the window is unchanged:
    // one interval after the accepted spin, the next is allowed regardless of the refusals.
    await rejection(service.spin({ roundId: nextRoundId(), stake: STAKE }));
    clock.now += 2_500;
    await service.spin({ roundId: nextRoundId(), stake: STAKE });
  });

  it('never paces free spins — steps inside a round are presentation-paced (§2.1)', async () => {
    const { service, clock } = harness({ minSpinIntervalMs: 60_000 });

    // Hunt for a feature with the clock stepping past the window each time.
    let feature: SpinRes | undefined;
    for (let attempt = 0; attempt < 2_000 && feature === undefined; attempt += 1) {
      clock.now += 60_000;
      const spin = await service.spin({ roundId: nextRoundId(), stake: STAKE });
      if (spin.feature !== undefined) {
        feature = spin;
      } else if (spin.next === 'SETTLE') {
        await service.settle({ roundId: spin.roundId });
      }
    }
    if (feature === undefined) throw new Error('no feature in 2000 rounds — seed drifted?');

    // Two steps back to back, no clock movement: a paced featureSpin would refuse the first.
    const step1 = await service.featureSpin({ roundId: feature.roundId, step: 1 });
    expect(step1.step).toBe(1);
    if (step1.next === 'FEATURE_SPIN') {
      expect((await service.featureSpin({ roundId: feature.roundId, step: 2 })).step).toBe(2);
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
      serverSeed: 'strand-server-seed',
      commitment: commitmentOf('strand-server-seed'),
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

describe('the rollback path — a wallet failure mid-round leaves no orphaned debit (R2)', () => {
  it('rolls the debit back when the store refuses the open, and the retry completes with one net debit', async () => {
    const h = harness();
    let failOpens = 1;
    const store = h.store;
    const failingStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'open' && failOpens > 0) {
          return () => {
            failOpens -= 1;
            return Promise.reject(new Error('the store is down'));
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? (value as CallableFunction).bind(target) : value;
      },
    });
    const service = boundTo(
      createRoundService({
        store: failingStore,
        wallet: h.wallet,
        ledger: h.ledger,
        sessions: h.sessions,
        seeds: committingSeedProvider(seededBytes('rgs-test-seed')),
        config: createGameConfig(),
        now: () => NOW,
      }),
      { token: TOKEN },
    );
    const roundId = nextRoundId();

    // The spin fails — RECOVERABLE from the client's side — and the debit was undone: the wallet
    // holds the full balance and the store holds nothing. No orphan.
    const caught: unknown = await service
      .spin({ roundId, stake: STAKE })
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(SlotError);
    await expect(h.wallet.getBalance(PLAYER)).resolves.toBe(1_000_000);
    expect(store.snapshot()).toHaveLength(0);

    // The client's honest retry — same roundId, the wire's own rule — re-debits the rolled-back
    // ref as a fresh transaction and the round completes: exactly one standing debit.
    const spin = await service.spin({ roundId, stake: STAKE });
    expect(spin.balance).toBe(1_000_000 - STAKE);
    await expect(h.wallet.getBalance(PLAYER)).resolves.toBe(1_000_000 - STAKE);
  });

  it('leaves the round RESOLVED through a credit outage, and the later settle credits once', async () => {
    const h = harness();
    // Armed only after the hunt below has found its round — the hunt settles the wins it is not
    // looking for, and this outage belongs to the settle under test, not to whichever round the
    // seed happens to deal first.
    let failCredits = 0;
    const wallet = h.wallet;
    const flakyWallet = new Proxy(wallet, {
      get(target, property, receiver) {
        if (property === 'credit' && failCredits > 0) {
          return () => {
            failCredits -= 1;
            return Promise.reject(new Error('wallet outage at the credit'));
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? (value as CallableFunction).bind(target) : value;
      },
    });
    const service = boundTo(
      createRoundService({
        store: h.store,
        wallet: flakyWallet,
        ledger: h.ledger,
        sessions: h.sessions,
        seeds: committingSeedProvider(seededBytes('rgs-test-seed')),
        config: createGameConfig(),
        now: () => NOW,
      }),
      { token: TOKEN },
    );
    const win = await spinUntil(service, (spin) => spin.next === 'SETTLE');

    failCredits = 1;
    const outage = await rejection(service.settle({ roundId: win.roundId }));
    expect(outage.code).toBe('WALLET_UNAVAILABLE');
    expect(outage.isRetryable).toBe(true);

    // The round was not lost: it is still RESOLVED, and the retry credits exactly once.
    const settled = await service.settle({ roundId: win.roundId });
    expect(settled.totalWin).toBe(win.roundWin);
    expect(settled.balance).toBe(win.balance + settled.totalWin);
    expect(await service.settle({ roundId: win.roundId })).toEqual(settled);
  });
});

describe('the wallet as an upstream', () => {
  it('surfaces a wallet outage as WALLET_UNAVAILABLE, having moved nothing', async () => {
    const h = harness();
    const broken = boundTo(
      createRoundService({
        store: h.store,
        wallet: {
          getBalance: () => Promise.reject(new Error('wallet is down')),
          debit: () => Promise.reject(new Error('wallet is down')),
          credit: () => Promise.reject(new Error('wallet is down')),
          rollback: () => Promise.reject(new Error('wallet is down')),
        },
        ledger: h.ledger,
        sessions: h.sessions,
        seeds: committingSeedProvider(seededBytes('rgs-test-seed')),
        config: createGameConfig(),
        now: () => NOW,
      }),
      { token: TOKEN },
    );

    const error = await rejection(broken.spin({ roundId: nextRoundId(), stake: STAKE }));

    expect(error.code).toBe('WALLET_UNAVAILABLE');
    expect(error.isRetryable).toBe(true);
    expect(h.store.snapshot()).toHaveLength(0);
  });
});
