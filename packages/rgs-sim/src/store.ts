/**
 * The persistence port, and the two implementations behind it.
 *
 * The simulator's round machine is only credible if it survives a reload: a player who refreshes
 * mid-feature must come back to `pendingRound`, not to a fresh balance. That means the sim persists
 * — but persistence is I/O, and this package is pure.
 *
 * So the port is a **synchronous string store**, and the browser implementation takes the storage
 * object as a constructor argument instead of reaching for the global. `localStorage` is a lint
 * error here and `Storage` is not in this package's type environment (no `DOM` lib), both on
 * purpose — see docs/adr/ADR-0003-injected-persistence-port.md. The wiring site passes the real
 * one; a test passes a fake and the browser adapter is unit-testable in Node.
 */

/** Where a `SimState` lives between calls. Keys are namespaced by the caller. */
export interface SimStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

/** The default store key. One session per key; a second player needs a second key. */
export const SIM_STORE_KEY = 'slot.rgs-sim.state';

/** Node, tests, and any consumer that does not need the state to outlive the process. */
export class InMemoryStore implements SimStore {
  readonly #entries = new Map<string, string>();

  read(key: string): string | null {
    return this.#entries.get(key) ?? null;
  }

  write(key: string, value: string): void {
    this.#entries.set(key, value);
  }

  remove(key: string): void {
    this.#entries.delete(key);
  }
}

/**
 * The shape of `localStorage`, structurally — declared rather than imported.
 *
 * This is what lets the browser-backed store exist in a package with no `DOM` lib: the sim depends
 * on three method signatures, not on the platform that provides them.
 */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The browser implementation — `new WebStorageStore(localStorage)` at the wiring site.
 *
 * A write that throws is swallowed. `localStorage` throws on a full quota and in Safari's private
 * mode, and the alternative to swallowing is a slot that crashes on spin 5,000 rather than one that
 * quietly stops resuming across reloads. The authoritative state is the server's anyway — the local
 * copy is an optimisation, and `authenticate` re-reads the truth (docs/protocol.md §5).
 */
export class WebStorageStore implements SimStore {
  readonly #storage: WebStorageLike;

  constructor(storage: WebStorageLike) {
    this.#storage = storage;
  }

  read(key: string): string | null {
    try {
      return this.#storage.getItem(key);
    } catch {
      return null;
    }
  }

  write(key: string, value: string): void {
    try {
      this.#storage.setItem(key, value);
    } catch {
      // Quota exceeded, or storage disabled. See the note above.
    }
  }

  remove(key: string): void {
    try {
      this.#storage.removeItem(key);
    } catch {
      // As above.
    }
  }
}
