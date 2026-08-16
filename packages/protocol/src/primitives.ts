import { z } from 'zod';

/**
 * Money, in integer **minor units** (cents, pence, öre), behind a brand.
 *
 * The brand is why `stake + 0.1` is a compile error rather than a rounding incident, and why it
 * lives *here*: a response field validated at the boundary must arrive already branded, otherwise
 * the guarantee dies exactly where the untrusted data enters. Arithmetic and formatting are
 * `@slot/money`'s job — this package only says what crosses the wire.
 *
 * See docs/adr/ADR-0002-integer-minor-units.md.
 */
export type Minor = number & { readonly __brand: 'Minor' };

const integer = z.int();

/** Any amount, including negative (a correction, a ledger leg). */
export const MinorSchema = integer.transform((value): Minor => value as Minor);

/** Balances, wins, totals — never negative on the wire. */
export const NonNegativeMinorSchema = integer.min(0).transform((value): Minor => value as Minor);

/** Stakes and limits — a zero stake is not a round. */
export const PositiveMinorSchema = integer.min(1).transform((value): Minor => value as Minor);

/**
 * Client-generated, and the idempotency key for every mutating call: a retry after a timeout is
 * provably the same round. UUIDv7 because it sorts by creation time, which makes round logs
 * readable without a join.
 */
export type RoundId = string;

export const RoundIdSchema = z.uuidv7();

/**
 * The port that mints round ids. The engine is pure, so it takes one rather than calling into
 * `crypto` itself — same reason it takes a clock.
 */
export type RoundIdFactory = () => RoundId;

/**
 * A reel symbol. Deliberately a plain string on the wire: the server owns the symbol set, and a
 * client that hard-codes a union stops working the day the math ships a new symbol. `@slot/game-math`
 * narrows it for the symbols *it* knows how to pay.
 */
export type SymbolId = string;

export const SymbolIdSchema = z.string().min(1).max(16);

/** ISO 4217, e.g. `EUR`. Display formatting is `@slot/money`'s problem, not the wire's. */
export const CurrencySchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/);

/** Epoch milliseconds, from the server's clock. Never read ambiently inside a pure package. */
export const TimestampSchema = z.int().min(0);
