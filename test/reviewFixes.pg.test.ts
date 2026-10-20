/**
 * Database and API regression tests for the security review findings.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiServer } from '../src/api/server.js';
import { signToken } from '../src/api/auth.js';
import { MasterKey } from '../src/crypto/keyring.js';
import { PgConnection, PgError } from '../src/db/pg.js';
import { PgAuthStore, PgJobQueue, PgKillSwitchStore, TenantKeys, saveRoute, withTenant } from '../src/db/pgStores.js';
import { Dispatcher } from '../src/delivery/dispatcher.js';
import { RateLimiter } from '../src/delivery/rateLimiter.js';
import { SafetyMonitor } from '../src/delivery/safety.js';
import { ConnectionManager } from '../src/wa/connectionManager.js';
import { FakeWaNetwork, fakeTransportFactory } from '../src/wa/fakeNetwork.js';
import { adminSetTenant, createTestDb, pgAvailable, type TestDb } from './pgHelpers.js';

const available = await pgAvailable();
const SECRET = 'review-fixes-secret-0123456789abcdefghij';

describe('review fixes (database + API)', { skip: !available && 'local test Postgres not running' }, () => {
  let db: TestDb;
  let keys: TenantKeys;
  let api: ApiServer;
  let conns: ConnectionManager;
  let tA: string;
  let accA: string;
  let tok: string;

  const call = async (method: string, path: string, body?: unknown, token = tok) => {
    const r = await fetch(api.url + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };

  before(async () => {
    db = await createTestDb();
    keys = new TenantKeys(new MasterKey('mk-rf', MasterKey.generateB64()), db.worker);
    tA = await keys.provision(db.app, 'A', 'trial', 'a@x.com');
    accA = (await withTenant(db.app, tA, (c) => c.query<{ id: string }>(`INSERT INTO wa_accounts (tenant_id) VALUES ($1) RETURNING id`, [tA]))).rows[0]!.id;
    conns = new ConnectionManager({ transportFactory: fakeTransportFactory(new FakeWaNetwork()), storeFactory: async (t, a) => new PgAuthStore(db.worker, t, a, await keys.cipher(t)) });
    api = new ApiServer({ appPool: db.app, connections: conns, queue: new PgJobQueue(db.worker, db.app), killSwitches: new PgKillSwitchStore(db.worker), tokenSecret: SECRET });
    await api.listen();
    tok = signToken({ tenantId: tA, userId: 'u1', role: 'owner' }, SECRET);
  });
  after(async () => {
    await api?.close();
    await conns?.shutdown();
    await db?.drop();
  });

  test('#1 timestamps read back as real dates (session in UTC)', async () => {
    const r = await db.worker.query<{ t: Date }>('SELECT now() AS t');
    assert.ok(Math.abs(r.rows[0]!.t.getTime() - Date.now()) < 10_000);
    const tz = await db.worker.query<{ tz: string }>(`SELECT current_setting('TimeZone') AS tz`);
    assert.equal(tz.rows[0]!.tz, 'UTC');
  });

  test('#1 stale jobs read from the database are skipped, not sent', async () => {
    const q = new PgJobQueue(db.worker, db.app);
    await q.enqueue([{ tenantId: tA, routeId: '', source: { platform: 'wa', accountId: accA, chatId: 's' }, sourceMessageId: 'old', target: { platform: 'wa', accountId: accA, chatId: 't' }, content: { kind: 'text', text: 'ישן' }, notBefore: new Date(Date.now() - 1000), requiresApproval: false, idempotencyKey: 'stale-1' }]);
    await db.worker.query(`UPDATE outbound_jobs SET created_at = now() - interval '3 hours' WHERE idempotency_key = 'stale-1'`);
    let sent = 0;
    const ks = new PgKillSwitchStore(db.worker);
    const limiter = new RateLimiter(() => ({ accountMinGapMs: 0, accountPerMinute: 999, chatMinGapMs: 0, dailyCap: 999 }), async () => 0);
    const d = new Dispatcher({
      workerId: 'w', queue: q, killSwitches: ks, limiter, safety: new SafetyMonitor({ killSwitches: ks, limiter }),
      senderFor: () => ({ platform: 'wa', accountId: accA, send: async () => { sent++; return { messageId: 'x', sentAt: new Date() }; } }),
    });
    const s = await d.tick();
    assert.equal(s.skipped, 1);
    assert.equal(sent, 0);
  });

  test('#2 a suspended tenant cannot send, and the customer cannot lift an admin stop', async () => {
    const ks = new PgKillSwitchStore(db.worker);
    assert.equal(await ks.find({ tenantId: tA, accountId: accA }), null);
    await adminSetTenant(db, tA, null, 'suspended');
    const sw = await ks.find({ tenantId: tA, accountId: accA });
    assert.equal(sw?.scope, 'tenant');
    assert.equal(sw?.setBy, 'admin:status');
    await adminSetTenant(db, tA, null, 'active');
    assert.equal(await ks.find({ tenantId: tA, accountId: accA }), null);

    await ks.set({ scope: 'tenant', scopeId: tA, tenantId: tA, reason: 'abuse', setBy: 'admin:moshe' });
    const r = await call('POST', '/v1/resume', { scope: 'tenant' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'locked_stop');
    await ks.clear('tenant', tA, 'admin:moshe');

    await ks.set({ scope: 'account', scopeId: accA, tenantId: tA, reason: 'banned', setBy: 'system:auto' });
    assert.equal((await call('POST', '/v1/resume', { scope: 'account', id: accA })).status, 403);
    await ks.clear('account', accA, 'admin');

    assert.equal((await call('POST', '/v1/stop', { scope: 'tenant' })).status, 200);
    assert.equal((await call('POST', '/v1/resume', { scope: 'tenant' })).status, 200, 'the customer can lift their own stop');
  });

  test('#3 the worker role cannot read users', async () => {
    await assert.rejects(db.worker.query('SELECT email, password_hash FROM users'), (e: unknown) => e instanceof PgError && e.code === '42501');
  });

  test('#8 sign-up cannot create a paid plan', async () => {
    await assert.rejects(keys.provision(db.app, 'X', 'business', 'x@x.com'), (e: unknown) => e instanceof PgError && e.code === '42501');
  });

  test('#9 finishing a job that was re-queued does nothing', async () => {
    const q = new PgJobQueue(db.worker, db.app);
    await q.enqueue([{ tenantId: tA, routeId: '', source: { platform: 'wa', accountId: accA, chatId: 's' }, sourceMessageId: 'g', target: { platform: 'wa', accountId: accA, chatId: 't9' }, content: { kind: 'text', text: 'x' }, notBefore: new Date(Date.now() - 1000), requiresApproval: false, idempotencyKey: 'guard-1' }]);
    await db.worker.query(`UPDATE outbound_jobs SET status = 'skipped' WHERE idempotency_key <> 'guard-1' AND status = 'queued'`);
    const [j] = await q.claim('slow', 1, 1);
    await new Promise((r) => setTimeout(r, 20));
    await q.reapStale();
    await q.complete(j!.id, { messageId: 'late', sentAt: new Date() });
    assert.equal((await q.get(j!.id))!.status, 'queued');
  });

  test('#4 a pool waiting for a slot recovers when connections die', async () => {
    const { PgPool } = await import('../src/db/pg.js');
    const pool = new PgPool({ host: '127.0.0.1', port: Number(process.env.TEST_PG_PORT ?? 55432), user: 'newsflow_worker', password: 'dev-worker-pw', database: db.name }, 1);
    const c = await pool.acquire();
    const waiting = pool.query<{ x: number }>('SELECT 1 AS x');
    await c.close();
    pool.release(c);
    assert.equal((await waiting).rows[0]!.x, 1);
    await pool.end();
  });

  test('#10 the client refuses to send a password in cleartext without TLS', async () => {
    // A tiny fake server that asks for a cleartext password.
    const net = await import('node:net');
    const sockets: import('node:net').Socket[] = [];
    const srv = net.createServer((s) => {
      sockets.push(s);
      s.once('data', () => {
        const b = Buffer.alloc(9);
        b.write('R', 0);
        b.writeInt32BE(8, 1);
        b.writeInt32BE(3, 5);
        s.write(b);
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    await assert.rejects(PgConnection.connect({ host: '127.0.0.1', port, user: 'u', password: 'secret', database: 'd' }), /cleartext/);
    for (const s of sockets) s.destroy();
    srv.close();
  });

  test('#12 deleting a number frees the plan slot, cancels its jobs and disables its routes', async () => {
    await withTenant(db.app, tA, (c) => c.query(`INSERT INTO chats (tenant_id, platform, account_id, chat_id, title, can_send) VALUES ($1,'wa',$2,'s@g.us','s',true), ($1,'wa',$2,'t@g.us','t',true)`, [tA, accA]));
    const rid = await withTenant(db.app, tA, (c) => saveRoute(c, tA, { name: 'r', enabled: true, filters: {}, requireApproval: false, sources: [{ platform: 'wa', accountId: accA, chatId: 's@g.us' }], targets: [{ platform: 'wa', accountId: accA, chatId: 't@g.us' }] }));
    await new PgJobQueue(db.worker).enqueue([{ tenantId: tA, routeId: rid, source: { platform: 'wa', accountId: accA, chatId: 's@g.us' }, sourceMessageId: 'd', target: { platform: 'wa', accountId: accA, chatId: 't@g.us' }, content: { kind: 'text', text: 'x' }, notBefore: new Date(Date.now() + 60_000), requiresApproval: false, idempotencyKey: 'del-1' }]);
    assert.equal((await call('POST', '/v1/wa/accounts', {})).status, 403, 'trial plan: one number');
    assert.equal((await call('DELETE', `/v1/wa/accounts/${accA}`)).status, 200);
    const job = await db.worker.query<{ status: string }>(`SELECT status FROM outbound_jobs WHERE idempotency_key = 'del-1'`);
    assert.equal(job.rows[0]!.status, 'cancelled');
    const route = await db.worker.query<{ enabled: boolean }>('SELECT enabled FROM routes WHERE id = $1', [rid]);
    assert.equal(route.rows[0]!.enabled, false);
    assert.equal((await call('POST', '/v1/wa/accounts', {})).status, 200, 'slot is free again');
  });

  test('#6 the API refuses a route that closes a cycle', async () => {
    const acc = (await db.worker.query<{ id: string }>(`SELECT id FROM wa_accounts WHERE tenant_id = $1 AND status <> 'deleted'`, [tA])).rows[0]!.id;
    await withTenant(db.app, tA, (c) => c.query(`INSERT INTO chats (tenant_id, platform, account_id, chat_id, title, can_send) VALUES ($1,'wa',$2,'A@g.us','A',true), ($1,'wa',$2,'B@g.us','B',true)`, [tA, acc]));
    const ab = await call('POST', '/v1/routes', { name: 'A→B', sources: [{ platform: 'wa', accountId: acc, chatId: 'A@g.us' }], targets: [{ platform: 'wa', accountId: acc, chatId: 'B@g.us' }] });
    assert.equal(ab.status, 200);
    const ba = await call('POST', '/v1/routes', { name: 'B→A', sources: [{ platform: 'wa', accountId: acc, chatId: 'B@g.us' }], targets: [{ platform: 'wa', accountId: acc, chatId: 'A@g.us' }] });
    assert.equal(ba.status, 422);
    assert.ok(ba.body.error.details.some((p: any) => p.code === 'route_cycle'));
  });

  test('#12 tokens in the URL are refused outside the live-status stream; bad ids are 404', async () => {
    const r = await fetch(`${api.url}/v1/stats?token=${encodeURIComponent(tok)}`);
    assert.equal(r.status, 401);
    assert.equal((await call('POST', '/v1/approvals/11111111-1111-4111-8111-111111111111/approve', {})).status, 404);
  });
});
