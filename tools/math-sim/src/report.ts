import type { Simulation } from './simulate.js';
import { WIN_BUCKETS } from './simulate.js';

/**
 * The report, as text a human reads and a README can carry.
 *
 * Two rules. **Every figure says what it is measured over** — an RTP without a spin count is a
 * claim, not a measurement — and the design targets are printed *beside* the results, so the table
 * answers "is this tuned?" rather than "what did it do?".
 */

export interface DesignTarget {
  rtp: number;
  rtpTolerance: number;
  hitFrequency: [number, number];
  spinsPerTrigger: [number, number];
  /** A feature this long means the retrigger is not converging. */
  longestFeature: number;
}

/**
 * What this game is designed to be: a medium-volatility 96% slot.
 *
 * 96% is the mainstream European figure and the one an operator expects to be handed. The bands
 * around the rest are what make the number a *design* rather than an outcome: a 96% game that pays
 * out twice a session and a 96% game that pays out once an hour are different products.
 */
export const DESIGN: DesignTarget = {
  rtp: 0.96,
  rtpTolerance: 0.005,
  /**
   * Two rounds in five pay *something*. High for a slot in the abstract and normal for twenty fixed
   * lines, where three of a kind on the cheapest paying symbol is a frequent event — which is also
   * why `L4` does not pay for three at all: below this band the game feels dead, and above it most
   * "wins" return less than the stake and feel like losses with a sound effect.
   */
  hitFrequency: [0.25, 0.45],
  /** Roughly one round in a hundred and ten. Frequent enough to be the game's rhythm. */
  spinsPerTrigger: [80, 250],
  /** A feature longer than this means the retrigger is not converging. */
  longestFeature: 120,
};

const percent = (value: number, digits = 2): string => `${(value * 100).toFixed(digits)}%`;
const pad = (value: string, width: number): string => value.padStart(width);

const verdict = (ok: boolean): string => (ok ? 'ok' : 'OUT OF BAND');

const within = ([low, high]: [number, number], value: number): boolean =>
  value >= low && value <= high;

export const meetsDesign = (simulation: Simulation, design: DesignTarget = DESIGN): boolean =>
  Math.abs(simulation.rtp - design.rtp) <= design.rtpTolerance &&
  within(design.hitFrequency, simulation.hitFrequency) &&
  within(design.spinsPerTrigger, simulation.spinsPerTrigger) &&
  simulation.longestFeature <= design.longestFeature &&
  simulation.runaways === 0;

export function formatReport(
  simulation: Simulation,
  context: { mathVersion: string; seed: string; elapsedMs: number },
  design: DesignTarget = DESIGN,
): string {
  const lines: string[] = [];
  const rows: Array<[string, string, string, string]> = [
    [
      'RTP',
      percent(simulation.rtp, 3),
      `${percent(design.rtp, 1)} ± ${percent(design.rtpTolerance, 1)}`,
      verdict(Math.abs(simulation.rtp - design.rtp) <= design.rtpTolerance),
    ],
    ['  base game', percent(simulation.baseRtp, 3), '', ''],
    ['  feature', percent(simulation.featureRtp, 3), '', ''],
    [
      'Hit frequency',
      percent(simulation.hitFrequency, 2),
      `${percent(design.hitFrequency[0], 0)}–${percent(design.hitFrequency[1], 0)}`,
      verdict(within(design.hitFrequency, simulation.hitFrequency)),
    ],
    ['Volatility (σ per round)', simulation.volatility.toFixed(2), '', ''],
    ['Max win seen', `${simulation.maxWinMultiple.toFixed(1)}×`, '', ''],
    [
      'Spins per trigger',
      simulation.spinsPerTrigger === Infinity ? '—' : simulation.spinsPerTrigger.toFixed(0),
      `${String(design.spinsPerTrigger[0])}–${String(design.spinsPerTrigger[1])}`,
      verdict(within(design.spinsPerTrigger, simulation.spinsPerTrigger)),
    ],
    [
      'Longest feature',
      `${String(simulation.longestFeature)} spins`,
      `≤ ${String(design.longestFeature)}`,
      verdict(simulation.longestFeature <= design.longestFeature),
    ],
    ['Feature share of RTP', percent(simulation.featureShare, 1), '', ''],
    ['Runaway features', String(simulation.runaways), '0', verdict(simulation.runaways === 0)],
  ];

  lines.push(
    `math ${context.mathVersion} · ${simulation.spins.toLocaleString('en')} rounds · seed "${context.seed}" · ${(context.elapsedMs / 1000).toFixed(1)}s`,
  );
  lines.push('');
  lines.push(`| ${'Measure'.padEnd(24)} | ${pad('Result', 12)} | ${pad('Design', 14)} |         |`);
  lines.push(`| ${'-'.repeat(24)} | ${'-'.repeat(12)} | ${'-'.repeat(14)} | ------- |`);
  for (const [label, result, target, ok] of rows) {
    lines.push(
      `| ${label.padEnd(24)} | ${pad(result, 12)} | ${pad(target, 14)} | ${ok.padEnd(7)} |`,
    );
  }

  lines.push('');
  lines.push('Win distribution (per round, in stakes)');
  lines.push('');
  lines.push(`| ${'Band'.padEnd(14)} | ${pad('Rounds', 12)} | ${pad('Share', 8)} |`);
  lines.push(`| ${'-'.repeat(14)} | ${'-'.repeat(12)} | ${'-'.repeat(8)} |`);

  simulation.distribution.forEach((count, index) => {
    const low = index === 0 ? 0 : (WIN_BUCKETS[index - 1] as number);
    const high = WIN_BUCKETS[index];
    const band =
      index === 0
        ? 'no win'
        : high === undefined
          ? `${String(low)}×+`
          : `${String(low)}–${String(high)}×`;
    lines.push(
      `| ${band.padEnd(14)} | ${pad(count.toLocaleString('en'), 12)} | ${pad(percent(count / simulation.spins, 3), 8)} |`,
    );
  });

  return lines.join('\n');
}
