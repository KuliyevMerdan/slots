import type { Pool } from 'pg';
import type { Session } from '@slot/protocol';
import type { SessionStore } from './sessions.js';
import { createPgPool } from '../persistence/postgres.js';
import { migrate } from '../persistence/migrate.js';

/**
 * The session store on Postgres (`migrations/0004_sessions.sql`) — the memory twin's semantics,
 * on rows. A session that survives a restart is what keeps a deploy from logging every player out
 * mid-round: the token in the client's hand still names a session, so resume is the ordinary §5
 * path rather than a lobby round-trip. `put` is the upsert the port promises — issue, renew and
 * expire are all the same statement.
 */

interface SessionRow {
  token: string;
  player_id: string;
  currency: string;
  expires_at: number;
}

export class PostgresSessionStore implements SessionStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async find(token: string): Promise<Session | undefined> {
    const result = await this.#pool.query<SessionRow>('select * from sessions where token = $1', [
      token,
    ]);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      playerId: row.player_id,
      currency: row.currency as Session['currency'],
      expiresAt: row.expires_at,
    };
  }

  async put(token: string, session: Session): Promise<void> {
    await this.#pool.query(
      `insert into sessions (token, player_id, currency, expires_at)
       values ($1, $2, $3, $4)
       on conflict (token) do update
         set player_id = excluded.player_id,
             currency = excluded.currency,
             expires_at = excluded.expires_at`,
      [token, session.playerId, session.currency, session.expiresAt],
    );
  }

  /** Drain the pool — tests and orderly shutdowns. Skip when the pool is shared with the store. */
  async close(): Promise<void> {
    await this.#pool.end();
  }
}

export interface PostgresSessionStoreOptions {
  databaseUrl?: string;
  /** Inject to share one pool with the round store; the migrations run either way (idempotent). */
  pool?: Pool;
}

export async function createPostgresSessionStore({
  databaseUrl,
  pool,
}: PostgresSessionStoreOptions): Promise<PostgresSessionStore> {
  if (pool === undefined && databaseUrl === undefined) {
    throw new TypeError('createPostgresSessionStore needs a databaseUrl or a pool');
  }
  const connected = pool ?? createPgPool(databaseUrl as string);
  await migrate(connected);
  return new PostgresSessionStore(connected);
}
