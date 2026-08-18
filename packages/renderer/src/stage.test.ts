import { describe, expect, it, vi } from 'vitest';
import { Texture } from 'pixi.js';
import type { GameConfig } from '@slot/protocol';
import type { EngineEvent, EngineInput, EngineState } from '@slot/engine';
import type { Win } from '@slot/protocol';
import { GameStage } from './stage.js';
import type { SymbolAtlas } from './atlas.js';

/**
 * The stage, driven headless.
 *
 * Pixi's scene graph — containers, sprites, graphics — is ordinary JavaScript until something asks
 * it to draw, so everything except the atlas runs in Node. The atlas is an *interface*, which is
 * what makes this possible: a fake that returns one empty texture stands in for the generated sheet,
 * and the reels, the curve and the event wiring are all real.
 *
 * What is asserted here is the contract between the engine and the renderer, in both directions:
 * the events the stage reacts to, and the two inputs it is the sole source of.
 */

const STRIP = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const ROWS = 3;

const atlas: SymbolAtlas = {
  symbols: STRIP,
  sharp: () => Texture.EMPTY,
  blurred: () => Texture.EMPTY,
  destroy: () => {},
};

const config = {
  strips: [STRIP, STRIP, STRIP, STRIP, STRIP],
  rows: ROWS,
  paylines: [
    [1, 1, 1, 1, 1],
    [0, 0, 0, 0, 0],
  ],
} as unknown as GameConfig;

/** A stand-in for `SlotEngine`: it records inputs and lets a test publish any event it likes. */
class FakeEngine {
  readonly sent: EngineInput[] = [];
  readonly #listeners = new Set<(event: EngineEvent, state: EngineState) => void>();

