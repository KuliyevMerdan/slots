import { describe, expect, it } from 'vitest';
import { PERSISTENCE_SCHEMA_VERSION } from '@slot/protocol';
import { InMemoryStore, SIM_STORE_KEY, WebStorageStore } from './store.js';
import type { WebStorageLike } from './store.js';
import { loadState, saveState } from './state.js';
import { testState } from './__fixtures__/harness.js';

/** A `localStorage` stand-in — which is the point: the browser store is testable in Node. */
class FakeWebStorage implements WebStorageLike {
  readonly entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }
}

class HostileWebStorage implements WebStorageLike {
  getItem(): string | null {
    throw new Error('storage disabled');
  }

  setItem(): void {
    throw new Error('QuotaExceededError');
  }

  removeItem(): void {
    throw new Error('storage disabled');
  }
}

describe('InMemoryStore', () => {
  it('reads back what it wrote', () => {
    const store = new InMemoryStore();
    store.write('k', 'v');
    expect(store.read('k')).toBe('v');
  });

  it('returns null for a key it has never seen', () => {
    expect(new InMemoryStore().read('missing')).toBeNull();
  });

  it('removes a key', () => {
    const store = new InMemoryStore();
    store.write('k', 'v');
    store.remove('k');
    expect(store.read('k')).toBeNull();
  });
});

describe('WebStorageStore', () => {
  it('delegates to the injected storage', () => {
    const storage = new FakeWebStorage();
    const store = new WebStorageStore(storage);

    store.write('k', 'v');
    expect(storage.entries.get('k')).toBe('v');
    expect(store.read('k')).toBe('v');

    store.remove('k');
    expect(storage.entries.has('k')).toBe(false);
  });

  /**
   * A full quota, or Safari's private mode, must not take the game down.
   *
   * The local copy is an optimisation — `authenticate` re-reads the authoritative state either way
   * — so the correct failure is "stops resuming across reloads", not "throws on spin 5,000".
   */
  it('survives a storage that throws on every operation', () => {
    const store = new WebStorageStore(new HostileWebStorage());
    expect(() => store.write('k', 'v')).not.toThrow();
    expect(() => store.remove('k')).not.toThrow();
    expect(store.read('k')).toBeNull();
  });
});

describe('saveState / loadState', () => {
  it('round-trips a session through a string store', () => {
    const store = new InMemoryStore();
    const state = testState();

    saveState(store, SIM_STORE_KEY, state, 1_700_000_000_000);

    expect(loadState(store, SIM_STORE_KEY)).toEqual(state);
  });

  it('round-trips through the browser store too', () => {
    const store = new WebStorageStore(new FakeWebStorage());
    const state = testState();

    saveState(store, SIM_STORE_KEY, state, 1_700_000_000_000);

    expect(loadState(store, SIM_STORE_KEY)).toEqual(state);
  });

  it('returns null when nothing was ever saved', () => {
    expect(loadState(new InMemoryStore(), SIM_STORE_KEY)).toBeNull();
  });

  it('returns null for corrupt JSON', () => {
    const store = new InMemoryStore();
    store.write(SIM_STORE_KEY, '{not json');
    expect(loadState(store, SIM_STORE_KEY)).toBeNull();
  });

  /**
   * The discard rule, end to end: a payload written by an older schema version is dropped whole
   * rather than best-effort parsed. Safe *and* cheap, because `authenticate` returns `pendingRound`
   * — the server's view of the round survives a discarded local copy.
   */
  it('discards a payload from a different schema version', () => {
    const store = new InMemoryStore();
    store.write(
      SIM_STORE_KEY,
      JSON.stringify({
        v: PERSISTENCE_SCHEMA_VERSION + 1,
        savedAt: 1_700_000_000_000,
        data: testState(),
      }),
    );

    expect(loadState(store, SIM_STORE_KEY)).toBeNull();
  });

  it('discards a payload whose shape drifted', () => {
    const store = new InMemoryStore();
    store.write(
      SIM_STORE_KEY,
      JSON.stringify({
        v: PERSISTENCE_SCHEMA_VERSION,
        savedAt: 1_700_000_000_000,
        data: { ...testState(), balance: 'not a number' },
      }),
    );

    expect(loadState(store, SIM_STORE_KEY)).toBeNull();
  });
});
