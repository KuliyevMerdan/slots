import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  FeatureSpinRes,
  GameConfig,
  Minor,
  NextAction,
  RoundResult,
  SettleRes,
  SpinRes,
  Win,
} from '@slot/protocol';
import { AuthenticateResSchema, SlotError, classOf } from '@slot/protocol';
import { evaluate, sha256Hex, stopsForStep, viewMatchesStops } from '@slot/game-math';
import type { RgsTransport } from '@slot/transport';
import type { ContractTarget, TargetHandle } from './targets.js';

/**
 * The contract suite — one suite, every target.
 *
 * This is the switch-over gate. Everything else in the repository *argues* that swapping the
 * simulator for a real RGS is a config change; this is the thing that could disprove it. It holds an
 * `RgsTransport` and a control plane, and asserts `docs/protocol.md`: the round lifecycle (§3),
 * idempotent replay (§4), recovery through `pendingRound` (§5), the stake rules (§6) and the error
 * taxonomy — without ever naming a server implementation.
 *
 * Two rules keep it honest.
 *
 * **It asserts what a client depends on, not how a server is built.** Where it reads the server's
 * own state it goes through `TargetHandle.state()`, because "one press produced one round" is a
 * contract statement the wire cannot make on its own.
 *
 * **What a target cannot do is declared, not omitted.** A missing capability turns a test into a
 * skip whose name says which capability is missing, so a hole shows up in the output rather than in
 * a document nobody diffs.
 */

const START_BALANCE = 1_000_000 as Minor;
const STAKE = 100 as Minor;
/** Off the ladder, and deliberately not a round number either. */
const ILLEGAL_STAKE = 37 as Minor;

let minted = 0;
/** UUIDv7-shaped and monotonic — what the wire requires, and what makes a round log readable. */
const nextRoundId = (): string =>
  `01890000-0000-7000-8000-${(minted += 1).toString(16).padStart(12, '0')}`;

/**
 * Carry an already-open round to whatever end the server asked for.
 *
 * It takes `next` rather than a response because that is all the protocol says to obey: the server
 * names the call that moves the round on, and the client makes it until it is told `IDLE`.
 */
async function finish(
  transport: RgsTransport,
  roundId: string,
  next: NextAction,
  completedSteps = 0,
): Promise<{ steps: FeatureSpinRes[]; settle: SettleRes | undefined }> {
  const steps: FeatureSpinRes[] = [];
  let step = completedSteps;
  let action = next;

  while (action === 'FEATURE_SPIN') {
    step += 1;
    const played = await transport.featureSpin({ roundId, step });
    steps.push(played);
    action = played.next;
  }

  return {
    steps,
    settle: action === 'SETTLE' ? await transport.settle({ roundId }) : undefined,
  };
}

const playOut = async (
  transport: RgsTransport,
  stake: Minor,
): Promise<{ spin: SpinRes; steps: FeatureSpinRes[]; settle: SettleRes | undefined }> => {
  const spin = await transport.spin({ roundId: nextRoundId(), stake });
  return { spin, ...(await finish(transport, spin.roundId, spin.next)) };
};

/**
 * Spin fresh rounds until one looks like `want`, finishing every round that does not.
 *
 * `forceOutcome` would be shorter and would make half of these tests unrunnable against the one
 * target that matters most — a production server refuses the field by design. The seed fixes the
 * sequence, so this converges in the same number of spins on every run.
 */
async function spinUntil(
  transport: RgsTransport,
  stake: Minor,
  want: (spin: SpinRes) => boolean,
  limit = 60,
): Promise<SpinRes> {
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    const spin = await transport.spin({ roundId: nextRoundId(), stake });
    if (want(spin)) return spin;
    await finish(transport, spin.roundId, spin.next);
  }
  throw new Error(
    `no round matched in ${limit} spins — this target's outcomes are not what we think`,
  );
}

