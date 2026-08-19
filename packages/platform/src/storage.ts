/**
 * Storage that cannot throw.
 *
 * `localStorage` fails in ways nothing else in a browser does: Safari's private mode used to throw
 * on every write, quota errors arrive mid-session, and an embedded iframe may be denied the API
 * entirely — reading `window.localStorage` itself can throw a `SecurityError`. Every caller in
 * this workspace treats persistence as best-effort (the discard rule, docs/protocol.md §9), so the
 * honest wrapper swallows the failure and keeps the session in memory: preferences stop surviving
 * a reload, and nothing else changes.
 */

/** The slice of `Storage` the workspace uses — `WebStorageStore` and the client both fit it. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The in-memory fallback: a session-lifetime store with storage's shape. */
export class MemoryStorage implements KeyValueStorage {
  readonly #entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#entries.set(key, value);
  }

  removeItem(key: string): void {
    this.#entries.delete(key);
  }
}

const PROBE_KEY = '__slot_storage_probe__';

/**
 * The safe wrapper. Probes the candidate with one write — the only reliable feature test — and
 * falls back to memory when the candidate is absent or refuses. Individual writes that fail later
 * (quota) are swallowed: a preference that fails to save must never take the game down with it.
 */
export function safeStorage(candidate: KeyValueStorage | null | undefined): KeyValueStorage {
  if (candidate === null || candidate === undefined) return new MemoryStorage();

  try {
    candidate.setItem(PROBE_KEY, '1');
    candidate.removeItem(PROBE_KEY);
  } catch {
    return new MemoryStorage();
  }

  return {
    getItem: (key) => {
      try {
        return candidate.getItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      try {
        candidate.setItem(key, value);
      } catch {
        // Quota, private mode, revoked permission — the preference is lost, the game is not.
      }
    },
    removeItem: (key) => {
      try {
        candidate.removeItem(key);
      } catch {
        // Same rule: removal is best-effort.
      }
    },
  };
}
