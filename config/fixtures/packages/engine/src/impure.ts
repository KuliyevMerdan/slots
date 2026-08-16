// FIXTURE — every line here must be rejected by the purity rules in eslint.config.mjs.
export function impure() {
  const roll = Math.random();
  const now = Date.now();
  const stamp = new Date();
  return { roll, now, stamp };
}