/** Win identity without `positions` — the same comparison the client's dev assertion makes. */
const shapeOf = (wins: readonly Win[]): string =>
  JSON.stringify(
    [...wins]
      .map((win) => ({
        kind: win.kind,
        line: win.line ?? null,
        symbol: win.symbol,
        count: win.count,
        amount: win.amount,
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );

/**
 * The two assertions that catch a server drifting from the math its client ships.
 *
 * `viewMatchesStops` catches a strip-alignment bug — a server whose grid disagrees with its own
 * outcome. The re-evaluation catches the subtler and more expensive one: a paytable the two sides no
 * longer share, so the reels would light a win the player was never paid. Neither decides anything
 * (ADR-0001); they check authority against itself.
 *
 * **Worth being precise about what this proves against which target.** Both simulator targets derive
 * their view and their wins with these very functions — `rgs-sim` imports `@slot/game-math` — so
 * here the check is a function agreeing with itself and cannot fail. It is carried anyway because
 * the target it exists for is the one that ships its own math: `apps/rgs` (R1+), or any operator's
 * server reached by base URL. That is the moment a paytable can drift, and this is the assertion
 * waiting for it.
 */
function expectResultIsSelfConsistent(config: GameConfig, result: RoundResult, stake: Minor): void {
  expect(viewMatchesStops(config.strips, result.stops, result.view)).toBe(true);

  const local = evaluate({
    view: result.view,
    paylines: config.paylines,
    paytable: config.paytable,
    stake,
  });

  expect(shapeOf(result.wins)).toBe(shapeOf(local.wins));
  expect(result.totalWin).toBe(local.totalWin);
}

/** Every rejection is a `SlotError` whose class comes from its code — never from the wire's claim. */
async function rejection(promise: Promise<unknown>): Promise<SlotError> {
  const caught: unknown = await promise.then(() => undefined).catch((error: unknown) => error);

  expect(caught).toBeInstanceOf(SlotError);
  const error = caught as SlotError;
  expect(error.errorClass).toBe(classOf(error.code));
  return error;
}

/**
 * The red gate — what the contract suite asserts of a target that is wired but not built.
 *
 * R0's "done when" (ROADMAP Part III): the suite runs against `apps/rgs` and every failure is
 * `NotImplemented` **and nothing else**. That is only meaningful because the refusal is
 * distinguishable on the wire (D10): `NOT_IMPLEMENTED` proves the route exists, the request was
 * understood, and the domain is missing — where `SCHEMA_MISMATCH` would blame the request,
 * `UPSTREAM_UNAVAILABLE` the network, and a hang the server. So the gate is a *green* CI
 * assertion about an honestly empty server, and the full contract above takes over per endpoint
 * as the R-blocks land.
 */
function runExpectedRedGate(target: ContractTarget, reason: string): void {
  describe(`contract · ${target.name} — expected red: ${reason}`, () => {
    let handle: TargetHandle;
    let transport: RgsTransport;

    beforeAll(async () => {
      // `devMode` is a simulator affordance; this server has no such flag to set.
      handle = await target.start({ devMode: false, balance: 1_000_000 as Minor });
      transport = handle.transport;
    });

    afterAll(async () => {
      await handle.close();
    });

    const calls: Record<string, () => Promise<unknown>> = {
      authenticate: () => transport.authenticate({ token: 'contract-demo-token' }),
      spin: () => transport.spin({ roundId: nextRoundId(), stake: 100 as Minor }),
      featureSpin: () => transport.featureSpin({ roundId: nextRoundId(), step: 1 }),
      settle: () => transport.settle({ roundId: nextRoundId() }),
      history: () => transport.history({}),
    };

    it.each(Object.keys(calls))('%s — refused as NOT_IMPLEMENTED, FATAL', async (name) => {
      const error = await rejection((calls[name] as () => Promise<unknown>)());

      expect(error.code).toBe('NOT_IMPLEMENTED');
      expect(error.errorClass).toBe('FATAL');
    });

    it('still validates first — a malformed request is SCHEMA_MISMATCH, never NOT_IMPLEMENTED', async () => {
      const error = await rejection(transport.spin({ roundId: 'not-a-uuid', stake: -1 } as never));

      expect(error.code).toBe('SCHEMA_MISMATCH');
      expect(error.errorClass).toBe('FATAL');
    });
  });
}

export function runContractSuite(target: ContractTarget): void {
  if (target.unavailable !== undefined) {
    // Named, skipped, and visible in the output — a suite that quietly covers two targets while
    // claiming three is worse than one that prints the hole.
    describe(`contract · ${target.name}`, () => {
      it.skip(`not run — ${target.unavailable}`, () => undefined);
    });
    return;
  }

  if (target.expectedRed !== undefined) {
    runExpectedRedGate(target, target.expectedRed);
    return;
  }

  describe(`contract · ${target.name}`, () => {
    let handle: TargetHandle;
    let transport: RgsTransport;
    let token: string;
    let config: GameConfig;

    /** Declares a test this target cannot run, naming the capability instead of dropping the case. */
    const needs =
      (capability: keyof ContractTarget['supports']) =>
      (name: string, body: () => Promise<void>): void => {
        if (target.supports[capability]) it(name, body);
        else it.skip(`${name}  ·  needs ${capability}`, body);
      };

    beforeAll(async () => {
      handle = await target.start({ devMode: true, balance: START_BALANCE });
      transport = handle.transport;
      const opened = await handle.reset();
      config = (await transport.authenticate({ token: opened.token })).config;
    });

    afterAll(async () => {
      await handle.close();
    });

    // Every test starts from a session with a known balance and no history: a suite whose tests
    // depend on the order they run in is one that fails in CI only.
    beforeEach(async () => {
      await handle.faults({});
      token = (await handle.reset({ balance: START_BALANCE })).token;
    });

    describe('authenticate', () => {
      it('answers with a session, an authoritative balance and a config the schema accepts', async () => {
        const session = await transport.authenticate({ token });

        // The parse *is* the assertion: `MockTransport` does not validate responses, so in-process
        // this is the only place the shape is checked at all.
        expect(() => AuthenticateResSchema.parse(session)).not.toThrow();
        expect(session.balance).toBe(START_BALANCE);
        expect(session.pendingRound).toBeUndefined();
        expect(session.session.expiresAt).toBeGreaterThan(0);
      });

      it('publishes a bet ladder its own limits allow', async () => {
        const { config: served } = await transport.authenticate({ token });

        expect(served.betLevels.length).toBeGreaterThan(0);
        expect(served.limits.minStake).toBeLessThanOrEqual(served.limits.maxStake);
        for (const level of served.betLevels) {
          expect(level).toBeGreaterThanOrEqual(served.limits.minStake);
          expect(level).toBeLessThanOrEqual(served.limits.maxStake);
        }
      });

      it('refuses a token it never issued, as a PLAYER error', async () => {
        const error = await rejection(transport.authenticate({ token: 'not-a-token' }));

        expect(error.code).toBe('SESSION_EXPIRED');
        expect(error.errorClass).toBe('PLAYER');
      });
    });

    describe('the round lifecycle', () => {
      it('debits exactly the stake and reports the balance after the debit', async () => {
        const spin = await transport.spin({ roundId: nextRoundId(), stake: STAKE });

        expect(spin.balance).toBe(START_BALANCE - STAKE);
        expect((await handle.state()).balance).toBe(START_BALANCE - STAKE);

        await finish(transport, spin.roundId, spin.next);
      });

      it('sends a grid its own stops derive, and pays what the shipped paytable says', async () => {
        const round = await playOut(transport, STAKE);

        expectResultIsSelfConsistent(config, round.spin.result, STAKE);
        for (const step of round.steps) {
          expectResultIsSelfConsistent(config, step.result, step.feature.stakeRef);
        }
      });

      it('settles a zero-win round atomically, leaving nothing to do', async () => {
        const dead = await spinUntil(transport, STAKE, (spin) => spin.next === 'IDLE');

        expect(dead.result.totalWin).toBe(0);
        expect(dead.feature).toBeUndefined();

        const round = (await handle.state()).rounds.find((entry) => entry.roundId === dead.roundId);
        expect(round?.state).toBe('SETTLED');
      });

      it('credits a winning round exactly what it said it would', async () => {
        const win = await spinUntil(transport, STAKE, (spin) => spin.next === 'SETTLE');
        expect(win.result.totalWin).toBeGreaterThan(0);

        const before = (await handle.state()).balance;
        const settled = await transport.settle({ roundId: win.roundId });

        expect(settled.next).toBe('IDLE');
        // `roundWin`, not `result.totalWin`: the payable figure is what gets credited, and on a
        // capped round the two differ. This is the whole reason the field exists.
        expect(settled.totalWin).toBe(win.roundWin);
        expect(settled.balance).toBe(before + settled.totalWin);
        expect((await handle.state()).balance).toBe(settled.balance);
      });

      /**
       * The ceiling, without needing a round that actually reaches it: `roundWin` is what the client
       * counts up to and `settle.totalWin` is what the balance receives, so the contract is that
       * they are never allowed to differ — capped or not (docs/protocol.md D7).
       */
      it('never credits a different number from the one it last showed', async () => {
        const { config: served } = await transport.authenticate({ token });
        const round = await playOut(transport, STAKE);

        const stated = round.steps[round.steps.length - 1]?.roundWin ?? round.spin.roundWin;
        expect(round.settle?.totalWin ?? stated).toBe(stated);

        // And the payable figure is never above the ceiling the config publishes.
        expect(stated).toBeLessThanOrEqual(STAKE * served.limits.maxWinMultiplier);
      });

      it('accepts every stake it advertises', async () => {
        const { config: served, balance } = await transport.authenticate({ token });
        let spent = 0;

        for (const level of served.betLevels) {
          const round = await playOut(transport, level);

          expect(round.spin.balance).toBe(balance - spent - level);
          spent += level - (round.settle?.totalWin ?? 0);
        }
      });

      needs('forceOutcome')(
        'holds a feature round open across every free spin, then credits the round once',
        async () => {
          const roundId = nextRoundId();
          const spin = await transport.spin({
            roundId,
            stake: STAKE,
            forceOutcome: { scenario: 'FREE_SPINS_TRIGGER' },
          });

          expect(spin.next).toBe('FEATURE_SPIN');
          const awarded = spin.feature?.total ?? 0;
          expect(awarded).toBeGreaterThan(0);
          expect(spin.feature?.remaining).toBe(awarded);

          const steps: FeatureSpinRes[] = [];
          let action: NextAction = spin.next;
          while (action === 'FEATURE_SPIN') {
            const played = await transport.featureSpin({ roundId, step: steps.length + 1 });
            steps.push(played);

            // The invariant that keeps `total` and `remaining` honest under retrigger. The client
            // displays this arithmetic; it must never have to perform it.
            expect(played.feature.step).toBe(steps.length);
            expect(played.feature.remaining).toBe(played.feature.total - played.feature.step);
            // A free spin neither debits nor credits.
            expect(played.balance).toBe(spin.balance);

            const open = (await handle.state()).rounds.find((entry) => entry.roundId === roundId);
            expect(open?.state).toBe(played.next === 'SETTLE' ? 'RESOLVED' : 'OPEN');
            action = played.next;
          }

          const last = steps[steps.length - 1];
          const settled = await transport.settle({ roundId });

          // One stake, one debit, one credit: the feature belongs to the round that paid for it.
          expect(settled.totalWin).toBe(last?.roundWin);
          expect(settled.balance).toBe(START_BALANCE - STAKE + settled.totalWin);

          const finished = (await handle.state()).rounds.find((entry) => entry.roundId === roundId);
          expect(finished?.state).toBe('SETTLED');
          expect(finished?.steps).toBe(steps.length);
        },
      );

      needs('forceOutcome')('refuses a free spin taken out of order', async () => {
        const roundId = nextRoundId();
        await transport.spin({
          roundId,
          stake: STAKE,
          forceOutcome: { scenario: 'FREE_SPINS_TRIGGER' },
        });

        // Step 2 before step 1: a client that skips a step is guessing, not resuming.
        const error = await rejection(transport.featureSpin({ roundId, step: 2 }));

        expect(error.code).toBe('ILLEGAL_TRANSITION');
        expect(error.errorClass).toBe('FATAL');
      });
    });

    describe('idempotent replay', () => {
      it('replays a duplicate spin instead of spinning again', async () => {
        const roundId = nextRoundId();

        const first = await transport.spin({ roundId, stake: STAKE });
        const again = await transport.spin({ roundId, stake: STAKE });

        expect(again).toEqual(first);
        const state = await handle.state();
        expect(state.rounds).toHaveLength(1);
        // One press, one debit — however many times the request went out.
        expect(state.balance).toBe(START_BALANCE - STAKE);

        await finish(transport, roundId, first.next);
      });

      needs('forceOutcome')('replays a duplicate free spin at the same step', async () => {
        const roundId = nextRoundId();
        await transport.spin({
          roundId,
          stake: STAKE,
          forceOutcome: { scenario: 'FREE_SPINS_TRIGGER' },
        });

        const first = await transport.featureSpin({ roundId, step: 1 });
        const again = await transport.featureSpin({ roundId, step: 1 });

        expect(again).toEqual(first);
        const round = (await handle.state()).rounds.find((entry) => entry.roundId === roundId);
        expect(round?.steps).toBe(1);
      });

      it('replays a duplicate settle instead of crediting twice', async () => {
        const win = await spinUntil(transport, STAKE, (spin) => spin.next === 'SETTLE');

        const first = await transport.settle({ roundId: win.roundId });
        const again = await transport.settle({ roundId: win.roundId });

        expect(again).toEqual(first);
        expect((await handle.state()).balance).toBe(first.balance);
      });

      it('settles an atomically-settled round as a replay rather than an error', async () => {
        const dead = await spinUntil(transport, STAKE, (spin) => spin.next === 'IDLE');

        const settled = await transport.settle({ roundId: dead.roundId });

        expect(settled.totalWin).toBe(0);
        expect(settled.next).toBe('IDLE');
        expect(settled.balance).toBe(dead.balance);
      });

      it('refuses the same round id carrying different parameters', async () => {
        const roundId = nextRoundId();
        const spin = await transport.spin({ roundId, stake: STAKE });
        const otherLevel = config.betLevels.find((level) => level !== STAKE) as Minor;

        const error = await rejection(transport.spin({ roundId, stake: otherLevel }));

        expect(error.code).toBe('ROUND_CONFLICT');
        expect(error.errorClass).toBe('FATAL');

        await finish(transport, roundId, spin.next);
      });
    });

    /**
     * Recovery is `authenticate` and nothing else (docs/protocol.md §5). There is no reconciliation
     * endpoint to test because there is no reconciliation endpoint: the server states where the
     * round is and which call moves it on, and the client obeys.
     */
    describe('recovery through pendingRound', () => {
      it('reports a resolved round, and finishing it from that report credits it once', async () => {
        const win = await spinUntil(transport, STAKE, (spin) => spin.next === 'SETTLE');

        const resumed = await transport.authenticate({ token });
        const pending = resumed.pendingRound;

        expect(pending?.roundId).toBe(win.roundId);
        expect(pending?.state).toBe('RESOLVED');
        expect(pending?.next).toBe('SETTLE');
        expect(pending?.stake).toBe(STAKE);
        expect(resumed.balance).toBe(win.balance);

        const settled = await transport.settle({ roundId: pending?.roundId ?? '' });
        expect(settled.balance).toBe(win.balance + settled.totalWin);

        // And the session is clean again — nothing left claiming to be in flight.
        expect((await transport.authenticate({ token })).pendingRound).toBeUndefined();
      });

      needs('forceOutcome')('reports an open feature round at the step it is on', async () => {
        const roundId = nextRoundId();
        await transport.spin({
          roundId,
          stake: STAKE,
          forceOutcome: { scenario: 'FREE_SPINS_TRIGGER' },
        });
        const first = await transport.featureSpin({ roundId, step: 1 });

        const pending = (await transport.authenticate({ token })).pendingRound;

        expect(pending?.roundId).toBe(roundId);
        expect(pending?.state).toBe(first.next === 'SETTLE' ? 'RESOLVED' : 'OPEN');
        expect(pending?.next).toBe(first.next);
        expect(pending?.feature?.step).toBe(1);
        expect(pending?.feature?.remaining).toBe(first.feature.remaining);
        // The outcome the reels have to land on is in the report, so a reload has something to draw.
        expect(pending?.result?.stops).toEqual(first.result.stops);

        const { settle } = await finish(transport, roundId, first.next, 1);
        expect(settle?.balance).toBe(START_BALANCE - STAKE + (settle?.totalWin ?? 0));
        expect((await transport.authenticate({ token })).pendingRound).toBeUndefined();
      });

      needs('unresolvedRounds')('reports a round that was debited and never resolved', async () => {
        // Only a server that can die between the debit and the outcome produces this. Both simulator
        // targets run the two inside one synchronous handler, so they declare the capability false
        // and this case is skipped by name rather than quietly untested — see the gaps registry.
        if (handle.strand === undefined) {
          throw new Error('a target claiming unresolvedRounds must implement strand()');
        }

        const roundId = await handle.strand(STAKE);
        const pending = (await transport.authenticate({ token })).pendingRound;

        expect(pending?.roundId).toBe(roundId);
        expect(pending?.state).toBe('OPEN');
        expect((await handle.state()).balance).toBe(START_BALANCE - STAKE);

        // The client re-sends the spin it never got an answer to. One debit, still.
        const spun = await transport.spin({ roundId, stake: STAKE });
        expect(spun.balance).toBe(START_BALANCE - STAKE);

        await finish(transport, roundId, spun.next);
      });
    });

    /**
     * The §5/D9 story, held at the wire: a session ends mid-round, the refusal is `PLAYER`, and
     * the lobby's renewal re-attaches to the same round — credited exactly once. Every target
     * runs this; expiry-on-every-call has had a producer in the sim since C6 and in `apps/rgs`
     * since R5.
     */
    describe('session expiry mid-round (§5, D9)', () => {
      it('refuses under an expired session, and the renewed one resumes and credits once', async () => {
        await transport.authenticate({ token });
        const win = await spinUntil(transport, STAKE, (spin) => spin.next === 'SETTLE');

        await handle.expire();
        const refused = await rejection(transport.settle({ roundId: win.roundId }));
        expect(refused.code).toBe('SESSION_EXPIRED');
        expect(refused.errorClass).toBe('PLAYER');

        // The lobby seam (§7): a renewed token onto the same player. §5 does the rest.
        const { token: renewed } = await handle.renew();
        const resumed = await transport.authenticate({ token: renewed });
        const pending = resumed.pendingRound;
        expect(pending?.roundId).toBe(win.roundId);
        expect(pending?.state).toBe('RESOLVED');
        expect(pending?.next).toBe('SETTLE');
        expect(pending?.roundWin).toBe(win.roundWin);

        const settle = await transport.settle({ roundId: win.roundId });
        expect(settle.totalWin).toBe(win.roundWin);
        expect(settle.balance).toBe(resumed.balance + win.roundWin);

        // Credited exactly once, by the server's own account.
        const snapshot = await handle.state();
        expect(snapshot.balance).toBe(settle.balance);
        expect(snapshot.rounds.filter((round) => round.roundId === win.roundId)).toHaveLength(1);
      });
    });

    /**
     * The jurisdiction's pacing rule (§2.1), server half — enforced by the sim since C6 and by
     * `apps/rgs` since R5. A dedicated instance, because the shared one deliberately serves the
     * unpaced demo regime: the whole rest of this suite is the proof that `minSpinIntervalMs: 0`
     * means what it says.
     */
    describe('the pacing rule (§2.1, R5)', () => {
      it('refuses a spin inside minSpinIntervalMs as LIMIT_REACHED; the idempotent replay is exempt', async () => {
        const paced = await target.start({
          devMode: false,
          balance: START_BALANCE,
          jurisdictionRules: {
            minSpinIntervalMs: 60_000,
            turboAllowed: true,
            autoplayAllowed: true,
            realityCheckIntervalMs: 0,
          },
        });
        try {
          const opened = await paced.reset({ balance: START_BALANCE });
          const served = await paced.transport.authenticate({ token: opened.token });
          expect(served.config.jurisdictionRules.minSpinIntervalMs).toBe(60_000);

          const first = await paced.transport.spin({ roundId: nextRoundId(), stake: STAKE });

          // The clocks these targets run on are frozen, so the second fresh spin is always
          // inside the window — and must be refused as the PLAYER class, no retry invited.
          const refused = await rejection(
            paced.transport.spin({ roundId: nextRoundId(), stake: STAKE }),
          );
          expect(refused.code).toBe('LIMIT_REACHED');
          expect(refused.errorClass).toBe('PLAYER');

          // The replay answers from the record — pacing measures accepted spins, not retries (§4).
          expect(await paced.transport.spin({ roundId: first.roundId, stake: STAKE })).toEqual(
            first,
          );

          // The server accepted exactly one round.
          expect((await paced.state()).rounds).toHaveLength(1);
        } finally {
          await paced.close();
        }
      });
    });

    /**
     * Read-only, outside the round lifecycle, and the one call a regulator asks about by name. What
     * it must never do is show a round that has not finished — that round is `pendingRound`.
     */
    describe('round history', () => {
      it('is empty for a session that has played nothing', async () => {
        const listed = await transport.history({});

        expect(listed.rounds).toEqual([]);
        expect(listed.retention).toBeGreaterThan(0);
      });

      it('lists finished rounds newest first, and agrees with what it credited', async () => {
        const rounds = [await playOut(transport, STAKE), await playOut(transport, STAKE)];

        const listed = await transport.history({});
        expect(listed.rounds).toHaveLength(2);

        const [newest, older] = listed.rounds;
        expect(newest?.at).toBeGreaterThanOrEqual(older?.at ?? 0);

        for (const played of rounds) {
          const summary = listed.rounds.find((entry) => entry.roundId === played.spin.roundId);
          expect(summary?.stake).toBe(STAKE);
          expect(summary?.freeSpins).toBe(played.steps.length);
          // The history and the credit are the same number, or the history is fiction.
          expect(summary?.totalWin).toBe(played.settle?.totalWin ?? 0);
        }
      });

      it('leaves a round still in flight out of it', async () => {
        const open = await spinUntil(transport, STAKE, (spin) => spin.next === 'SETTLE');

        const listed = await transport.history({});

        expect(listed.rounds.some((entry) => entry.roundId === open.roundId)).toBe(false);
        await finish(transport, open.roundId, open.next);
        expect((await transport.history({})).rounds[0]?.roundId).toBe(open.roundId);
      });

      it('honours a limit, and gives the newest', async () => {
        for (let round = 0; round < 3; round += 1) await playOut(transport, STAKE);

        const all = await transport.history({});
        const limited = await transport.history({ limit: 2 });

        expect(limited.rounds).toHaveLength(2);
        expect(limited.rounds).toEqual(all.rounds.slice(0, 2));
      });

      it('rejects a limit outside what it will serve', async () => {
        const error = await rejection(transport.history({ limit: 0 } as never));

        expect(error.code).toBe('SCHEMA_MISMATCH');
      });
    });

    describe('the error taxonomy', () => {
      it('refuses a stake that is not on the ladder', async () => {
        const error = await rejection(
          transport.spin({ roundId: nextRoundId(), stake: ILLEGAL_STAKE }),
        );

        expect(error.code).toBe('STAKE_NOT_ALLOWED');
        expect(error.errorClass).toBe('PLAYER');
        expect((await handle.state()).balance).toBe(START_BALANCE);
      });

      it('refuses a stake the balance cannot cover', async () => {
        const smallest = config.betLevels[0] as Minor;
        const largest = config.betLevels[config.betLevels.length - 1] as Minor;
        expect(largest).toBeGreaterThan(smallest);
        await handle.reset({ balance: smallest });

        const error = await rejection(transport.spin({ roundId: nextRoundId(), stake: largest }));

        expect(error.code).toBe('INSUFFICIENT_FUNDS');
        expect(error.errorClass).toBe('PLAYER');
        expect((await handle.state()).balance).toBe(smallest);
      });

      it('refuses to settle a round it never saw', async () => {
        const error = await rejection(transport.settle({ roundId: nextRoundId() }));

        expect(error.code).toBe('UNKNOWN_ROUND');
        expect(error.errorClass).toBe('FATAL');
      });

      it('refuses a free spin for a round it never saw', async () => {
        const error = await rejection(transport.featureSpin({ roundId: nextRoundId(), step: 1 }));

        expect(error.code).toBe('UNKNOWN_ROUND');
        expect(error.errorClass).toBe('FATAL');
      });

      it('rejects a malformed request at the boundary, not three animations later', async () => {
        const error = await rejection(
          transport.spin({ roundId: 'not-a-uuid', stake: -1 } as never),
        );

        expect(error.code).toBe('SCHEMA_MISMATCH');
        expect(error.errorClass).toBe('FATAL');
        expect((await handle.state()).rounds).toHaveLength(0);
      });

      needs('forceOutcome')('refuses a forced outcome it cannot honour', async () => {
        const error = await rejection(
          transport.spin({
            roundId: nextRoundId(),
            stake: STAKE,
            // Fewer stops than the game has reels: a request this server cannot act on.
            forceOutcome: { stops: [0] },
          }),
        );

        expect(error.code).toBe('FORCE_OUTCOME_REFUSED');
        expect(error.errorClass).toBe('FATAL');
      });

      needs('faultInjection')(
        'surfaces an upstream failure as RECOVERABLE, having moved nothing',
        async () => {
          await handle.faults({ errorRates: { WALLET_UNAVAILABLE: 1 } });

          const error = await rejection(transport.spin({ roundId: nextRoundId(), stake: STAKE }));

          expect(error.code).toBe('WALLET_UNAVAILABLE');
          expect(error.isRetryable).toBe(true);
          // Nothing happened, so a retry is a fresh attempt rather than a replay.
          const state = await handle.state();
          expect(state.balance).toBe(START_BALANCE);
          expect(state.rounds).toHaveLength(0);
        },
      );
    });

    /**
     * `forceOutcome` has two gates because one is a typo away from failing: the client cannot send
     * the field outside a dev build, and the server refuses it unless `devMode`. This exercises the
     * second — the gate that still holds once the first has regressed.
     */
    describe('the dev gate', () => {
      it('refuses forceOutcome when the server is not a dev server', async () => {
        const production = await target.start({ devMode: false, balance: START_BALANCE });
        const opened = await production.reset();
        await production.transport.authenticate({ token: opened.token });

        const error = await rejection(
          production.transport.spin({
            roundId: nextRoundId(),
            stake: STAKE,
            forceOutcome: { scenario: 'MAX_WIN' },
          }),
        );

        expect(error.code).toBe('FORCE_OUTCOME_REFUSED');
        expect(error.errorClass).toBe('FATAL');
        // Refused before anything else was considered: no round, no debit.
        const state = await production.state();
        expect(state.balance).toBe(START_BALANCE);
        expect(state.rounds).toHaveLength(0);

        await production.close();
      });
    });

    /**
     * Provable fairness (§9, D11) — the capability only a server that refuses `forceOutcome` can
     * claim, which is why both simulator targets skip these by name: a server built to be driven
     * cannot commit to its outcomes, and pretending would test fiction. The player's half of the
     * arithmetic comes from `@slot/game-math`, exactly as it would in a browser console.
     */
    describe('provable fairness', () => {
      const HEX64 = /^[0-9a-f]{64}$/;

      needs('provableFairness')(
        'publishes a commitment before the bet, honours it, and the reveal recomputes the round',
        async () => {
          const auth = await transport.authenticate({ token });
          let held = auth.fairness?.next;
          expect(held).toMatch(HEX64);

          // Two full rounds: the chain must hand each bet exactly the commitment on offer.
          for (let round = 0; round < 2; round += 1) {
            const roundId = nextRoundId();
            const spin = await transport.spin({
              roundId,
              stake: STAKE,
              clientSeed: 'players-own-entropy',
            });
            expect(spin.fairness?.commitment).toBe(held);

            const played = await finish(transport, roundId, spin.next);
            const closing = played.settle?.fairness ?? spin.fairness;
            if (played.settle !== undefined) {
              // The round needed a settle, so the spin must not have revealed anything.
              expect(spin.fairness?.reveal).toBeUndefined();
              expect(played.settle.fairness?.commitment).toBe(held);
            }
            const reveal = closing?.reveal as string;
            expect(sha256Hex(reveal)).toBe(held);

            // The player's own recomputation, step by step, from wire data alone.
            const stopsByStep = [
              spin.result.stops,
              ...played.steps.map((stepRes) => stepRes.result.stops),
            ];
            stopsByStep.forEach((stops, index) => {
              expect(stopsForStep(config, reveal, roundId, 'players-own-entropy', index)).toEqual(
                stops,
              );
            });

            held = closing?.next;
            expect(held).toMatch(HEX64);
          }
        },
      );

      // Only the target that can strand a round can test the §5 half of fairness; today that
      // target is also the only committing one, so one capability gate covers both.
      needs('unresolvedRounds')(
        'reports the stranded round’s binding on authenticate, and the resume reveals it',
        async () => {
          if (handle.strand === undefined) {
            throw new Error('a target claiming unresolvedRounds must implement strand()');
          }
          const roundId = await handle.strand(STAKE);

          const pending = (await transport.authenticate({ token })).pendingRound;
          expect(pending?.fairness?.commitment).toMatch(HEX64);

          const spin = await transport.spin({ roundId, stake: STAKE });
          expect(spin.fairness?.commitment).toBe(pending?.fairness?.commitment);

          const played = await finish(transport, roundId, spin.next);
          const closing = played.settle?.fairness ?? spin.fairness;
          expect(sha256Hex(closing?.reveal as string)).toBe(pending?.fairness?.commitment);
          expect(stopsForStep(config, closing?.reveal as string, roundId, undefined, 0)).toEqual(
            spin.result.stops,
          );
        },
      );
    });
  });
}
