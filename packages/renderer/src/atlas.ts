import { Container, Graphics, Rectangle, Text, TextStyle, Texture } from 'pixi.js';
import type { Renderer } from 'pixi.js';
import { FONT_STACK, PALETTE, SYMBOL_SIZE, styleFor } from './theme.js';

/**
 * The symbol atlas — **generated at boot, into one texture**.
 *
 * Two constraints meet here. The performance rules want *one* texture and therefore one draw-call
 * batch for the whole symbol layer, and motion blur that is a **pre-rendered texture swap** rather
 * than a `BlurFilter` (a filter breaks batching and costs a render target every frame). And the
 * repository is public, which makes shipped art a licensing question rather than a shopping one.
 *
 * Drawing the symbols ourselves answers both at once: no binary asset, no licence, no attribution —
 * and a single `RenderTexture` holding every symbol in two variants, sliced into frames that all
 * share one source and therefore batch. Swapping in real art later replaces this file and nothing
 * else, because everything downstream asks for `atlas.sharp(symbol)`.
 *
 * The blurred variant is a **vertical smear**, not a gaussian: a spinning reel blurs along one axis
 * only, and a stack of offset copies looks more like motion than a soft focus does.
 */

/** Copies drawn per blurred symbol, and how far the smear reaches, in fractions of a symbol. */
const SMEAR_COPIES = 9;
const SMEAR_REACH = 0.55;

/**
 * Which row of the sheet the smeared variant sits on.
 *
 * Row 2 rather than row 1 because the smear reaches beyond its own cell by `SMEAR_REACH` in both
 * directions — put it directly under the sharp row and it bleeds into that frame, which draws as a
 * ghost under every symbol on screen. One empty row is cheaper than clipping every copy.
 */
const SMEAR_ROW = 2;

export interface SymbolAtlas {
  /** The crisp symbol, drawn when the reel is slow enough to read. */
  sharp(symbol: string): Texture;
  /** The smeared symbol, drawn above the blur threshold. */
  blurred(symbol: string): Texture;
  /** Every symbol this atlas was built for. */
  readonly symbols: readonly string[];
  destroy(): void;
}

const glyphStyle = (size: number): TextStyle =>
  new TextStyle({
    fontFamily: FONT_STACK,
    fontSize: size * 0.34,
    fontWeight: '700',
    fill: PALETTE.glyph,
    letterSpacing: 1,
  });

/** One symbol tile: a rounded plate, an inner edge, and the glyph. */
function drawSymbol(symbol: string, size: number): Container {
  const { fill, edge, glyph } = styleFor(symbol);
  const tile = new Container();
  const inset = size * 0.06;
  const plate = new Graphics()
    .roundRect(inset, inset, size - inset * 2, size - inset * 2, size * 0.16)
    .fill({ color: fill })
    .stroke({ width: Math.max(2, size * 0.02), color: edge, alpha: 0.9 });

  // A highlight along the top edge — the cheapest way to stop a flat fill reading as a coloured box.
  const sheen = new Graphics()
    .roundRect(inset * 1.8, inset * 1.8, size - inset * 3.6, size * 0.28, size * 0.12)
    .fill({ color: 0xffffff, alpha: 0.09 });

  const label = new Text({ text: glyph, style: glyphStyle(size) });
  label.anchor.set(0.5);
  label.position.set(size / 2, size / 2);

  tile.addChild(plate, sheen, label);
  return tile;
}

/**
 * Build the atlas.
 *
 * Every tile is laid out in a two-row grid — sharp on top, smeared underneath — rendered once, and
 * then handed out as `Texture` frames over that single source. One base texture, one batch.
 */
export function createSymbolAtlas(
  renderer: Renderer,
  symbols: readonly string[],
  size = SYMBOL_SIZE,
): SymbolAtlas {
  const unique = [...new Set(symbols)];
  const sheet = new Container();

  unique.forEach((symbol, column) => {
    const sharp = drawSymbol(symbol, size);
    sharp.position.set(column * size, 0);
    sheet.addChild(sharp);

    const smeared = new Container();
    smeared.position.set(column * size, SMEAR_ROW * size);
    for (let copy = 0; copy < SMEAR_COPIES; copy += 1) {
      const offset = (copy / (SMEAR_COPIES - 1) - 0.5) * 2 * SMEAR_REACH * size;
      const layer = drawSymbol(symbol, size);
      layer.position.y = offset;
      // Ends of the smear are faintest, which is what gives the streak a direction rather than a
      // uniform ghost.
      layer.alpha = (1 - Math.abs(copy / (SMEAR_COPIES - 1) - 0.5) * 2) * 0.55 + 0.08;
      smeared.addChild(layer);
    }
    sheet.addChild(smeared);
  });

  const source = renderer.generateTexture({
    target: sheet,
    // Explicit, and not optional: without it the texture is cut to the *drawn* bounds, which start
    // at the tile's inset rather than at the origin. Every frame would then be offset by a few
    // pixels and each symbol would show a sliver of its neighbour — subtle enough to look like a
    // rendering artefact and infuriating to track down.
    frame: new Rectangle(0, 0, unique.length * size, (SMEAR_ROW + 1) * size),
    resolution: renderer.resolution,
    antialias: true,
  });

  const frames = new Map<string, { sharp: Texture; blurred: Texture }>();
  unique.forEach((symbol, column) => {
    frames.set(symbol, {
      sharp: new Texture({
        source: source.source,
        frame: new Rectangle(column * size, 0, size, size),
      }),
      blurred: new Texture({
        source: source.source,
        frame: new Rectangle(column * size, SMEAR_ROW * size, size, size),
      }),
    });
  });

  sheet.destroy({ children: true });

  const fallback = frames.get(unique[0] ?? '') ?? {
    sharp: Texture.EMPTY,
    blurred: Texture.EMPTY,
  };

  return {
    symbols: unique,
    sharp: (symbol) => (frames.get(symbol) ?? fallback).sharp,
    blurred: (symbol) => (frames.get(symbol) ?? fallback).blurred,
    destroy: () => {
      for (const frame of frames.values()) {
        frame.sharp.destroy();
        frame.blurred.destroy();
      }
      frames.clear();
      source.destroy(true);
    },
  };
}
