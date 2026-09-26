import { describe, expect, it } from 'vitest';
import type { Minor } from '@slot/protocol';
import { SimServer, createSimConfig, createSimState } from '@slot/rgs-sim';
import { SessionPool } from './sessions.js';
import type { VisitorIdentity } from './sessions.js';

/**
 * The pool's arithmetic, with the clock and the token mint in the test's hands: who is renewed,
 * who is new, who is forgotten and when.
 */

const START = 1_700_000_000_000;
const IDLE_MS = 60_000;

const simFor = (serverSeed: string, token?: string): SimServer =>
  new SimServer({
    initialState: createSimState({
      serverSeed,
      balance: 1_000 as Minor,
      expiresAt: START + 3_600_000,
      ...(token === undefined ? {} : { token }),
    }),
    config: createSimConfig({ devMode: true }),
    now: () => START,
  });

const pool = (maxSessions = 3) => {
  let now = START;
  let minted = 0;
  const created: VisitorIdentity[] = [];
  const sessions = new SessionPool(simFor('resident-seed'), {
    create: (identity) => {
      created.push(identity);
      return simFor(`visitor-${identity.ordinal}`, identity.token);
    },
    maxSessions,
    idleMs: IDLE_MS,
    now: () => now,
    mintToken: () => `visitor-token-${(minted += 1)}`,
  });
  return {
    sessions,
    created,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe('SessionPool', () => {
  it('begins a new visitor for a lobby request that names no session', () => {
    const { sessions, created } = pool();

    const first = sessions.issue();
    const second = sessions.issue();

    expect(first.token).toBe('visitor-token-1');
    expect(second.token).toBe('visitor-token-2');
    expect(created.map((identity) => identity.ordinal)).toEqual([1, 2]);
    expect(sessions.find(first.token)?.sim).not.toBe(sessions.find(second.token)?.sim);
  });

  it('renews the session a known token names — the reload and the §5 renewal', () => {
    const { sessions, created } = pool();
    const { token } = sessions.issue();

    expect(sessions.issue(token)).toEqual({ token });
    expect(created).toHaveLength(1);
  });

  it('starts a forgotten visitor again rather than refusing them', () => {
    const { sessions } = pool();

    expect(sessions.issue('a-token-from-before-the-restart').token).toBe('visitor-token-1');
  });

  it('forgets a visitor who has been idle longer than the window', () => {
    const { sessions, advance } = pool();
    const { token } = sessions.issue();

    advance(IDLE_MS + 1);
    sessions.issue();

    expect(sessions.find(token)).toBeUndefined();
    expect(sessions.size).toBe(1);
  });

  it('counts finding a session as activity, so a playing visitor is never idle', () => {
    const { sessions, advance } = pool();
    const { token } = sessions.issue();

    advance(IDLE_MS - 1);
    sessions.find(token);
    advance(IDLE_MS - 1);
    sessions.issue();

    expect(sessions.find(token)).toBeDefined();
  });

  it('makes room at capacity by forgetting the longest-idle visitor', () => {
    const { sessions, advance } = pool(2);
    const oldest = sessions.issue().token;
    advance(1);
    const newer = sessions.issue().token;
    advance(1);

    const third = sessions.issue().token;

    expect(sessions.size).toBe(2);
    expect(sessions.find(oldest)).toBeUndefined();
    expect(sessions.find(newer)).toBeDefined();
    expect(sessions.find(third)).toBeDefined();
  });

  it('never evicts the resident, and finds it by its own token', () => {
    const { sessions, advance } = pool(1);
    const resident = sessions.resident.sim.state.token;

    advance(IDLE_MS * 10);
    sessions.issue();
    sessions.issue();

    expect(sessions.find(resident)).toBe(sessions.resident);
  });

  it('renews the resident when it may not create visitors — the single-session server', () => {
    const sessions = new SessionPool(simFor('resident-seed'));

    expect(sessions.issue()).toEqual({ token: sessions.resident.sim.state.token });
    expect(sessions.size).toBe(0);
  });
});
