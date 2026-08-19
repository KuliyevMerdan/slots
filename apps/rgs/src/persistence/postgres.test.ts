import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { Minor } from '@slot/protocol';
import type { PostgresRoundStore } from './postgres.js';
import { createPostgresStore } from './postgres.js';
import { runStoreContract } from './store-contract.js';
import type { PostgresLedger } from '../ledger/postgres.js';
import { createPostgresLedger } from '../ledger/postgres.js';
import { runLedgerContract } from '../ledger/ledger-contract.js';
import type { PostgresSessionStore } from '../domain/sessions-postgres.js';
import { createPostgresSessionStore } from '../domain/sessions-postgres.js';
import { runSessionStoreContract } from '../domain/sessions-contract.js';

/**
 * Postgres, held to the same contracts the memory twins define — the store's and, since R3, the
 * ledger's. Both live in this one file deliberately: Vitest runs files in parallel workers, and
 * two files dropping and truncating one database race each other; one file is sequential.
 *
 * Gated on `RGS_TEST_DATABASE_URL`: locally it runs when a developer points it at a database
 * (`docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=postgres postgres:16` and
 * `RGS_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres pnpm test`); in CI
 * a service container provides it on every run, so "the database enforces what the memory store
 * promises" is asserted by the pipeline, not by whoever remembered to run it. Skipped *by name*
 * otherwise — a suite that silently shrinks when the database is absent would claim coverage it
 * does not have.
 */

const url = process.env.RGS_TEST_DATABASE_URL;

describe.skipIf(url === undefined)('postgres (RGS_TEST_DATABASE_URL)', () => {
  let admin: pg.Pool;
  let store: PostgresRoundStore;
  let ledger: PostgresLedger;
  let sessions: PostgresSessionStore;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });
    // A fresh schema per run: the migrations themselves are part of what is under test.
    await admin.query(
      'drop table if exists idempotency_records, rounds, ledger_entries, sessions, schema_migrations',
    );
    await admin.query('drop function if exists ledger_entries_are_append_only cascade');
    store = await createPostgresStore({ databaseUrl: url as string });
    ledger = await createPostgresLedger({ databaseUrl: url as string });
    sessions = await createPostgresSessionStore({ databaseUrl: url as string });
  });

  beforeEach(async () => {
    // TRUNCATE bypasses row triggers, so the append-only guard does not bar the test reset —
    // it guards DML, and resetting a schema is an owner's operation.
    await admin.query('truncate idempotency_records, rounds, ledger_entries, sessions');
  });

  afterAll(async () => {
    await store.close();
    await ledger.close();
    await sessions.close();
    await admin.end();
  });

  runStoreContract('on postgres', () => Promise.resolve(store));
  runLedgerContract('on postgres', () => Promise.resolve(ledger));
  runSessionStoreContract('on postgres', () => Promise.resolve(sessions));

  describe('append-only, enforced by the database', () => {
    it('refuses UPDATE and DELETE on ledger entries — a correction is a new entry', async () => {
      await ledger.record({
        kind: 'STAKE',
        roundId: '018c0000-0000-7000-8000-00000000fefe',
        playerId: 'demo-player',
        amount: 100 as Minor,
        ref: '018c0000-0000-7000-8000-00000000fefe',
        at: 1_700_000_000_000,
      });

      await expect(admin.query('update ledger_entries set amount = 1')).rejects.toThrow(
        /append-only/,
      );
      await expect(admin.query('delete from ledger_entries')).rejects.toThrow(/append-only/);
    });
  });
});
