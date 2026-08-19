import type { Minor } from '@slot/protocol';
import { add, subtract } from '@slot/money';
import { WalletError } from './provider.js';
import type { WalletProvider } from './provider.js';

/**
 * An in-memory wallet that keeps the seam's promises, so the domain (R1) and the wallet
 * integration (R2) are written against behaviour that already exists rather than behaviour that is
 * hoped for. It is the only code in this app that *works* — deliberately: the wallet seam is the
 * one interface whose semantics (idempotency on ref, replay vs. conflict, reversible debits) are
 * subtle enough that an interface alone would under-specify them. The unit tests beside this file
 * are those semantics, written down.
 *
 * Money is `@slot/money` arithmetic — exact or throwing — because a wallet that silently
 * overflows is a wallet, and this one is the reference for two more blocks.
 */

interface Transaction {
  readonly kind: 'DEBIT' | 'CREDIT';
  readonly playerId: string;
  readonly amount: Minor;
  /** The balance this transaction answered with — what an idempotent replay must answer again. */
  readonly balanceAfter: Minor;
  reversed: boolean;
  /** Set once the debit is rolled back: the balance the reversal answered with. */
  reversalBalance?: Minor;
}

export class MockWallet implements WalletProvider {
  readonly #balances = new Map<string, Minor>();
  readonly #transactions = new Map<string, Transaction>();

  constructor(initial: Record<string, Minor> = {}) {
    this.reset(initial);
  }

  /**
   * Forget everything and start from the given balances — the control plane the contract target's
   * `reset()` needs, on the mock only: a real provider is reset by being someone else's system.
   */
  reset(initial: Record<string, Minor>): void {
    this.#balances.clear();
    this.#transactions.clear();
    for (const [playerId, balance] of Object.entries(initial)) {
      this.#balances.set(playerId, balance);
    }
  }

  getBalance(playerId: string): Promise<Minor> {
    return Promise.resolve(this.#balanceOf(playerId));
  }

  debit(playerId: string, amount: Minor, ref: string): Promise<Minor> {
    return this.#apply('DEBIT', playerId, amount, ref);
  }

  credit(playerId: string, amount: Minor, ref: string): Promise<Minor> {
    return this.#apply('CREDIT', playerId, amount, ref);
  }

  rollback(ref: string): Promise<Minor> {
    const transaction = this.#transactions.get(ref);
    if (transaction === undefined) {
      return Promise.reject(new WalletError('UNKNOWN_REF', `no transaction under ref ${ref}`));
    }
    // Only a debit reverses: a credit that must come back is a correction, which is the ledger's
    // conversation (R3), not this seam's.
    if (transaction.kind !== 'DEBIT') {
      return Promise.reject(new WalletError('REF_CONFLICT', `ref ${ref} is not a debit`));
    }
    if (transaction.reversed) {
      // Reversing twice is one reversal, replayed — the same answer, not a second refund.
      return Promise.resolve(transaction.reversalBalance as Minor);
    }

    const balance = add(this.#balanceOf(transaction.playerId), transaction.amount);
    this.#balances.set(transaction.playerId, balance);
    transaction.reversed = true;
    transaction.reversalBalance = balance;
    return Promise.resolve(balance);
  }

  #apply(kind: 'DEBIT' | 'CREDIT', playerId: string, amount: Minor, ref: string): Promise<Minor> {
    const seen = this.#transactions.get(ref);
    if (seen !== undefined) {
      const identical = seen.kind === kind && seen.playerId === playerId && seen.amount === amount;
      if (!identical) {
        return Promise.reject(
          new WalletError('REF_CONFLICT', `ref ${ref} was seen with different parameters`),
        );
      }
      // An honest retry: the recorded answer, not a second movement of money.
      return Promise.resolve(seen.balanceAfter);
    }

    if (!this.#balances.has(playerId)) {
      return Promise.reject(new WalletError('UNKNOWN_PLAYER', `no wallet for ${playerId}`));
    }

    const current = this.#balanceOf(playerId);
    if (kind === 'DEBIT' && current < amount) {
      return Promise.reject(
        new WalletError('INSUFFICIENT_FUNDS', `balance ${current} cannot cover ${amount}`),
      );
    }

    const balance = kind === 'DEBIT' ? subtract(current, amount) : add(current, amount);
    this.#balances.set(playerId, balance);
    this.#transactions.set(ref, { kind, playerId, amount, balanceAfter: balance, reversed: false });
    return Promise.resolve(balance);
  }

  #balanceOf(playerId: string): Minor {
    const balance = this.#balances.get(playerId);
    if (balance === undefined) {
      throw new WalletError('UNKNOWN_PLAYER', `no wallet for ${playerId}`);
    }
    return balance;
  }
}
