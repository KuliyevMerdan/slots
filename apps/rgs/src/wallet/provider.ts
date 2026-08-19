import type { Minor } from '@slot/protocol';

/**
 * The operator↔provider seam every real RGS has.
 *
 * The game provider does not hold the player's money — the operator's wallet does, and the RGS
 * talks to it through exactly this interface: read a balance, debit a stake, credit a win, and
 * undo a debit whose round never resolved. Everything the domain will ever know about money
 * arrives through these four calls, which is why the seam is built in R0, before any of them can
 * succeed: R2 implements a provider behind it, and the domain (R1) is written against the
 * interface from its first line.
 *
 * Two rules are the industry shape, stated here so R2 inherits them as requirements:
 *
 * - **Every mutation is idempotent on `ref`.** The RGS retries over a network it does not trust,
 *   so a duplicate `(ref, kind)` with identical parameters replays the recorded result — one
 *   stake, one debit, however many times the request went out. The `roundId` is the natural ref,
 *   exactly as it is on the game wire.
 * - **`rollback` exists because a debit can outlive its round.** A spin that was debited and never
 *   resolved (docs/protocol.md §5) either resumes — or, when the operator's rules say abort, the
 *   debit is reversed by ref. It is the wallet-side half of the recovery story, and R2's test is
 *   that a wallet failure mid-round leaves no orphaned debit.
 */
export interface WalletProvider {
  getBalance(playerId: string): Promise<Minor>;
  /** Take the stake. Answers the balance after the debit — the number `SpinRes.balance` carries. */
  debit(playerId: string, amount: Minor, ref: string): Promise<Minor>;
  /** Pay the round's win. Answers the balance after the credit — `SettleRes.balance`. */
  credit(playerId: string, amount: Minor, ref: string): Promise<Minor>;
  /** Reverse a debit by its ref. Idempotent: reversing twice is one reversal, replayed. */
  rollback(ref: string): Promise<Minor>;
}

/**
 * What a wallet can refuse. Deliberately the wallet's own vocabulary, not the protocol's: the
 * domain layer (R2) is what maps `INSUFFICIENT_FUNDS` onto the player's modal and everything else
 * onto `WALLET_UNAVAILABLE` — a wallet does not get to speak to the client directly.
 */
export type WalletErrorCode =
  | 'INSUFFICIENT_FUNDS'
  | 'UNKNOWN_PLAYER'
  | 'UNKNOWN_REF'
  /** The ref was seen before with *different* parameters — a retry is a replay, never a rewrite. */
  | 'REF_CONFLICT';

export class WalletError extends Error {
  readonly code: WalletErrorCode;

  constructor(code: WalletErrorCode, message: string) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}
