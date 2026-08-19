import { describe, expect, it } from 'vitest';
import {
  PALETTE,
  SYMBOL_STYLE,
  UNKNOWN_SYMBOL,
  WCAG_AA_LARGE_TEXT,
  WCAG_AA_TEXT,
  WIN_PALETTE,
  contrastRatio,
} from '@slot/renderer';
import { UI_PALETTE } from '@slot/ui';

/**
 * Contrast stops being luck (C6): every text-on-surface pair either palette can produce is held to
 * WCAG 2.1 AA, in CI. A root suite because the pairs span two packages — `ui` deliberately may not
 * import `renderer`, so only a wiring-level test can see both palettes at once.
 *
 * Two thresholds, applied by what the text is on screen: symbol glyphs, banner titles and HUD
 * amounts render at display sizes (3:1, AA large text); the status line and captions are small
 * (4.5:1). This suite found its first two failures the day it was written — SCAT and H3 carried
 * white glyphs at 1.98:1 and 2.26:1 — and the fills in `SYMBOL_STYLE` are darker for it.
 */

describe('symbol glyphs on their tiles — AA large text', () => {
  it.each(Object.entries(SYMBOL_STYLE))('%s', (_symbol, style) => {
    expect(contrastRatio(PALETTE.glyph, style.fill)).toBeGreaterThanOrEqual(WCAG_AA_LARGE_TEXT);
  });

  it('covers the fallback tile too — an unknown symbol still has to be legible', () => {
    expect(contrastRatio(PALETTE.glyph, UNKNOWN_SYMBOL.fill)).toBeGreaterThanOrEqual(
      WCAG_AA_LARGE_TEXT,
    );
  });
});

describe('the win presentation — AA large text on the banner plate', () => {
  it.each([
    ['tier title', WIN_PALETTE.bannerText],
    ['counted amount', WIN_PALETTE.amount],
  ])('%s', (_label, colour) => {
    expect(contrastRatio(colour, WIN_PALETTE.bannerPlate)).toBeGreaterThanOrEqual(
      WCAG_AA_LARGE_TEXT,
    );
  });

  it('the per-line amount over the darkest and lightest surfaces it can cross', () => {
    // The line amount floats over the reels; the track and the frame are its extremes.
    for (const surface of [PALETTE.reelTrack, PALETTE.frame]) {
      expect(contrastRatio(WIN_PALETTE.amount, surface)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
    }
  });
});

describe('the control panel — AA text', () => {
  it.each([
    ['readout values', UI_PALETTE.text, UI_PALETTE.panel],
    ['captions and status', UI_PALETTE.textMuted, UI_PALETTE.panel],
    ['the win readout', UI_PALETTE.win, UI_PALETTE.panel],
    ['the status line on the backdrop', UI_PALETTE.textMuted, 0x0b1020],
    ['an error message on the backdrop', UI_PALETTE.danger, 0x0b1020],
  ])('%s', (_label, text, surface) => {
    expect(contrastRatio(text, surface)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });

  it('the spin button label at both button states — AA large text', () => {
    for (const face of [UI_PALETTE.accent, UI_PALETTE.accentPressed]) {
      expect(contrastRatio(0x0b1020, face)).toBeGreaterThanOrEqual(WCAG_AA_LARGE_TEXT);
    }
  });
});
