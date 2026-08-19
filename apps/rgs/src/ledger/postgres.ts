import type { Pool } from 'pg';
import type { Minor, RoundId } from '@slot/protocol';
import { LEGS_OF_KIND, LedgerConflictError, judge } from './ledger.js';
import type { Ledger, LedgerAccount, LedgerEntry, Movement, MovementKind } from './ledger.js';
import { createPgPool } from '../persistence/postgres.js';
import { migrate } from '../persistence/migrate.js';

/**
 * The ledger on Postgres — the semantics the memory twin defines, enforced by the database.
 *
 * The rules land where they belong: the journal order is an identity column; append-only is a
 * trigger (`migrations/0002_ledger.sql`) rather than a code-review promise; and the idempotency
 * verdict — one shared `judge`, the same decision the memory ledger makes — runs under a per-ref
 * advisory lock inside the recording transaction, so two racing reports of the same movement
 * serialize and collapse to one entry. There is deliberately no foreign key to `rounds`: an entry
 * whose round never came to exist is not a broken reference, it is the orphan the reconciliation
 * job exists to find.
 */

interface LedgerRow {
  seq: number;
  round_id: string;
  player_id: string;
  kind: MovementKind;
  debit_account: LedgerAccount;
  credit_account: LedgerAccount;
  amount: number;
  ref: string;
  recorded_at: number;
}

const entryOfRow = (row: LedgerRow): LedgerEntry => ({
  seq: row.seq,
  kind: row.kind,
  roundId: row.round_id,
  playerId: row.player_id,
  amount: row.amount as Minor,
  ref: row.ref,
  at: row.recorded_at,
  debit: row.debit_account,
  credit: row.credit_account,
});

export class PostgresLedger implements Ledger {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async record(movement: Movement): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('begin');
      // Serialize per ref: the verdict reads the ref's history and appends on the strength of it,
      // and two racing reports of one movement must collapse to one entry, not two.
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [movement.ref]);
      const forRef = await client.query<LedgerRow>(
        'select * from ledger_entries where ref = $1 order by seq',
        [movement.ref],
      );

      const verdict = judge(movement, forRef.rows.map(entryOfRow));
      if (verdict instanceof LedgerConflictError) throw verdict;
      if (verdict === 'APPEND') {
        const legs = LEGS_OF_KIND[movement.kind];
        await client.query(
          `insert into ledger_entries
             (round_id, player_id, kind, debit_account, credit_account, amount, ref, recorded_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            movement.roundId,
            movement.playerId,
            movement.kind,
            legs.debit,
            legs.credit,
            movement.amount,
            movement.ref,
            movement.at,
          ],
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async entriesFor(roundId: RoundId): Promise<readonly LedgerEntry[]> {
    const result = await this.#pool.query<LedgerRow>(
      'select * from ledger_entries where round_id = $1 order by seq',
      [roundId],
    );
    return result.rows.map(entryOfRow);
  }

  async entries({ since }: { since?: number } = {}): Promise<readonly LedgerEntry[]> {
    const result =
      since === undefined
        ? await this.#pool.query<LedgerRow>('select * from ledger_entries order by seq')
        : await this.#pool.query<LedgerRow>(
            'select * from ledger_entries where recorded_at >= $1 order by seq',
            [since],
          );
    return result.rows.map(entryOfRow);
  }

  /** Drain the pool — tests and orderly shutdowns. Skip when the pool is shared with the store. */
  async close(): Promise<void> {
    await this.#pool.end();
  }
}

export interface PostgresLedgerOptions {
  databaseUrl?: string;
  /** Inject to share one pool with the store; the migrations run either way (idempotent). */
  pool?: Pool;
}

export async function createPostgresLedger({
  databaseUrl,
  pool,
}: PostgresLedgerOptions): Promise<PostgresLedger> {
  if (pool === undefined && databaseUrl === undefined) {
    throw new TypeError('createPostgresLedger needs a databaseUrl or a pool');
  }
  const connected = pool ?? createPgPool(databaseUrl as string);
  await migrate(connected);
  return new PostgresLedger(connected);
}
