import type { Minor } from '@slot/protocol';

/**
 * Win tiers — the thresholds that decide whether a win gets a banner, and for how long.
 *
 * Expressed as a **multiple of the stake actually played**, which is the only way this can work: a
 * fixed amount would make the same banner a formality at the maximum bet and unreachable at the
 * minimum. (Exactly the argument that moved `limits.maxWinMultiplier` off being an absolute figure —
 * docs/protocol.md D7.)
 *
 * The numbers are conventional for a medium-volatility slot: a 5× win is worth a beat, 15× is worth
 * a banner, 50× is worth the room going quiet. S4 tunes the math; if the volatility moves, these
 * move with it.
 */

export const WIN_TIERS = [
  { id: 'NICE', atLeastTimesStake: 5, countUpMs: 1_200, holdMs: 500 },
  { id: 'BIG', atLeastTimesStake: 15, countUpMs: 2_000, holdMs: 800 },
  { id: 'MEGA', atLeastTimesStake: 50, countUpMs: 3_200, holdMs: 1_200 },
] as const;

export type WinTierId = (typeof WIN_TIERS)[number]['id'];

export type WinTier = (typeof WIN_TIERS)[number];

/**
 * The tier a win falls into, or `null` for an ordinary win.
 *
 * Integer arithmetic: `win >= stake * multiple` rather than `win / stake >= multiple`, because
 * dividing money is how a win one unit short of a tier becomes a win that shows the banner.
 */
export function tierFor(totalWin: Minor, stake: Minor): WinTier | null {
  if (stake <= 0 || totalWin <= 0) return null;

  let found: WinTier | null = null;
  for (const tier of WIN_TIERS) {
    if (totalWin >= stake * tier.atLeastTimesStake) found = tier;
  }
  return found;
}
