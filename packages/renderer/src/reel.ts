import { Container, Sprite } from 'pixi.js';
import type { SymbolAtlas } from './atlas.js';
import { SYMBOL_GAP, SYMBOL_SIZE } from './theme.js';

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
  /** Cached so a frame that changes nothing writes nothing — texture assignment is not free. */
  readonly #shown: string[] = [];
  #blurred = false;

  constructor({ strip, rows, atlas, symbolSize = SYMBOL_SIZE, gap = SYMBOL_GAP }: ReelOptions) {
    this.#strip = strip;
    this.#atlas = atlas;
    this.cell = symbolSize + gap;

    // rows + 2: the window, plus the sprite entering from above and the one leaving below.
    for (let slot = 0; slot < rows + 2; slot += 1) {
      const sprite = new Sprite(atlas.sharp(strip[0] ?? ''));
      sprite.width = symbolSize;
      sprite.height = symbolSize;
      sprite.anchor.set(0.5, 0);
      sprite.x = symbolSize / 2;
      this.#sprites.push(sprite);
      this.#shown.push('');
      this.view.addChild(sprite);
    }
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

      sprite.y = (row + fraction) * this.cell;

      const symbol = this.#strip[(((base + row) % length) + length) % length] ?? '';
      if (blurChanged || symbol !== this.#shown[slot]) {
        sprite.texture = blurred ? this.#atlas.blurred(symbol) : this.#atlas.sharp(symbol);
        this.#shown[slot] = symbol;
      }
    }

    this.#blurred = blurred;
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
