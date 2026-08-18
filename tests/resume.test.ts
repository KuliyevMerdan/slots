import { describe, expect, it } from 'vitest';
import { Texture } from 'pixi.js';
import type { ForceOutcome, Minor } from '@slot/protocol';
import { InMemoryStore, SimServer, createSimConfig, createSimState } from '@slot/rgs-sim';
import type { SimStore } from '@slot/rgs-sim';
import { MockTransport, withRetry } from '@slot/transport';
import { SlotEngine } from '@slot/engine';
import { GameStage } from '@slot/renderer';
import type { SymbolAtlas } from '@slot/renderer';

/**
 * **A hard refresh at five arbitrary points mid-feature resumes correctly every time.**
 *
 * That is block C5's acceptance criterion, and this is it. A "refresh" here is the real thing minus
 * the browser: the engine, the renderer and the transport are thrown away and rebuilt from nothing,
 * while the *store* survives — exactly what `localStorage` does across a page load. The simulator is
 * reconstructed from that store, so the server remembers the round and the client remembers nothing.
 *
 * Which is the whole point of the design. There is no client-side round state to restore and no
 * reconciliation dance: `authenticate` returns `pendingRound`, the engine walks into the phase that
 * continues it, and the reels land on an outcome that was decided before the reload
 * (docs/protocol.md §5).
 */

/**
 * A seed whose feature is ten free spins and no retrigger.
 *
 * Chosen deliberately, and this is what determinism is *for*: the same seed replays the same
 * feature, so a resume test is a fixed-length experiment rather than a coin toss. (The strips are
 * untuned — other seeds run to a hundred and fifty free spins, which is a note in the gaps registry
 * and S4's problem, not this test's.)
 */
const SEED = 'resume-seed-0';
const START_BALANCE = 1_000_000 as Minor;
const STAKE = 100 as Minor;
const FRAME_MS = 16.67;

