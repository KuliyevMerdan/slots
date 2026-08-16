import type { Minor, PaytableEntry, SymbolId, Win } from '@slot/protocol';
import { ZERO, divideExact, multiply, sum } from '@slot/money';
import { SCATTER, WILD } from './symbols.js';

/**
 * The payline evaluator — pure, and **not** an authority.
 *
 * The server decides `stops`; this exists so the client can highlight the right cells and sequence
 * the right animations, and so a dev build can re-evaluate the server's grid and scream on a
 * mismatch. Never call it to decide what a player won (ADR-0001).
 */

export interface EvaluateInput {
  /** `view[reel][row]`, as sent by the server. */
  view: readonly (readonly SymbolId[])[];
  /** Row index per reel, one entry per line. */
  paylines: readonly (readonly number[])[];
  paytable: readonly PaytableEntry[];
  /** The total stake for the spin. It must divide evenly into the line count. */
  stake: Minor;
}

export interface Evaluation {
  /** Line wins in payline order, then scatter wins. Presentation sequences straight off this. */
  wins: Win[];
  totalWin: Minor;
}

const multiplierFor = (entry: PaytableEntry | undefined, count: number): number =>
  entry?.pays.find((pay) => pay.count === count)?.multiplier ?? 0;

const symbolAt = (
  view: readonly (readonly SymbolId[])[],
  reel: number,
  row: number,
): SymbolId | undefined => view[reel]?.[row];

/** How many leading reels match `target`, counting wilds as substitutes for anything but scatter. */
const runLength = (symbols: readonly SymbolId[], target: SymbolId): number => {
  let count = 0;
  for (const symbol of symbols) {
    const matches = symbol === target || (symbol === WILD && target !== WILD);
    if (!matches) break;
    count += 1;
  }
  return count;
};

interface LineCandidate {
  symbol: SymbolId;
  count: number;
  amount: Minor;
}

const bestLineWin = (
  symbols: readonly SymbolId[],
  lineEntries: ReadonlyMap<SymbolId, PaytableEntry>,
  lineBet: Minor,
): LineCandidate | null => {
  // Two readings of a line that starts with wilds: the wilds paying as themselves, and the wilds
  // standing in for the first real symbol. The player is paid the better one — which is the rule
  // every studio uses, and the one that is easy to get silently wrong.
  const firstNonWild = symbols.find((symbol) => symbol !== WILD);

  const candidates: SymbolId[] = [WILD];
  if (firstNonWild !== undefined && firstNonWild !== SCATTER) {
    candidates.push(firstNonWild);
  }

  let best: LineCandidate | null = null;

  for (const candidate of candidates) {
    const count = runLength(symbols, candidate);
    const multiplier = multiplierFor(lineEntries.get(candidate), count);
    if (multiplier === 0) continue;

    const amount = multiply(lineBet, multiplier);
    if (best === null || amount > best.amount) {
      best = { symbol: candidate, count, amount };
    }
  }

  return best;
};

export function evaluate({ view, paylines, paytable, stake }: EvaluateInput): Evaluation {
  if (paylines.length === 0) {
    throw new RangeError('a paytable with no paylines cannot be evaluated');
  }

  // Exact by construction: bet levels are whole multiples of the line count, so no rounding rule
  // is needed anywhere in this file. If this throws, the stake was built wrong.
  const lineBet = divideExact(stake, paylines.length);

  const lineEntries = new Map<SymbolId, PaytableEntry>(
    paytable.filter((entry) => entry.kind === 'LINE').map((entry) => [entry.symbol, entry]),
  );
  const scatterEntries = paytable.filter((entry) => entry.kind === 'SCATTER');

  const wins: Win[] = [];

  paylines.forEach((line, lineIndex) => {
    const symbols = line.map((row, reel) => {
      const symbol = symbolAt(view, reel, row);
      if (symbol === undefined) {
        throw new RangeError(
          `payline ${lineIndex} points at reel ${reel} row ${row}, which is empty`,
        );
      }
      return symbol;
    });

    const best = bestLineWin(symbols, lineEntries, lineBet);
    if (best === null) return;

    wins.push({
      kind: 'LINE',
      line: lineIndex,
      symbol: best.symbol,
      count: best.count,
      positions: line.slice(0, best.count).map((row, reel) => [reel, row] as [number, number]),
      amount: best.amount,
    });
  });

  for (const entry of scatterEntries) {
    const positions: Array<[number, number]> = [];
    view.forEach((reel, reelIndex) => {
      reel.forEach((symbol, row) => {
        if (symbol === entry.symbol) positions.push([reelIndex, row]);
      });
    });

    const multiplierValue = multiplierFor(entry, positions.length);
    if (multiplierValue === 0) continue;

    wins.push({
      kind: 'SCATTER',
      symbol: entry.symbol,
      count: positions.length,
      positions,
      // Scatters multiply the total stake, not the line bet.
      amount: multiply(stake, multiplierValue),
    });
  }

  return {
    wins,
    totalWin: wins.length === 0 ? ZERO : sum(wins.map((win) => win.amount)),
  };
}
