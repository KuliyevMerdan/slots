import type { SymbolId } from '@slot/protocol';
import { minor } from '@slot/money';
import { describe, expect, it } from 'vitest';
import { evaluate } from './evaluate.js';
import { PAYTABLE } from './paytable.js';

/**
 * Semantics, one payline at a time.
 *
 * A single line and a 100-unit stake keep every expectation readable: these tests are the
 * specification of *how a win is read*, and the messy many-lines-at-once behaviour is pinned
 * separately by the golden file.
 *
 * Amounts are written as `pays(symbol, count) × line bet` rather than as literals. That is not
 * laziness: the tuned multipliers are S4's and will move again when the math is re-tuned, while the
 * rules under test here — a run starts on reel one, wilds substitute for anything but the scatter,
 * a line starting with wilds is paid the better of its two readings, scatters multiply the *total
 * stake* — do not. What each test pins is the rule; the golden file and `pnpm math-sim` pin the
 * numbers.
 */

const SINGLE_LINE = [[1, 1, 1, 1, 1]] as const;
const STAKE = minor(100); // one line × 100 = a line bet of 100

/** The paytable multiplier for `count` of `symbol`, or 0 if that count does not pay. */
const pays = (symbol: SymbolId, count: number): number =>
  PAYTABLE.find((entry) => entry.symbol === symbol)?.pays.find((pay) => pay.count === count)
    ?.multiplier ?? 0;

/** What a line win of `count` × `symbol` is worth on the single-line, 100-unit stake above. */
const line = (symbol: SymbolId, count: number): number => pays(symbol, count) * 100;

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

    expect(result.totalWin).toBe(line('L1', 3));
    expect(result.wins[0]).toMatchObject({ kind: 'LINE', symbol: 'L1', count: 3, line: 0 });
  });

  it('pays four of a kind', () => {
    expect(run(['L2', 'L2', 'L2', 'L2', 'H1']).totalWin).toBe(line('L2', 4));
  });

  it('pays five of a kind', () => {
    expect(run(['H1', 'H1', 'H1', 'H1', 'H1']).totalWin).toBe(line('H1', 5));
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
    // Four L4s on the grid but only three in a row, and `L4` does not pay for three — so a break
    // is worth exactly nothing, which is the strongest form this rule can be asserted in.
    expect(run(['L4', 'L4', 'L4', 'H1', 'L4']).totalWin).toBe(0);
    expect(run(['L4', 'L4', 'L4', 'L4', 'H1']).totalWin).toBe(line('L4', 4));
  });
});

describe('wilds', () => {
  it('substitutes to complete a run', () => {
    expect(run(['L3', 'L3', 'WILD', 'H1', 'H2']).totalWin).toBe(line('L3', 3));
  });

  it('substitutes in the middle of a longer run', () => {
    expect(run(['H2', 'H2', 'WILD', 'H2', 'H2']).totalWin).toBe(line('H2', 5));
  });

  it('pays the better reading when the line starts with wilds', () => {
    // WILD ×2 pays nothing; WILD WILD standing in for H1 pays five of a kind. The player gets the
    // second reading.
    expect(run(['WILD', 'WILD', 'H1', 'H1', 'H1']).totalWin).toBe(line('H1', 5));
  });

  it('pays as itself when that is worth more', () => {
    // Three wilds beat standing in for four L4s — and the test says so in those terms rather than in
    // numbers, so it keeps meaning that after the next re-tune.
    expect(line('WILD', 3)).toBeGreaterThan(line('L4', 4));
    expect(run(['WILD', 'WILD', 'WILD', 'L4', 'H1']).totalWin).toBe(line('WILD', 3));
  });

  it('pays the substitution when *that* is worth more', () => {
    // The mirror case: four H3s beat three wilds.
    expect(line('H3', 4)).toBeGreaterThan(line('WILD', 3));
    expect(run(['WILD', 'WILD', 'WILD', 'H3', 'H1']).totalWin).toBe(line('H3', 4));
  });

  it('pays a full line of wilds', () => {
    expect(run(['WILD', 'WILD', 'WILD', 'WILD', 'WILD']).totalWin).toBe(line('WILD', 5));
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

    expect(result.totalWin).toBe(pays('SCAT', 3) * STAKE); // the *total stake*, not a line bet
    expect(result.wins[0]).toMatchObject({ kind: 'SCATTER', count: 3 });
    expect(result.wins[0]?.line).toBeUndefined();
  });

  it.each([4, 5])('pays %i scatters', (count) => {
    expect(evaluateScatters(count).totalWin).toBe(pays('SCAT', count) * STAKE);
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
    // Against the 2,000 stake, not against the 100-unit line bet it would have on twenty lines.
    expect(scatterWin?.amount).toBe(pays('SCAT', 3) * 2_000);
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