  on(listener: (event: EngineEvent, state: EngineState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  send(input: EngineInput): unknown {
    this.sent.push(input);
    return undefined;
  }

  emit(event: EngineEvent, state: EngineState = { phase: 'IDLE' } as EngineState): void {
    for (const listener of this.#listeners) listener(event, state);
  }

  get types(): string[] {
    return this.sent.map((input) => input.type);
  }
}

const viewFor = (stops: readonly number[]): string[][] =>
  stops.map((stop) =>
    Array.from({ length: ROWS }, (_u, row) => STRIP[(stop + row) % STRIP.length] ?? ''),
  );

const build = () => {
  const engine = new FakeEngine();
  const mismatches: unknown[] = [];
  const amounts: number[] = [];
  const stage = new GameStage({
    engine,
    config,
    atlas,
    currency: 'EUR',
    onGridMismatch: (expected, drawn) => mismatches.push({ expected, drawn }),
    onWinAmount: (amount) => amounts.push(amount),
  });
  return { engine, stage, mismatches, amounts };
};

const LINE_WIN = {
  kind: 'LINE',
  line: 0,
  symbol: 'A',
  count: 3,
  positions: [
    [0, 1],
    [1, 1],
    [2, 1],
  ],
  amount: 300,
} as unknown as Win;

const SCATTER_WIN = {
  kind: 'SCATTER',
  symbol: 'C',
  count: 3,
  positions: [
    [0, 0],
    [2, 2],
    [4, 1],
  ],
  amount: 200,
} as unknown as Win;

/** Put the machine where a win presentation happens: a phase change, then what to present. */
const present = (engine: FakeEngine, totalWin: number, stake = 100) => {
  engine.emit({ type: 'PHASE_CHANGED', from: 'STOPPING', to: 'WIN_PRESENTATION' });
  engine.emit(
    { type: 'WINS_PRESENTED', wins: [LINE_WIN, SCATTER_WIN], totalWin: totalWin as never },
    { phase: 'WIN_PRESENTATION', stake } as unknown as EngineState,
  );
};

/** Run frames until the stage reports the reels stopped, or give up. */
const runToStop = (stage: GameStage, engine: FakeEngine, frames = 800): void => {
  for (let frame = 0; frame < frames; frame += 1) {
    stage.update(16.67);
    if (engine.types.includes('REELS_STOPPED')) return;
  }
};

describe('the engine drives the reels', () => {
  it('starts them on SPIN_STARTED and lands them on the server’s stops', () => {
    const { engine, stage } = build();
    const stops = [3, 5, 0, 7, 2];

    engine.emit({ type: 'SPIN_STARTED', roundId: 'r', stake: 20 as never });
    expect(stage.reels.spinning).toBe(true);

    engine.emit({ type: 'REELS_TARGETED', stops, view: viewFor(stops), slam: false });
    runToStop(stage, engine);

    expect(engine.types).toContain('REELS_STOPPED');
    expect(stage.reels.grid()).toEqual(viewFor(stops));
  });

  /**
   * The dev-build assertion, and the reason it exists: if the reels ever draw something other than
   * the grid the server committed to, the client is showing the player a different game.
   */
  it('reports nothing to the mismatch hook when it drew what the server sent', () => {
    const { engine, stage, mismatches } = build();
    const stops = [1, 6, 4, 0, 5];

    engine.emit({ type: 'SPIN_STARTED', roundId: 'r', stake: 20 as never });
    engine.emit({ type: 'REELS_TARGETED', stops, view: viewFor(stops), slam: false });
    runToStop(stage, engine);

    expect(mismatches).toEqual([]);
  });

  it('reports a mismatch when the server’s view disagrees with its own stops', () => {
    const { engine, stage, mismatches } = build();
    const stops = [1, 6, 4, 0, 5];
    const lying = viewFor([2, 6, 4, 0, 5]);

    engine.emit({ type: 'SPIN_STARTED', roundId: 'r', stake: 20 as never });
    engine.emit({ type: 'REELS_TARGETED', stops, view: lying, slam: false });
    runToStop(stage, engine);

    expect(mismatches).toHaveLength(1);
  });

  /**
   * Resume: `authenticate` hands back a round that was left open, and the engine walks into the
   * phase that continues it — targeting reels that were never started. Before this was handled, the
   * client hung at boot on reels that would never move.
   */
  it('starts reels that were never spun when a target arrives, and still lands on the stops', () => {
    const { engine, stage } = build();
    const stops = [2, 4, 6, 1, 3];

    engine.emit({ type: 'REELS_TARGETED', stops, view: viewFor(stops), slam: false });
    runToStop(stage, engine);

    expect(engine.types).toContain('REELS_STOPPED');
    expect(stage.reels.grid()).toEqual(viewFor(stops));
  });

  it('re-spins for a free spin, which arrives as a phase change rather than a SPIN_STARTED', () => {
    const { engine, stage } = build();

    engine.emit({ type: 'PHASE_CHANGED', from: 'FEATURE_INTRO', to: 'FEATURE_SPINNING' });

    expect(stage.reels.spinning).toBe(true);
  });

  it('sends REELS_STOPPED exactly once per spin', () => {
    const { engine, stage } = build();
    const stops = [0, 1, 2, 3, 4];

    engine.emit({ type: 'SPIN_STARTED', roundId: 'r', stake: 20 as never });
    engine.emit({ type: 'REELS_TARGETED', stops, view: viewFor(stops), slam: false });
    for (let frame = 0; frame < 900; frame += 1) stage.update(16.67);

    expect(engine.sent.filter((input) => input.type === 'REELS_STOPPED')).toHaveLength(1);
  });
});

describe('interruption', () => {
  it('slams the reels when the engine says the skip was legal', () => {
    const ordinary = build();
    const slammed = build();
    const stops = [4, 4, 4, 4, 4];

    for (const { engine } of [ordinary, slammed]) {
      engine.emit({ type: 'SPIN_STARTED', roundId: 'r', stake: 20 as never });
      engine.emit({ type: 'REELS_TARGETED', stops, view: viewFor(stops), slam: false });
    }
    slammed.engine.emit({ type: 'SKIPPED', phase: 'SPINNING' });

    const framesTo = ({ engine, stage }: ReturnType<typeof build>): number => {
      let frames = 0;
      while (!engine.types.includes('REELS_STOPPED') && frames < 900) {
        stage.update(16.67);
        frames += 1;
      }
      return frames;
    };

    const slammedFrames = framesTo(slammed);
    const ordinaryFrames = framesTo(ordinary);

    expect(slammedFrames).toBeLessThan(ordinaryFrames);
    // Sooner, and on the same outcome — which is the whole point of a slam stop.
    expect(slammed.stage.reels.grid()).toEqual(ordinary.stage.reels.grid());
  });
});

describe('the win presentation', () => {
  it('reports itself complete once the sequence has run', () => {
    const { engine, stage } = build();

    present(engine, 700);
    stage.update(100);
    expect(engine.types).not.toContain('PRESENTATION_COMPLETE');

    for (let frame = 0; frame < 400; frame += 1) stage.update(16.67);
    expect(engine.types).toContain('PRESENTATION_COMPLETE');
  });

  it('rolls the amount up and always ends on the total the server sent', () => {
    const { engine, stage, amounts } = build();

    present(engine, 500);
    for (let frame = 0; frame < 400; frame += 1) stage.update(16.67);

    expect(amounts.length).toBeGreaterThan(5);
    expect(Math.max(...amounts)).toBe(500);
    expect(amounts.at(-1)).toBe(500);
    // It counts *up*: no frame may show more than the final figure.
    for (const amount of amounts) expect(amount).toBeLessThanOrEqual(500);
  });

  /**
   * The done-when of this block, at the level that implements it: a skipped presentation must leave
   * exactly what a finished one leaves — the final number, and nothing still lit.
   */
  /**
   * A phase that owes the engine an input must never be left without one. Every screen is built from
   * the event carrying its data, so this cannot happen — and if it ever did, the round would hang
   * forever, which is why the stage recovers on the next frame instead.
   */
  it('never leaves a waiting phase without an answer', () => {
    const { engine, stage } = build();

    engine.emit({ type: 'PHASE_CHANGED', from: 'STOPPING', to: 'WIN_PRESENTATION' });
    // No `WINS_PRESENTED`: an ordering nobody produces, and a hang if it were ever produced.
    for (let frame = 0; frame < 5; frame += 1) stage.update(16.67);

    expect(engine.types).toContain('PRESENTATION_COMPLETE');
  });

  it('leaves the same state whether it is skipped or finished', () => {
    const played = build();
    const skipped = build();

    present(played.engine, 4_000);
    for (let frame = 0; frame < 600; frame += 1) played.stage.update(16.67);

    present(skipped.engine, 4_000);
    skipped.stage.update(16.67);
    skipped.engine.emit({ type: 'SKIPPED', phase: 'WIN_PRESENTATION' });

    expect(skipped.amounts.at(-1)).toBe(played.amounts.at(-1));
    expect(skipped.amounts.at(-1)).toBe(4_000);
  });

  /**
   * The engine advances *itself* on a skip, so a presentation that fired its completion afterwards
   * would deliver an input the new phase cannot service.
   */
  it('does not report completion after a skip', () => {
    const { engine, stage } = build();

    present(engine, 900);
    stage.update(16.67);
    engine.emit({ type: 'SKIPPED', phase: 'WIN_PRESENTATION' });
    engine.emit({ type: 'PHASE_CHANGED', from: 'WIN_PRESENTATION', to: 'SETTLING' });
    for (let frame = 0; frame < 400; frame += 1) stage.update(16.67);

    expect(engine.types).not.toContain('PRESENTATION_COMPLETE');
  });

  it('is instant when the spin paid nothing', () => {
    const { engine, stage } = build();

    engine.emit({ type: 'PHASE_CHANGED', from: 'STOPPING', to: 'WIN_PRESENTATION' });
    engine.emit({ type: 'WINS_PRESENTED', wins: [], totalWin: 0 as never }, {
      phase: 'WIN_PRESENTATION',
      stake: 100,
    } as unknown as EngineState);
    stage.update(16.67);

    expect(engine.types).toContain('PRESENTATION_COMPLETE');
  });

  it('is shorter in turbo', () => {
    const framesFor = (turbo: boolean): number => {
      const { engine, stage } = build();
      stage.setTurbo(turbo);
      present(engine, 6_000);
      let frames = 0;
      while (!engine.types.includes('PRESENTATION_COMPLETE') && frames < 2_000) {
        stage.update(16.67);
        frames += 1;
      }
      return frames;
    };

    expect(framesFor(true)).toBeLessThan(framesFor(false));
  });
});

describe('attaching to a round already in motion', () => {
  /**
   * The client cannot build a stage until `authenticate` has answered, so a resumed round is
   * announced before anything is listening. Without `attach`, the reels sit still and the engine
   * waits forever for a `REELS_STOPPED` nobody will send — which is exactly how a reload mid-feature
   * used to hang.
   */
  it('lands reels the engine targeted before this stage existed', () => {
    const { engine, stage } = build();
    const stops = [5, 2, 7, 0, 4];

    stage.attach({
      phase: 'STOPPING',
      result: { stops, view: viewFor(stops) },
      stake: 100,
    } as unknown as EngineState);
    runToStop(stage, engine);

    expect(engine.types).toContain('REELS_STOPPED');
    expect(stage.reels.grid()).toEqual(viewFor(stops));
  });

  it('picks the feature back up, counter and all', () => {
    const { stage } = build();

    stage.attach({
      phase: 'STOPPING',
      result: { stops: [0, 0, 0, 0, 0], view: viewFor([0, 0, 0, 0, 0]) },
      feature: {
        kind: 'FREE_SPINS',
        total: 10,
        remaining: 4,
        step: 6,
        cumulativeWin: 900,
        stakeRef: 100,
      },
    } as unknown as EngineState);

    expect(stage.feature.active).toBe(true);
    expect(stage.feature.counter).toBe('FREE SPIN 7 / 10');
  });

  it('spins for a round that was debited but never resolved', () => {
    const { stage } = build();

    stage.attach({ phase: 'SPINNING' } as unknown as EngineState);

    expect(stage.reels.spinning).toBe(true);
  });

  it('does nothing at an idle table', () => {
    const { stage } = build();

    stage.attach({ phase: 'IDLE' } as unknown as EngineState);

    expect(stage.reels.spinning).toBe(false);
    expect(stage.feature.active).toBe(false);
  });
});

describe('the feature', () => {
  const progress = (over: Partial<Record<string, number>> = {}) =>
    ({
      kind: 'FREE_SPINS',
      total: 10,
      remaining: 7,
      step: 3,
      cumulativeWin: 1_200,
      stakeRef: 100,
      ...over,
    }) as never;

  it('plays an intro, and reports it complete', () => {
    const { engine, stage } = build();

    // The engine prepends `PHASE_CHANGED` to the events of a transition, so the phase always
    // arrives before the data. These tests mirror that order deliberately: building a screen from
    // the phase rather than from its event is how the intro once announced "0 SPINS".
    engine.emit({ type: 'PHASE_CHANGED', from: 'WIN_PRESENTATION', to: 'FEATURE_INTRO' });
    engine.emit({ type: 'FEATURE_AWARDED', total: 10 });

    expect(stage.feature.active).toBe(true);
    stage.update(100);
    expect(engine.types).not.toContain('INTRO_COMPLETE');

    stage.update(5_000);
    expect(engine.types).toContain('INTRO_COMPLETE');
  });

  it('shows the server’s counter, and never computes one', () => {
    const { engine, stage } = build();

    engine.emit({ type: 'FEATURE_PROGRESS', feature: progress() });

    expect(stage.feature.counter).toBe('FREE SPIN 4 / 10');
    // A progress event alone is enough: this is exactly what a mid-feature resume delivers.
    expect(stage.feature.active).toBe(true);
  });

  /** A retrigger is a `total` that grew. The server folded the arithmetic; the client notices. */
  it('announces a retrigger when the total grows mid-feature', () => {
    const { engine, stage } = build();

    engine.emit({ type: 'FEATURE_AWARDED', total: 10 });
    engine.emit({ type: 'FEATURE_PROGRESS', feature: progress({ total: 10 }) });
    expect(stage.feature.announcement).toBeNull();

    engine.emit({ type: 'FEATURE_PROGRESS', feature: progress({ total: 15, remaining: 11 }) });

    expect(stage.feature.announcement).toBe('+5 FREE SPINS');
    // It rides the spin rather than blocking it, and it does not outlive the round.
    stage.update(3_000);
    expect(stage.feature.announcement).toBeNull();
  });

  it('does not mistake the first award for a retrigger', () => {
    const { engine, stage } = build();

    engine.emit({ type: 'FEATURE_AWARDED', total: 10 });
    engine.emit({ type: 'FEATURE_PROGRESS', feature: progress({ total: 10, step: 0 }) });

    expect(stage.feature.announcement).toBeNull();
  });

  it('counts the feature’s total up in the outro and then puts the screen back', () => {
    const { engine, stage } = build();

    engine.emit({ type: 'PHASE_CHANGED', from: 'FEATURE_SPINNING', to: 'FEATURE_OUTRO' });
    engine.emit({ type: 'FEATURE_ENDED', cumulativeWin: 4_500 as never });
    stage.update(5_000);

    expect(engine.types).toContain('OUTRO_COMPLETE');
    expect(stage.feature.active).toBe(false);
  });

  it('leaves nothing behind when the next round starts', () => {
    const { engine, stage } = build();

    engine.emit({ type: 'FEATURE_PROGRESS', feature: progress() });
    engine.emit({ type: 'PHASE_CHANGED', from: 'SETTLING', to: 'IDLE' });

    expect(stage.feature.active).toBe(false);
  });

  it('completes a skipped intro instead of leaving the banner up', () => {
    const { engine, stage } = build();

    engine.emit({ type: 'PHASE_CHANGED', from: 'WIN_PRESENTATION', to: 'FEATURE_INTRO' });
    engine.emit({ type: 'FEATURE_AWARDED', total: 10 });
    stage.update(16.67);
    // A skip advances the engine, so the phase change follows immediately — as it does in reality.
    engine.emit({ type: 'SKIPPED', phase: 'FEATURE_INTRO' });
    engine.emit({ type: 'PHASE_CHANGED', from: 'FEATURE_INTRO', to: 'FEATURE_SPINNING' });
    stage.update(5_000);

    // The engine advanced itself, so no completion is owed — and the banner is gone either way.
    expect(engine.types).not.toContain('INTRO_COMPLETE');
    expect(stage.feature.active).toBe(true);
    expect(stage.reels.spinning).toBe(true);
  });
});

describe('teardown', () => {
  it('unsubscribes, so a destroyed stage cannot be driven by a live engine', () => {
    const { engine, stage } = build();
    const spy = vi.spyOn(stage.reels, 'spin');

    stage.destroy();
    engine.emit({ type: 'SPIN_STARTED', roundId: 'r', stake: 20 as never });

    expect(spy).not.toHaveBeenCalled();
  });
});
