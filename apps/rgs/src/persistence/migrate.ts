import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

/**
 * The migration runner: committed SQL files, applied once each, in name order, each inside its own
 * transaction. Deliberately this small — a migrations *framework* earns its keep on a team with
 * concurrent branches of schema; a portfolio RGS earns more from the reader seeing exactly what
 * runs. The files are the artifact; this is just the loop.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

export async function migrate(
  pool: Pool,
  dir: string = MIGRATIONS_DIR,
): Promise<readonly string[]> {
  await pool.query(
    `create table if not exists schema_migrations (
       name text primary key,
       applied_at timestamptz not null default now()
     )`,
  );

  const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
  const applied: string[] = [];

  for (const file of files) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      // The insert doubles as the lock: two racing processes both try it, one wins, the loser's
      // unique-violation rolls its transaction back and the migration is not applied twice.
      const claimed = await client.query(
        'insert into schema_migrations (name) values ($1) on conflict do nothing returning name',
        [file],
      );
      if (claimed.rowCount === 0) {
        await client.query('rollback');
        continue;
      }
      await client.query(await readFile(path.join(dir, file), 'utf8'));
      await client.query('commit');
      applied.push(file);
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw new Error(
        `migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          cause: error,
        },
      );
    } finally {
      client.release();
    }
  }

  return applied;
}
