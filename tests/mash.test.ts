import { describe, expect, it } from 'vitest';
import { Texture } from 'pixi.js';
import type { ForceOutcome, Minor } from '@slot/protocol';
import { SimServer, createSimConfig, createSimState } from '@slot/rgs-sim';
import { MockTransport, withRetry } from '@slot/transport';
import { SlotEngine } from '@slot/engine';
import { GameStage } from '@slot/renderer';
import type { SymbolAtlas } from '@slot/renderer';

/**
 * **Mash the spin button through everything and the money still has to be exactly right.**
 *
 * That sentence is block C4's acceptance criterion, and this is it as a test. Everything real is
 * real: the simulator decides the outcomes, the engine runs the round, the transport carries it, and
 * the renderer's actual `GameStage` runs the spin curve and the win presentation frame by frame. The
 * only stand-in is the texture atlas, because drawing needs a GPU and none of this is about drawing.
 *
 * The player is a loop that presses at random — while the reels spin, during a count-up, in the
 * middle of a feature — which is precisely the input pattern that breaks a naively interruptible
 * slot: a skipped presentation that pays twice, a slam that resolves the wrong round, a counter that
 * lands on a number the balance never moved by.
 *
 * The assertion is deliberately blunt: **the client's balance equals the server's, every round.**
 */

const SEED = 'mash-seed';
const START_BALANCE = 1_000_000 as Minor;
const STAKE = 100 as Minor;
const ROUNDS = 120;
const FRAME_MS = 16.67;
/**
 * A round cannot take more than this many frames; if it does, something is stuck.
 *
 * Generous on purpose: a feature is twenty free spins, each with its own reels and its own
 * presentation, so a single *round* can legitimately run for minutes of game time.
 */
const FRAME_BUDGET = 20_000;

/** Deterministic pressing: a mash you cannot replay is a bug report nobody can act on. */
const lcg = (seed: number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

const atlas: SymbolAtlas = {
  symbols: [],
  sharp: () => Texture.EMPTY,
  blurred: () => Texture.EMPTY,
  destroy: () => {},
};

/** Let every settled promise run — the transport answers in microtasks, not on a timer. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Harness {
  sim: SimServer;
  engine: SlotEngine;
  stage: GameStage;
  force(outcome: ForceOutcome | undefined): void;
  /** Every value the rolling counter published, in order. */
  amounts: number[];
  /** Every total the server asked to have presented, in order. */
  presented: number[];
}

async function harness({ turbo = false } = {}): Promise<Harness> {
  const sim = new SimServer({
    initialState: createSimState({
      serverSeed: SEED,
      balance: START_BALANCE,
      expiresAt: 4_102_444_800_000,
    }),
    config: createSimConfig({ devMode: true }),
    now: () => 1_700_000_000_000,
  });

  let pending: ForceOutcome | undefined;
  const engine = new SlotEngine({
    port: withRetry(new MockTransport({ backend: sim, sleep: async () => {} })),
    newRoundId: (() => {
      let index = 0;
      return () => `01890000-0000-7000-8000-${(index += 1).toString(16).padStart(12, '0')}`;
    })(),
    forceOutcome: () => {
      const outcome = pending;
      pending = undefined;
      return outcome;
    },
  });

  const amounts: number[] = [];
  const presented: number[] = [];
  engine.on((event) => {
    if (event.type === 'WINS_PRESENTED') presented.push(event.totalWin);
  });

  const stage = new GameStage({
    engine,
    config: sim.config,
    atlas,
    currency: 'EUR',
    onWinAmount: (amount) => amounts.push(amount),
  });
  stage.setTurbo(turbo);

  await engine.start(sim.state.token);
  engine.send({ type: 'SET_STAKE', stake: STAKE });

  return {
    sim,
    engine,
    stage,
    amounts,
    presented,
    force: (outcome) => {
      pending = outcome;
    },
  };
}

/** Play one round to completion, pressing whenever `press()` says so. */
async function playRound(
  { engine, stage }: Harness,
  press: () => boolean,
): Promise<{ frames: number; phases: Set<string> }> {
  const phases = new Set<string>();
  engine.send({ type: 'PRESS' });

  let frames = 0;
  while (engine.state.phase !== 'IDLE' && frames < FRAME_BUDGET) {
    stage.update(FRAME_MS);
    phases.add(engine.state.phase);
    if (press()) engine.send({ type: 'PRESS' });
    frames += 1;
    // Every few frames, let the transport's promises land — otherwise the round can never advance.
    if (frames % 4 === 0) await flush();
  }

  await flush();
  return { frames, phases };
}

describe('mashing the button', () => {
  it('keeps the balance exactly right for a hundred rounds of random pressing', async () => {
    const game = await harness();
    const random = lcg(0xc0ffee);
    const seen = new Set<string>();

    for (let round = 0; round < ROUNDS; round += 1) {
      const { frames, phases } = await playRound(game, () => random() < 0.12);

      for (const phase of phases) seen.add(phase);
      expect(frames).toBeLessThan(FRAME_BUDGET);
      expect(game.engine.state.phase).toBe('IDLE');
      // The client shows the server's number, every round, however hard it was interrupted.
      expect(game.engine.state).toMatchObject({ balance: game.sim.state.balance });
    }

    // The mash was worth running: it went through presentations and features, not just dead spins.
    expect(seen).toContain('WIN_PRESENTATION');
    expect(seen.has('FEATURE_SPINNING')).toBe(true);
    expect(game.sim.state.rounds.every((round) => round.state === 'SETTLED')).toBe(true);
  });

  /** The literal sentence from the roadmap: an entire max-win presentation, mashed through. */
  it('survives a max win mashed from the first frame to the last', async () => {
    const game = await harness();

    game.force({ scenario: 'MAX_WIN' });
    await playRound(game, () => true);

    while (game.engine.state.phase !== 'IDLE') {
      game.stage.update(FRAME_MS);
      game.engine.send({ type: 'PRESS' });
      await flush();
    }

    expect(game.engine.state).toMatchObject({ balance: game.sim.state.balance });
    // However many presentations were cut short, the counter ended on the number the *last* one was
    // asked to show — a skip completes the timeline, it does not abandon it.
    expect(game.amounts.at(-1)).toBe(game.presented.at(-1));
  });

  it('pays a forced max win exactly once, however many times it is pressed', async () => {
    const game = await harness();
    const before = game.sim.state.balance;

    game.force({ scenario: 'MAX_WIN' });
    await playRound(game, () => true);
    while (game.engine.state.phase !== 'IDLE') {
      game.stage.update(FRAME_MS);
      await flush();
    }

    const round = game.sim.state.rounds.at(-1);
    const credited = round?.settle?.totalWin ?? (0 as Minor);
    expect(game.sim.state.balance).toBe(before - round!.stake + credited);
    expect(game.engine.state).toMatchObject({ balance: game.sim.state.balance });
  });

  it('is faster in turbo, and just as correct', async () => {
    const ordinary = await harness({ turbo: false });
    const fast = await harness({ turbo: true });

    let ordinaryFrames = 0;
    let fastFrames = 0;
    for (let round = 0; round < 12; round += 1) {
      ordinaryFrames += (await playRound(ordinary, () => false)).frames;
      fastFrames += (await playRound(fast, () => false)).frames;
    }

    expect(fastFrames).toBeLessThan(ordinaryFrames);
    expect(fast.engine.state).toMatchObject({ balance: fast.sim.state.balance });
    expect(ordinary.engine.state).toMatchObject({ balance: ordinary.sim.state.balance });
  });
});
