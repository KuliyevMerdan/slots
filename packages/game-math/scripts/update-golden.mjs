import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAYLINES, PAYTABLE, evaluate } from '../dist/index.js';

/**
 * Regenerates the expectations in src/__fixtures__/golden.json from the current evaluator.
 *
 * Run it (`pnpm --filter @slot/game-math golden:update`) when you have **deliberately** changed the
 * math, then read the diff: it is the change, stated in one place. Never run it to make a red test
 * green — that is the one thing a golden file is for.
 *
 * Requires a build first (it imports dist/), which also proves the published surface exports what
 * the tests use.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, '../src/__fixtures__/golden.json');

const toView = (rows) => {
  const grid = rows.map((row) => row.trim().split(/\s+/));
  const reels = grid[0].length;
  return Array.from({ length: reels }, (_unused, reel) => grid.map((row) => row[reel]));
};

const describeWin = (win) =>
  win.kind === 'LINE'
    ? `LINE l${win.line} ${win.symbol}×${win.count} ${win.amount}`
    : `SCATTER ${win.symbol}×${win.count} ${win.amount}`;

const golden = JSON.parse(readFileSync(FILE, 'utf8'));

golden.cases = golden.cases.map((testCase) => {
  const result = evaluate({
    view: toView(testCase.rows),
    paylines: PAYLINES,
    paytable: PAYTABLE,
    stake: golden.stake,
  });

  return {
    ...testCase,
    expected: { totalWin: result.totalWin, wins: result.wins.map(describeWin) },
  };
});

writeFileSync(FILE, `${JSON.stringify(golden, null, 2)}\n`);

const total = golden.cases.reduce((sum, testCase) => sum + testCase.expected.totalWin, 0);
console.log(`updated ${golden.cases.length} cases (${total} minor units across the set)`);
