import type { PaytableEntry } from '@slot/protocol';
import type { GameSymbol } from './symbols.js';

/**
 * The paytable, as data.
 *
 * `LINE` multipliers apply to the **line bet**; the `SCATTER` multiplier applies to the **total
 * stake**. Nothing here is tuned yet — RTP convergence is S4's job (`tools/math-sim`), and until
 * that runs these numbers are plausible, not designed.
 */
export const PAYTABLE: readonly PaytableEntry[] = [
  {
    symbol: 'WILD' satisfies GameSymbol,
    kind: 'LINE',
    pays: [
      { count: 3, multiplier: 20 },
      { count: 4, multiplier: 100 },
      { count: 5, multiplier: 500 },
    ],
  },
  {
    symbol: 'H1' satisfies GameSymbol,
    kind: 'LINE',
    pays: [
      { count: 3, multiplier: 10 },
      { count: 4, multiplier: 50 },
      { count: 5, multiplier: 250 },
    ],
  },
  {
    symbol: 'H2' satisfies GameSymbol,
    kind: 'LINE',
    pays: [
      { count: 3, multiplier: 8 },
      { count: 4, multiplier: 40 },
      { count: 5, multiplier: 150 },
    ],
  },
  {
    symbol: 'H3' satisfies GameSymbol,
    kind: 'LINE',
    pays: [
      { count: 3, multiplier: 5 },
      { count: 4, multiplier: 25 },
      { count: 5, multiplier: 100 },
    ],
  },
  {
    symbol: 'L1' satisfies GameSymbol,
    kind: 'LINE',
    pays: [
      { count: 3, multiplier: 3 },
      { count: 4, multiplier: 10 },
      { count: 5, multiplier: 50 },
    ],
  },
  {
    symbol: 'L2' satisfies GameSymbol,
    kind: 'LINE',
    pays: [
      { count: 3, multiplier: 2 },
      { count: 4, multiplier: 8 },
      { count: 5, multiplier: 40 },
    ],
  },
  {
    symbol: 'L3' satisfies GameSymbol,
    kind: 'LINE',
    pays: [
      { count: 3, multiplier: 2 },
      { count: 4, multiplier: 6 },
      { count: 5, multiplier: 30 },
    ],
  },
  {
    symbol: 'L4' satisfies GameSymbol,
    kind: 'LINE',
    pays: [
      { count: 3, multiplier: 1 },
      { count: 4, multiplier: 5 },
      { count: 5, multiplier: 25 },
    ],
  },
  {
    symbol: 'SCAT' satisfies GameSymbol,
    kind: 'SCATTER',
    pays: [
      { count: 3, multiplier: 2 },
      { count: 4, multiplier: 10 },
      { count: 5, multiplier: 50 },
    ],
  },
];

/** How many scatters award free spins, and how many. The server owns the award; this is the table. */
export const FREE_SPIN_AWARDS: Readonly<Record<number, number>> = {
  3: 10,
  4: 15,
  5: 20,
};
