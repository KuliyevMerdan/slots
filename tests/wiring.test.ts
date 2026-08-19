import { describe, expect, it } from 'vitest';
import { SlotError } from '@slot/protocol';
import { MATH_VERSION } from '@slot/game-math';
import { NO_FAULTS, SimServer, createSimConfig, createSimState } from '@slot/rgs-sim';
import { SlotEngine } from '@slot/engine';
import { MockTransport } from '@slot/transport';
import type { InProcessBackend } from '@slot/transport';

/**
 * The one test neither package can write.
 *
 * `@slot/transport` may only depend on `@slot/protocol`, so it cannot import the simulator; the
 * simulator may only reach `protocol`, `money` and `game-math`, so it cannot import the transport.
 * The two meet structurally, at a wiring site — which is exactly what `apps/game-client` will be —
 * and this suite stands in for that site until it exists.
 *
 * It is also the seed the contract suite grew from: the same round, played through the seam, now
 * runs against every registered target in `tests/contract/`.
 */

const NOW = 1_700_000_000_000;
const STAKE = 100;
const START_BALANCE = 1_000_000;
const roundId = (index: number): string =>
  `01890000-0000-7000-8000-${index.toString(16).padStart(12, '0')}`;

const simulator = (devMode = false) =>
  new SimServer({
    initialState: createSimState({
      serverSeed: 'wiring-seed',
      balance: START_BALANCE as never,
      expiresAt: 4_102_444_800_000,
    }),
    config: createSimConfig({ devMode }),
    now: () => NOW,
  });

