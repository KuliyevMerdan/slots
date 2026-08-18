import { Container, Graphics } from 'pixi.js';
import type { GameConfig, Minor } from '@slot/protocol';
import type { EngineEvent, EngineInput, EngineState } from '@slot/engine';
import type { SymbolAtlas } from './atlas.js';
import { DEFAULT_CURVE, TURBO_FACTOR, scaleCurve } from './curve.js';
import type { SpinCurve } from './curve.js';
import { ReelSet } from './reels.js';
import { Timeline } from './timeline.js';
import { WinPresentation } from './win-presentation.js';
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
  /** The server's config — strips, rows and paylines come from it, never from a local copy. */
  config: GameConfig;
  atlas: SymbolAtlas;
  /** From `session.currency`: the win presentation formats money, so it needs the server's currency. */
  currency: string;
  locale?: string;
  curve?: Partial<SpinCurve>;
  anticipationSymbol?: string;
  anticipationTrigger?: number;
  /** The rolling win amount, for the HUD. Always ends on the final total, skip or no skip. */
  onWinAmount?: (amount: Minor) => void;
  /**
   * The dev-build assertion (`__ASSERT_MATH__`): the grid drawn versus the grid the server sent.
   * A mismatch means the client is showing the player something other than the committed outcome,
   * which is the one bug class this architecture exists to make impossible.
   */
  onGridMismatch?: (expected: readonly (readonly string[])[], drawn: readonly string[][]) => void;
}

/**
 * The feature screens, still a hold rather than a screen.
 *
 * **C5 replaces these**; the win presentation they used to sit beside is real as of C4. They are
 * timelines like everything else, so a skip already completes them correctly — what is missing is
 * something to look at, not something to interrupt.
 */
const FEATURE_HOLD_MS = { FEATURE_INTRO: 1_200, FEATURE_OUTRO: 1_200 };

export class GameStage {
  readonly view = new Container();
  readonly reels: ReelSet;
  readonly presentation: WinPresentation;

  readonly #engine: EngineBridge;
  readonly #unsubscribe: () => void;
  readonly #onGridMismatch: GameStageOptions['onGridMismatch'];
  readonly #baseCurve: SpinCurve;
  /** The outcome the server sent for the spin currently landing, kept for the assertion. */
  #expected: readonly (readonly string[])[] | null = null;
  /**
   * The presentation currently running, and the input the engine is waiting for at the end of it.
   *
   * One mechanism for every timed screen — the win presentation and the feature holds — because a
   * skip has to behave identically whichever is on screen.
   */
  #sequence: { timeline: Timeline; input: EngineInput } | null = null;
  #speed = 1;

  constructor({
    engine,
    config,
    atlas,
    currency,
    locale,
    curve,
    anticipationSymbol,
    anticipationTrigger,
    onGridMismatch,
    onWinAmount,
  }: GameStageOptions) {
    this.#engine = engine;
    this.#onGridMismatch = onGridMismatch;
    this.#baseCurve = { ...DEFAULT_CURVE, ...curve };

    this.reels = new ReelSet({
      strips: config.strips,
      rows: config.rows,
      atlas,
      ...(curve === undefined ? {} : { curve }),
      ...(anticipationSymbol === undefined ? {} : { anticipationSymbol }),
      ...(anticipationTrigger === undefined ? {} : { anticipationTrigger }),
    });

    this.presentation = new WinPresentation({
      reels: this.reels,
      paylines: config.paylines,
      currency,
      ...(locale === undefined ? {} : { locale }),
      ...(onWinAmount === undefined ? {} : { onAmount: onWinAmount }),
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

    // The overlay sits above the reels and outside their mask: a payline reads across the whole
    // window, and a big-win plate is not something to clip.
    this.view.addChild(frame, track, this.reels.view, this.presentation.view);
    this.#unsubscribe = engine.on((event, state) => {
      this.#handle(event, state);
    });
  }

  get width(): number {
    return this.reels.width + SYMBOL_GAP * 6;
  }

  get height(): number {
    return this.reels.height + SYMBOL_GAP * 6;
  }

