import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import type { CallName, FeatureProgress, Minor, RoundId, RoundResult } from '@slot/protocol';
import { StoreConflictError } from './store.js';
import type { RoundCommit, RoundStore, StoredRecord, StoredRound } from './store.js';
import { migrate } from './migrate.js';

/**
 * The store on Postgres — the semantics the memory twin defines, enforced by the database.
 *
 * The two rules land where they belong: idempotency is the `idempotency_records` primary key (a
 * duplicate insert raises 23505, surfaced as `DUPLICATE_RECORD`), and the guarded transition is a
 * compare-and-swap `UPDATE … WHERE state = $from` inside the same transaction (zero rows updated →
 * `STALE_TRANSITION`, and the transaction rolls back with the records it would have kept). The
 * shared store-contract suite runs against this implementation whenever `RGS_TEST_DATABASE_URL`
 * is set — always in CI, where a service container provides it.
 */

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * `bigint` columns arrive as strings by default because a bigint can exceed 2⁵³. Minor units
 * cannot (`@slot/money` refuses unsafe integers long before the database sees them), so parsing to
 * number is safe here and branded `Minor` everywhere above.
 */
const int8 = (value: string): number => Number.parseInt(value, 10);

export interface PostgresStoreOptions {
  databaseUrl: string;
  /** The wire's `history.retention`. Rows are kept, not evicted — archival is an ops job (R7). */
  retention?: number;
  /** Injected for tests; defaults to a fresh pool over `databaseUrl`. */
  pool?: Pool;
}

interface RoundRow {
  round_id: string;
  player_id: string;
  state: StoredRound['state'];
  stake: number;
  cumulative_win: number;
  capped: boolean;
  client_seed: string | null;
  server_seed: string;
  commitment: string;
  fingerprint: string;
  feature: FeatureProgress | null;
  last_result: RoundResult | null;
  steps: number;
  opened_at: number;
}

const roundOfRow = (row: RoundRow): StoredRound => ({
  roundId: row.round_id,
  playerId: row.player_id,
  state: row.state,
  stake: row.stake as Minor,
  ...(row.client_seed === null ? {} : { clientSeed: row.client_seed }),
  serverSeed: row.server_seed,
  commitment: row.commitment,
  fingerprint: row.fingerprint,
  cumulativeWin: row.cumulative_win as Minor,
  capped: row.capped,
  ...(row.feature === null ? {} : { feature: row.feature }),
  ...(row.last_result === null ? {} : { lastResult: row.last_result }),
  steps: row.steps,
  openedAt: row.opened_at,
});

export class PostgresRoundStore implements RoundStore {
  readonly retention: number;
  readonly #pool: Pool;

  constructor(pool: Pool, retention = 1_000) {
    this.#pool = pool;
    this.retention = retention;
  }

