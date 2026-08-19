import type { Minor, RoundId } from '@slot/protocol';
import { ZERO, add, subtract } from '@slot/money';

/**
 * The double-entry ledger — append-only, integer minor units, one entry pair per money movement.
 *
 * Every movement the wallet confirmed is journaled as one entry with two legs: the stake leaves
 * `PLAYER_BALANCE` and lands in `GAME_ROUNDS`; a win (or a rollback) travels back. Nothing is ever
 * updated or deleted — a correction is a new entry — which is what makes the R3 gate provable: a
 * scripted session's ledger sums to zero across accounts and reproduces the exact balance history
 * from the entries alone. The wallet (`WalletProvider`) is the operator's view of the same money;
 * the reconciliation job (`reconcile.ts`) is what trues the two against each other and reports
 * drift.
 *
 * Two decisions carry the design (ADR-0005):
 *
 * - **The ledger observes; it never decides.** Recording happens after the wallet confirms a
 *   movement, and a recording failure must not fail the call — the money already moved, and a
 *   game refused over its own audit trail would leave the player with a debit and no round. The
 *   drift a lost entry creates is exactly what reconciliation exists to find.
 * - **Idempotency mirrors the wallet's, movement for movement.** The domain records after every
 *   wallet success, and a wallet success can be a *replay* (an honest retry) as easily as a fresh
 *   movement. So `record` applies the wallet's own rules to decide which it was: a standing stake
 *   replays, a rolled-back ref is stakeable again as a fresh entry, a win happens once per ref.
 *   One movement, one entry — however many times the request went out.
 */

/** The two sides of every pair. New accounts (jackpot, promotion) may join — never leave. */
export type LedgerAccount = 'PLAYER_BALANCE' | 'GAME_ROUNDS';

/**
 * What moved. `STAKE` is the debit that opens a round; `WIN` is the settle's credit; `ROLLBACK`
 * reverses a stake whose round never came to exist (docs/wallet-api.md §4).
 */
export type MovementKind = 'STAKE' | 'WIN' | 'ROLLBACK';

/** Which account each movement drains and which it fills — the pair, derived from the kind. */
export const LEGS_OF_KIND: Record<MovementKind, { debit: LedgerAccount; credit: LedgerAccount }> = {
  STAKE: { debit: 'PLAYER_BALANCE', credit: 'GAME_ROUNDS' },
  WIN: { debit: 'GAME_ROUNDS', credit: 'PLAYER_BALANCE' },
  ROLLBACK: { debit: 'GAME_ROUNDS', credit: 'PLAYER_BALANCE' },
};

/** One confirmed wallet movement, as the domain reports it. */
export interface Movement {
  readonly kind: MovementKind;
  /** Both legs carry it: the round is the reconciliation unit, on the ledger as on the wire. */
  readonly roundId: RoundId;
  readonly playerId: string;
  /** Zero is legal: a feature round can settle with nothing to pay, and the credit still ran. */
  readonly amount: Minor;
  /**
   * The wallet ref the movement was made under — the idempotency identity, here as there. The
   * stake and its rollback share the round's ref; the win lives under the settle ref.
   */
  readonly ref: string;
  /** Epoch ms, from an injected clock — the purity rule holds server-side too. */
  readonly at: number;
}

/** A movement, journaled: both legs explicit, `seq` monotonic across the whole ledger. */
export interface LedgerEntry extends Movement {
  readonly seq: number;
  /** The account the money left. */
  readonly debit: LedgerAccount;
  /** The account the money entered. */
  readonly credit: LedgerAccount;
}

/**
 * A movement that contradicts what the ledger already holds — a duplicate ref with *different*
 * parameters, a rollback of nothing. The wallet refuses the same shapes (`REF_CONFLICT`,
 * `UNKNOWN_REF`), so reaching this from the domain means the two have diverged: a bug, not a race.
 */
export class LedgerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerConflictError';
  }
}

