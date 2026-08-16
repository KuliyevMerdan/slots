import type { Minor } from '@slot/protocol';

/**
 * Display formatting — the **only** place minor units become a decimal string, and the last thing
 * that happens before a number reaches a player's eyes.
 *
 * The number of minor digits comes from `Intl` rather than a hard-coded 2, because it is 0 for JPY
 * and 3 for KWD, and a slot that shows `¥12.34` is a slot nobody in that market will trust.
 */

export interface FormatOptions {
  /** ISO 4217, from `session.currency`. */
  currency: string;
  /** BCP 47. Defaults to the currency's conventional formatting under `en`. */
  locale?: string;
  /** Show the currency symbol. Off for a bare number next to a label. */
  showCurrency?: boolean;
}

const formatterCache = new Map<string, Intl.NumberFormat>();

const formatterFor = (
  locale: string,
  currency: string,
  showCurrency: boolean,
): Intl.NumberFormat => {
  const key = `${locale}|${currency}|${showCurrency}`;
  const cached = formatterCache.get(key);
  if (cached !== undefined) return cached;

  const digits = minorDigits(currency, locale);
  const created = new Intl.NumberFormat(
    locale,
    showCurrency
      ? { style: 'currency', currency }
      : { minimumFractionDigits: digits, maximumFractionDigits: digits },
  );
  formatterCache.set(key, created);
  return created;
};

/** How many minor units make one major unit, as a power of ten: 2 for EUR, 0 for JPY, 3 for KWD. */
export const minorDigits = (currency: string, locale = 'en'): number => {
  // `maximumFractionDigits` is optional in the lib types but always resolved for style: 'currency'.
  // An unknown currency code makes the constructor throw before we get here.
  const { maximumFractionDigits } = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).resolvedOptions();

  return maximumFractionDigits ?? 2;
};

/** For display and for chart/animation interpolation only — never for arithmetic. */
export const toMajorNumber = (amount: Minor, currency: string, locale = 'en'): number =>
  amount / 10 ** minorDigits(currency, locale);

export const format = (amount: Minor, options: FormatOptions): string => {
  const { currency, locale = 'en', showCurrency = true } = options;
  return formatterFor(locale, currency, showCurrency).format(
    toMajorNumber(amount, currency, locale),
  );
};