  async open(round: StoredRound): Promise<void> {
    try {
      await this.#pool.query(
        `insert into rounds
           (round_id, player_id, state, stake, cumulative_win, capped, client_seed, server_seed,
            commitment, fingerprint, feature, last_result, steps, opened_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          round.roundId,
          round.playerId,
          round.state,
          round.stake,
          round.cumulativeWin,
          round.capped,
          round.clientSeed ?? null,
          round.serverSeed,
          round.commitment,
          round.fingerprint,
          round.feature === undefined ? null : JSON.stringify(round.feature),
          round.lastResult === undefined ? null : JSON.stringify(round.lastResult),
          round.steps,
          round.openedAt,
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new StoreConflictError('DUPLICATE_ROUND', `round ${round.roundId} already exists`);
      }
      throw error;
    }
  }

  async find(roundId: RoundId): Promise<StoredRound | undefined> {
    const result = await this.#pool.query<RoundRow>('select * from rounds where round_id = $1', [
      roundId,
    ]);
    const row = result.rows[0];
    return row === undefined ? undefined : roundOfRow(row);
  }

  async record(roundId: RoundId, call: CallName, step: number): Promise<StoredRecord | undefined> {
    const result = await this.#pool.query<{
      fingerprint: string;
      response: unknown;
    }>(
      'select fingerprint, response from idempotency_records where round_id = $1 and call_name = $2 and step = $3',
      [roundId, call, step],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : { roundId, call, step, fingerprint: row.fingerprint, response: row.response };
  }

  async commit({ roundId, from, patch, records }: RoundCommit): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('begin');
      await this.#transition(client, roundId, from, patch);
      for (const record of records) {
        await this.#insertRecord(client, record);
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async pendingFor(playerId: string): Promise<StoredRound | undefined> {
    const result = await this.#pool.query<RoundRow>(
      `select * from rounds where player_id = $1 and state <> 'SETTLED' order by seq limit 1`,
      [playerId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : roundOfRow(row);
  }

  async settledFor(playerId: string, limit: number): Promise<readonly StoredRound[]> {
    const result = await this.#pool.query<RoundRow>(
      `select * from rounds where player_id = $1 and state = 'SETTLED' order by seq desc limit $2`,
      [playerId, limit],
    );
    return result.rows.map(roundOfRow);
  }

  async lastOpenedAt(playerId: string): Promise<number | undefined> {
    const result = await this.#pool.query<{ last: number | null }>(
      'select max(opened_at) as last from rounds where player_id = $1',
      [playerId],
    );
    const last = result.rows[0]?.last;
    return last === null || last === undefined ? undefined : last;
  }

  /** Drain the pool — tests and orderly shutdowns; the process exit path never waits on it. */
  async close(): Promise<void> {
    await this.#pool.end();
  }

  async #transition(
    client: PoolClient,
    roundId: RoundId,
    from: StoredRound['state'],
    patch: RoundCommit['patch'],
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [roundId, from];
    const set = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (patch.state !== undefined) set('state', patch.state);
    if (patch.cumulativeWin !== undefined) set('cumulative_win', patch.cumulativeWin);
    if (patch.capped !== undefined) set('capped', patch.capped);
    if (patch.feature !== undefined) set('feature', JSON.stringify(patch.feature));
    if (patch.lastResult !== undefined) set('last_result', JSON.stringify(patch.lastResult));
    if (patch.steps !== undefined) set('steps', patch.steps);

    // A commit with an empty patch still asserts the precondition — the WHERE is the point.
    const assignment = sets.length === 0 ? 'state = state' : sets.join(', ');
    const updated = await client.query(
      `update rounds set ${assignment} where round_id = $1 and state = $2`,
      values,
    );
    if (updated.rowCount === 0) {
      throw new StoreConflictError('STALE_TRANSITION', `round ${roundId} is not ${from}`);
    }
  }

  async #insertRecord(client: PoolClient, record: StoredRecord): Promise<void> {
    try {
      await client.query(
        `insert into idempotency_records (round_id, call_name, step, fingerprint, response)
         values ($1, $2, $3, $4, $5)`,
        [
          record.roundId,
          record.call,
          record.step,
          record.fingerprint,
          JSON.stringify(record.response),
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new StoreConflictError(
          'DUPLICATE_RECORD',
          `${record.call} ${record.step} of ${record.roundId} is already recorded`,
        );
      }
      throw error;
    }
  }
}

/**
 * A pool that parses `int8` as number — safe because minor units are safe integers. Per-pool
 * rather than pg's global `setTypeParser`: a library mutating process-wide parser state on import
 * is exactly the kind of spooky action this workspace bans elsewhere. Exported so the composition
 * can hand one pool to both the store and the ledger.
 */
export function createPgPool(databaseUrl: string): Pool {
  const INT8_OID = 20;
  const types = {
    getTypeParser: (oid: number, format?: 'text' | 'binary') =>
      oid === INT8_OID && format !== 'binary' ? int8 : pg.types.getTypeParser(oid, format as never),
  } as pg.CustomTypesConfig;
  return new pg.Pool({ connectionString: databaseUrl, types });
}

/** Connect, parse bigints as numbers (safe: minor units are safe integers), migrate, serve. */
export async function createPostgresStore({
  databaseUrl,
  retention,
  pool,
}: PostgresStoreOptions): Promise<PostgresRoundStore> {
  const connected = pool ?? createPgPool(databaseUrl);
  await migrate(connected);
  return new PostgresRoundStore(connected, retention);
}