  /**
   * Turbo: shorter spins and a quicker presentation, same game underneath.
   *
   * One switch drives both, so they cannot drift apart — and when the compliance layer (C6) forbids
   * turbo in a jurisdiction, there is exactly one thing for it to refuse.
   */
  setTurbo(on: boolean): void {
    this.#speed = on ? TURBO_FACTOR : 1;
    this.reels.setCurve(on ? scaleCurve(this.#baseCurve, TURBO_FACTOR) : this.#baseCurve);
  }

  get turbo(): boolean {
    return this.#speed !== 1;
  }

  /** One frame, delta-time driven throughout. Called from the client's single ticker. */
  update(deltaMs: number): void {
    if (this.reels.update(deltaMs)) {
      this.#assertGrid();
      this.#engine.send({ type: 'REELS_STOPPED' });
    }

    const sequence = this.#sequence;
    if (sequence === null) return;

    // `advance` reports the frame it *finishes* on; `finished` covers the sequence that had nothing
    // to show in the first place — a spin that paid nothing, if the engine ever routes one here.
    // Either way the engine is waiting for exactly one input, and it gets exactly one.
    const done = sequence.timeline.advance(deltaMs) || sequence.timeline.finished;
    if (!done) return;

    this.#sequence = null;
    this.#engine.send(sequence.input);
  }

  destroy(): void {
    this.#unsubscribe();
    this.presentation.destroy();
    this.reels.destroy();
    this.view.destroy({ children: true });
  }

  #handle(event: EngineEvent, state: EngineState): void {
    switch (event.type) {
      case 'SPIN_STARTED':
        this.#expected = null;
        this.reels.spin(false);
        return;

      case 'REELS_TARGETED':
        this.#expected = event.view;
        // A target can arrive for reels that were never started: `authenticate` resumes a round the
        // player left open, and the engine walks straight into the phase that continues it without
        // ever emitting `SPIN_STARTED`. Starting them here — slammed, because the round already
        // happened and there is nothing to build suspense about — is what makes resume land on the
        // outcome instead of hanging on reels that never moved.
        if (!this.reels.spinning) this.reels.spin(true);
        this.reels.land(event.stops, event.view, event.slam);
        return;

      case 'WINS_PRESENTED':
        // Sequenced from the server's `wins[]`, at the stake the round was played for.
        this.#sequence = {
          input: { type: 'PRESENTATION_COMPLETE' },
          timeline: this.presentation.build({
            wins: event.wins,
            totalWin: event.totalWin,
            stake: 'stake' in state ? state.stake : (0 as Minor),
            speed: this.#speed,
          }),
        };
        return;

      case 'SKIPPED': {
        // The engine decided the interruption was legal; completing the timeline is this layer's
        // half of the contract. `complete()` runs every remaining step to its end — the counter
        // lands on the final number and every highlight clears itself — and then the sequence is
        // dropped, because the engine has *already* advanced and is no longer waiting for it.
        const sequence = this.#sequence;
        this.#sequence = null;
        sequence?.timeline.complete();

        if (event.phase === 'SPINNING' || event.phase === 'FEATURE_SPINNING') this.reels.slam();
        return;
      }

      case 'PHASE_CHANGED':
        this.#onPhase(event.to);
        return;

      default:
        return;
    }
  }

  /**
   * A phase change ends whatever was on screen.
   *
   * `WIN_PRESENTATION` is deliberately not built here: the phase change arrives *before*
   * `WINS_PRESENTED`, which is the event carrying what to present. Clearing here and building there
   * is what keeps the order safe either way.
   */
  #onPhase(phase: EngineState['phase']): void {
    this.#sequence = null;

    if (phase === 'FEATURE_SPINNING') {
      // A free spin enters this phase without a `SPIN_STARTED` — one round, many spins.
      this.#expected = null;
      this.reels.spin(false);
      return;
    }

    if (phase === 'FEATURE_INTRO' || phase === 'FEATURE_OUTRO') {
      this.#sequence = {
        input: phase === 'FEATURE_INTRO' ? { type: 'INTRO_COMPLETE' } : { type: 'OUTRO_COMPLETE' },
        timeline: new Timeline([{ durationMs: FEATURE_HOLD_MS[phase] * this.#speed }]),
      };
      return;
    }

    if (phase === 'IDLE' || phase === 'SPINNING') this.presentation.clear();
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
