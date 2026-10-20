/**
 * Integration-test database: a fresh database per test file on the local
 * test server (port 55432 by default). Tests that need it are skipped when
 * the server is not reachable, so `npm test` still works anywhere.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/migrate.js';
import { PgConnection, PgPool, type ConnOptions } from '../src/db/pg.js';

const PORT = Number(process.env.TEST_PG_PORT ?? 55432);
const SOCKET = process.env.TEST_PG_SOCKET ?? '/tmp';
const HOST = '127.0.0.1';
const PW = { owner: 'dev-owner-pw', app: 'dev-app-pw', worker: 'dev-worker-pw' };

export async function pgAvailable(): Promise<boolean> {
  try {
    const c = await PgConnection.connect({ host: HOST, socketDir: SOCKET, port: PORT, user: 'postgres', database: 'postgres' });
    await c.close();
    return true;
  } catch {
    return false;
  }
}

export interface TestDb {
  name: string;
  app: PgPool;
  worker: PgPool;
  owner: PgPool;
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const name = `nf_it_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const su = await PgConnection.connect({ host: HOST, socketDir: SOCKET, port: PORT, user: 'postgres', database: 'postgres' });
  await su.exec(`CREATE DATABASE ${name} OWNER newsflow_owner`);
  await su.close();
  const su2 = await PgConnection.connect({ host: HOST, socketDir: SOCKET, port: PORT, user: 'postgres', database: name });
  await su2.exec(`REVOKE ALL ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO newsflow_owner;
                  GRANT USAGE ON SCHEMA public TO newsflow_app, newsflow_worker;`);
  await su2.close();

  // Everything below goes over TCP with SCRAM passwords, like production.
  const opts = (user: string, password: string): ConnOptions => ({ host: HOST, port: PORT, user, password, database: name });
  const ownerConn = await PgConnection.connect(opts('newsflow_owner', PW.owner));
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
  await migrate(ownerConn, dir);
  await ownerConn.close();

  const db: TestDb = {
    name,
    app: new PgPool(opts('newsflow_app', PW.app), 5),
    worker: new PgPool(opts('newsflow_worker', PW.worker), 5),
    owner: new PgPool(opts('newsflow_owner', PW.owner), 2),
    async drop() {
      await Promise.all([db.app.end(), db.worker.end(), db.owner.end()]);
      const s = await PgConnection.connect({ host: HOST, socketDir: SOCKET, port: PORT, user: 'postgres', database: 'postgres' });
      await s.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await s.close();
    },
  };
  return db;
}

/** Admin action: change a tenant's plan or status (as the owner role, audited). */
export async function adminSetTenant(db: TestDb, tenantId: string, plan: string | null, status: string | null = null) {
  await db.owner.query('SELECT admin_set_tenant($1, $2, $3, $4)', [tenantId, plan, status, 'admin:test']);
}
