import type { Session } from '@slot/protocol';
import type { RandomBytes } from '../rng/seeds.js';

/**
 * The session seam, real since R5.
 *
 * The wire carries the token in `authenticate`'s body and — since D12 — as an `Authorization`
 * bearer header on every other call, so one process can finally serve many players: each call
 * names its session, and the domain resolves it per call instead of holding "the" session the way
 * the R1-minimal `SingleSessionHost` did. Tokens are minted server-side from injected entropy
 * (`main.ts` hands in the CSPRNG, tests hand in a seeded stream — the R4 arrangement, reused),
 * issued through an operator surface (§7: the lobby is out of band, and `/operator/sessions` is
 * its face), and stored behind a port with memory and Postgres twins held to one contract — the
 * same shape as the round store and the ledger, because a restart that logs every player out
 * mid-round would make §5's recovery story worse than it needs to be.
 *
 * What stays out of here on purpose: judging expiry. The store keeps `expiresAt`; the *domain*
 * compares it to its injected clock and phrases `SESSION_EXPIRED`, exactly as it always has —
 * one clock, one place the error is worded.
 */

/** What the domain needs of sessions: the session a presented token names, or nothing. */
export interface SessionPort {
  verify(token: string): Promise<Session | undefined>;
}

/**
 * Storage, and only storage. `put` is an upsert: issuing writes, renewal overwrites the same
 * token, and expiry rewrites `expiresAt` — three verbs, one operation, no store-side rules.
 */
export interface SessionStore {
  find(token: string): Promise<Session | undefined>;
  put(token: string, session: Session): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  #sessions = new Map<string, Session>();

  find(token: string): Promise<Session | undefined> {
    const session = this.#sessions.get(token);
    return Promise.resolve(session === undefined ? undefined : { ...session });
  }

  put(token: string, session: Session): Promise<void> {
    this.#sessions.set(token, { ...session });
    return Promise.resolve();
  }

  /** Tests and the contract target's reset. */
  clear(): void {
    this.#sessions.clear();
  }
}

export interface IssueSessionOptions {
  playerId: string;
  currency?: Session['currency'];
  ttlMs?: number;
  /**
   * An explicit token, for channels that are genuinely out of band — the env demo token, a test
   * fixture. Absent, one is minted from the injected entropy, which is the operator path.
   */
  token?: string;
}

export interface SessionService extends SessionPort {
  /** Issue — or, for a token already stored, renew. The out-of-band channel's one verb (§7). */
  issue(options: IssueSessionOptions): Promise<{ token: string; session: Session }>;
  /** End a session now. Answers whether there was one — the control plane expiry tests need. */
  expire(token: string): Promise<boolean>;
}

export interface SessionServiceDeps {
  store: SessionStore;
  randomBytes: RandomBytes;
  /** Epoch ms. Injected — the purity rule, applied to a server. */
  now: () => number;
  defaultTtlMs?: number;
}

export const DEFAULT_SESSION_TTL_MS = 12 * 3_600_000;

/** 24 bytes → 48 hex chars: unguessable, and visibly not a UUID, so nobody mistakes it for one. */
const TOKEN_BYTES = 24;

const hexOf = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export function createSessionService({
  store,
  randomBytes,
  now,
  defaultTtlMs = DEFAULT_SESSION_TTL_MS,
}: SessionServiceDeps): SessionService {
  return {
    async issue({ playerId, currency = 'EUR', ttlMs = defaultTtlMs, token }) {
      const issued = token ?? hexOf(randomBytes(TOKEN_BYTES));
      const session: Session = { playerId, currency, expiresAt: now() + ttlMs };
      await store.put(issued, session);
      return { token: issued, session };
    },

    verify(token) {
      return store.find(token);
    },

    async expire(token) {
      const session = await store.find(token);
      if (session === undefined) return false;
      await store.put(token, { ...session, expiresAt: now() });
      return true;
    },
  };
}
