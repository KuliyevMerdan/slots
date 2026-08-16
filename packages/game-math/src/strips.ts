import type { GameSymbol } from './symbols.js';

/**
 * The reel strips, as data — one per reel, read with wrap-around from the server's stop index.
 *
 * Two deliberate properties, both classic and both tested: **wilds appear only on reels 2–4**
 * (a wild on reel 1 makes near-misses feel wrong and inflates RTP fast), and every reel carries a
 * handful of scatters so the feature can trigger from any position.
 *
 * These are not RTP-tuned. Tuning is S4's job, against `tools/math-sim` — and the tuned numbers are
 * the ones the README will publish.
 *
 * The ten-per-row layout is deliberate and Prettier is told to leave it alone: a strip is read as a
 * band of symbols, and one symbol per line makes a 40-stop reel unreviewable.
 */

// prettier-ignore
const REEL_1: readonly GameSymbol[] = [
  'L4',  'L3', 'H3', 'L2', 'SCAT', 'L1', 'L4', 'H2', 'L3', 'L2',
  'H1',  'L4', 'L1', 'L3', 'H3',   'L2', 'L4', 'H2', 'L1', 'L3',
  'L4',  'SCAT', 'L2', 'H3', 'L1', 'L4', 'L3', 'H2', 'L2', 'L1',
  'H1',  'L4', 'L3', 'L2', 'H3',   'L1', 'L4', 'L2', 'L3', 'H2',
];

// prettier-ignore
const REEL_2: readonly GameSymbol[] = [
  'L3', 'H2', 'L1', 'L4', 'WILD', 'L2', 'H3', 'L3', 'SCAT', 'L1',
  'L4', 'H1', 'L2', 'L3', 'H2',   'L4', 'L1', 'WILD', 'L3', 'L2',
  'H3', 'L4', 'SCAT', 'L1', 'H2', 'L3', 'L2', 'L4', 'H1', 'L1',
  'L3', 'H3', 'L2', 'L4', 'L1',   'H2', 'L3', 'SCAT', 'L2', 'L4',
];

// prettier-ignore
const REEL_3: readonly GameSymbol[] = [
  'H3', 'L2', 'L4', 'L1', 'L3',   'WILD', 'H2', 'L4', 'L2', 'SCAT',
  'L3', 'L1', 'H1', 'L4', 'L2',   'H3', 'L1', 'L3', 'WILD', 'L2',
  'H2', 'L4', 'L1', 'L3', 'SCAT', 'L2', 'H1', 'L4', 'L1', 'H3',
  'L3', 'L2', 'L4', 'SCAT', 'L1', 'H2', 'L3', 'L2', 'L4', 'L1',
];

// prettier-ignore
const REEL_4: readonly GameSymbol[] = [
  'L1', 'L3', 'H2', 'L4', 'L2',   'H3', 'WILD', 'L1', 'L3', 'SCAT',
  'L4', 'H1', 'L2', 'L1', 'H2',   'L3', 'L4', 'WILD', 'L2', 'H3',
  'L1', 'L4', 'SCAT', 'L3', 'L2', 'H1', 'L1', 'L4', 'H2', 'L3',
  'L2', 'L4', 'L1', 'H3', 'SCAT', 'L3', 'L2', 'L4', 'L1', 'H2',
];

// prettier-ignore
const REEL_5: readonly GameSymbol[] = [
  'L2', 'L4', 'H1', 'L1', 'L3',   'H2', 'L4', 'L2', 'SCAT', 'L1',
  'H3', 'L3', 'L4', 'L2', 'H1',   'L1', 'L3', 'H2', 'L4', 'SCAT',
  'L2', 'L1', 'H3', 'L3', 'L4',   'L2', 'H1', 'L1', 'L4', 'H2',
  'L3', 'L2', 'SCAT', 'L4', 'L1', 'H3', 'L3', 'L2', 'L4', 'L1',
];

export const STRIPS: readonly (readonly GameSymbol[])[] = [REEL_1, REEL_2, REEL_3, REEL_4, REEL_5];
