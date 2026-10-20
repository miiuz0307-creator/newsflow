/**
 * Applies SQL files from db/migrations in name order, each in its own
 * transaction, and records them in schema_migrations. Already-applied files
 * are skipped; an edited applied file is reported (checksum mismatch) rather
 * than silently re-run.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PgConnection } from './pg.js';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(conn: PgConnection, dir: string): Promise<MigrationResult> {
  await conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Map(
    (await conn.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [r.version, r.checksum]),
  );
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const result: MigrationResult = { applied: [], skipped: [] };
  for (const f of files) {
    const sql = await readFile(path.join(dir, f), 'utf8');
    const sum = createHash('sha256').update(sql).digest('hex');
    const prev = done.get(f);
    if (prev) {
      if (prev !== sum) throw new Error(`migration ${f} was edited after being applied — add a new migration instead`);
      result.skipped.push(f);
      continue;
    }
    await conn.exec(`BEGIN;\n${sql}\n;COMMIT;`).catch(async (e) => {
      await conn.exec('ROLLBACK').catch(() => {});
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    });
    await conn.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [f, sum]);
    result.applied.push(f);
  }
  return result;
}
