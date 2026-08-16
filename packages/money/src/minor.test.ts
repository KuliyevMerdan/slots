import { describe, expect, it } from 'vitest';
import {
  ZERO,
  add,
  clamp,
  compare,
  divideExact,
  isMinor,
  minor,
  multiply,
  subtract,
  sum,
} from './minor.js';

describe('construction', () => {
  it.each([0, 1, -1, 100_00, Number.MAX_SAFE_INTEGER])('accepts the integer %i', (value) => {
    expect(minor(value)).toBe(value);
  });

  it.each([1.5, 0.1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'refuses %p — a fractional amount of money is a bug, not an input',
    (value) => {
      expect(() => minor(value)).toThrow(RangeError);
      expect(isMinor(value)).toBe(false);
    },
  );
});

describe('arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(add(minor(1_00), minor(2_50))).toBe(3_50);
    expect(subtract(minor(1_00), minor(2_50))).toBe(-1_50);
  });

  it('sums an empty list to zero', () => {
    expect(sum([])).toBe(ZERO);
  });

  it('sums a win list without drifting', () => {
    // The classic float failure: 0.1 + 0.2 !== 0.3. In minor units it cannot happen.
    const wins = [minor(10), minor(20)];
    expect(sum(wins)).toBe(30);
  });

  it('multiplies by an integer paytable factor', () => {
    expect(multiply(minor(25), 100)).toBe(2_500);
  });

  it('refuses a fractional factor rather than rounding it away', () => {
    expect(() => multiply(minor(25), 1.5)).toThrow(TypeError);
  });

  it('divides a stake into line bets exactly', () => {
    expect(divideExact(minor(2_00), 20)).toBe(10);
  });

  it('refuses a stake that does not divide into whole line bets', () => {
    expect(() => divideExact(minor(1_05), 20)).toThrow(RangeError);
  });

  it('refuses to overflow into unsafe integers', () => {
    expect(() => add(minor(Number.MAX_SAFE_INTEGER), minor(1))).toThrow(RangeError);
    expect(() => multiply(minor(Number.MAX_SAFE_INTEGER), 2)).toThrow(RangeError);
  });
});

describe('comparison and capping', () => {
  it('orders amounts', () => {
    expect(compare(minor(1), minor(2))).toBe(-1);
    expect(compare(minor(2), minor(2))).toBe(0);
    expect(compare(minor(3), minor(2))).toBe(1);
  });

  it('caps a payout at the max win', () => {
    const maxWin = minor(1_000_00);
    expect(clamp(minor(5_000_00), ZERO, maxWin)).toBe(1_000_00);
    expect(clamp(minor(250), ZERO, maxWin)).toBe(250);
  });

  it('refuses inverted bounds', () => {
    expect(() => clamp(minor(1), minor(10), minor(0))).toThrow(RangeError);
  });
});
