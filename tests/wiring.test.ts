import { describe, expect, it } from 'vitest';
import { SlotError } from '@slot/protocol';
import { NO_FAULTS, SimServer, createSimConfig, createSimState } from '@slot/rgs-sim';
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
 * It is also the seed of the contract suite (S3): the same round, played through the seam, is what
 * will later run against `apps/mock-rgs` over HTTP and against `apps/rgs`.
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
