/**
 * The control panel's palette and type, as data.
 *
 * Deliberately a separate file from the renderer's: the dependency table says `ui → protocol, money`,
 * so this package may not import `@slot/renderer` — and a shared-constants package for nine colours
 * would be a dependency invented to avoid retyping nine colours. When a real design system arrives
 * (C6), both read from it.
 */

export const UI_PALETTE = {
  panel: 0x121a2e,
  panelEdge: 0x2c3860,
  text: 0xe8ecf8,
  textMuted: 0x8d97b8,
  accent: 0x39d98a,
  accentPressed: 0x2aa76a,
  disabled: 0x3a4260,
  win: 0xffd166,
  danger: 0xff6b6b,
} as const;

/**
 * Inter first — the OFL face the client ships (via `@fontsource/inter`, latin + cyrillic subsets),
 * chosen because the i18n catalogue includes Russian and a display face without Cyrillic falls back
 * per glyph. The rest is the system stack the game booted with before the font arrives.
 */
export const UI_FONT =
  'Inter, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", system-ui, sans-serif';
