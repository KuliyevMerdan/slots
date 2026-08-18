import { afterEach, describe, expect, it } from 'vitest';
import type { Minor, RoundId } from '@slot/protocol';
import { SlotEngine } from '@slot/engine';
import type { EngineEvent } from '@slot/engine';
import { SimServer, createSimConfig, createSimState } from '@slot/rgs-sim';
import { buildApp } from '@slot/mock-rgs';
import { HttpTransport, withRetry } from '@slot/transport';

/**
 * The soak, over a socket.
 *
 * `tests/soak.test.ts` plays a thousand rounds in process, which proves the engine, the retry policy
 * and the simulator survive each other — and proves nothing at all about the wire. The failures this
 * one is looking for only exist on a connection: a hijacked reply that is never reclaimed, a socket
 * pool that grows until the run stalls, a server that answers correctly for fifty rounds and drifts
 * on the five hundredth, a timeout that rejects the caller and leaves the request holding a socket
 * until the server answers into nothing.
 *
 * So it is deliberately *not* a copy of the in-process soak at a different base URL. It runs fewer
 * rounds — a real HTTP round trip is a thousand times slower than a function call, and a suite
 * nobody can afford to run is a suite nobody runs — and it turns the faults up, because every one of
 * the interesting failures is a failure of recovery rather than of arithmetic.
 */

const STAKE = 100 as Minor;
const START_BALANCE = 10_000_000 as Minor;
const NOW = 1_700_000_000_000;
/**
 * Enough to exercise features, retries and drops; small enough to stay a test rather than an errand.
 *
 * A feature triggers about once in 110 rounds, so a hundred would be a coin toss on whether the
 * free-spin path is covered at all — and a seeded coin toss is worse than none, because it looks
 * deterministic while depending on a number nobody chose.
 */
const ROUNDS = 300;

interface Run {
  engine: SlotEngine;
  sim: SimServer;
  events: EngineEvent[];
  /** Every retry the policy performed, by code — proof the faults fired and were recovered from. */
  retries: string[];
  close: () => Promise<void>;
}

const servers: Array<() => Promise<void>> = [];

afterEach(async () => {
  // A leaked server is exactly the failure mode under test, so teardown is not best-effort here:
  // `close()` waits for connections, and a hijacked reply that was never reclaimed makes it hang.
  for (const close of servers.splice(0)) await close();
});

async function start(
  seed: string,
  faults: Parameters<SimServer['setFaults']>[0] = {},
): Promise<Run> {
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

  const app = buildApp({ sim });
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  servers.push(() => app.close());

  const retries: string[] = [];
  const transport = withRetry(new HttpTransport({ baseUrl }), {
    // A dropped response has to actually time out, and the backoff must not turn the run into a
    // coffee break. Short but real — the abort these produce is the thing being tested.
    policy: { timeoutMs: 60, maxRetries: 4, baseDelayMs: 1, factor: 2, maxDelayMs: 8, jitter: 0 },
    onRetry: (attempt) => retries.push(attempt.error.code),
  });

  let counter = 0;
  const newRoundId = (): RoundId =>
    `01890000-0000-7000-8000-${(counter += 1).toString(16).padStart(12, '0')}`;

  const events: EngineEvent[] = [];
  const engine = new SlotEngine({ port: transport, newRoundId });
  engine.on((event) => events.push(event));

  return { engine, sim, events, retries, close: () => app.close() };
}

