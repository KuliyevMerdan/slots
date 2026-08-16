import type { Minor } from '@slot/protocol';
import { minor } from '@slot/money';
import { PAYLINES, REELS, ROWS } from './paylines.js';
import { PAYTABLE } from './paytable.js';
import { STRIPS } from './strips.js';

/**
 * Identifies this strips + paytable combination.
 *
 * The server sends its own in `GameConfig.mathVersion`. If the two disagree the client is drawing
 * reels the server is not playing, which is `MATH_VERSION_MISMATCH` — `FATAL`, because there is no
 * safe way to present an outcome you cannot reproduce. **Bump this whenever strips, paylines or the
 * paytable change.**
 */
export const MATH_VERSION = '1.0.0';

/**
 * Total stakes, in minor units. Every level is a whole multiple of the payline count, which is what
 * makes the line bet exact — see `@slot/money`.
 */
export const BET_LEVELS: readonly Minor[] = [20, 40, 100, 200, 400, 1_000, 2_000, 4_000].map(minor);

/**
 * The math half of `GameConfig`. The commercial half — limits, currency, jurisdiction, `devMode` —
 * belongs to whoever is serving the game, so the simulator (S0) and the real RGS compose the rest
 * around this.
 */
export const MATH_CONFIG = {
  mathVersion: MATH_VERSION,
  reels: REELS,
  rows: ROWS,
  strips: STRIPS,
  paytable: PAYTABLE,
  paylines: PAYLINES,
} as const;
