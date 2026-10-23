/**
 * PUSH demo server: the real engine, database and dashboard, with SIMULATED
 * WhatsApp. Nothing here connects to WhatsApp or Telegram.
 *
 * On first boot it prepares its own database (roles, schema, migrations), a
 * demo customer, a simulated control group and five target groups. The demo
 * customer can then post, edit and delete messages in the control group from
 * the dashboard and watch PUSH distribute, sync and report.
 *
 * Environment:
 *   DATABASE_URL   superuser URL of a dedicated Postgres (e.g. Railway's)
 *   DEMO_SECRET    ≥ 32 random characters; every password and key is derived from it
 *   DEMO_EMAIL     login email of the demo customer
 *   DEMO_PASSWORD  login password of the demo customer
 *   PORT           HTTP port (Railway sets it)
 */
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { authModule } from '../api/modules/auth.js';
import { pushModule } from '../api/modules/push.js';
import { ApiServer } from '../api/server.js';
import { hashPassword } from '../auth/password.js';
import { MasterKey } from '../crypto/keyring.js';
import { migrate } from '../db/migrate.js';
import { PgConnection, PgPool, parseDatabaseUrl, type ConnOptions } from '../db/pg.js';
import {
  PgAuthStore, PgDedupStore, PgJobQueue, PgKillSwitchStore, PgRouteSource, PgSourceMessageStore, TenantKeys, saveRoute, withTenant,
} from '../db/pgStores.js';
import { MemoryMediaStore } from '../delivery/mediaStore.js';
import { Worker } from '../engine/worker.js';
import { createLogger } from '../logger.js';
import { ConnectionManager } from '../wa/connectionManager.js';
import { FakeWaNetwork, fakeTransportFactory } from '../wa/fakeNetwork.js';
import { DEMO, demoModule } from './module.js';

const log = createLogger({ service: 'push-demo', env: 'demo' });
const need = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is required`);
  return v;
};
const secret = need('DEMO_SECRET');
if (secret.length < 32) throw new Error('DEMO_SECRET must be at least 32 characters');
const derive = (label: string, len = 32) => createHmac('sha256', secret).update(label).digest('base64url').slice(0, len);
const email = need('DEMO_EMAIL').toLowerCase();
const password = need('DEMO_PASSWORD');

// ------------------------------------------------------------ database
const su = parseDatabaseUrl(need('DATABASE_URL'));
const DB = 'push_demo';
const pw = { owner: derive('owner'), app: derive('app'), worker: derive('worker'), admin: derive('admin') };
// The repository (or image) root, where db/ lives.
const root = process.env.APP_ROOT ?? process.cwd();

async function prepareDatabase() {
  const s = await PgConnection.connect(su);
  try {
    await s.exec(await readFile(path.join(root, 'db', 'bootstrap-roles.sql'), 'utf8'));
    for (const [role, p] of Object.entries(pw)) {
      await s.exec(`ALTER ROLE newsflow_${role} PASSWORD '${p.replace(/'/g, "''")}'`);
    }
    const exists = await s.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB]);
    if (!exists.rowCount) {
      await s.exec(`CREATE DATABASE ${DB} OWNER newsflow_owner`);
      const s2 = await PgConnection.connect({ ...su, database: DB });
      await s2.exec(`REVOKE ALL ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO newsflow_owner;
                     GRANT USAGE ON SCHEMA public TO newsflow_app, newsflow_worker, newsflow_admin;`);
      await s2.close();
    }
  } finally {
    await s.close();
  }
  const as = (user: string, password: string): ConnOptions => ({ ...su, user, password, database: DB });
  const owner = await PgConnection.connect(as('newsflow_owner', pw.owner));
  const res = await migrate(owner, path.join(root, 'db', 'migrations'));
  await owner.close();
  log.info('database ready', { applied: res.applied.length });
  return {
    app: new PgPool(as('newsflow_app', pw.app), 6),
    worker: new PgPool(as('newsflow_worker', pw.worker), 6),
    owner: new PgPool(as('newsflow_owner', pw.owner), 2),
  };
}

const pools = await prepareDatabase();
const keys = new TenantKeys(new MasterKey('mk-demo', Buffer.from(derive('master-key', 43), 'base64url').subarray(0, 32).toString('base64')), pools.worker);

// ------------------------------------------------------------ simulated WhatsApp world
const net = new FakeWaNetwork({ connectDelayMs: 1 });
net.createGroup('קבוצת שליטה — PUSH', { members: [DEMO.linked, DEMO.customer], jid: DEMO.controlJid });
for (const g of DEMO.targets) net.createGroup(g.title, { members: g.member ? [DEMO.linked] : [], jid: g.jid });

