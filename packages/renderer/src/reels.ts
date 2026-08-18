import { Container, Graphics } from 'pixi.js';
import type { SymbolAtlas } from './atlas.js';
import { Reel } from './reel.js';
import {
  DEFAULT_CURVE,
  advance,
  isBlurred,
  isStopped,
  parked,
  slam,
  startSpin,
  target,
} from './curve.js';
import type { ReelMotion, SpinCurve } from './curve.js';
import { PALETTE, SYMBOL_GAP, SYMBOL_SIZE } from './theme.js';

/**
 * The five reels, the mask, and the cadence between them.
 *
 * It owns motion but decides nothing about the game: stops arrive from the engine, which got them
 * from the server. What this class adds is *timing* — the stagger, the scatter anticipation, and the
 * moment the last reel comes to rest, which is the only thing it tells the engine
 * (`REELS_STOPPED`).
 *
 * The window is masked with a **rectangle**, not a filter: a mask is a stencil and costs nothing,
 * while a filter allocates a render target and breaks the symbol layer out of its batch.
 */

export interface ReelSetOptions {
  /** The strips from `GameConfig` — the server's, not a local copy. */
  strips: readonly (readonly string[])[];
  rows: number;
  atlas: SymbolAtlas;
  curve?: Partial<SpinCurve>;
  symbolSize?: number;
  gap?: number;
  /**
   * Which symbol makes the remaining reels slow down, and how many of them a trigger needs.
   *
   * Injected rather than imported: the dependency table says `renderer → protocol, engine, money`,
   * so the renderer does not get to know that `@slot/game-math` calls the scatter `SCAT`. The
   * wiring site knows, and passes it in — the same shape the simulator's storage port and the
   * engine's `RgsPort` take.
   */
  anticipationSymbol?: string;
  anticipationTrigger?: number;
}

export class ReelSet {
  readonly view = new Container();
  readonly rows: number;

  readonly #reels: Reel[] = [];
  readonly #motions: ReelMotion[] = [];
  readonly #curve: SpinCurve;
  readonly #cell: number;
  readonly #symbolSize: number;
  readonly #strips: readonly (readonly string[])[];
  readonly #anticipationSymbol: string;
  readonly #anticipationTrigger: number;
  readonly #window = new Container();
  readonly #mask: Graphics;
  /**
   * Which rows are lit, per reel. Allocated once and mutated in place: the pulse runs every frame of
   * a win presentation, and rebuilding five arrays a frame is exactly the kind of allocation the
   * ticker rules exist to prevent.
   */
  readonly #lit: boolean[][] = [];
  #emphasised = false;
  #spinning = false;

  constructor({
    strips,
    rows,
    atlas,
    curve,
    symbolSize = SYMBOL_SIZE,
    gap = SYMBOL_GAP,
    anticipationSymbol = 'SCAT',
    anticipationTrigger = 3,
  }: ReelSetOptions) {
    this.rows = rows;
    this.#strips = strips;
    this.#curve = { ...DEFAULT_CURVE, ...curve };
    this.#anticipationSymbol = anticipationSymbol;
    this.#anticipationTrigger = anticipationTrigger;
    this.#symbolSize = symbolSize;

    const cell = symbolSize + gap;
    this.#cell = cell;
    strips.forEach((strip, index) => {
      const reel = new Reel({ strip, rows, atlas, symbolSize, gap });
      reel.view.x = index * cell;
      this.#reels.push(reel);
      this.#motions.push(parked(0));
      this.#window.addChild(reel.view);
      this.#lit.push(new Array<boolean>(rows).fill(false));
      reel.update(0, false);
    });

    this.#mask = new Graphics()
      .rect(0, 0, strips.length * cell - gap, rows * cell - gap)
      .fill({ color: PALETTE.reelTrack });

    this.#window.mask = this.#mask;
    this.view.addChild(this.#mask, this.#window);
  }

  get width(): number {
    return this.#mask.width;
  }

  get height(): number {
    return this.#mask.height;
  }

  get spinning(): boolean {
    return this.#spinning;
  }

  /** Launch. The outcome is not known yet — that is the whole reason a spin has a cruise phase. */
  spin(slamRequested = false): void {
    // Whatever the last round lit, the next spin starts clean. A payline still glowing over a
    // spinning reel is the classic symptom of a presentation that was interrupted badly.
    this.setEmphasis(null);
    this.#spinning = true;
    for (let reel = 0; reel < this.#motions.length; reel += 1) {
      this.#motions[reel] = startSpin(
        this.#motions[reel] ?? parked(0),
        { reel, slam: slamRequested, anticipated: false },
        this.#curve,
      );
    }
  }