/** No sleeping in tests: the simulator's latency is data, and this is what enacts it. */
const wire = (sim: SimServer) => {
  const waits: number[] = [];
  const transport = new MockTransport({
    backend: sim,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { transport, waits };
};

describe('SimServer satisfies InProcessBackend', () => {
  it('type-checks as the interface without either package importing the other', () => {
    // If `SimServer.deliver` ever stops matching the seam, this line stops compiling — which is the
    // assertion. The runtime check below just keeps the test honest at runtime too.
    const backend: InProcessBackend = simulator();
    expect(typeof backend.deliver).toBe('function');
  });
});

describe('a full round through MockTransport', () => {
  it('authenticates, spins and finishes whatever the server asked for', async () => {
    const sim = simulator();
    const { transport } = wire(sim);

    const session = await transport.authenticate({ token: sim.state.token });
    expect(session.balance).toBe(START_BALANCE);
    expect(session.pendingRound).toBeUndefined();

    const id = roundId(1);
    const spun = await transport.spin({ roundId: id, stake: STAKE as never });
    expect(spun.balance).toBe(START_BALANCE - STAKE);

    let next = spun.next;
    let step = 0;
    while (next === 'FEATURE_SPIN') {
      step += 1;
      const played = await transport.featureSpin({ roundId: id, step });
      next = played.next;
    }

    if (next === 'SETTLE') {
      const settled = await transport.settle({ roundId: id });
      expect(settled.next).toBe('IDLE');
      expect(settled.balance).toBe(START_BALANCE - STAKE + settled.totalWin);
    }

    expect(sim.state.rounds.every((round) => round.state === 'SETTLED')).toBe(true);
  });

  it('rejects with a classified SlotError the engine can branch on', async () => {
    const sim = simulator();
    const { transport } = wire(sim);

    await expect(transport.spin({ roundId: roundId(2), stake: 37 as never })).rejects.toMatchObject(
      { code: 'STAKE_NOT_ALLOWED', errorClass: 'PLAYER' },
    );
  });

  it('forces an outcome on demand in devMode', async () => {
    const sim = simulator(true);
    const { transport } = wire(sim);

    const spun = await transport.spin({
      roundId: roundId(3),
      stake: STAKE as never,
      forceOutcome: { scenario: 'FREE_SPINS_TRIGGER' },
    });

    expect(spun.next).toBe('FEATURE_SPIN');
    expect(spun.feature?.remaining).toBeGreaterThan(0);
  });
});

describe('faults, end to end', () => {
  it('enacts the latency the simulator decided', async () => {
    const sim = simulator();
    sim.setFaults({ latencyMs: 180 });
    const { transport, waits } = wire(sim);

    await transport.authenticate({ token: sim.state.token });

    expect(waits).toEqual([180]);
  });

  it('surfaces an injected error as a retryable SlotError', async () => {
    const sim = simulator();
    sim.setFaults({ errorRates: { WALLET_UNAVAILABLE: 1 } });
    const { transport } = wire(sim);

    const failure = await transport
      .spin({ roundId: roundId(4), stake: STAKE as never })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SlotError);
    expect((failure as SlotError).isRetryable).toBe(true);
    // Nothing happened server-side, so a retry is a fresh attempt.
    expect(sim.state.balance).toBe(START_BALANCE);
  });

  /**
   * The scenario the whole idempotency design exists for, played out through the real seam: the
   * spin lands, the response is lost, the client never learns the outcome — and recovers by
   * re-authenticating and retrying the same `roundId`, receiving the original answer and one debit.
   */
  it('survives a lost response mid-round', async () => {
    const sim = simulator();
    sim.setFaults({ dropRate: 1 });
    const { transport } = wire(sim);

    const id = roundId(5);
    const hung = await Promise.race([
      transport.spin({ roundId: id, stake: STAKE as never }).then(() => 'answered'),
      new Promise((resolve) => setTimeout(() => resolve('never answered'), 20)),
    ]);

    expect(hung).toBe('never answered');
    expect(sim.state.balance).toBe(START_BALANCE - STAKE);

    // The link recovers. The client reconnects and is told exactly where it stands.
    sim.setFaults(NO_FAULTS);
    const resumed = await transport.authenticate({ token: sim.state.token });
    expect(resumed.balance).toBe(START_BALANCE - STAKE);

    const retried = await transport.spin({ roundId: id, stake: STAKE as never });
    expect(retried.roundId).toBe(id);
    expect(sim.state.balance).toBe(START_BALANCE - STAKE);
    expect(sim.state.rounds).toHaveLength(1);
  });
});

/**
 * The §5 mid-round expiry recovery, against the real simulator (docs/protocol.md §5, D9).
 *
 * The engine's own tests prove the machine against a stub; this proves the whole seam — the sim
 * expires the session mid-feature, the transport carries the `SESSION_EXPIRED`, the engine renews
 * through the same lobby that issued the boot token, and the feature resumes at the step it was on.
 */
describe('a session that expires mid-feature', () => {
  it('renews transparently and finishes the round, credited once', async () => {
    const sim = simulator(true);
    const transport = new MockTransport({ backend: sim, sleep: async () => {} });

    // One forced trigger, so the round deterministically owes free spins — the same one-shot shape
    // the client wires behind `__DEV_TOOLS__`, permitted here because the sim is in devMode.
    let force: { scenario: 'FREE_SPINS_TRIGGER' } | undefined = { scenario: 'FREE_SPINS_TRIGGER' };
    let renewals = 0;
    const engine = new SlotEngine({
      port: transport,
      newRoundId: () => roundId(70),
      forceOutcome: () => {
        const outcome = force;
        force = undefined;
        return outcome;
      },
      renewSession: () => {
        renewals += 1;
        return Promise.resolve(sim.issueSession().token);
      },
    });

    await engine.start(sim.issueSession().token);
    expect(engine.state.phase).toBe('IDLE');

    engine.send({ type: 'PRESS' });
    await engine.settled();

    // Drive the round; the first time the feature is about to ask for a spin, kill the session
    // under it. The next `featureSpin` fails SESSION_EXPIRED and the machine must renew, resume
    // from `pendingRound` and carry the feature home — with no ERROR phase ever observed.
    let expiredOnce = false;
    for (let guard = 0; guard < 60 && engine.state.phase !== 'IDLE'; guard += 1) {
      const phase = engine.state.phase;
      if (phase === 'FEATURE_INTRO' && !expiredOnce) {
        expiredOnce = true;
        sim.expireSession();
      }
      if (phase === 'STOPPING') engine.send({ type: 'REELS_STOPPED' });
      else if (phase === 'WIN_PRESENTATION') engine.send({ type: 'PRESENTATION_COMPLETE' });
      else if (phase === 'FEATURE_INTRO') engine.send({ type: 'INTRO_COMPLETE' });
      else if (phase === 'FEATURE_OUTRO') engine.send({ type: 'OUTRO_COMPLETE' });
      await engine.settled();
      expect(engine.state.phase).not.toBe('ERROR');
    }

    expect(expiredOnce).toBe(true);
    expect(renewals).toBeGreaterThanOrEqual(1);
    expect(engine.state.phase).toBe('IDLE');

    // One round, one settle, and both sides agree on the money.
    expect(sim.state.rounds.filter((round) => round.state === 'SETTLED')).toHaveLength(1);
    expect(engine.state.phase === 'IDLE' && engine.state.balance).toBe(sim.state.balance);
  });
});

/**
 * The versions meet here, and nowhere else.
 *
 * `GameConfig.mathVersion` says what the server pays on; `@slot/game-math`'s `MATH_VERSION` says
 * what this build's evaluator implements. Every unit test in the workspace builds both from the same
 * package, so the two agree by construction — which is exactly why the check has to be proved at a
 * wiring site: a deployed server and a deployed client are two builds, and this is the only thing
 * that puts their versions side by side. S4 already moved the version once.
 */
describe('a server paying on different math', () => {
  const engineAgainst = (mathVersion: string) => {
    const sim = new SimServer({
      initialState: createSimState({
        serverSeed: 'math-version-seed',
        balance: START_BALANCE as never,
        expiresAt: 4_102_444_800_000,
      }),
      config: { ...createSimConfig(), mathVersion },
      now: () => NOW,
    });

    return {
      sim,
      engine: new SlotEngine({
        port: new MockTransport({ backend: sim }),
        newRoundId: () => roundId(90),
      }),
    };
  };

  it('boots normally when the two agree', async () => {
    const { sim, engine } = engineAgainst(MATH_VERSION);

    await engine.start(sim.state.token);

    expect(engine.state.phase).toBe('IDLE');
  });

  it('freezes instead of presenting a game it cannot reproduce', async () => {
    const { sim, engine } = engineAgainst('1.0.0');

    await engine.start(sim.state.token);

    expect(engine.state).toMatchObject({ phase: 'ERROR', recovery: 'FROZEN' });
    expect(engine.state.phase === 'ERROR' && engine.state.error.code).toBe('MATH_VERSION_MISMATCH');
    // Nothing was spun, so nothing has to be unwound: the gate is on the way in.
    expect(sim.state.rounds).toHaveLength(0);
  });
});
