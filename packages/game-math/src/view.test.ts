import { describe, expect, it } from 'vitest';
import { STRIPS } from './strips.js';
import { viewFrom, viewMatchesStops } from './view.js';

const STRIP_A = ['A', 'B', 'C', 'D'];
const STRIP_B = ['E', 'F', 'G', 'H'];

describe('deriving the grid from stops', () => {
  it('reads three consecutive symbols per reel', () => {
    expect(viewFrom([STRIP_A, STRIP_B], [0, 1], 3)).toEqual([
      ['A', 'B', 'C'],
      ['F', 'G', 'H'],
    ]);
  });

  it('wraps around the end of a strip — a strip is a loop, not a list', () => {
    expect(viewFrom([STRIP_A], [3], 3)).toEqual([['D', 'A', 'B']]);
  });

  it.each([
    ['too few stops', [0]],
    ['too many stops', [0, 0, 0]],
    ['a negative stop', [-1, 0]],
    ['a fractional stop', [1.5, 0]],
  ])('refuses %s rather than guessing', (_label, stops) => {
    expect(() => viewFrom([STRIP_A, STRIP_B], stops, 3)).toThrow(RangeError);
  });
});

describe('checking a server grid against its own stops', () => {
  it('accepts a consistent pair', () => {
    const stops = [7, 12, 3, 19, 31];
    const view = viewFrom(STRIPS, stops, 3);

    expect(viewMatchesStops(STRIPS, stops, view)).toBe(true);
  });

  it('rejects a grid that does not follow from the stops', () => {
    // This is the drift the dev-build assertion exists to catch: a server whose view and stops
    // disagree has a strip-alignment bug, and the client would happily animate the wrong reels.
    const stops = [7, 12, 3, 19, 31];
    const view = viewFrom(STRIPS, stops, 3);
    const tampered = view.map((reel, index) => (index === 2 ? ['WILD', 'WILD', 'WILD'] : reel));

    expect(viewMatchesStops(STRIPS, stops, tampered)).toBe(false);
  });

  it('rejects a malformed grid instead of throwing at the caller', () => {
    expect(viewMatchesStops(STRIPS, [0, 0, 0, 0, 0], [])).toBe(false);
  });
});
