import type { SymbolId } from '@slot/protocol';

/**
 * The symbol set this math model knows how to pay.
 *
 * `SymbolId` stays a plain string on the wire (the server owns the set), so this union is the
 * client's *local* narrowing — used to type the strips and the paytable, never to decide an outcome.
 */
export const SYMBOLS = ['WILD', 'SCAT', 'H1', 'H2', 'H3', 'L1', 'L2', 'L3', 'L4'] as const;

export type GameSymbol = (typeof SYMBOLS)[number];

/** Substitutes for every symbol except the scatter. */
export const WILD: GameSymbol = 'WILD';

/** Pays anywhere, multiplies the total stake, and triggers the free spins. Never substituted for. */
export const SCATTER: GameSymbol = 'SCAT';

export const isGameSymbol = (value: SymbolId): value is GameSymbol =>
  (SYMBOLS as readonly string[]).includes(value);