/** The headless renderer: it answers "that animation is done", and decides nothing. */
async function playRound(engine: SlotEngine): Promise<'FINISHED' | 'FROZEN'> {
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

describe(`${String(ROUNDS)} rounds over a real connection`, () => {
  it('keeps the client and the server agreeing on the money, round after round', async () => {
    const run = await start('http-soak-clean');
    await run.engine.start(run.sim.state.token);
    run.engine.send({ type: 'SET_STAKE', stake: STAKE });

    for (let round = 0; round < ROUNDS; round += 1) {
      expect(await playRound(run.engine)).toBe('FINISHED');

      const state = run.engine.state;
      // The client never computes a balance, so this is not arithmetic agreeing with arithmetic —
      // it is the last number the server sent agreeing with the number the server holds.
      expect('balance' in state ? state.balance : -1).toBe(run.sim.state.balance);
    }

    expect(run.engine.state.phase).toBe('IDLE');
    // Nothing left open: every round that took money gave an answer and was credited.
    expect(run.sim.state.rounds.every((round) => round.state === 'SETTLED')).toBe(true);
  }, 120_000);

  it('exercises features rather than only base rounds', async () => {
    const run = await start('http-soak-clean');
    await run.engine.start(run.sim.state.token);
    run.engine.send({ type: 'SET_STAKE', stake: STAKE });

    for (let round = 0; round < ROUNDS; round += 1) await playRound(run.engine);

    expect(run.events.filter((event) => event.type === 'FEATURE_AWARDED').length).toBeGreaterThan(
      0,
    );
  }, 120_000);

  /**
   * The one this file exists for.
   *
   * Every fault is enacted on the connection rather than on a promise: a rejected call is a real
   * status code, and a dropped one is a socket held open saying nothing until the client's own clock
   * ends the wait. Sustain that for a hundred rounds and a leak has somewhere to show itself — in
   * the balance, in a round left open, or in a `close()` at the end that never returns.
   */
  it('survives a bad line without losing or duplicating a single round', async () => {
    const run = await start('http-soak-faulty', {
      latencyMs: 1,
      dropRate: 0.05,
      slowRate: 0.05,
      slowMs: 30,
      errorRates: { WALLET_UNAVAILABLE: 0.04, RATE_LIMITED: 0.03 },
    });

    await run.engine.start(run.sim.state.token);
    run.engine.send({ type: 'SET_STAKE', stake: STAKE });

    let played = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      const outcome = await playRound(run.engine);
      if (outcome === 'FROZEN') throw new Error('a FATAL error on a merely unreliable link');
      played += 1;

      const state = run.engine.state;
      expect('balance' in state ? state.balance : -1).toBe(run.sim.state.balance);
    }

    expect(played).toBe(ROUNDS);
    // One press, one round: a retry replays rather than re-spins, however many times it went out.
    expect(run.sim.state.rounds.filter((round) => round.state !== 'SETTLED')).toHaveLength(0);

    // And the faults really fired — otherwise this is the clean test with extra steps. They are
    // counted at the *retry*, not at `ERROR_RAISED`: the policy absorbing them before the engine
    // ever sees one is the correct outcome, not a missing assertion.
    expect(run.retries.length).toBeGreaterThan(0);
    // Dropped responses become the client's own timeout, which is the case worth naming.
    expect(run.retries).toContain('TIMEOUT');
  }, 180_000);

  /**
   * The leak, asserted directly.
   *
   * A dropped response is served by hijacking the reply and holding the socket open. Fastify's
   * `close()` waits for open connections — so a server that forgot to track those sockets waits for
   * a connection that is, by construction, waiting forever. This is the shutdown that would hang,
   * and the reason it is a test rather than a comment in `app.ts`.
   */
  it('shuts down cleanly with a hundred deliberately abandoned responses in flight', async () => {
    const sim = new SimServer({
      initialState: createSimState({
        serverSeed: 'http-soak-drops',
        balance: START_BALANCE,
        expiresAt: 4_102_444_800_000,
      }),
      config: createSimConfig(),
      now: () => NOW,
      faults: { dropRate: 1 },
    });

    const app = buildApp({ sim });
    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    // No retry policy: these calls are meant to hang, not to recover.
    const transport = new HttpTransport({ baseUrl });

    const inFlight = 100;
    const abandoned = Array.from({ length: inFlight }, (_unused, index) =>
      transport
        .spin({
          roundId: `01890000-0000-7000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
          stake: STAKE,
        })
        // They settle only when shutdown destroys the socket underneath them, which is precisely
        // what is being asserted — and an unhandled rejection would fail the run.
        .catch(() => undefined),
    );

    // Wait for the server to have actually run them: the promises above are requests in flight, and
    // asserting on the state before they land would pass for the wrong reason.
    for (let wait = 0; wait < 200 && sim.state.rounds.length < inFlight; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Every one was executed server-side and its answer thrown away: a hundred debited rounds nobody
    // has seen, which is exactly the state idempotency exists for.
    expect(sim.state.rounds).toHaveLength(inFlight);

    await expect(app.close()).resolves.toBeUndefined();
    await Promise.all(abandoned);
  }, 60_000);
});
