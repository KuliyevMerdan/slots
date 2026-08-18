import type { PaytableEntry } from '@slot/protocol';
import type { GameSymbol } from './symbols.js';

/**
 * The paytable, as data — **tuned in S4 against `tools/math-sim`**.
 *
 * `LINE` multipliers apply to the **line bet** (a twentieth of the stake, since all twenty lines are
 * always played); the `SCATTER` multiplier applies to the **total stake**. `pnpm math-sim`
 * reproduces the measured figures and fails if an edit here moves the game out of its design band.
 *
 * Two shapes are worth knowing before changing a number. The three-of-a-kind pays are what set the
 * **hit frequency** — they are most of the wins — while the five-of-a-kind pays set the
 * **volatility** and almost none of the RTP. And **`L4` does not pay for three**: the cheapest
 * symbol paying on a fifth of all rounds pushed the hit frequency past 52% while returning less than
 * the stake, which is the definition of a win that does not feel like one.
 */
export const PAYTABLE: readonly PaytableEntry[] = [
  {
    symbol: 'WILD' satisfies GameSymbol,
    kind: 'LINE',
    pays: [
      { count: 3, multiplier: 80 },
      { count: 4, multiplier: 400 },
      { count: 5, multiplier: 2_000 },
    ],
  },
  {
    symbol: 'H1' satisfies GameSymbol,
    kind: 'LINE',
    pays: [
      { count: 3, multiplier: 40 },
      { count: 4, multiplier: 200 },
      { count: 5, multiplier: 1_000 },
    ],
  },
  {
    symbol: 'H2' satisfies GameSymbol,
    kind: 'LINE',
    pays: [
      { count: 3, multiplier: 32 },
      { count: 4, multiplier: 160 },
      { count: 5, multiplier: 600 },
    ],
  },
  {
    symbol: 'H3' satisfies GameSymbol,
    kind: 'LINE',
    pays: [
      { count: 3, multiplier: 22 },
      { count: 4, multiplier: 100 },
      { count: 5, multiplier: 400 },
    ],
  },
  {
    symbol: 'L1' satisfies GameSymbol,
    kind: 'LINE',
    pays: [
      { count: 3, multiplier: 13 },
      { count: 4, multiplier: 40 },
      { count: 5, multiplier: 200 },
    ],
  },
  {
    symbol: 'L2' satisfies GameSymbol,
    kind: 'LINE',
    pays: [
      { count: 3, multiplier: 9 },
      { count: 4, multiplier: 32 },
      { count: 5, multiplier: 160 },
    ],
  },
  {
    symbol: 'L3' satisfies GameSymbol,
    kind: 'LINE',
    pays: [
      { count: 3, multiplier: 8 },
      { count: 4, multiplier: 25 },
      { count: 5, multiplier: 125 },
    ],
  },
  {
    /* No three-of-a-kind: see the note above. The cheapest symbol pays from four. */
    symbol: 'L4' satisfies GameSymbol,
    kind: 'LINE',
    pays: [
      { count: 4, multiplier: 20 },
      { count: 5, multiplier: 100 },
    ],
  },
  {
    symbol: 'SCAT' satisfies GameSymbol,
    kind: 'SCATTER',
    pays: [
      { count: 3, multiplier: 8 },
      { count: 4, multiplier: 40 },
      { count: 5, multiplier: 200 },
    ],
  },
];

/** How many scatters award free spins, and how many. The server owns the award; this is the table. */
export const FREE_SPIN_AWARDS: Readonly<Record<number, number>> = {
  3: 10,
  4: 15,
  5: 20,
};
