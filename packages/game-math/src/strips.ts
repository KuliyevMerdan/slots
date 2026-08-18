import type { GameSymbol } from './symbols.js';

/**
 * The reel strips, as data — one per reel, read with wrap-around from the server's stop index.
 *
 * **Tuned in S4 against `tools/math-sim`**, which plays these strips through the game's own
 * evaluator. The measured figures are in CLAUDE.md and `pnpm math-sim` reproduces them; the CLI
 * exits non-zero if an edit here moves the game out of its design band.
 *
 * Three deliberate properties, all tested:
 *
 * - **Wilds only on reels 2–4.** A wild on reel 1 makes near-misses feel wrong and inflates RTP fast.
 * - **Seven scatters in total** — one each on reels 1, 3 and 5, two each on reels 2 and 4. That is
 *   what sets the trigger at roughly one round in a hundred and ten, and it is the number that had
 *   to come down: the untuned strips carried fifteen, which triggered every fifteenth spin and made
 *   the retrigger a **supercritical branching process** — features of a hundred and fifty free spins,
 *   and an RTP of 125%.
 * - **Low symbols outnumber high ones about six to one**, which is what puts the hit frequency near
 *   43% while the volatility stays around 3σ per round.
 *
 * The ten-per-row layout is deliberate and Prettier is told to leave it alone: a strip is read as a
 * band of symbols, and one symbol per line makes a 40-stop reel unreviewable.
 */

// prettier-ignore
const REEL_1: readonly GameSymbol[] = [
  'L4', 'L3', 'H3', 'L2', 'SCAT', 'L1', 'L4', 'H2', 'L3', 'L2',
  'H1', 'L4', 'L1', 'L3', 'H3',   'L2', 'L4', 'H2', 'L1', 'L3',
  'L4', 'L2', 'L2', 'H3', 'L1',   'L4', 'L3', 'H2', 'L2', 'L1',
  'H1', 'L4', 'L3', 'L2', 'H3',   'L1', 'L4', 'L2', 'L3', 'H2',
];

// prettier-ignore
const REEL_2: readonly GameSymbol[] = [
  'L3', 'H2', 'L1', 'L4', 'WILD', 'L2', 'H3', 'L3', 'SCAT', 'L1',
  'L4', 'H1', 'L2', 'L3', 'H2',   'L4', 'L1', 'WILD', 'L3', 'L2',
  'H3', 'L4', 'SCAT', 'L1', 'H2', 'L3', 'L2', 'L4', 'H1', 'L1',
  'L3', 'H3', 'L2', 'L4', 'L1',   'H2', 'L3', 'H3', 'L2', 'L4',
];

// prettier-ignore
const REEL_3: readonly GameSymbol[] = [
  'H3', 'L2', 'L4', 'L1', 'L3',   'WILD', 'H2', 'L4', 'L2', 'SCAT',
  'L3', 'L1', 'H1', 'L4', 'L2',   'H3', 'L1', 'L3', 'WILD', 'L2',
  'H2', 'L4', 'L1', 'L3', 'L2',   'L2', 'H1', 'L4', 'L1', 'H3',
  'L3', 'L2', 'L4', 'L1', 'L1',   'H2', 'L3', 'L2', 'L4', 'L1',
];

// prettier-ignore
const REEL_4: readonly GameSymbol[] = [
  'L1', 'L3', 'H2', 'L4', 'L2',   'H3', 'WILD', 'L1', 'L3', 'SCAT',
  'L4', 'H1', 'L2', 'L1', 'H2',   'L3', 'L4', 'WILD', 'L2', 'H3',
  'L1', 'L4', 'SCAT', 'L3', 'L2', 'H1', 'L1', 'L4', 'H2', 'L3',
  'L2', 'L4', 'L1', 'H3', 'L3',   'L3', 'L2', 'L4', 'L1', 'H2',
];

// prettier-ignore
const REEL_5: readonly GameSymbol[] = [
  'L2', 'L4', 'H1', 'L1', 'L3',   'H2', 'L4', 'L2', 'SCAT', 'L1',
  'H3', 'L3', 'L4', 'L2', 'H1',   'L1', 'L3', 'H2', 'L4', 'H3',
  'L2', 'L1', 'H3', 'L3', 'L4',   'L2', 'H1', 'L1', 'L4', 'H2',
  'L3', 'L2', 'L2', 'L4', 'L1',   'H3', 'L3', 'L2', 'L4', 'L1',
];

export const STRIPS: readonly (readonly GameSymbol[])[] = [REEL_1, REEL_2, REEL_3, REEL_4, REEL_5];
