import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as fontkit from 'fontkit';
import { LOCALES, STRINGS, allStrings, resolveLocale } from './i18n.js';

/**
 * The font-coverage half of the i18n story (C6): the RU catalogue is walked character by character
 * against the *actual shipped face*, so a new string with a glyph Inter's Cyrillic subset lacks
 * fails CI — instead of falling back per glyph in front of a player, which is how a type design
 * silently stops applying to half the supported languages.
 *
 * The face is resolved out of `node_modules` exactly as Vite bundles it, so the file the test opens
 * is byte-for-byte the file the client ships.
 */

const require = createRequire(import.meta.url);

/** The subsets the client imports in main.ts, at the weights it imports. */
const SHIPPED_SUBSETS = ['latin', 'cyrillic', 'cyrillic-ext'] as const;
const SHIPPED_WEIGHTS = [400, 600, 700] as const;

const fontPath = (subset: string, weight: number): string =>
  path.join(
    path.dirname(require.resolve('@fontsource/inter/package.json')),
    'files',
    `inter-${subset}-${String(weight)}-normal.woff2`,
  );

/** Characters with no glyph anywhere: whitespace and controls the renderer never draws. */
const undrawn = (character: string): boolean => /\s/.test(character);

describe('the shipped face covers every catalogue', () => {
  it.each(LOCALES)('every %s string has a glyph at every shipped weight', (locale) => {
    for (const weight of SHIPPED_WEIGHTS) {
      const faces = SHIPPED_SUBSETS.map((subset) => {
        const face = fontkit.openSync(fontPath(subset, weight));
        // `openSync` can also hand back a collection (.ttc); a fontsource woff2 never is one.
        if (!('hasGlyphForCodePoint' in face)) throw new Error(`${subset} opened as a collection`);
        return face;
      });

      const missing = new Set<string>();
      for (const sentence of allStrings(STRINGS[locale])) {
        for (const character of sentence) {
          if (undrawn(character)) continue;
          const codePoint = character.codePointAt(0);
          if (codePoint === undefined) continue;
          if (!faces.some((face) => face.hasGlyphForCodePoint(codePoint))) {
            missing.add(`${character} (U+${codePoint.toString(16).toUpperCase()})`);
          }
        }
      }

      expect([...missing], `weight ${String(weight)} lacks glyphs`).toEqual([]);
    }
  });
});

describe('locale resolution', () => {
  it('obeys the launch URL first — the operator knows the player (§7)', () => {
    expect(resolveLocale('?lang=ru', 'en-GB')).toBe('ru');
    expect(resolveLocale('?token=abc&lang=RU', 'en-GB')).toBe('ru');
  });

  it('falls back to the browser, then to English', () => {
    expect(resolveLocale('', 'ru-RU')).toBe('ru');
    expect(resolveLocale('', 'de-DE')).toBe('en');
    expect(resolveLocale('', undefined)).toBe('en');
  });

  it('shrugs at a language it does not ship rather than refusing to play', () => {
    expect(resolveLocale('?lang=xx', undefined)).toBe('en');
  });
});

describe('the catalogues themselves', () => {
  it('agree on their shape — every locale answers every key', () => {
    for (const locale of LOCALES) {
      expect(Object.keys(STRINGS[locale]).sort()).toEqual(Object.keys(STRINGS.en).sort());
    }
  });

  it('russian plurals decline: 1 минуту, 2 минуты, 5 минут, 11 минут, 21 минуту', () => {
    const message = STRINGS.ru.realityMessage.bind(STRINGS.ru);
    expect(message(1)).toContain('минуту');
    expect(message(2)).toContain('минуты');
    expect(message(5)).toContain('минут.');
    expect(message(11)).toContain('минут.');
    expect(message(21)).toContain('минуту');
  });
});
