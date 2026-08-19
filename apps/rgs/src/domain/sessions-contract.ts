import { describe, expect, it } from 'vitest';
import type { Session } from '@slot/protocol';
import type { SessionStore } from './sessions.js';

/**
 * The session store's semantics, as one suite both implementations run — the arrangement the
 * round store and the ledger already have, applied to the smallest port in the codebase. Small is
 * the point: everything a session *means* (minting, renewal, expiry judgment) lives in the
 * service and the domain; all a store owes is that what was put is what is found, per token,
 * latest write wins.
 */

const sessionOf = (overrides: Partial<Session> = {}): Session => ({
  playerId: 'demo-player',
  currency: 'EUR',
  expiresAt: 1_700_000_000_000,
  ...overrides,
});

export function runSessionStoreContract(
  name: string,
  makeStore: () => Promise<SessionStore>,
): void {
  describe(`session store contract · ${name}`, () => {
    it('finds exactly what was put, and does not invent a session', async () => {
      const store = await makeStore();

      await store.put('token-a', sessionOf());

      expect(await store.find('token-a')).toEqual(sessionOf());
      expect(await store.find('token-never-issued')).toBeUndefined();
    });

    it('keeps tokens apart — two sessions for one player are two rows', async () => {
      const store = await makeStore();

      await store.put('token-a', sessionOf({ expiresAt: 1_700_000_111_111 }));
      await store.put('token-b', sessionOf({ expiresAt: 1_700_000_222_222 }));

      expect((await store.find('token-a'))?.expiresAt).toBe(1_700_000_111_111);
      expect((await store.find('token-b'))?.expiresAt).toBe(1_700_000_222_222);
    });

    it('overwrites on the same token — renewal and expiry are both a put', async () => {
      const store = await makeStore();

      await store.put('token-a', sessionOf());
      await store.put('token-a', sessionOf({ expiresAt: 1_700_009_999_999 }));

      expect((await store.find('token-a'))?.expiresAt).toBe(1_700_009_999_999);
    });

    it('hands back a copy, not a live reference', async () => {
      const store = await makeStore();
      const original = sessionOf();

      await store.put('token-a', original);
      const found = await store.find('token-a');
      (found as { expiresAt: number }).expiresAt = 0;

      expect((await store.find('token-a'))?.expiresAt).toBe(original.expiresAt);
    });
  });
}