  /**
   * Hand the reels the outcome the server committed to.
   *
   * `view` is used for one thing only — deciding which reels get the anticipation hold. It never
   * decides where a reel lands; `stops` does, because `stops` is the authority (ADR-0001).
   */
  land(
    stops: readonly number[],
    view: readonly (readonly string[])[],
    slamRequested: boolean,
  ): void {
    for (let reel = 0; reel < this.#motions.length; reel += 1) {
      const motion = this.#motions[reel];
      const stop = stops[reel];
      if (motion === undefined || stop === undefined) continue;

      const length = this.#strips[reel]?.length ?? 1;
      // The reel walks the strip backwards (see `Reel`), so the position it must land on is the
      // mirror of the server's stop. One line here buys reels that fall rather than rise.
      const mirrored = (length - (stop % length)) % length;

      const held = this.#anticipated(view, reel);
      this.#motions[reel] = target(
        held ? { ...motion, holdMs: motion.holdMs + this.#curve.anticipationHoldMs } : motion,
        mirrored,
        slamRequested,
      );
    }
  }

  /**
   * Light exactly these `[reel, row]` cells, or clear the emphasis with `null`.
   *
   * Called once per presentation step, not per frame. The positions come from the server's `wins[]`
   * — the client highlights what it was told won, it does not work out what won.
   */
  setEmphasis(positions: readonly (readonly [number, number])[] | null): void {
    for (const rows of this.#lit) rows.fill(false);

    if (positions !== null) {
      for (const [reel, row] of positions) {
        const rows = this.#lit[reel];
        if (rows !== undefined && row >= 0 && row < rows.length) rows[row] = true;
      }
    }

    this.#emphasised = positions !== null;
    this.pulse(0);
  }

  /** One frame of the win pulse. `phase` runs 0 → 1 → 0; nothing here allocates. */
  pulse(phase: number): void {
    for (let index = 0; index < this.#reels.length; index += 1) {
      const reel = this.#reels[index];
      if (reel === undefined) continue;
      reel.emphasise(this.#emphasised ? (this.#lit[index] ?? null) : null, phase);
    }
  }

  /** Turbo, and the compliance layer that will one day forbid it, both arrive through here. */
  setCurve(curve: SpinCurve): void {
    Object.assign(this.#curve, curve);
  }

  /** Where a cell's centre sits, in the reel area's own coordinates — payline geometry reads this. */
  centreOf(reel: number, row: number): { x: number; y: number } {
    const cell = this.#cell;
    return { x: reel * cell + this.#symbolSize / 2, y: row * cell + this.#symbolSize / 2 };
  }

  /** The player pressed again: cut the waiting, keep the outcome. */
  slam(): void {
    for (let reel = 0; reel < this.#motions.length; reel += 1) {
      const motion = this.#motions[reel];
      if (motion !== undefined) this.#motions[reel] = slam(motion, this.#curve);
    }
  }

  /**
   * One frame. Returns `true` on the frame the **last** reel comes to rest — the edge the caller
   * turns into `REELS_STOPPED`.
   */
  update(deltaMs: number): boolean {
    if (!this.#spinning) return false;

    let allStopped = true;
    for (let index = 0; index < this.#reels.length; index += 1) {
      const reel = this.#reels[index];
      const motion = this.#motions[index];
      if (reel === undefined || motion === undefined) continue;

      const next = advance(motion, deltaMs, {
        stripLength: this.#strips[index]?.length ?? 1,
        curve: this.#curve,
      });
      this.#motions[index] = next;
      reel.update(next.position, isBlurred(next, this.#curve));
      if (!isStopped(next)) allStopped = false;
    }

    if (!allStopped) return false;
    this.#spinning = false;
    return true;
  }

  /** The symbols on screen, `[reel][row]` — what the dev build compares against the server's view. */
  grid(): string[][] {
    return this.#reels.map((reel, index) =>
      reel.visible(this.rows, this.#motions[index]?.position ?? 0),
    );
  }

  /**
   * Should this reel slow down dramatically?
   *
   * Only when the reels that have already landed carry enough scatters that this one could still
   * complete a trigger. Cheap to compute, and it is the single effect that makes a near-miss feel
   * like a near-miss rather than a nothing.
   */
  #anticipated(view: readonly (readonly string[])[], reel: number): boolean {
    if (reel === 0) return false;

    let scatters = 0;
    for (let earlier = 0; earlier < reel; earlier += 1) {
      const column = view[earlier];
      if (column === undefined) continue;
      for (const symbol of column) {
        if (symbol === this.#anticipationSymbol) scatters += 1;
      }
    }

    return scatters >= this.#anticipationTrigger - 1;
  }

  destroy(): void {
    for (const reel of this.#reels) reel.destroy();
    this.view.destroy({ children: true });
  }
}