const atlas: SymbolAtlas = {
  symbols: [],
  sharp: () => Texture.EMPTY,
  blurred: () => Texture.EMPTY,
  destroy: () => {},
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** One "browser tab": a simulator over a shared store, plus a fresh engine and renderer. */
class Session {
  readonly sim: SimServer;
  readonly engine: SlotEngine;
  readonly stage: GameStage;
  /**
   * Free spins entered, counted from the engine's own events.
   *
   * Not by polling the phase once a frame: a free spin is entered and left again inside a couple of
   * frames, so sampling misses most of them. The machine announces every transition — listen to it.
   */
  featureSpins = 0;
  #force: ForceOutcome | undefined;
  #ids = 0;

  constructor(store: SimStore, idOffset: number) {
    this.sim = new SimServer({
      initialState: createSimState({
        serverSeed: SEED,
        balance: START_BALANCE,
        expiresAt: 4_102_444_800_000,
      }),
      config: createSimConfig({ devMode: true }),
      store,
      now: () => 1_700_000_000_000,
    });

    this.#ids = idOffset;
    this.engine = new SlotEngine({
      port: withRetry(new MockTransport({ backend: this.sim, sleep: async () => {} })),
      newRoundId: () =>
        `01890000-0000-7000-8000-${(this.#ids += 1).toString(16).padStart(12, '0')}`,
      forceOutcome: () => {
        const outcome = this.#force;
        this.#force = undefined;
        return outcome;
      },
    });

    this.engine.on((event) => {
      if (event.type === 'PHASE_CHANGED' && event.to === 'FEATURE_SPINNING') this.featureSpins += 1;
    });

    this.stage = new GameStage({
      engine: this.engine,
      config: this.sim.config,
      atlas,
      currency: 'EUR',
    });
  }

  force(outcome: ForceOutcome): void {
    this.#force = outcome;
  }

  /** Authenticate — which is also the entire recovery path. */
  async start(): Promise<void> {
    await this.engine.start(this.sim.state.token);
  }

  /** Run frames until `stop()` says so, or the budget runs out. */
  async run(stop: () => boolean, budget = 20_000): Promise<number> {
    let frames = 0;
    while (!stop() && frames < budget) {
      this.stage.update(FRAME_MS);
      frames += 1;
      if (frames % 4 === 0) await flush();
    }
    await flush();
    return frames;
  }

  get phase(): string {
    return this.engine.state.phase;
  }

  get balance(): Minor {
    return 'balance' in this.engine.state ? this.engine.state.balance : (0 as Minor);
  }

  destroy(): void {
    this.stage.destroy();
  }
}

describe('a hard refresh mid-feature', () => {
  /**
   * Five points, chosen to hit every branch the resume path has: the intro before a single free spin
   * has been played, a free spin already resolved, the presentation between spins, the last spin,
   * and the outro after the feature has ended but before the credit lands.
   */
  it.each([
    ['during the feature intro', 'FEATURE_INTRO', 0],
    ['while a free spin is landing', 'STOPPING', 1],
    ['between free spins', 'FEATURE_SPINNING', 2],
    ['deep into the feature', 'FEATURE_SPINNING', 5],
    ['during the outro, before the credit', 'FEATURE_OUTRO', 0],
  ])('resumes correctly when the tab is closed %s', async (_case, phase, skipSpins) => {
    const store = new InMemoryStore();

    // ── the first tab: trigger a feature and play into it ──────────────────────────────────────
    const first = new Session(store, 0);
    await first.start();
    first.engine.send({ type: 'SET_STAKE', stake: STAKE });
    first.force({ scenario: 'FREE_SPINS_TRIGGER' });
    first.engine.send({ type: 'PRESS' });

    let reached = false;
    await first.run(() => {
      reached = first.phase === phase && first.featureSpins >= skipSpins;
      return reached;
    });

    expect(reached).toBe(true);
    const balanceBefore = first.sim.state.balance;
    const openRound = first.sim.state.rounds.find((round) => round.state !== 'SETTLED');
    expect(openRound).toBeDefined();
    first.destroy();

    // ── the refresh: everything client-side is gone; the store is not ──────────────────────────
    const second = new Session(store, 1_000);
    await second.start();

    // The server said where we were, and the client is there — not at an idle table with a lost
    // round, and not paid twice for one that had already resolved.
    expect(second.phase).not.toBe('IDLE');
    expect(second.balance).toBe(balanceBefore);

    // ── and the round finishes, exactly once ───────────────────────────────────────────────────
    await second.run(() => second.phase === 'IDLE');

    expect(second.phase).toBe('IDLE');
    expect(second.sim.state.rounds.every((round) => round.state === 'SETTLED')).toBe(true);
    expect(second.balance).toBe(second.sim.state.balance);

    const settled = second.sim.state.rounds.find((round) => round.roundId === openRound?.roundId);
    expect(settled?.state).toBe('SETTLED');
    // One stake, one debit, one credit — however many tabs played the round.
    expect(second.sim.state.balance).toBe(
      START_BALANCE - (settled?.stake ?? 0) + (settled?.settle?.totalWin ?? 0),
    );
    second.destroy();
  });

  it('resumes an ordinary round left mid-presentation, and credits it once', async () => {
    const store = new InMemoryStore();

    const first = new Session(store, 0);
    await first.start();
    first.engine.send({ type: 'SET_STAKE', stake: STAKE });
    first.force({ scenario: 'MAX_WIN' });
    first.engine.send({ type: 'PRESS' });
    await first.run(() => first.phase === 'WIN_PRESENTATION');
    const openRound = first.sim.state.rounds.at(-1);
    first.destroy();

    const second = new Session(store, 1_000);
    await second.start();
    await second.run(() => second.phase === 'IDLE');

    expect(second.balance).toBe(second.sim.state.balance);
    expect(
      second.sim.state.rounds.filter((round) => round.roundId === openRound?.roundId),
    ).toHaveLength(1);
  });

  /** Nothing was in flight: the client comes back to an idle table with the server's balance. */
  it('comes back to IDLE when there was no round to resume', async () => {
    const store = new InMemoryStore();

    const first = new Session(store, 0);
    await first.start();
    first.engine.send({ type: 'SET_STAKE', stake: STAKE });
    first.engine.send({ type: 'PRESS' });
    await first.run(() => first.phase === 'IDLE');
    const balance = first.sim.state.balance;
    first.destroy();

    const second = new Session(store, 1_000);
    await second.start();

    expect(second.phase).toBe('IDLE');
    expect(second.balance).toBe(balance);
  });
});
