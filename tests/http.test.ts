import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Minor, SpinRes } from '@slot/protocol';
import { SlotError } from '@slot/protocol';
import { SimServer, createSimConfig, createSimState } from '@slot/rgs-sim';
import { buildApp } from '@slot/mock-rgs';
import { HttpTransport, MockTransport, withRetry } from '@slot/transport';
import type { RgsTransport } from '@slot/transport';

/** Fastify's own type, without making the root workspace depend on Fastify to name it. */
type MockRgs = ReturnType<typeof buildApp>;

/**
 * The claim, tested: **the client runs identically against `MockTransport` and `HttpTransport`.**
 *
 * Two simulators with the same seed, two transports, one round played through each — and the
 * responses have to be equal, field for field. That is a stronger statement than "both work": it
 * says the network path adds latency and failure modes and *nothing else*, which is the entire
 * reason swapping the transport can be a config change rather than a refactor.
 *
 * It runs at the root for the same reason `wiring.test.ts` does: no package may import all the
 * pieces, and `apps/game-client` (C3) is the site that eventually will. It is also the second seed
 * of the contract suite (S3) — the same round, now against a target reached over a socket.
 */

const SEED = 'http-parity-seed';
const NOW = 1_700_000_000_000;
const STAKE = 100 as Minor;
const START_BALANCE = 1_000_000 as Minor;
const roundId = (index: number): string =>
  `01890000-0000-7000-8000-${index.toString(16).padStart(12, '0')}`;

const simulator = (): SimServer =>
  new SimServer({
    initialState: createSimState({
      serverSeed: SEED,
      balance: START_BALANCE,
      expiresAt: 4_102_444_800_000,
    }),
    config: createSimConfig({ devMode: true }),
    now: () => NOW,
  });

/** Play one whole round, whatever shape the server says it has. */
async function playRound(
  transport: RgsTransport,
  id: string,
): Promise<{ spin: SpinRes; balance: Minor; steps: number }> {
  const spin = await transport.spin({ roundId: id, stake: STAKE });

  let next = spin.next;
  let balance = spin.balance;
  let steps = 0;

  while (next === 'FEATURE_SPIN') {
    steps += 1;
    const played = await transport.featureSpin({ roundId: id, step: steps });
    next = played.next;
    balance = played.balance;
  }

  if (next === 'SETTLE') {
    const settled = await transport.settle({ roundId: id });
    balance = settled.balance;
  }

  return { spin, balance, steps };
}

describe('the same simulator, reached two ways', () => {
  let served: SimServer;
  let app: MockRgs;
  let http: RgsTransport;
  let inProcess: SimServer;
  let mock: RgsTransport;

  beforeAll(async () => {
    served = simulator();
    app = buildApp({ sim: served });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    http = new HttpTransport({ baseUrl: address });
    inProcess = simulator();
    mock = new MockTransport({ backend: inProcess });
  });

  afterAll(async () => {
    await app.close();
  });

  it('authenticates to the same session, balance and config', async () => {
    const overHttp = await http.authenticate({ token: served.state.token });
    const inMemory = await mock.authenticate({ token: inProcess.state.token });

    expect(overHttp).toEqual(inMemory);
  });

  /** Same seed, same round id, same stake — so the outcome must be identical, not merely similar. */
  it('plays a round to the same outcome, field for field', async () => {
    const id = roundId(1);

    const overHttp = await playRound(http, id);
    const inMemory = await playRound(mock, id);

    expect(overHttp.spin.result.stops).toEqual(inMemory.spin.result.stops);
    expect(overHttp).toEqual(inMemory);
    expect(served.state.balance).toBe(inProcess.state.balance);
  });

  it('produces the same forced outcome for the same scenario', async () => {
    const id = roundId(2);
    const forced = { scenario: 'MAX_WIN' } as const;

    const overHttp = await http.spin({ roundId: id, stake: STAKE, forceOutcome: forced });
    const inMemory = await mock.spin({ roundId: id, stake: STAKE, forceOutcome: forced });

    expect(overHttp).toEqual(inMemory);
  });

  it('refuses an illegal stake with the same classified error', async () => {
    const bad = { roundId: roundId(3), stake: 37 as Minor };

    const overHttp = await http.spin(bad).catch((error: unknown) => error);
    const inMemory = await mock.spin(bad).catch((error: unknown) => error);

    expect(overHttp).toBeInstanceOf(SlotError);
    expect((overHttp as SlotError).code).toBe((inMemory as SlotError).code);
    expect((overHttp as SlotError).errorClass).toBe('PLAYER');
  });

  it('replays a duplicate spin over HTTP, exactly as it does in process', async () => {
    const id = roundId(4);

    const first = await http.spin({ roundId: id, stake: STAKE });
    const again = await http.spin({ roundId: id, stake: STAKE });

    expect(again).toEqual(first);
  });
});

/**
 * The scenario the whole design exists for, over a real socket this time.
 *
 * The spin lands, the money moves, and the response never arrives — the connection simply goes
 * quiet. The retry policy's clock ends the wait, the *same* `roundId` goes back out, and the server
 * replays the original answer. One press, one debit, one round, and the player sees a spin that took
 * slightly too long.
 */
describe('a lost response, over a real connection', () => {
  it('times out, retries the same round, and is given the original answer', async () => {
    const sim = simulator();
    const app = buildApp({ sim });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    const retries: string[] = [];
    const transport = withRetry(new HttpTransport({ baseUrl: address }), {
      policy: { timeoutMs: 200, maxRetries: 2, baseDelayMs: 1, jitter: 0 },
      onRetry: (attempt) => {
        retries.push(attempt.error.code);
        // The link recovers between attempts. Everything before this point is a real dropped
        // response on a real socket.
        sim.setFaults({});
      },
    });

    sim.setFaults({ dropRate: 1 });
    const id = roundId(5);
    const spun = await transport.spin({ roundId: id, stake: STAKE });

    expect(retries).toEqual(['TIMEOUT']);
    expect(spun.roundId).toBe(id);
    // One round, one debit — the retry replayed rather than re-spun.
    expect(sim.state.rounds).toHaveLength(1);
    expect(sim.state.balance).toBe(START_BALANCE - STAKE);

    await app.close();
  });
});
