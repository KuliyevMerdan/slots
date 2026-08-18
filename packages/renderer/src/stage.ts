import { Container, Graphics } from 'pixi.js';
import type { GameConfig, Minor } from '@slot/protocol';
import type { EngineEvent, EngineInput, EngineState } from '@slot/engine';
import type { SymbolAtlas } from './atlas.js';
import { DEFAULT_CURVE, TURBO_FACTOR, scaleCurve } from './curve.js';
import type { SpinCurve } from './curve.js';
import { ReelSet } from './reels.js';
import { FeatureScreens } from './feature.js';
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

/** Space above the reel frame for the feature counter, which hangs over the top edge. */
const HEADROOM = SYMBOL_SIZE * 0.55;

export class GameStage {
  readonly view = new Container();
  readonly reels: ReelSet;
  readonly presentation: WinPresentation;
  readonly feature: FeatureScreens;

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
  /** The phase the engine is in, so the stage can tell when it owes an input and has not built one. */
  #phase: EngineState['phase'] = 'BOOTING';
  #speed = 1;
  /**
   * The feature's awarded total, kept for one job only: noticing that it grew, which is a retrigger.
   * Every other number the feature screens show arrives with the event that needs it.
   */
  #featureTotal = 0;

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

    this.feature = new FeatureScreens({
      width: this.reels.width,
      height: this.reels.height,
      currency,
      ...(locale === undefined ? {} : { locale }),
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

    // Everything is shifted down by the headroom the feature counter needs above the frame. Without
    // it the counter is drawn outside the stage's own box, and the client's letterbox layout — which
    // sizes itself from `width`/`height` — clips it against the top of the screen.
    const content = new Container();
    content.y = HEADROOM;
    // The overlays sit above the reels and outside their mask: a payline reads across the whole
    // window, and a big-win plate is not something to clip.
    content.addChild(frame, track, this.reels.view, this.presentation.view, this.feature.view);
    this.view.addChild(content);
    this.#unsubscribe = engine.on((event, state) => {
      this.#handle(event, state);
    });
  }

  get width(): number {
    return this.reels.width + SYMBOL_GAP * 6;
  }

  get height(): number {
    return this.reels.height + SYMBOL_GAP * 6 + HEADROOM;
  }

  /**
   * Catch up with a machine that is already in motion.
   *
   * The client cannot build this stage until `authenticate` has answered — the reel strips arrive in
   * that response — so on a resumed round the engine has *already* announced where the reels belong
   * and nobody was listening. Subscribing after the fact is not enough: events are not replayed, and
   * a renderer that missed them sits on motionless reels while the engine waits for a
   * `REELS_STOPPED` that will never come. Which is precisely what a reload mid-feature looked like.
   *
   * So the stage reads the state once, on attach, and puts itself where the machine already is.
   * Slammed, because the round happened before the page did.
   */
  attach(state: EngineState): void {
    if ('feature' in state && state.feature !== undefined) {
      this.#featureTotal = state.feature.total;
      this.feature.progress(state.feature);
    }

    if (state.phase === 'SPINNING') {
      // Debited but never resolved: the engine is re-sending the spin, and its answer will target
      // reels that are already turning.
      this.reels.spin(true);
      return;
    }

    if ('result' in state) {
      this.#expected = state.result.view;
      this.reels.spin(true);
      this.reels.land(state.result.stops, state.result.view, true);
    }
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
    this.feature.update(deltaMs);

    if (this.reels.update(deltaMs)) {
      this.#assertGrid();
      this.#engine.send({ type: 'REELS_STOPPED' });
    }

    const sequence = this.#sequence ?? this.#recover();
    if (sequence === null) return;

    // `advance` reports the frame it *finishes* on; `finished` covers the sequence that had nothing
    // to show in the first place — a spin that paid nothing, if the engine ever routes one here.
    // Either way the engine is waiting for exactly one input, and it gets exactly one.
    const done = sequence.timeline.advance(deltaMs) || sequence.timeline.finished;
    if (!done) return;

    this.#sequence = null;
    this.#engine.send(sequence.input);
  }

  /**
   * A phase that owes the engine an input, with nothing on screen to produce it.
   *
   * Every presentation is built from the event that carries its data — the wins, the spins awarded,
   * the feature's total — and each of those arrives in the same batch as the phase change, so this
   * should never fire. It exists because the failure mode if it ever did is the worst one available:
   * a game that waits forever for an input nobody is going to send. An empty timeline reports itself
   * complete on the next frame, and the round carries on unpresented rather than not at all.
   */
  #recover(): { timeline: Timeline; input: EngineInput } | null {
    const input: EngineInput | null =
      this.#phase === 'WIN_PRESENTATION'
        ? { type: 'PRESENTATION_COMPLETE' }
        : this.#phase === 'FEATURE_INTRO'
          ? { type: 'INTRO_COMPLETE' }
          : this.#phase === 'FEATURE_OUTRO'
            ? { type: 'OUTRO_COMPLETE' }
            : null;

    if (input === null) return null;

    const sequence = { input, timeline: new Timeline([]) };
    this.#sequence = sequence;
    return sequence;
  }

  destroy(): void {
    this.#unsubscribe();
    this.feature.destroy();
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

      case 'FEATURE_AWARDED':
        // Built here rather than on the phase change, because `PHASE_CHANGED` is emitted *first* and
        // the number of spins arrives with this event. Building on the phase would show a banner
        // reading "0 SPINS" — which is exactly what it did.
        this.#featureTotal = event.total;
        // Active immediately, not when the intro's first frame runs: the feature has been awarded,
        // and the border saying so is the answer to "did that just trigger?".
        this.feature.setActive(true);
        this.#sequence = {
          input: { type: 'INTRO_COMPLETE' },
          timeline: this.feature.intro(event.total, this.#speed),
        };
        return;

      case 'FEATURE_PROGRESS': {
        // A retrigger is a `total` that grew. The server folded the arithmetic; noticing is
        // presentation, and this is the only place the client is allowed to compare the two.
        const added = event.feature.total - this.#featureTotal;
        this.#featureTotal = event.feature.total;
        this.feature.progress(event.feature);
        if (added > 0 && this.#featureTotal > added) this.feature.retrigger(added);
        return;
      }

      case 'FEATURE_ENDED':
        this.#sequence = {
          input: { type: 'OUTRO_COMPLETE' },
          timeline: this.feature.outro(event.cumulativeWin, this.#speed),
        };
        return;

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
    this.#phase = phase;

    if (phase === 'FEATURE_SPINNING') {
      // A free spin enters this phase without a `SPIN_STARTED` — one round, many spins.
      this.#expected = null;
      this.reels.spin(false);
      return;
    }

    if (phase === 'IDLE' || phase === 'SPINNING') {
      this.presentation.clear();
      // A round that is not a feature must not inherit one: a reload straight after a feature, or a
      // skipped outro, would otherwise leave the border and the counter on screen forever.
      this.feature.clear();
      this.#featureTotal = 0;
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
