import type { CallName, RoundId } from '@slot/protocol';
import { StoreConflictError } from './store.js';
import type { RoundCommit, RoundStore, StoredRecord, StoredRound } from './store.js';

/**
 * The in-memory store: the port's semantics with no database under them.
 *
 * Three consumers, in honesty order: the shared store-contract tests define the semantics here and
 * hold Postgres to them; the contract suite's third target runs on this store because the gate is
 * about the *wire*, not the disk; and `pnpm dev` serves from it when `RGS_DATABASE_URL` is absent.
 * It enforces the same conflicts the database enforces — a store that is laxer than its production
 * twin lets the domain grow habits the real one will refuse.
 */

const recordKey = (roundId: RoundId, call: CallName, step: number): string =>
  `${roundId}/${call}/${step}`;

export interface MemoryStoreOptions {
  /** Settled rounds kept before the oldest are evicted. In-flight rounds are never evicted. */
  retention?: number;
}

export class MemoryRoundStore implements RoundStore {
  readonly retention: number;
  #rounds = new Map<RoundId, StoredRound>();
  #records = new Map<string, StoredRecord>();

  constructor({ retention = 50 }: MemoryStoreOptions = {}) {
    this.retention = retention;
  }

  open(round: StoredRound): Promise<void> {
    if (this.#rounds.has(round.roundId)) {
      return Promise.reject(
        new StoreConflictError('DUPLICATE_ROUND', `round ${round.roundId} already exists`),
      );
    }
    this.#rounds.set(round.roundId, round);
    return Promise.resolve();
  }

  find(roundId: RoundId): Promise<StoredRound | undefined> {
    return Promise.resolve(this.#rounds.get(roundId));
  }

  record(roundId: RoundId, call: CallName, step: number): Promise<StoredRecord | undefined> {
    return Promise.resolve(this.#records.get(recordKey(roundId, call, step)));
  }

  commit({ roundId, from, patch, records }: RoundCommit): Promise<void> {
    const round = this.#rounds.get(roundId);
    if (round === undefined || round.state !== from) {
      return Promise.reject(
        new StoreConflictError(
          'STALE_TRANSITION',
          `round ${roundId} is ${round?.state ?? 'absent'}, not ${from}`,
        ),
      );
    }
    for (const record of records) {
      if (this.#records.has(recordKey(record.roundId, record.call, record.step))) {
        return Promise.reject(
          new StoreConflictError(
            'DUPLICATE_RECORD',
            `${record.call} ${record.step} of ${record.roundId} is already recorded`,
          ),
        );
      }
    }

    // All checks passed — apply everything. Synchronous, so atomic by construction; the Postgres
    // twin gets the same all-or-nothing from a transaction.
    this.#rounds.set(roundId, { ...round, ...patch });
    for (const record of records) {
      this.#records.set(recordKey(record.roundId, record.call, record.step), record);
    }
    this.#evict();
    return Promise.resolve();
  }

  pendingFor(playerId: string): Promise<StoredRound | undefined> {
    const open = [...this.#rounds.values()]
      .filter((round) => round.playerId === playerId && round.state !== 'SETTLED')
      .sort((a, b) => a.openedAt - b.openedAt);
    return Promise.resolve(open[0]);
  }

  settledFor(playerId: string, limit: number): Promise<readonly StoredRound[]> {
    const settled = [...this.#rounds.values()]
      .filter((round) => round.playerId === playerId && round.state === 'SETTLED')
      // Newest first; `openedAt` ties (same injected clock) broken by insertion order, which the
      // Map preserves — so the sort must be stable, and Array.prototype.sort is.
      .reverse()
      .slice(0, limit);
    return Promise.resolve(settled);
  }

  /** Only `SETTLED` rounds are ever evicted — the in-flight round and its recovery are untouched. */
  #evict(): void {
    const settled = [...this.#rounds.values()].filter((round) => round.state === 'SETTLED');
    const excess = settled.length - this.retention;
    if (excess <= 0) return;
    for (const round of settled.slice(0, excess)) {
      this.#rounds.delete(round.roundId);
      for (const key of [...this.#records.keys()]) {
        if (key.startsWith(`${round.roundId}/`)) this.#records.delete(key);
      }
    }
  }

  /* ── the control plane, in-process only ──────────────────────────────────────────────────
   * The contract target and the tests reach these directly; nothing HTTP ever does.
   */

  clear(): void {
    this.#rounds = new Map();
    this.#records = new Map();
  }

  snapshot(): readonly StoredRound[] {
    return [...this.#rounds.values()];
  }
}
