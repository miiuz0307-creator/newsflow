/**
 * Runs against a real PostgreSQL: SCRAM login, migrations, Row Level
 * Security isolation, the job queue under concurrency, encrypted sessions,
 * dedup, kill switches, audit log immutability and retention.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MasterKey } from '../src/crypto/keyring.js';
import { PgConnection, PgError } from '../src/db/pg.js';
import {
  PgAuthStore, PgDedupStore, PgJobQueue, PgKillSwitchStore, PgRouteSource, TenantKeys, saveRoute, withTenant,
} from '../src/db/pgStores.js';
import type { PlannedJob } from '../src/routing/types.js';
import { adminSetTenant, createTestDb, pgAvailable, type TestDb } from './pgHelpers.js';

const available = await pgAvailable();

describe('PostgreSQL integration', { skip: !available && 'local test Postgres not running' }, () => {
  let db: TestDb;
  let keys: TenantKeys;
  let tA: string;
  let tB: string;
  let accA: string;
  let accB: string;

  before(async () => {
    db = await createTestDb();
    keys = new TenantKeys(new MasterKey('mk-test', MasterKey.generateB64()), db.worker);
    tA = await keys.provision(db.app, 'Tenant A', 'trial', 'a@example.com');
    await adminSetTenant(db, tA, 'premium');
    tB = await keys.provision(db.app, 'Tenant B', 'free', 'b@example.com');
    accA = (await withTenant(db.app, tA, (c) => c.query<{ id: string }>(`INSERT INTO wa_accounts (tenant_id, label) VALUES ($1, 'main') RETURNING id`, [tA]))).rows[0]!.id;
    accB = (await withTenant(db.app, tB, (c) => c.query<{ id: string }>(`INSERT INTO wa_accounts (tenant_id, label) VALUES ($1, 'main') RETURNING id`, [tB]))).rows[0]!.id;
  });
  after(async () => {
    await db?.drop();
  });

  describe('client', () => {
    test('wrong password is rejected (SCRAM)', async () => {
      await assert.rejects(
        PgConnection.connect({ host: '127.0.0.1', port: Number(process.env.TEST_PG_PORT ?? 55432), user: 'newsflow_app', password: 'wrong', database: db.name }),
        (e: unknown) => e instanceof PgError && e.code === '28P01',
      );
    });
    test('types round-trip', async () => {
      const r = await db.worker.query<Record<string, unknown>>(
        `SELECT 1::int AS i, 't'::bool AS b, '{"a":[1,"ש"]}'::jsonb AS j, now() AS ts, NULL::text AS n, ARRAY['x','y z']::text[] AS arr, $1::text AS p`, ['שלום "quoted"']);
      const row = r.rows[0]!;
      assert.equal(row.i, 1);
      assert.equal(row.b, true);
      assert.deepEqual(row.j, { a: [1, 'ש'] });
      assert.ok(row.ts instanceof Date);
      assert.equal(row.n, null);
      assert.deepEqual(row.arr, ['x', 'y z']);
      assert.equal(row.p, 'שלום "quoted"');
    });
    test('errors carry SQLSTATE and the connection stays usable', async () => {
      await assert.rejects(db.worker.query('SELECT * FROM no_such_table'), (e: unknown) => e instanceof PgError && e.code === '42P01');
      assert.equal((await db.worker.query<{ x: number }>('SELECT 2 AS x')).rows[0]!.x, 2);
    });
  });

  describe('tenant isolation (RLS)', () => {
    test('each tenant sees only its own rows', async () => {
      const a = await withTenant(db.app, tA, (c) => c.query('SELECT id FROM wa_accounts'));
      const b = await withTenant(db.app, tB, (c) => c.query('SELECT id FROM wa_accounts'));
      assert.deepEqual(a.rows.map((r) => r.id), [accA]);
      assert.deepEqual(b.rows.map((r) => r.id), [accB]);
    });
    test('without a tenant context the API sees nothing (fails closed)', async () => {
      const r = await db.app.query('SELECT id FROM wa_accounts');
      assert.equal(r.rowCount, 0);
      const t = await db.app.query('SELECT id FROM tenants');
      assert.equal(t.rowCount, 0);
    });
    test('cannot write rows for another tenant', async () => {
      await assert.rejects(
        withTenant(db.app, tA, (c) => c.query(`INSERT INTO wa_accounts (tenant_id) VALUES ($1)`, [tB])),
        (e: unknown) => e instanceof PgError && e.code === '42501',
      );
    });
    test('cannot update or delete another tenant\'s rows', async () => {
      const u = await withTenant(db.app, tA, (c) => c.query(`UPDATE wa_accounts SET label = 'hacked' WHERE id = $1`, [accB]));
      const d = await withTenant(db.app, tA, (c) => c.query(`DELETE FROM wa_accounts WHERE id = $1`, [accB]));
      assert.equal(u.rowCount, 0);
      assert.equal(d.rowCount, 0);
      const still = await withTenant(db.app, tB, (c) => c.query<{ label: string }>('SELECT label FROM wa_accounts'));
      assert.equal(still.rows[0]!.label, 'main');
    });
    test('the API cannot read wrapped keys of other tenants, nor change its plan', async () => {
      const r = await withTenant(db.app, tA, (c) => c.query('SELECT id FROM tenants'));
      assert.deepEqual(r.rows.map((x) => x.id), [tA]);
      await assert.rejects(withTenant(db.app, tA, (c) => c.query(`UPDATE tenants SET plan_code = 'business'`)), (e: unknown) => e instanceof PgError && e.code === '42501');
    });
    test('the API cannot set a global kill switch', async () => {
      await assert.rejects(
        withTenant(db.app, tA, (c) => c.query(`INSERT INTO kill_switches (scope, scope_id, tenant_id, reason, set_by) VALUES ('global', '*', NULL, 'x', 'y')`)),
        (e: unknown) => e instanceof PgError,
      );
    });
    test('the audit log cannot be edited or deleted', async () => {
      await assert.rejects(withTenant(db.app, tA, (c) => c.query(`UPDATE audit_log SET action = 'x'`)), (e: unknown) => e instanceof PgError && e.code === '42501');
      await assert.rejects(withTenant(db.app, tA, (c) => c.query(`DELETE FROM audit_log`)), (e: unknown) => e instanceof PgError && e.code === '42501');
      await assert.rejects(db.worker.query(`DELETE FROM audit_log`), (e: unknown) => e instanceof PgError && e.code === '42501');
    });
    test('a tenant key cannot be replaced after provisioning', async () => {
      await assert.rejects(db.worker.query('SELECT set_tenant_key($1, $2, $3)', [tA, 'x', 'mk-test']), (e: unknown) => e instanceof PgError && e.code === '42501');
    });
  });

  describe('encrypted sessions', () => {
    test('auth state round-trips and is unreadable in the table', async () => {
      const cipher = await keys.cipher(tA);
      const s = new PgAuthStore(db.worker, tA, accA, cipher);
      await s.writeCreds({ registered: true, me: { id: '972500000001' }, k: Buffer.from([9, 8, 7]) });
      await s.setKeys({ 'pre-key': { '1': { a: 1 }, 'x"y': { b: 2 } } });
      assert.deepEqual(((await s.readCreds()) as { k: Buffer }).k, Buffer.from([9, 8, 7]));
      assert.deepEqual(await s.getKeys('pre-key', ['1', 'x"y', 'missing']), { '1': { a: 1 }, 'x"y': { b: 2 } });
      const raw = await db.worker.query<{ blob: string }>('SELECT blob FROM wa_auth WHERE account_id = $1', [accA]);
      for (const r of raw.rows) assert.ok(!r.blob.includes('972500000001'), 'phone leaked in plaintext');
      // Tenant B's key cannot read tenant A's session.
      const wrong = new PgAuthStore(db.worker, tA, accA, await keys.cipher(tB));
      await assert.rejects(wrong.readCreds(), /decryption failed/);
      await s.wipe();
      assert.equal(await s.hasCreds(), false);
    });
    test('many keys at once (a send to a big group) are written together, updated and removed', async () => {
      const s = new PgAuthStore(db.worker, tA, accA, await keys.cipher(tA));
      const many: Record<string, unknown> = {};
      for (let i = 0; i < 900; i++) many[`${i}@lid`] = { n: i };
      await s.setKeys({ session: many, 'sender-key-memory': { 'g@g.us': { a: true } } });
      const ids = ['0@lid', '450@lid', '899@lid'];
      assert.deepEqual(await s.getKeys('session', ids), { '0@lid': { n: 0 }, '450@lid': { n: 450 }, '899@lid': { n: 899 } });
      await s.setKeys({ session: { '0@lid': null, '450@lid': { n: 'new' } } });
      assert.deepEqual(await s.getKeys('session', ids), { '450@lid': { n: 'new' }, '899@lid': { n: 899 } });
      assert.deepEqual(await s.getKeys('sender-key-memory', ['g@g.us']), { 'g@g.us': { a: true } });
      await s.wipe();
    });
        test('a fresh TenantKeys instance unwraps the stored key', async () => {
      const fresh = new TenantKeys((keys as unknown as { master: MasterKey }).master, db.worker);
      const c1 = await keys.cipher(tA);
      const c2 = await fresh.cipher(tA);
      assert.equal(c2.decryptString('p', c1.encrypt('p', 'ok')), 'ok');
    });
  });

  describe('queue', () => {
    const job = (i: number, over: Partial<PlannedJob> = {}): PlannedJob => ({
      tenantId: tA, routeId: '', source: { platform: 'wa', accountId: accA, chatId: 'src@g.us' }, sourceMessageId: `m${i}`,
      target: { platform: 'wa', accountId: accA, chatId: `t${i % 7}@g.us` }, content: { kind: 'text', text: `msg ${i}` },
      notBefore: new Date(Date.now() - 1000), requiresApproval: false, idempotencyKey: `key-${i}-${Math.random()}`, ...over,
    });

    test('idempotent enqueue', async () => {
      const q = new PgJobQueue(db.worker, db.app);
      const j = job(1);
      assert.equal((await q.enqueue([j, j])).inserted, 1);
      assert.equal((await q.enqueue([j])).inserted, 0);
    });

    test('concurrent workers never claim the same job', async () => {
      const q = new PgJobQueue(db.worker, db.app);
      await db.worker.query(`DELETE FROM outbound_jobs`);
      await q.enqueue(Array.from({ length: 200 }, (_, i) => job(i)));
      const claims = await Promise.all(Array.from({ length: 5 }, (_, w) => (async () => {
        const mine: string[] = [];
        for (;;) {
          const got = await q.claim(`w${w}`, 13, 60_000);
          if (!got.length) break;
          mine.push(...got.map((g) => g.id));
        }
        return mine;
      })()));
      const all = claims.flat();
      assert.equal(all.length, 200);
      assert.equal(new Set(all).size, 200, 'a job was claimed twice');
    });

    test('defer keeps attempts, retry counts them, reap returns stale locks', async () => {
      const q = new PgJobQueue(db.worker, db.app);
      await db.worker.query(`DELETE FROM outbound_jobs`);
      await q.enqueue([job(500)]);
      let [j] = await q.claim('w', 1, 60_000);
      assert.equal(j!.attempts, 1);
      await q.defer(j!.id, new Date(Date.now() - 1));
      [j] = await q.claim('w', 1, 60_000);
      assert.equal(j!.attempts, 1, 'deferral did not count');
      await q.retry(j!.id, new Date(Date.now() - 1), 'transient', 'x');
      [j] = await q.claim('w', 1, 1);
      assert.equal(j!.attempts, 2);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(await q.reapStale(), 1);
      [j] = await q.claim('w', 1, 60_000);
      await q.complete(j!.id, { messageId: 'OUT1', sentAt: new Date() });
      assert.equal((await q.get(j!.id))!.status, 'sent');
      assert.equal(await q.sentCountSince(accA, new Date(Date.now() - 60_000)), 1);
    });

    test('media bytes never reach the database', async () => {
      const q = new PgJobQueue(db.worker, db.app);
      const j = job(900, { content: { kind: 'image', text: 'c', media: { mimeType: 'image/jpeg', ref: `media:${tA}/00000000-0000-0000-0000-000000000000`, data: Buffer.from('BYTES') } } });
      await q.enqueue([j]);
      const r = await db.worker.query<{ content: { media: Record<string, unknown> } }>('SELECT content FROM outbound_jobs WHERE idempotency_key = $1', [j.idempotencyKey]);
      assert.equal(r.rows[0]!.content.media.data, undefined);
      assert.ok(r.rows[0]!.content.media.ref);
    });

    test('approval is tenant-scoped and audited', async () => {
      const q = new PgJobQueue(db.worker, db.app);
      await db.worker.query(`DELETE FROM outbound_jobs`);
      await q.enqueue([job(600, { requiresApproval: true })]);
      const pendingB = await q.listPendingApproval(tB);
      assert.equal(pendingB.length, 0, 'tenant B must not see tenant A\'s pending jobs');
      const [p] = await q.listPendingApproval(tA);
      assert.equal(await q.approve(tB, p!.id), false);
      assert.equal(await q.approve(tA, p!.id), true);
      assert.equal((await q.get(p!.id))!.status, 'queued');
      const audit = await withTenant(db.app, tA, (c) => c.query(`SELECT action FROM audit_log WHERE action = 'job.approved'`));
      assert.equal(audit.rowCount, 1);
    });
  });

  describe('dedup, kill switches, routes, retention', () => {
    test('dedup claims once until expiry', async () => {
      const d = new PgDedupStore(db.worker);
      assert.equal(await d.claim(tA, 'k1', 60_000), true);
      assert.equal(await d.claim(tA, 'k1', 60_000), false);
      assert.equal(await d.claim(tA, 'k2', 1), true);
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(await d.claim(tA, 'k2', 60_000), true, 'expired key can be claimed again');
    });

    test('kill switches: precedence, clear, audit', async () => {
      const ks = new PgKillSwitchStore(db.worker);
      assert.equal(await ks.find({ tenantId: tA, accountId: accA }), null);
      await ks.set({ scope: 'account', scopeId: accA, tenantId: tA, reason: 'banned', setBy: 'system:auto' });
      assert.equal((await ks.find({ tenantId: tA, accountId: accA }))?.scope, 'account');
      assert.equal(await ks.find({ tenantId: tB, accountId: accB }), null);
      await ks.clear('account', accA, 'customer');
      assert.equal(await ks.find({ tenantId: tA, accountId: accA }), null);
      const audit = await withTenant(db.app, tA, (c) => c.query<{ action: string }>(`SELECT action FROM audit_log WHERE action LIKE 'kill_switch.%' ORDER BY id`));
      assert.deepEqual(audit.rows.map((r) => r.action), ['kill_switch.set', 'kill_switch.cleared']);
    });

    test('routes saved by the API are found by the worker', async () => {
      const id = await withTenant(db.app, tA, (c) => saveRoute(c, tA, {
        name: 'ארצי', enabled: true, filters: { excludeAny: ['פרסומת'] }, requireApproval: false,
        sources: [{ platform: 'wa', accountId: accA, chatId: 'src@g.us' }],
        targets: [{ platform: 'wa', accountId: accA, chatId: 't1@g.us', title: 'חדשות אשדוד' }],
        quietHours: { start: '23:00', end: '06:00', timeZone: 'Asia/Jerusalem' },
      }));
      const found = await new PgRouteSource(db.worker).routesForSource({ platform: 'wa', accountId: accA, chatId: 'src@g.us' });
      assert.equal(found.length, 1);
      assert.equal(found[0]!.id, id);
      assert.deepEqual(found[0]!.filters, { excludeAny: ['פרסומת'] });
      assert.equal(found[0]!.targets[0]!.title, 'חדשות אשדוד');
      assert.equal(found[0]!.quietHours?.start, '23:00');
      // Tenant B cannot attach its route to tenant A's route id.
      await assert.rejects(withTenant(db.app, tB, (c) => saveRoute(c, tB, { ...found[0]!, id })), (e: unknown) => e instanceof PgError);
    });

    test('retention clears old message content', async () => {
      const q = new PgJobQueue(db.worker, db.app);
      await db.worker.query(`DELETE FROM outbound_jobs`);
      await q.enqueue([{ tenantId: tA, routeId: '', source: { platform: 'wa', accountId: accA, chatId: 's' }, sourceMessageId: 'old',
        target: { platform: 'wa', accountId: accA, chatId: 't' }, content: { kind: 'text', text: 'ישן' }, notBefore: new Date(), requiresApproval: false, idempotencyKey: 'old-1' }]);
      await db.worker.query(`UPDATE outbound_jobs SET status = 'sent', updated_at = now() - interval '8 days'`);
      const r = await db.worker.query<{ jobs_cleared: number }>('SELECT * FROM purge_expired(7)');
      assert.equal(Number(r.rows[0]!.jobs_cleared), 1);
      const c = await db.worker.query<{ content: unknown }>('SELECT content FROM outbound_jobs');
      // The text is gone; only the kind of message and a "purged" mark remain (migration 011).
      assert.deepEqual(c.rows[0]!.content, { kind: 'text', purged: true });
    });
  });
});
