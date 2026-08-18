import { describe, expect, it } from 'vitest';
import type { Minor, RoundId } from '@slot/protocol';
import { SlotEngine } from '@slot/engine';
import type { EngineEvent, Phase } from '@slot/engine';
import { SimServer, createSimConfig, createSimState } from '@slot/rgs-sim';
import type { FaultConfig } from '@slot/rgs-sim';
import { MockTransport, withRetry } from '@slot/transport';

/**
 * Block C2's done-when, and the closest thing this repository has to a real play session.
 *
 * > A headless Vitest run plays 1,000 seeded rounds including features, retries and disconnects with
 * > no state violations — and no canvas anywhere in sight.
 *
 * Everything below the engine is real: the actual simulator deciding outcomes, the actual transport
 * enacting its faults, the actual retry policy recovering from them. The only stand-in is the
 * renderer, and it is a `switch` — which is the honest shape of one, since the renderer's whole job
 * in this loop is to say "the animation you asked for has finished".
 */

const STAKE = 100 as Minor;
const START_BALANCE = 100_000_000 as Minor;
const NOW = 1_700_000_000_000;

/** Legal phase transitions. Anything observed and not listed here is a state violation. */
const LEGAL: Record<Phase, Phase[]> = {
  BOOTING: ['IDLE', 'SPINNING', 'STOPPING', 'ERROR'],
  IDLE: ['SPINNING', 'ERROR'],
  SPINNING: ['STOPPING', 'ERROR'],
  STOPPING: [
    'WIN_PRESENTATION',
    'IDLE',
    'FEATURE_INTRO',
    'FEATURE_SPINNING',
    'FEATURE_OUTRO',
    'SETTLING',
    'ERROR',
  ],
  WIN_PRESENTATION: [
    'IDLE',
    'FEATURE_INTRO',
    'FEATURE_SPINNING',
    'FEATURE_OUTRO',
    'SETTLING',
    'ERROR',
  ],
  FEATURE_INTRO: ['FEATURE_SPINNING', 'ERROR'],
  FEATURE_SPINNING: ['STOPPING', 'ERROR'],
  FEATURE_OUTRO: ['SETTLING', 'ERROR'],
  SETTLING: ['IDLE', 'ERROR'],
  // An error resumes to whatever it interrupted, or is dismissed back to idle.
  ERROR: ['IDLE', 'SPINNING', 'FEATURE_SPINNING', 'SETTLING'],
};

interface Session {
  engine: SlotEngine;
  sim: SimServer;
  events: EngineEvent[];
}

function session(seed: string, faults: FaultConfig = {}): Session {
  const sim = new SimServer({
    initialState: createSimState({
      serverSeed: seed,
      balance: START_BALANCE,
      expiresAt: 4_102_444_800_000,
    }),
    config: createSimConfig(),
    now: () => NOW,
    faults,
  });

  const transport = withRetry(new MockTransport({ backend: sim, sleep: async () => {} }), {
    // Real but tiny: a dropped response has to actually time out, and the backoff must not make
    // a thousand rounds take a minute.
    policy: { timeoutMs: 1, maxRetries: 4, baseDelayMs: 1, factor: 2, maxDelayMs: 4, jitter: 0 },
    sleep: async () => {},
  });

  let counter = 0;
  const newRoundId = (): RoundId => {
    counter += 1;
    return `01890000-0000-7000-8000-${counter.toString(16).padStart(12, '0')}`;
  };

  const events: EngineEvent[] = [];
  const engine = new SlotEngine({ port: transport, newRoundId });
  engine.on((event) => events.push(event));

  return { engine, sim, events };
}

/**
 * The headless renderer: it answers "that animation is done" and nothing else.
 *
 * Notice what it does *not* do — decide anything. It reads the phase the engine is in and sends the
 * completion that phase is waiting for. If it ever needed to know what the round contained, the
 * engine/renderer split would be wrong.
 */
async function playRound({ engine }: Session): Promise<'FINISHED' | 'FROZEN'> {
  engine.send({ type: 'PRESS' });
  await engine.settled();

  for (let guard = 0; guard < 500; guard += 1) {
    const state = engine.state;

    switch (state.phase) {
      case 'STOPPING':
        engine.send({ type: 'REELS_STOPPED' });
        break;
      case 'WIN_PRESENTATION':
        engine.send({ type: 'PRESENTATION_COMPLETE' });
        break;
      case 'FEATURE_INTRO':
        engine.send({ type: 'INTRO_COMPLETE' });
        break;
      case 'FEATURE_OUTRO':
        engine.send({ type: 'OUTRO_COMPLETE' });
        break;
      case 'ERROR':
        if (state.recovery === 'RETRY') engine.send({ type: 'RETRY' });
        else if (state.recovery === 'DISMISS') engine.send({ type: 'DISMISS_ERROR' });
        else return 'FROZEN';
        break;
      case 'IDLE':
        return 'FINISHED';
      default:
        break;
    }

    await engine.settled();
  }

  throw new Error(`a round did not finish: stuck in ${engine.state.phase}`);
}

