import { describe, expect, it } from 'vitest';
import { PERSISTENCE_SCHEMA_VERSION } from '@slot/protocol';
import type { Minor } from '@slot/protocol';
import { CLIENT_STATE_KEY, loadClientState, saveClientState, stakeFor } from './persistence.js';
import type { ClientStorage } from './persistence.js';

/**
 * The discard rule, tested where it is applied.
 *
 * `readPersisted` is `@slot/protocol`'s and has its own tests; what is asserted here is that the
 * client actually *obeys* the rule rather than repairing what it finds — and that a stake the server
 * no longer offers cannot survive a reload into a spin the server would refuse.
 */

class FakeStorage implements ClientStorage {
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

const LEVELS = [20, 100, 400] as Minor[];
const NOW = 1_700_000_000_000;

describe('remembering preferences', () => {
  it('round-trips the stake and turbo', () => {
    const storage = new FakeStorage();

    saveClientState(storage, { stake: 100, turbo: true }, NOW);

    expect(loadClientState(storage)).toEqual({ stake: 100, turbo: true });
  });

  it('writes through the shared envelope, at the current version', () => {
    const storage = new FakeStorage();

    saveClientState(storage, { stake: 20, turbo: false }, NOW);

    expect(JSON.parse(storage.getItem(CLIENT_STATE_KEY) ?? '{}')).toEqual({
      v: PERSISTENCE_SCHEMA_VERSION,
      savedAt: NOW,
      data: { stake: 20, turbo: false },
    });
  });

  /** The rule: discard and re-authenticate. Never best-effort parse. */
  it.each([
    [
      'a payload from an older schema',
      JSON.stringify({ v: 0, savedAt: NOW, data: { stake: 100, turbo: true } }),
    ],
    [
      'a payload from a newer schema',
      JSON.stringify({ v: 99, savedAt: NOW, data: { stake: 100, turbo: true } }),
    ],
    ['corrupt JSON', '{not json'],
    [
      'a drifted shape',
      JSON.stringify({ v: PERSISTENCE_SCHEMA_VERSION, savedAt: NOW, data: { stake: 'lots' } }),
    ],
    ['an empty string', ''],
  ])('discards %s', (_case, raw) => {
    const storage = new FakeStorage();
    storage.setItem(CLIENT_STATE_KEY, raw);

    expect(loadClientState(storage)).toBeNull();
  });

  it('reports nothing remembered when there is nothing stored', () => {
    expect(loadClientState(new FakeStorage())).toBeNull();
  });

  /** Safari's private mode throws on write. A forgotten preference is not a broken game. */
  it('survives a storage that refuses to co-operate', () => {
    const hostile: ClientStorage = {
      getItem: () => {
        throw new Error('nope');
      },
      setItem: () => {
        throw new Error('nope');
      },
      removeItem: () => {
        throw new Error('nope');
      },
    };

    expect(() => saveClientState(hostile, { stake: 20, turbo: false }, NOW)).not.toThrow();
    expect(loadClientState(hostile)).toBeNull();
  });
});

describe('the remembered stake', () => {
  it('is used when the server still offers it', () => {
    expect(stakeFor({ stake: 100, turbo: false }, LEVELS)).toBe(100);
  });

  /**
   * Bet ladders change. A remembered stake that is no longer on one would be refused as
   * `STAKE_NOT_ALLOWED` on the first spin of the session — a reload turning into an error screen.
   */
  it('falls back to the first level when the ladder has moved under it', () => {
    expect(stakeFor({ stake: 250, turbo: false }, LEVELS)).toBe(20);
  });

  it('falls back when nothing was remembered at all', () => {
    expect(stakeFor(null, LEVELS)).toBe(20);
  });
});