const conns = new ConnectionManager({
  transportFactory: fakeTransportFactory(net),
  storeFactory: async (tenantId, accountId) => new PgAuthStore(pools.worker, tenantId, accountId, await keys.cipher(tenantId)),
  logger: log,
});
const queue = new PgJobQueue(pools.worker, pools.app);
const worker = new Worker({
  workerId: 'demo-1',
  connections: conns,
  queue,
  routes: new PgRouteSource(pools.worker),
  dedup: new PgDedupStore(pools.worker),
  killSwitches: new PgKillSwitchStore(pools.worker),
  media: new MemoryMediaStore(),
  sources: new PgSourceMessageStore(pools.worker),
  dailyCapFor: () => 2000,
  // Faster than the real spacing so the demo reacts within seconds.
  rulesOverride: { wa: { accountMinGapMs: 300, chatMinGapMs: 500, accountPerMinute: 120 } },
  logger: log,
});

// ------------------------------------------------------------ demo customer (first boot only)
async function seed(): Promise<{ tenantId: string; accountId: string }> {
  const DEMO_NAME = 'חדשות הצפון (דמו)';
  const existing = await pools.owner.query<{ id: string }>(`SELECT id FROM tenants WHERE name = $1 AND status = 'active' ORDER BY created_at LIMIT 1`, [DEMO_NAME]);
  let tenantId = existing.rows[0]?.id;
  if (!tenantId) {
    tenantId = await keys.provision(pools.app, DEMO_NAME, 'trial', email, await hashPassword(password));
    await pools.owner.query('SELECT admin_set_tenant($1, $2, $3, $4)', [tenantId, 'premium', null, 'admin:demo-seed']);
    log.info('demo customer created');
  } else {
    // Keep the password in step with DEMO_PASSWORD.
    const hash = await hashPassword(password);
    await withTenant(pools.app, tenantId, (c) => c.query('UPDATE users SET password_hash = $2 WHERE lower(email) = $1', [email, hash]));
  }
  const t = tenantId;
  const acc = await withTenant(pools.app, t, async (c) => {
    const a = await c.query<{ id: string }>(`SELECT id FROM wa_accounts ORDER BY created_at LIMIT 1`);
    if (a.rows[0]) return a.rows[0].id;
    const id = (await c.query<{ id: string }>(`INSERT INTO wa_accounts (tenant_id, label) VALUES ($1, 'מספר PUSH (מדומה)') RETURNING id`, [t])).rows[0]!.id;
    const chats: [string, string][] = [[DEMO.controlJid, 'קבוצת שליטה — PUSH'], ...DEMO.targets.map((g) => [g.jid, g.title] as [string, string])];
    for (const [jid, title] of chats) {
      await c.query('INSERT INTO chats (tenant_id, platform, account_id, chat_id, title, can_send) VALUES ($1, $2, $3, $4, $5, true)', [t, 'wa', id, jid, title]);
    }
    await saveRoute(c, t, {
      name: 'PUSH — קבוצת שליטה', enabled: true, filters: {}, requireApproval: false,
      control: { syncEdits: true, syncDeletes: true, reportMode: 'summary' },
      sources: [{ platform: 'wa', accountId: id, chatId: DEMO.controlJid }],
      targets: DEMO.targets.map((g) => ({ platform: 'wa' as const, accountId: id, chatId: g.jid, title: g.title })),
    });
    return id;
  });
  return { tenantId: t, accountId: acc };
}

const demo = await seed();

// The simulated number links itself (QR scanned by the simulation on first boot).
await conns.connect(demo.tenantId, demo.accountId, { method: 'qr' });
for (let i = 0; i < 200 && conns.getState(demo.accountId)?.status !== 'connected'; i++) {
  const qr = conns.getState(demo.accountId)?.qr;
  if (qr) {
    try { net.scanQr(DEMO.linked, qr); } catch { /* already linked */ }
  }
  await new Promise((r) => setTimeout(r, 50));
}
log.info('simulated WhatsApp', { status: conns.getState(demo.accountId)?.status });

// ------------------------------------------------------------ API
const api = new ApiServer({
  appPool: pools.app,
  connections: conns,
  queue,
  killSwitches: new PgKillSwitchStore(pools.worker),
  tokenSecret: derive('token-secret', 43),
  trustProxyHops: 1,
  modules: [authModule({ keys }), pushModule(), demoModule({ net, tenantId: demo.tenantId })],
  logger: log,
});
// The root address opens the dashboard.
api.on('GET', '/', false, async ({ res }) => {
  res.writeHead(302, { location: '/app' });
  res.end();
  return undefined;
});

await api.listen(Number(process.env.PORT ?? 8787), '0.0.0.0');
worker.dispatcher.start();
setInterval(() => void pools.worker.query('SELECT * FROM purge_expired(7)').catch(() => {}), 3_600_000).unref();
log.info('PUSH demo started', { url: api.url });

async function shutdown() {
  await api.close();
  await worker.shutdown();
  await Promise.all([pools.app.end(), pools.worker.end(), pools.owner.end()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
