// FIXTURE — every line here must be rejected by the purity rules in eslint.config.mjs.
// compliance joined PURE_PACKAGES on 2026-08-19: a reality-check timer reads an injected clock,
// so a given session replays identically — the same discipline as the engine and the sim.
export function impure() {
  const roll = Math.random();
  const now = Date.now();
  const stamp = new Date();
  return { roll, now, stamp };
}
