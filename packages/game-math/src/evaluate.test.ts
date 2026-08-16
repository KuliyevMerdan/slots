import type { SymbolId } from '@slot/protocol';
import { minor } from '@slot/money';
import { describe, expect, it } from 'vitest';
import { evaluate } from './evaluate.js';
import { PAYTABLE } from './paytable.js';

/**
 * Semantics, one payline at a time.
 *
 * A single line and a 100-unit stake make every expectation checkable by eye against the paytable —
 * which is the point: these tests are the specification of how a win is read. The messy,
 * many-line-at-once behaviour is pinned separately by the golden file.
 */

const SINGLE_LINE = [[1, 1, 1, 1, 1]] as const;
const STAKE = minor(100); // one line × 100 = a line bet of 100

/** `middle` is what lands on the payline; the other rows are filled with non-matching symbols. */
const grid = (middle: readonly SymbolId[]): SymbolId[][] =>
  middle.map((symbol, reel) => {
    const filler: SymbolId[] = ['H1', 'H2', 'H3', 'L1', 'L2'];
    const above = filler[reel] ?? 'H1';
    const below = filler[(reel + 2) % filler.length] ?? 'H2';
    return [above, symbol, below];
  });

const run = (middle: readonly SymbolId[], stake = STAKE) =>
  evaluate({ view: grid(middle), paylines: SINGLE_LINE, paytable: PAYTABLE, stake });

describe('line wins', () => {
  it('pays nothing when nothing lines up', () => {
    const result = run(['L1', 'H1', 'L2', 'H2', 'L3']);

    expect(result.wins).toEqual([]);
    expect(result.totalWin).toBe(0);
  });

  it('pays three of a kind', () => {
    const result = run(['L1', 'L1', 'L1', 'H3', 'H1']);

    expect(result.totalWin).toBe(300); // L1 ×3 = 3 × line bet
    expect(result.wins[0]).toMatchObject({ kind: 'LINE', symbol: 'L1', count: 3, line: 0 });
  });

  it('pays four of a kind', () => {
    expect(run(['L2', 'L2', 'L2', 'L2', 'H1']).totalWin).toBe(800);
  });

  it('pays five of a kind', () => {
    expect(run(['H1', 'H1', 'H1', 'H1', 'H1']).totalWin).toBe(25_000);
  });

  it('reports the winning cells, and only those', () => {
    const result = run(['L1', 'L1', 'L1', 'H3', 'H1']);

    expect(result.wins[0]?.positions).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
    ]);
  });

  it('only counts a run that starts on reel one', () => {
    // Three H1s, but the line starts with something else — no pay. The single most common
    // misreading of a slot grid, and the one players notice instantly.
    expect(run(['L4', 'H1', 'H1', 'H1', 'L2']).totalWin).toBe(0);
  });

  it('stops counting at the first break', () => {
    expect(run(['L4', 'L4', 'L4', 'H1', 'L4']).totalWin).toBe(100); // L4 ×3, not ×4
  });
});

describe('wilds', () => {
  it('substitutes to complete a run', () => {
    expect(run(['L3', 'L3', 'WILD', 'H1', 'H2']).totalWin).toBe(200); // L3 ×3
  });

  it('substitutes in the middle of a longer run', () => {
    expect(run(['H2', 'H2', 'WILD', 'H2', 'H2']).totalWin).toBe(15_000); // H2 ×5
  });

  it('pays the better reading when the line starts with wilds', () => {
    // WILD ×2 pays nothing; WILD WILD standing in for H1 pays five of a kind. The player gets the
    // second reading.
    expect(run(['WILD', 'WILD', 'H1', 'H1', 'H1']).totalWin).toBe(25_000);
  });

  it('pays as itself when that is worth more', () => {
    // WILD ×3 = 2000 beats standing in for L4 across four reels = 500.
    expect(run(['WILD', 'WILD', 'WILD', 'L4', 'H1']).totalWin).toBe(2_000);
  });

  it('pays the substitution when *that* is worth more', () => {
    // The mirror case: WILD ×3 = 2000, but standing in for H3 across four reels = 2500.
    expect(run(['WILD', 'WILD', 'WILD', 'H3', 'H1']).totalWin).toBe(2_500);
  });

  it('pays a full line of wilds', () => {
    expect(run(['WILD', 'WILD', 'WILD', 'WILD', 'WILD']).totalWin).toBe(50_000);
  });

  it('never substitutes for the scatter', () => {
    const result = run(['WILD', 'WILD', 'SCAT', 'H1', 'H2']);

    // Two scatters do not pay, and the wilds cannot turn them into three.
    expect(result.wins.filter((win) => win.kind === 'SCATTER')).toEqual([]);
    expect(result.totalWin).toBe(0);
  });
});

describe('scatters', () => {
  const withScatters = (count: number): SymbolId[][] => {
    const view = grid(['L1', 'H1', 'L2', 'H2', 'L3']);
    for (let reel = 0; reel < count; reel += 1) {
      const column = view[reel];
      if (column !== undefined) column[0] = 'SCAT';
    }
    return view;
  };

  const evaluateScatters = (count: number) =>
    evaluate({
      view: withScatters(count),
      paylines: SINGLE_LINE,
      paytable: PAYTABLE,
      stake: STAKE,
    });

  it('pays anywhere on the grid, not along a line', () => {
    const result = evaluateScatters(3);

    expect(result.totalWin).toBe(200); // 2 × the total stake
    expect(result.wins[0]).toMatchObject({ kind: 'SCATTER', count: 3 });
    expect(result.wins[0]?.line).toBeUndefined();
  });

  it.each([
    [4, 1_000],
    [5, 5_000],
  ])('pays %i scatters', (count, expected) => {
    expect(evaluateScatters(count).totalWin).toBe(expected);
  });

  it.each([0, 1, 2])('does not pay %i scatters', (count) => {
    expect(evaluateScatters(count).totalWin).toBe(0);
  });

  it('multiplies the total stake, not the line bet', () => {
    const view = withScatters(3);
    const twentyLines = Array.from({ length: 20 }, () => [1, 1, 1, 1, 1]);

    const result = evaluate({
      view,
      paylines: twentyLines,
      paytable: PAYTABLE,
      stake: minor(2_000),
    });

    const scatterWin = result.wins.find((win) => win.kind === 'SCATTER');
    expect(scatterWin?.amount).toBe(4_000); // 2 × 2000, not 2 × the 100-unit line bet
  });
});

describe('input validation', () => {
  it('refuses a stake that does not divide into whole line bets', () => {
    expect(() =>
      evaluate({
        view: grid(['L1', 'L1', 'L1', 'H1', 'H2']),
        paylines: [
          [1, 1, 1, 1, 1],
          [0, 0, 0, 0, 0],
          [2, 2, 2, 2, 2],
        ],
        paytable: PAYTABLE,
        stake: minor(100),
      }),
    ).toThrow(RangeError);
  });

  it('refuses a payline that points outside the grid', () => {
    expect(() =>
      evaluate({
        view: grid(['L1', 'L1', 'L1', 'H1', 'H2']),
        paylines: [[9, 9, 9, 9, 9]],
        paytable: PAYTABLE,
        stake: STAKE,
      }),
    ).toThrow(RangeError);
  });
});