export interface Ledger {
  /**
   * Journal one movement. Idempotent by the wallet's own rules: a movement the ledger already
   * holds standing is a replay and appends nothing; one that contradicts the record throws
   * `LedgerConflictError`. Anything else (a full store, a lost connection) must throw too — the
   * caller decides what a lost entry costs, and reconciliation finds it regardless.
   */
  record(movement: Movement): Promise<void>;
  /** Every entry a round produced, in seq order — what per-round reconciliation reads. */
  entriesFor(roundId: RoundId): Promise<readonly LedgerEntry[]>;
  /** The whole journal in seq order; `since` scopes to entries recorded at or after it. */
  entries(options?: { since?: number }): Promise<readonly LedgerEntry[]>;
}

/**
 * The idempotency verdict for one movement, against the entries already journaled under its ref —
 * the wallet's own rules (docs/wallet-api.md §3), applied to the journal. It lives beside the port
 * because it *is* the port's semantics: one implementation of the decision, two of the storage.
 */
export function judge(
  movement: Movement,
  forRef: readonly LedgerEntry[],
): 'APPEND' | 'REPLAY' | LedgerConflictError {
  const last = forRef[forRef.length - 1];

  const replayIfIdentical = (standing: LedgerEntry): 'REPLAY' | LedgerConflictError =>
    standing.playerId === movement.playerId &&
    standing.amount === movement.amount &&
    standing.roundId === movement.roundId
      ? 'REPLAY'
      : new LedgerConflictError(
          `ref ${movement.ref} already holds a ${standing.kind} with different parameters`,
        );

  switch (movement.kind) {
    case 'STAKE':
      // A standing stake replays; a rolled-back ref is stakeable again as a fresh movement —
      // exactly the wallet's rule, which is what keeps the two journals one story.
      if (last === undefined || last.kind === 'ROLLBACK') return 'APPEND';
      return replayIfIdentical(last);
    case 'ROLLBACK':
      if (last === undefined) {
        return new LedgerConflictError(`ref ${movement.ref} has no stake to roll back`);
      }
      if (last.kind === 'ROLLBACK') return replayIfIdentical(last);
      return last.playerId === movement.playerId && last.amount === movement.amount
        ? 'APPEND'
        : new LedgerConflictError(
            `rollback of ref ${movement.ref} does not match the standing stake`,
          );
    case 'WIN':
      // Once per ref, ever: a credit is never reversed at this seam, so a second win under the
      // settle ref is either an honest replay or a divergence.
      if (last === undefined) return 'APPEND';
      return replayIfIdentical(last);
  }
}

/* ── folds — the arithmetic the gate and the reconciliation share ────────────────────────────── */

export interface AccountBalances {
  readonly PLAYER_BALANCE: Minor;
  readonly GAME_ROUNDS: Minor;
}

export const EMPTY_BALANCES: AccountBalances = { PLAYER_BALANCE: ZERO, GAME_ROUNDS: ZERO };

/** Apply one entry: the amount leaves the debit account and enters the credit account. */
export const foldEntry = (balances: AccountBalances, entry: LedgerEntry): AccountBalances => ({
  ...balances,
  [entry.debit]: subtract(balances[entry.debit], entry.amount),
  [entry.credit]: add(balances[entry.credit], entry.amount),
});

/**
 * Fold a journal into per-account deltas. For any well-formed ledger the accounts sum to zero —
 * every entry is a pair — and that is asserted by the gate rather than assumed.
 */
export const balancesOf = (entries: readonly LedgerEntry[]): AccountBalances =>
  entries.reduce(foldEntry, EMPTY_BALANCES);

/**
 * One player's net `PLAYER_BALANCE` change: what the wallet's balance should have moved by.
 * Signed — a session normally ends with the player down.
 */
export const playerDeltaOf = (entries: readonly LedgerEntry[], playerId: string): Minor =>
  entries
    .filter((entry) => entry.playerId === playerId)
    .reduce<Minor>(
      (delta, entry) =>
        entry.debit === 'PLAYER_BALANCE' ? subtract(delta, entry.amount) : add(delta, entry.amount),
      ZERO,
    );
