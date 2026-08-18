import { MATH_VERSION } from '@slot/game-math';
import { createSimConfig } from '@slot/rgs-sim';
import type { Minor } from '@slot/protocol';
import { simulate } from './simulate.js';
import { DESIGN, formatReport, meetsDesign } from './report.js';

/**
 * `pnpm math-sim --spins 5000000`
 *
 * Exits non-zero when the shipped math is outside its design band, so this is a check as much as a
 * report: a strip edit that moves the RTP fails here rather than in a player's session.
 */

const flag = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value ?? fallback;
};

const spins = Number.parseInt(flag('spins', '1000000'), 10);
const seed = flag('seed', 'math-sim');
const stake = Number.parseInt(flag('stake', '100'), 10) as Minor;

if (!Number.isFinite(spins) || spins < 1) {
  console.error(`--spins must be a positive integer, got "${flag('spins', '')}"`);
  process.exit(2);
}

const config = createSimConfig();
const started = Date.now();

const simulation = simulate({
  config,
  spins,
  seed,
  stake,
  onProgress: (played) => {
    const share = ((played / spins) * 100).toFixed(0);
    process.stderr.write(`  ${played.toLocaleString('en')} rounds (${share}%)\n`);
  },
});

console.log(
  formatReport(simulation, { mathVersion: MATH_VERSION, seed, elapsedMs: Date.now() - started }),
);

if (!meetsDesign(simulation, DESIGN)) {
  console.error('\nthe shipped math is outside its design band — see the OUT OF BAND rows above');
  process.exit(1);
}
