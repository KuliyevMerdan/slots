import { describe, expect, it } from 'vitest';
import { format, minorDigits, toMajorNumber } from './format.js';
import { minor } from './minor.js';

describe('minor digits', () => {
  it.each([
    ['EUR', 2],
    ['USD', 2],
    ['JPY', 0],
    ['KWD', 3],
  ])('knows %s has %i minor digits', (currency, digits) => {
    expect(minorDigits(currency)).toBe(digits);
  });
});

describe('formatting', () => {
  it('renders a two-digit currency', () => {
    // Intl uses a non-breaking space in some locales, so match loosely on the parts that matter.
    expect(format(minor(123_45), { currency: 'EUR', locale: 'en-US' })).toMatch(/€\s?123\.45/);
  });

  it('renders a zero-digit currency without inventing decimals', () => {
    const formatted = format(minor(1_234), { currency: 'JPY', locale: 'en-US' });

    expect(formatted).toMatch(/¥\s?1,234/);
    expect(formatted).not.toContain('.');
  });

  it('renders a bare number when the label already says the currency', () => {
    expect(format(minor(500), { currency: 'EUR', locale: 'en-US', showCurrency: false })).toBe(
      '5.00',
    );
  });

  it('converts to major units for display only', () => {
    expect(toMajorNumber(minor(123_45), 'EUR')).toBe(123.45);
    expect(toMajorNumber(minor(1_234), 'JPY')).toBe(1234);
  });
});
