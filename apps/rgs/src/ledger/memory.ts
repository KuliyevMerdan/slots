import type { RoundId } from '@slot/protocol';
import { LEGS_OF_KIND, LedgerConflictError, judge } from './ledger.js';
import type { Ledger, LedgerEntry, Movement } from './ledger.js';

/**
 * The in-memory ledger: the port's semantics with no database under them — the same honesty
 * arrangement as `MemoryRoundStore`. The shared ledger-contract tests define the behaviour here
 * and hold Postgres to it; the dev composition journals into this when `RGS_DATABASE_URL` is
 * absent. Append-only is a fact of the API (nothing here can update or delete); the Postgres twin
 * additionally enforces it with a trigger, because a database has more callers than a class.
 */
export class MemoryLedger implements Ledger {
  #entries: LedgerEntry[] = [];
  #byRef = new Map<string, LedgerEntry[]>();

  record(movement: Movement): Promise<void> {
    const verdict = judge(movement, this.#byRef.get(movement.ref) ?? []);
    if (verdict instanceof LedgerConflictError) return Promise.reject(verdict);
    if (verdict === 'REPLAY') return Promise.resolve();

    const entry: LedgerEntry = {
      ...movement,
      seq: this.#entries.length + 1,
      ...LEGS_OF_KIND[movement.kind],
    };
    this.#entries.push(entry);
    const forRef = this.#byRef.get(movement.ref);
    if (forRef === undefined) this.#byRef.set(movement.ref, [entry]);
    else forRef.push(entry);
    return Promise.resolve();
  }

  entriesFor(roundId: RoundId): Promise<readonly LedgerEntry[]> {
    return Promise.resolve(this.#entries.filter((entry) => entry.roundId === roundId));
  }

  entries({ since }: { since?: number } = {}): Promise<readonly LedgerEntry[]> {
    return Promise.resolve(
      since === undefined ? [...this.#entries] : this.#entries.filter((e) => e.at >= since),
    );
  }

  /* ── the control plane, in-process only — tests and the contract target's reset ───────────── */

  clear(): void {
    this.#entries = [];
    this.#byRef = new Map();
  }
}
