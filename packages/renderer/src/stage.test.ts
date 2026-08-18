import { describe, expect, it, vi } from 'vitest';
import { Texture } from 'pixi.js';
import type { GameConfig } from '@slot/protocol';
import type { EngineEvent, EngineInput, EngineState } from '@slot/engine';
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

  emit(event: EngineEvent): void {
    for (const listener of this.#listeners) listener(event, { phase: 'IDLE' } as EngineState);
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
  const stage = new GameStage({
    engine,
    config,
    atlas,
    onGridMismatch: (expected, drawn) => mismatches.push({ expected, drawn }),
  });
  return { engine, stage, mismatches };
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

describe('the presentation stubs (C4 replaces these)', () => {
  it.each([
    ['WIN_PRESENTATION', 'PRESENTATION_COMPLETE'],
    ['FEATURE_INTRO', 'INTRO_COMPLETE'],
    ['FEATURE_OUTRO', 'OUTRO_COMPLETE'],
  ] as const)('answers %s with %s after a hold', (phase, input) => {
    const { engine, stage } = build();

    engine.emit({ type: 'PHASE_CHANGED', from: 'STOPPING', to: phase });
    stage.update(100);
    expect(engine.types).not.toContain(input);

    stage.update(5_000);
    expect(engine.types).toContain(input);
  });

  /**
   * A skip advances the machine itself, so a stub that fired afterwards would deliver an input the
   * new phase cannot service. Dropping it is the renderer's half of the interruption contract.
   */
  it('drops the pending stub when the player skips', () => {
    const { engine, stage } = build();

    engine.emit({ type: 'PHASE_CHANGED', from: 'STOPPING', to: 'WIN_PRESENTATION' });
    engine.emit({ type: 'SKIPPED', phase: 'WIN_PRESENTATION' });
    stage.update(5_000);

    expect(engine.types).not.toContain('PRESENTATION_COMPLETE');
  });

  it('drops it on any other phase change too', () => {
    const { engine, stage } = build();

    engine.emit({ type: 'PHASE_CHANGED', from: 'STOPPING', to: 'WIN_PRESENTATION' });
    engine.emit({ type: 'PHASE_CHANGED', from: 'WIN_PRESENTATION', to: 'SETTLING' });
    stage.update(5_000);

    expect(engine.types).not.toContain('PRESENTATION_COMPLETE');
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
