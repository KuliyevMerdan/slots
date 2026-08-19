import { describe, expect, it } from 'vitest';
import { seededBytes } from '../rng/seeds.js';
import { MemorySessionStore, createSessionService } from './sessions.js';
import { runSessionStoreContract } from './sessions-contract.js';

runSessionStoreContract('in memory', () => Promise.resolve(new MemorySessionStore()));

const NOW = 1_700_000_000_000;

const serviceOver = (store = new MemorySessionStore(), now: () => number = () => NOW) =>
  createSessionService({ store, randomBytes: seededBytes('sessions-test'), now });

describe('the session service', () => {
  it('mints an unguessable-shaped token and stores the session it names', async () => {
    const service = serviceOver();

    const { token, session } = await service.issue({ playerId: 'player-1', ttlMs: 60_000 });

    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(session).toEqual({ playerId: 'player-1', currency: 'EUR', expiresAt: NOW + 60_000 });
    expect(await service.verify(token)).toEqual(session);
  });

  it('mints a different token every time — two issues are two sessions', async () => {
    const service = serviceOver();

    const first = await service.issue({ playerId: 'player-1' });
    const second = await service.issue({ playerId: 'player-1' });

    expect(first.token).not.toBe(second.token);
    // Both stand: a fresh token for a returning player does not revoke the one a running tab
    // still holds — re-attachment to the same balance and round is the player id's doing.
    expect(await service.verify(first.token)).toBeDefined();
    expect(await service.verify(second.token)).toBeDefined();
  });

  it('honours an explicit token — the env demo channel — and renews on re-issue', async () => {
    let at = NOW;
    const service = serviceOver(new MemorySessionStore(), () => at);

    const first = await service.issue({ playerId: 'demo', token: 'demo-token', ttlMs: 1_000 });
    at += 5_000;
    const renewed = await service.issue({ playerId: 'demo', token: 'demo-token', ttlMs: 1_000 });

    expect(renewed.token).toBe('demo-token');
    expect(first.session.expiresAt).toBe(NOW + 1_000);
    expect(renewed.session.expiresAt).toBe(NOW + 6_000);
    expect((await service.verify('demo-token'))?.expiresAt).toBe(NOW + 6_000);
  });

  it('expires on demand by rewriting expiresAt to now, and says whether it had one', async () => {
    const service = serviceOver();

    const { token } = await service.issue({ playerId: 'player-1', ttlMs: 3_600_000 });

    expect(await service.expire(token)).toBe(true);
    expect((await service.verify(token))?.expiresAt).toBe(NOW);
    expect(await service.expire('token-never-issued')).toBe(false);
  });

  it('verifies nothing it never issued', async () => {
    expect(await serviceOver().verify('not-a-token')).toBeUndefined();
  });
});
