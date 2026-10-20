/**
 * Usage: DATABASE_URL=postgres://newsflow_owner:...@host:5432/newsflow npm run db:migrate
 * Must run as the schema owner role, never as the app or worker role.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/migrate.js';
import { PgConnection, parseDatabaseUrl } from '../src/db/pg.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const conn = await PgConnection.connect(parseDatabaseUrl(url));
try {
  const r = await migrate(conn, dir);
  console.log(`applied: ${r.applied.join(', ') || '(none)'}; already applied: ${r.skipped.length}`);
} finally {
  await conn.close();
}
