import { Container, Graphics } from 'pixi.js';
import type { GameConfig } from '@slot/protocol';
import type { EngineEvent, EngineInput, EngineState } from '@slot/engine';
import type { SymbolAtlas } from './atlas.js';
import type { SpinCurve } from './curve.js';
import { ReelSet } from './reels.js';
import { PALETTE, SYMBOL_GAP, SYMBOL_SIZE } from './theme.js';

/**
 * The reel area, wired to the engine.
 *
 * The direction of the arrows is the whole design: **the engine emits and this subscribes.** The
 * stage never reaches into the engine's state to decide anything, and the engine has never heard of
 * Pixi. The only things travelling back are the two facts a renderer is the sole owner of — the
 * reels have come to rest, and the presentation has finished.
 */

/** What the stage needs from a `SlotEngine`, as a structural port so a test can hand it a fake. */
export interface EngineBridge {
  on(listener: (event: EngineEvent, state: EngineState) => void): () => void;
  send(input: EngineInput): unknown;
}

export interface GameStageOptions {
  engine: EngineBridge;
  /** The server's config — strips and rows come from it, never from a local copy. */
  config: GameConfig;
  atlas: SymbolAtlas;
  curve?: Partial<SpinCurve>;
  anticipationSymbol?: string;
  anticipationTrigger?: number;
  /**
   * The dev-build assertion (`__ASSERT_MATH__`): the grid drawn versus the grid the server sent.
   * A mismatch means the client is showing the player something other than the committed outcome,
   * which is the one bug class this architecture exists to make impossible.
   */
  onGridMismatch?: (expected: readonly (readonly string[])[], drawn: readonly string[][]) => void;
}

/**
 * How long the placeholder presentation holds before it reports itself complete.
 *
 * **C4 replaces this with real timelines** — payline highlighting, per-symbol animation, a rolling
 * win counter — and C5 does the same for the feature screens. Until then the engine would sit in
 * `WIN_PRESENTATION` forever, so the stage holds for a beat and answers. It is a stub with a
 * deliberate shape: frame-driven rather than `setTimeout`, so it pauses when the tab does, and
 * cancelled by any phase change, so a skip can never race it.
 */
const PLACEHOLDER_HOLD_MS = { WIN_PRESENTATION: 900, FEATURE_INTRO: 1_200, FEATURE_OUTRO: 1_200 };

export class GameStage {
  readonly view = new Container();
  readonly reels: ReelSet;

  readonly #engine: EngineBridge;
  readonly #unsubscribe: () => void;
  readonly #onGridMismatch: GameStageOptions['onGridMismatch'];
  /** The outcome the server sent for the spin currently landing, kept for the assertion. */
  #expected: readonly (readonly string[])[] | null = null;
  #pending: { input: EngineInput; remainingMs: number } | null = null;

  constructor({
    engine,
    config,
    atlas,
    curve,
    anticipationSymbol,
    anticipationTrigger,
    onGridMismatch,
  }: GameStageOptions) {
    this.#engine = engine;
    this.#onGridMismatch = onGridMismatch;

    this.reels = new ReelSet({
      strips: config.strips,
      rows: config.rows,
      atlas,
      ...(curve === undefined ? {} : { curve }),
      ...(anticipationSymbol === undefined ? {} : { anticipationSymbol }),
      ...(anticipationTrigger === undefined ? {} : { anticipationTrigger }),
    });

    const padding = SYMBOL_GAP * 3;
    const frame = new Graphics()
      .roundRect(
        -padding,
        -padding,
        this.reels.width + padding * 2,
        this.reels.height + padding * 2,
        SYMBOL_SIZE * 0.12,
      )
      .fill({ color: PALETTE.frame })
      .stroke({ width: 3, color: PALETTE.frameEdge, alpha: 0.8 });

    const track = new Graphics()
      .rect(0, 0, this.reels.width, this.reels.height)
      .fill({ color: PALETTE.reelTrack });

    this.view.addChild(frame, track, this.reels.view);
    this.#unsubscribe = engine.on((event) => {
      this.#handle(event);
    });
  }

  get width(): number {
    return this.reels.width + SYMBOL_GAP * 6;
  }

  get height(): number {
    return this.reels.height + SYMBOL_GAP * 6;
  }

  /** One frame, delta-time driven throughout. Called from the client's single ticker. */
  update(deltaMs: number): void {
    if (this.reels.update(deltaMs)) {
      this.#assertGrid();
      this.#engine.send({ type: 'REELS_STOPPED' });
    }

    const pending = this.#pending;
    if (pending === null) return;

    pending.remainingMs -= deltaMs;
    if (pending.remainingMs > 0) return;

    this.#pending = null;
    this.#engine.send(pending.input);
  }

  destroy(): void {
    this.#unsubscribe();
    this.reels.destroy();
    this.view.destroy({ children: true });
  }

  #handle(event: EngineEvent): void {
    switch (event.type) {
      case 'SPIN_STARTED':
        this.#expected = null;
        this.reels.spin(false);
        return;

      case 'REELS_TARGETED':
        this.#expected = event.view;
        this.reels.land(event.stops, event.view, event.slam);
        return;

      case 'SKIPPED':
        // The engine decided the interruption was legal; completing the timeline is this layer's
        // half of the contract. A skipped presentation has already advanced the machine, so the
        // pending stub must be dropped rather than fired late.
        this.#pending = null;
        if (event.phase === 'SPINNING' || event.phase === 'FEATURE_SPINNING') this.reels.slam();
        return;

      case 'PHASE_CHANGED':
        this.#onPhase(event.to);
        return;

      default:
        return;
    }
  }

  #onPhase(phase: EngineState['phase']): void {
    this.#pending = null;

    if (phase === 'FEATURE_SPINNING') {
      // A free spin enters this phase without a `SPIN_STARTED` — one round, many spins.
      this.#expected = null;
      this.reels.spin(false);
      return;
    }

    if (phase === 'WIN_PRESENTATION' || phase === 'FEATURE_INTRO' || phase === 'FEATURE_OUTRO') {
      const input: EngineInput =
        phase === 'WIN_PRESENTATION'
          ? { type: 'PRESENTATION_COMPLETE' }
          : phase === 'FEATURE_INTRO'
            ? { type: 'INTRO_COMPLETE' }
            : { type: 'OUTRO_COMPLETE' };
      this.#pending = { input, remainingMs: PLACEHOLDER_HOLD_MS[phase] };
    }
  }

  /**
   * Did we draw what the server sent?
   *
   * Cheap, and it catches the whole class of strip-alignment bugs — an off-by-one in the wrap-around,
   * a reel drawn from the wrong strip, a landing that missed by a symbol. The client wires this to
   * `__ASSERT_MATH__` so it is loud in development and absent from production.
   */
  #assertGrid(): void {
    const expected = this.#expected;
    if (expected === null || this.#onGridMismatch === undefined) return;

    const drawn = this.reels.grid();
    const matches = expected.every((column, reel) =>
      column.every((symbol, row) => symbol === drawn[reel]?.[row]),
    );

    if (!matches) this.#onGridMismatch(expected, drawn);
  }
}
