import type { SymbolId, Win } from '@slot/protocol';
import { describe, expect, it } from 'vitest';
import golden from './__fixtures__/golden.json' with { type: 'json' };
import { evaluate } from './evaluate.js';
import { PAYLINES } from './paylines.js';
import { PAYTABLE } from './paytable.js';

/**
 * Thirty handcrafted grids evaluated over the **real** twenty paylines.
 *
 * `evaluate.test.ts` states the rules one line at a time; this states what those rules add up to on
 * a full screen, which is where the surprises live — a grid that "obviously" wins once often wins
 * three times, and that is exactly the arithmetic a win presentation has to survive.
 *
 * When the math changes deliberately: `pnpm --filter @slot/game-math golden:update`, then read the
 * diff. Regenerating to make a red test green defeats the entire point of the file.
 */

const toView = (rows: readonly string[]): SymbolId[][] => {
  const grid = rows.map((row) => row.trim().split(/\s+/));
  const reels = grid[0]?.length ?? 0;
  return Array.from({ length: reels }, (_unused, reel) =>
    grid.map((row) => row[reel] ?? 'MISSING'),
  );
};

const describeWin = (win: Win): string =>
  win.kind === 'LINE'
    ? `LINE l${String(win.line)} ${win.symbol}×${String(win.count)} ${String(win.amount)}`
    : `SCATTER ${win.symbol}×${String(win.count)} ${String(win.amount)}`;

describe('golden grids', () => {
  it('covers the cases worth having an opinion about', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(30);
  });

  it.each(golden.cases.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    (_name, testCase) => {
      const result = evaluate({
        view: toView(testCase.rows),
        paylines: PAYLINES,
        paytable: PAYTABLE,
        stake: golden.stake as never,
      });

      expect({
        totalWin: result.totalWin,
        wins: result.wins.map(describeWin),
      }).toEqual(testCase.expected);
    },
  );

  it('never pays a scatter win along a payline', () => {
    for (const testCase of golden.cases) {
      for (const win of testCase.expected.wins) {
        if (win.startsWith('SCATTER')) expect(win).not.toContain(' l');
      }
    }
  });
});
