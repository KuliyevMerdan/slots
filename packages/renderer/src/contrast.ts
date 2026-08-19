/**
 * WCAG 2.1 contrast arithmetic, over the packed `0xrrggbb` numbers the palettes use.
 *
 * Here rather than in a test, because the debug panel will want to display the same numbers —
 * and because a contrast rule enforced in CI should be computed by the code under test's own maths,
 * not by a copy in the test file that can drift from it.
 */

/** WCAG relative luminance of a packed `0xrrggbb` colour. */
export function relativeLuminance(rgb: number): number {
  const channel = (value: number): number => {
    const srgb = value / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };

  const r = channel((rgb >> 16) & 0xff);
  const g = channel((rgb >> 8) & 0xff);
  const b = channel(rgb & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two packed colours — 1 (none) to 21 (black on white). */
export function contrastRatio(a: number, b: number): number {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b));
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

/** The AA thresholds, named so the test reads as the rule it enforces. */
export const WCAG_AA_TEXT = 4.5;
export const WCAG_AA_LARGE_TEXT = 3;
