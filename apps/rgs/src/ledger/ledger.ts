import type { Minor, RoundId } from '@slot/protocol';

/**
 * Double-entry, append-only, integer minor units — the shape R3 fills.
 *
 * Every movement of money is one entry pair: the stake leaves `PLAYER_BALANCE` and lands in
 * `GAME_ROUNDS`; the win travels back. Nothing is ever updated or deleted, which is what makes the
 * R3 gate provable: a scripted session's ledger sums to zero and reproduces the exact balance
 * history from the entries alone. The wallet (`WalletProvider`) is the operator's view of the same
 * money; the reconciliation job R3 ships is what trues the two against each other and reports
 * drift.
 */

/** The two sides of every pair. R3 may add accounts (jackpot, promotion) — never remove these. */
export type LedgerAccount = 'PLAYER_BALANCE' | 'GAME_ROUNDS';

export interface LedgerEntry {
  /** Both legs carry it: the round is the reconciliation unit, on the ledger as on the wire. */
  readonly roundId: RoundId;
  readonly debit: LedgerAccount;
  readonly credit: LedgerAccount;
  readonly amount: Minor;
  /** Epoch ms, from an injected clock — the purity rule holds server-side too. */
  readonly at: number;
}

export interface Ledger {
  /** Append one pair. Refusing (full store, conflict) must throw — money never half-moves. */
  record(entry: LedgerEntry): Promise<void>;
  /** Every leg a round produced, in the order recorded — what the reconciliation reads. */
  entriesFor(roundId: RoundId): Promise<readonly LedgerEntry[]>;
}