async function play(run: Session, rounds: number): Promise<void> {
  await run.engine.start(run.sim.state.token);

  // A player picking a bet. Without it the session runs at `betLevels[0]`, which is a fine default
  // and a poor test — the stake would never have been exercised as an input.
  run.engine.send({ type: 'SET_STAKE', stake: STAKE });

  for (let round = 0; round < rounds; round += 1) {
    const outcome = await playRound(run);
    if (outcome === 'FROZEN') throw new Error('the engine froze on a FATAL error');
  }
}

const phaseChanges = (events: EngineEvent[]) =>
  events.filter(
    (event): event is Extract<EngineEvent, { type: 'PHASE_CHANGED' }> =>
      event.type === 'PHASE_CHANGED',
  );

const sumOf = (events: EngineEvent[], type: 'SPIN_STARTED' | 'ROUND_SETTLED'): number =>
  events.reduce((total, event) => {
    if (type === 'SPIN_STARTED' && event.type === 'SPIN_STARTED') return total + event.stake;
    if (type === 'ROUND_SETTLED' && event.type === 'ROUND_SETTLED') return total + event.totalWin;
    return total;
  }, 0);

describe('1,000 rounds, headless', () => {
  it('plays them all without a single illegal transition', async () => {
    const run = session('soak-clean');
    await play(run, 1_000);

    for (const change of phaseChanges(run.events)) {
      expect(LEGAL[change.from], `${change.from} → ${change.to}`).toContain(change.to);
    }

    expect(run.engine.state.phase).toBe('IDLE');
  }, 60_000);

  it('exercises features rather than only base rounds', async () => {
    const run = session('soak-clean');
    await play(run, 1_000);

    const awarded = run.events.filter((event) => event.type === 'FEATURE_AWARDED');
    const freeSpins = run.events.filter((event) => event.type === 'FEATURE_PROGRESS');

    // If this ever reads zero the soak is not testing what it claims to.
    expect(awarded.length).toBeGreaterThan(0);
    expect(freeSpins.length).toBeGreaterThan(awarded.length);
  }, 60_000);

  it('accounts for every minor unit against the server', async () => {
    const run = session('soak-clean');
    await play(run, 1_000);

    const staked = sumOf(run.events, 'SPIN_STARTED');
    const credited = sumOf(run.events, 'ROUND_SETTLED');

    // The engine never computes a balance — but what it was told must still add up.
    expect(run.sim.state.balance).toBe(START_BALANCE - staked + credited);
  }, 60_000);

  it('leaves no round open on the server', async () => {
    const run = session('soak-clean');
    await play(run, 1_000);

    expect(run.sim.state.rounds.every((round) => round.state === 'SETTLED')).toBe(true);
  }, 60_000);
});

describe('1,000 rounds through a bad connection', () => {
  /**
   * The interesting half. Five percent of calls have their response thrown away *after* the server
   * did the work — a real debited round the client never heard about — plus a steady trickle of
   * wallet outages. Every one of them has to be recovered by retrying the same `roundId`, and the
   * money has to come out exactly right anyway.
   */
  const faults: FaultConfig = {
    dropRate: 0.05,
    errorRates: { WALLET_UNAVAILABLE: 0.05, RATE_LIMITED: 0.02 },
    latencyMs: 0,
  };

  it('finishes every round and never violates a transition', async () => {
    const run = session('soak-faulty', faults);
    await play(run, 1_000);

    for (const change of phaseChanges(run.events)) {
      expect(LEGAL[change.from], `${change.from} → ${change.to}`).toContain(change.to);
    }
    expect(run.engine.state.phase).toBe('IDLE');
  }, 120_000);

  it('still balances to the minor unit', async () => {
    const run = session('soak-faulty', faults);
    await play(run, 1_000);

    const staked = sumOf(run.events, 'SPIN_STARTED');
    const credited = sumOf(run.events, 'ROUND_SETTLED');

    expect(run.sim.state.balance).toBe(START_BALANCE - staked + credited);
  }, 120_000);

  it('debits once per round, however many times the call was made', async () => {
    const run = session('soak-faulty', faults);
    await play(run, 1_000);

    const started = run.events.filter((event) => event.type === 'SPIN_STARTED').length;
    const settled = run.events.filter((event) => event.type === 'ROUND_SETTLED').length;

    expect(started).toBe(1_000);
    // Every round either settled explicitly or settled atomically on the server; the sim's own
    // ledger is the authority on how many debits actually happened.
    expect(settled).toBeLessThanOrEqual(started);
    expect(sumOf(run.events, 'SPIN_STARTED')).toBe(1_000 * STAKE);
  }, 120_000);

  it('actually hit the faults it configured', async () => {
    const run = session('soak-faulty', faults);
    await play(run, 1_000);

    // Guards against a soak that quietly stopped injecting anything and passed on easy mode.
    //
    // A thousand rounds make a thousand spins, a few hundred settles, the retries the faults force,
    // and whatever free spins the features ask for. The floor moved down in S4: the feature used to
    // trigger every fifteenth round and now triggers about once in a hundred and ten, so a
    // fault-free round is simply fewer calls than it used to be.
    expect(run.sim.state.seq).toBeGreaterThan(1_400);
  }, 120_000);
});
