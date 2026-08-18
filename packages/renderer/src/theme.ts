/**
 * The look of the reel area, as data.
 *
 * Kept in one file because every number here is a design decision someone will want to change, and
 * because the alternative — magic numbers spread across four Pixi files — is how a layout becomes
 * unmaintainable. `@slot/ui` carries its own palette rather than importing this one: the dependency
 * table says `ui → protocol, money`, and two small constant files are a smaller price than a
 * dependency that exists only to share six colours.
 */

export const SYMBOL_SIZE = 148;
export const SYMBOL_GAP = 6;

export const PALETTE = {
  backdrop: 0x0b1020,
  frame: 0x1b2340,
  frameEdge: 0x38508f,
  reelTrack: 0x131a2e,
  glyph: 0xf4f7ff,
  glyphShadow: 0x0a0f1e,
} as const;

/**
 * One colour per symbol, and the reason the placeholder art reads at a glance: value is encoded as
 * hue, so a screen of low symbols looks different from a screen of high ones before you can read a
 * single glyph. Real art replaces the atlas, not this idea.
 */
export const SYMBOL_STYLE: Record<string, { fill: number; edge: number; glyph: string }> = {
  WILD: { fill: 0x7b3ff2, edge: 0xc9a7ff, glyph: 'W' },
  SCAT: { fill: 0xf2a03f, edge: 0xffe0a7, glyph: 'S' },
  H1: { fill: 0xd8324b, edge: 0xff9aa8, glyph: 'H1' },
  H2: { fill: 0xdb6a1f, edge: 0xffc48f, glyph: 'H2' },
  H3: { fill: 0xc9a227, edge: 0xffe98f, glyph: 'H3' },
  L1: { fill: 0x2f7f5b, edge: 0x8fe0bc, glyph: 'L1' },
  L2: { fill: 0x2f5f9f, edge: 0x9fc8ff, glyph: 'L2' },
  L3: { fill: 0x4a4f78, edge: 0xb0b6e0, glyph: 'L3' },
  L4: { fill: 0x5c5f6b, edge: 0xc0c4d0, glyph: 'L4' },
};

/** Anything the server sends that this build has no art for still has to draw as *something*. */
export const UNKNOWN_SYMBOL = { fill: 0x333844, edge: 0x9aa0b4, glyph: '?' } as const;

export const styleFor = (symbol: string): { fill: number; edge: number; glyph: string } =>
  SYMBOL_STYLE[symbol] ?? UNKNOWN_SYMBOL;

/** The win presentation: the line, the ring around a winning cell, and the big-win plate. */
export const WIN_PALETTE = {
  line: 0xffd166,
  lineShadow: 0x1a1200,
  ring: 0xffe9a8,
  bannerPlate: 0x1b1330,
  bannerEdge: 0xffd166,
  bannerText: 0xffe9a8,
  amount: 0xffffff,
} as const;

/** The type face. A system stack, so the repository ships no font and licences no font. */
export const FONT_STACK =
  '"Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", system-ui, sans-serif';
