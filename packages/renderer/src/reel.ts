import { Container, Sprite } from 'pixi.js';
import type { SymbolAtlas } from './atlas.js';
import { SYMBOL_GAP, SYMBOL_SIZE } from './theme.js';

/** How far a non-winning symbol recedes while a win is being shown, and how far a winner grows. */
const DIMMED_ALPHA = 0.28;
const PULSE_SCALE = 0.08;

/**
 * One reel: a pooled column of sprites, and the arithmetic that decides what each one shows.
 *
 * **The pool is allocated at boot and never grows.** `rows + 2` sprites per reel — the visible
 * window plus one above and one below, which is exactly enough to cover a cell boundary mid-scroll.
 * Nothing in `update` allocates: no closures, no array literals, no spreads. That rule is not
 * decoration on a slot; the ticker runs sixty times a second for the length of a session, and a
 * per-frame allocation is a garbage-collection stutter in the middle of a spin.
 *
 * ## Which way a reel turns
 *
 * The curve's position only ever increases — that keeps the arithmetic monotonic and the landing
 * exact. A reel, though, spins *downward*: symbols fall. Both are true at once because the strip
 * index is read **backwards** from the position:
 *
 * ```
 * base = (-floor(position)) mod L        row r shows strip[(base + r) mod L]
 * ```
 *
 * so a rising position walks the strip backwards and the symbols fall down the screen. The caller
 * pays for this with one line — it targets `stripLength - stop` instead of `stop` — and gets a reel
 * that comes to rest showing exactly `view[reel][row] = strip[(stop + row) % L]`, which is the grid
 * the server sent.
 */

export interface ReelOptions {
  strip: readonly string[];
  rows: number;
  atlas: SymbolAtlas;
  symbolSize?: number;
  gap?: number;
}

export class Reel {
  readonly view = new Container();
  readonly cell: number;

  readonly #strip: readonly string[];
  readonly #sprites: Sprite[] = [];
  readonly #atlas: SymbolAtlas;
  readonly #centre: number;
  readonly #baseScale: number;
  /** Cached so a frame that changes nothing writes nothing — texture assignment is not free. */
  readonly #shown: string[] = [];
  #blurred = false;

  constructor({ strip, rows, atlas, symbolSize = SYMBOL_SIZE, gap = SYMBOL_GAP }: ReelOptions) {
    this.#strip = strip;
    this.#atlas = atlas;
    this.cell = symbolSize + gap;
    this.#centre = symbolSize / 2;

    // rows + 2: the window, plus the sprite entering from above and the one leaving below.
    for (let slot = 0; slot < rows + 2; slot += 1) {
      const sprite = new Sprite(atlas.sharp(strip[0] ?? ''));
      sprite.width = symbolSize;
      sprite.height = symbolSize;
      // Centred anchor so a win pulse grows a symbol about its middle rather than downward out of
      // its cell. The row arithmetic pays for it with one half-symbol offset, below.
      sprite.anchor.set(0.5, 0.5);
      sprite.x = symbolSize / 2;
      this.#sprites.push(sprite);
      this.#shown.push('');
      this.view.addChild(sprite);
    }

    // Every frame in the atlas is the same size, so one scale describes an unemphasised symbol —
    // captured once here rather than recomputed in the ticker.
    this.#baseScale = this.#sprites[0]?.scale.x ?? 1;
  }

  get width(): number {
    return this.cell;
  }

  /** Draw the reel at `position`, in symbols. Called once per reel per frame. */
  update(position: number, blurred: boolean): void {
    const length = this.#strip.length;
    const floor = Math.floor(position);
    const fraction = position - floor;
    const base = ((-floor % length) + length) % length;
    const blurChanged = blurred !== this.#blurred;

    for (let slot = 0; slot < this.#sprites.length; slot += 1) {
      const row = slot - 1;
      const sprite = this.#sprites[slot];
      if (sprite === undefined) continue;

      sprite.y = (row + fraction) * this.cell + this.#centre;

      const symbol = this.#strip[(((base + row) % length) + length) % length] ?? '';
      if (blurChanged || symbol !== this.#shown[slot]) {
        sprite.texture = blurred ? this.#atlas.blurred(symbol) : this.#atlas.sharp(symbol);
        this.#shown[slot] = symbol;
      }
    }

    this.#blurred = blurred;
  }

  /**
   * Light the winning symbols and dim the rest — or clear the emphasis entirely with `null`.
   *
   * `active` is indexed by **row**, so the caller can hand the same array back every frame and this
   * allocates nothing. `pulse` runs 0 → 1 → 0 and only scales what is already lit; the dimming is
   * constant, because a background that breathes is a background that distracts.
   */
  emphasise(active: readonly boolean[] | null, pulse: number): void {
    for (let slot = 0; slot < this.#sprites.length; slot += 1) {
      const sprite = this.#sprites[slot];
      if (sprite === undefined) continue;

      if (active === null) {
        sprite.alpha = 1;
        sprite.scale.set(this.#baseScale);
        continue;
      }

      const lit = active[slot - 1] === true;
      sprite.alpha = lit ? 1 : DIMMED_ALPHA;
      sprite.scale.set(lit ? this.#baseScale * (1 + PULSE_SCALE * pulse) : this.#baseScale);
    }
  }

  /** The symbols currently in the visible window, top row first. For the dev-build assertion. */
  visible(rows: number, position: number): string[] {
    const length = this.#strip.length;
    const base = ((-Math.round(position) % length) + length) % length;
    const window: string[] = [];
    for (let row = 0; row < rows; row += 1) {
      window.push(this.#strip[(base + row) % length] ?? '');
    }
    return window;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
