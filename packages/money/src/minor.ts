import type { Minor } from '@slot/protocol';

/**
 * Arithmetic on integer minor units.
 *
 * **Every operation here is exact or it throws.** There is no rounding mode, because nothing in the
 * game needs one: paytable multipliers are integers, and a stake is always a whole number of line
 * bets (`@slot/game-math` enforces that). The day a fractional operation appears, it should be a
 * loud decision — not a silently rounded cent.
 */

const assertSafe = (value: number, operation: string): Minor => {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `${operation} produced ${value}, which is not a safe integer — money is integer minor units`,
    );
  }
  return value as Minor;
};

export const ZERO = 0 as Minor;

/** The one place a plain number becomes money. Anything else is a bug. */
export const minor = (value: number): Minor => assertSafe(value, 'minor()');

export const isMinor = (value: number): boolean => Number.isSafeInteger(value);

export const add = (a: Minor, b: Minor): Minor => assertSafe(a + b, 'add');

export const subtract = (a: Minor, b: Minor): Minor => assertSafe(a - b, 'subtract');

/** `factor` must be a whole number — see the note at the top of this file. */
export const multiply = (amount: Minor, factor: number): Minor => {
  if (!Number.isSafeInteger(factor)) {
    throw new TypeError(`multiply expects an integer factor, got ${factor}`);
  }
  return assertSafe(amount * factor, 'multiply');
};

/** Exact division only: a remainder is a design error, not something to round away. */
export const divideExact = (amount: Minor, divisor: number): Minor => {
  if (!Number.isSafeInteger(divisor) || divisor === 0) {
    throw new TypeError(`divideExact expects a non-zero integer divisor, got ${divisor}`);
  }
  if (amount % divisor !== 0) {
    throw new RangeError(
      `${amount} minor units do not divide evenly by ${divisor} — pick a stake that does`,
    );
  }
  return assertSafe(amount / divisor, 'divideExact');
};

export const sum = (amounts: readonly Minor[]): Minor =>
  amounts.reduce<Minor>((total, amount) => add(total, amount), ZERO);

export const compare = (a: Minor, b: Minor): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0);

export const min = (a: Minor, b: Minor): Minor => (a <= b ? a : b);

export const max = (a: Minor, b: Minor): Minor => (a >= b ? a : b);

/** Used for the max-win cap: the payout the player actually receives. */
export const clamp = (amount: Minor, lower: Minor, upper: Minor): Minor => {
  if (lower > upper) {
    throw new RangeError(`clamp bounds are inverted: ${lower} > ${upper}`);
  }
  return min(max(amount, lower), upper);
};

export const isZero = (amount: Minor): boolean => amount === 0;

export const isPositive = (amount: Minor): boolean => amount > 0;

export const isNegative = (amount: Minor): boolean => amount < 0;
