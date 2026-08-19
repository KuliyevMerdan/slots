import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { Minor, SettleRes, SpinRes } from '@slot/protocol';
import { PostgresRoundStore, createPgPool, createPostgresStore } from './postgres.js';
import { runStoreContract } from './store-contract.js';
import type { PostgresLedger } from '../ledger/postgres.js';
import { createPostgresLedger } from '../ledger/postgres.js';
import { runLedgerContract } from '../ledger/ledger-contract.js';
import type { PostgresSessionStore } from '../domain/sessions-postgres.js';
import { createPostgresSessionStore } from '../domain/sessions-postgres.js';
import { runSessionStoreContract } from '../domain/sessions-contract.js';
import { runRaceSuite } from '../http/races-contract.js';
import { createGameConfig } from '../config.js';
import { boundTo, createRoundService } from '../domain/rounds.js';
import { createSessionService } from '../domain/sessions.js';
import { committingSeedProvider, seededBytes } from '../rng/seeds.js';
import { MockWallet } from '../wallet/mock.js';

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
  let pool: pg.Pool;
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
    pool = createPgPool(url as string);
    store = await createPostgresStore({ databaseUrl: url as string, pool });
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

  runStoreContract('on postgres', (options) =>
    Promise.resolve(
      // The eviction case wants a small retention; every other case runs the shared instance.
      options?.retention === undefined ? store : new PostgresRoundStore(pool, options.retention),
    ),
  );
  runLedgerContract('on postgres', () => Promise.resolve(ledger));
  runSessionStoreContract('on postgres', () => Promise.resolve(sessions));

  // R7's load-correctness gate, on the database: the same races the memory twin ran, landing on
  // real row locks, real unique violations and the ledger's advisory lock.
  runRaceSuite('on postgres', () => Promise.resolve({ store, ledger }));

  describe('the backup + restore drill (R7)', () => {
    /** Everything a backup must carry — the four tables main.ts writes. */
    const TABLES = ['rounds', 'idempotency_records', 'ledger_entries', 'sessions'] as const;
    /** The identity columns a restore has to write explicitly, then re-point their sequences. */
    const IDENTITY: Partial<Record<(typeof TABLES)[number], string>> = {
      rounds: 'seq',
      ledger_entries: 'seq',
    };

    interface TableDump {
      columns: string[];
      rows: unknown[][];
    }

    const dump = async (): Promise<Record<string, TableDump>> => {
      const snapshot: Record<string, TableDump> = {};
      for (const table of TABLES) {
        const result = await admin.query<unknown[]>({
          text: `select * from ${table}`,
          rowMode: 'array',
        });
        snapshot[table] = {
          columns: result.fields.map((field) => field.name),
          rows: result.rows,
        };
      }
      return snapshot;
    };

    const restore = async (snapshot: Record<string, TableDump>): Promise<void> => {
      for (const table of TABLES) {
        const { columns, rows } = snapshot[table] as TableDump;
        const overriding = IDENTITY[table] === undefined ? '' : 'overriding system value ';
        for (const row of rows) {
          const params = row.map((_value, index) => `$${index + 1}`).join(', ');
          await admin.query(
            `insert into ${table} (${columns.join(', ')}) ${overriding}values (${params})`,
            // jsonb columns arrive as objects and must go back as JSON text, not as pg arrays.
            row.map((value) =>
              value !== null && typeof value === 'object' ? JSON.stringify(value) : value,
            ),
          );
        }
        const identity = IDENTITY[table];
        if (identity !== undefined) {
          // What pg_restore does for sequences, done explicitly: the next generated value must
          // clear everything the backup carried.
          await admin.query(
            `select setval(pg_get_serial_sequence('${table}', '${identity}'),
                           (select coalesce(max(${identity}), 1) from ${table}))`,
          );
        }
      }
    };

    it('a restored database resumes the round, replays the answers and keeps the books', async () => {
      const PLAYER = 'demo-player';
      const TOKEN = 'drill-token';
      const OPENING = 100_000_000 as Minor;
      const NOW = 1_700_000_000_000;

      // The wallet is the operator's system: it survives our "crash" untouched, which is exactly
      // the situation a restore has to reconcile with.
      const wallet = new MockWallet({ [PLAYER]: OPENING });
      const config = createGameConfig();
      const sessionService = createSessionService({
        store: sessions,
        randomBytes: seededBytes('drill-tokens'),
        now: () => NOW,
      });
      await sessionService.issue({ playerId: PLAYER, currency: 'EUR', token: TOKEN });
      const compose = () =>
        boundTo(
          createRoundService({
            store,
            wallet,
            ledger,
            sessions: sessionService,
            seeds: committingSeedProvider(seededBytes('drill-seed')),
            config,
            now: () => NOW,
          }),
          { token: TOKEN },
        );
      const before = compose();

      // Play until a feature triggers, settling everything else — then stop mid-feature, one
      // step in: the exact shape of state a backup exists to not lose.
      let minted = 0;
      const nextRoundId = (): string =>
        `018e0000-0000-7000-8000-${(minted += 1).toString(16).padStart(12, '0')}`;
      let openRound: { roundId: string; step: number } | undefined;
      let staked = 0;
      let credited = 0;
      for (let attempt = 0; attempt < 600 && openRound === undefined; attempt += 1) {
        const roundId = nextRoundId();
        const spin: SpinRes = await before.spin({ roundId, stake: 100 as Minor });
        staked += 100;
        if (spin.next === 'FEATURE_SPIN') {
          const featured = await before.featureSpin({ roundId, step: 1 });
          if (featured.next === 'FEATURE_SPIN') {
            openRound = { roundId, step: 1 };
          } else if (featured.next === 'SETTLE') {
            credited += (await before.settle({ roundId })).totalWin;
          }
        } else if (spin.next === 'SETTLE') {
          credited += (await before.settle({ roundId })).totalWin;
        }
      }
      expect(openRound).toBeDefined();
      const { roundId: openId, step: playedStep } = openRound as { roundId: string; step: number };

      // What the truth looked like at backup time.
      const pendingBefore = await store.pendingFor(PLAYER);
      const countsBefore = await store.countByState();
      const entriesBefore = await ledger.entries();
      const spinRecord = await store.record(openId, 'spin', 0);
      expect(pendingBefore?.roundId).toBe(openId);

      // The drill: dump, lose everything, restore.
      const snapshot = await dump();
      await admin.query('truncate idempotency_records, rounds, ledger_entries, sessions');
      expect(await store.pendingFor(PLAYER)).toBeUndefined(); // the loss is real
      await restore(snapshot);

      // A fresh composition over the restored database — the restarted process, not the old one.
      const after = compose();

      // The store answers exactly as before the loss.
      expect(await store.pendingFor(PLAYER)).toEqual(pendingBefore);
      expect(await store.countByState()).toEqual(countsBefore);
      expect(await store.record(openId, 'spin', 0)).toEqual(spinRecord);
      // The journal is intact to the entry, and the session still names its player.
      expect(await ledger.entries()).toEqual(entriesBefore);
      expect(await sessionService.verify(TOKEN)).toMatchObject({ playerId: PLAYER });

      // And the round is not merely visible — it finishes: the restored seed pair resolves the
      // remaining free spins, the settle credits exactly once, and the wallet arithmetic closes.
      const authed = await after.authenticate({ token: TOKEN });
      expect(authed.pendingRound?.roundId).toBe(openId);
      let next = 'FEATURE_SPIN';
      let step = playedStep;
      while (next === 'FEATURE_SPIN') {
        step += 1;
        const featured = await after.featureSpin({ roundId: openId, step });
        next = featured.next;
      }
      const settled: SettleRes = await after.settle({ roundId: openId });
      credited += settled.totalWin;

      expect(await wallet.getBalance(PLAYER)).toBe(OPENING - staked + credited);
      expect((await store.find(openId))?.state).toBe('SETTLED');
    });
  });

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
