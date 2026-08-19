import { afterAll, beforeAll, beforeEach, describe } from 'vitest';
import pg from 'pg';
import type { PostgresRoundStore } from './postgres.js';
import { createPostgresStore } from './postgres.js';
import { runStoreContract } from './store-contract.js';

/**
 * The Postgres store, held to the same contract the memory store defines.
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

describe.skipIf(url === undefined)('postgres store (RGS_TEST_DATABASE_URL)', () => {
  let admin: pg.Pool;
  let store: PostgresRoundStore;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });
    // A fresh schema per run: the migrations themselves are part of what is under test.
    await admin.query('drop table if exists idempotency_records, rounds, schema_migrations');
    store = await createPostgresStore({ databaseUrl: url as string });
  });

  beforeEach(async () => {
    await admin.query('truncate idempotency_records, rounds');
  });

  afterAll(async () => {
    await store.close();
    await admin.end();
  });

  runStoreContract('on postgres', () => Promise.resolve(store));
});
