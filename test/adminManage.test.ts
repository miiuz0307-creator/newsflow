/**
 * Management panel: first admin set up once with a code and an authenticator,
 * customers added by hand (and able to sign in), removed (and no longer able to),
 * and the /admin page itself.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { adminModule } from '../src/api/modules/admin.js';
import { WindowLimiter, authModule } from '../src/api/modules/auth.js';
import { ApiServer } from '../src/api/server.js';
import { MasterKey } from '../src/crypto/keyring.js';
import { PgJobQueue, PgKillSwitchStore, TenantKeys, withTenant } from '../src/db/pgStores.js';
import { ConnectionManager } from '../src/wa/connectionManager.js';
import { FakeWaNetwork, fakeTransportFactory } from '../src/wa/fakeNetwork.js';
import { memoryStores } from './helpers.js';
import { createTestDb, pgAvailable, type TestDb } from './pgHelpers.js';

const available = await pgAvailable();
const SECRET = 'customer-token-secret-0123456789abcdefgh';
const ADMIN_SECRET = 'admin-token-secret-0123456789abcdefghijk';
const MASTER = MasterKey.generateB64();
const SETUP = 'setup-code-7f3a91';

describe('management panel', { skip: !available && 'local test Postgres not running' }, () => {
  let db: TestDb;
  let api: ApiServer;
  let conns: ConnectionManager;
  let keys: TenantKeys;
  let token = '';
  let customerId = '';
  let customerPassword = '';

  const call = async (method: string, path: string, body?: unknown, tok?: string) => {
    const r = await fetch(api.url + path, { method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: r.status, body: json, text, headers: r.headers };
  };

  before(async () => {
    db = await createTestDb();
    keys = new TenantKeys(new MasterKey('mk-adm', MASTER), db.worker);
    const { factory } = memoryStores();
    conns = new ConnectionManager({ transportFactory: fakeTransportFactory(new FakeWaNetwork({ connectDelayMs: 1 })), storeFactory: async (t, a) => factory(t, a) });
    api = new ApiServer({
      appPool: db.app, connections: conns, queue: new PgJobQueue(db.worker, db.app), killSwitches: new PgKillSwitchStore(db.worker), tokenSecret: SECRET,
      modules: [
        authModule({ keys, loginLimiter: new WindowLimiter(1000, 60_000), signupLimiter: new WindowLimiter(1000, 60_000) }),
        adminModule({
          adminPool: db.admin, adminTokenSecret: ADMIN_SECRET, customerTokenSecret: SECRET, masterKeyB64: MASTER, loginLimiter: new WindowLimiter(1000, 60_000),
          manage: {
            setupCode: SETUP,
            createFirstAdmin: async (email, hash, totp) => (await db.owner.query(
              `INSERT INTO admins (email, password_hash, totp_secret, role) SELECT $1, $2, $3, 'superadmin' WHERE NOT EXISTS (SELECT 1 FROM admins)`, [email, hash, totp])).rowCount > 0,
            createCustomer: (name, email, hash) => keys.provision(db.app, name, 'trial', email, hash),
            deleteCustomer: async (tenantId) => { await withTenant(db.app, tenantId, (c) => c.query('SELECT delete_my_tenant()')); },
          },
        }),
      ],
    });
    await api.listen();
  });
  after(async () => {
    await api?.close();
    await conns?.shutdown();
    await db?.drop();
  });

  test('the page is served with a strict CSP and its script parses', async () => {
    const page = await call('GET', '/admin');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    const scripts = [...page.text.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    assert.ok(scripts.length);
    for (const code of scripts) assert.doesNotThrow(() => new Function(code));
    assert.ok(!/innerHTML/.test(page.text));
  });

  test('first admin: needs the setup code, a strong password, and happens once', async () => {
    assert.equal((await call('GET', '/admin/v1/setup')).body.needed, true);
    const base = { code: SETUP, email: 'owner@push.test', password: 'Kvish-Arba-Tsafon-2026!' };
    assert.equal((await call('POST', '/admin/v1/setup', { ...base, code: 'wrong' })).status, 403);
    assert.equal((await call('POST', '/admin/v1/setup', { ...base, password: 'short' })).status, 400);
    const made = await call('POST', '/admin/v1/setup', base); assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal((await call('GET', '/admin/v1/setup')).body.needed, false);
    assert.equal((await call('POST', '/admin/v1/setup', { ...base, email: 'second@push.test' })).status, 409, 'only once');
    const raw = await db.owner.query<{ role: string }>(`SELECT role FROM admins`);
    assert.equal(raw.rowCount, 1);
    assert.equal(raw.rows[0]!.role, 'superadmin');
  });

  test('the new admin signs in with email and password only; a wrong password is refused', async () => {
    assert.equal((await call('POST', '/admin/v1/login', { email: 'owner@push.test', password: 'wrong-password-123' })).status, 401);
    const r = await call('POST', '/admin/v1/login', { email: 'owner@push.test', password: 'Kvish-Arba-Tsafon-2026!' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    token = r.body.token;
  });

  test('add a customer: they can sign in with the temporary password and appear in the list', async () => {
    assert.equal((await call('POST', '/admin/v1/tenants', { businessName: 'חדשות הדרום', email: 'bad' }, token)).status, 400);
    const c = await call('POST', '/admin/v1/tenants', { businessName: 'חדשות הדרום', email: 'south@push.test', plan: 'premium' }, token);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    customerId = c.body.tenantId;
    customerPassword = c.body.temporaryPassword;
    assert.ok(customerPassword.length >= 12);
    assert.equal((await call('POST', '/admin/v1/tenants', { businessName: 'שוב', email: 'south@push.test' }, token)).status, 409, 'email already used');
    const login = await call('POST', '/v1/auth/login', { email: 'south@push.test', password: customerPassword });
    assert.equal(login.status, 200, 'the customer can sign in');
    const list = await call('GET', '/admin/v1/tenants', undefined, token);
    const row = list.body.find((t: any) => t.id === customerId);
    assert.equal(row.name, 'חדשות הדרום');
    assert.equal(row.plan_code, 'premium');
    assert.equal(row.sent_24h, 0);
    assert.ok('last_login_at' in row && 'connected' in row);
    assert.equal(row.spark_7d.split(',').length, 7, 'a 7-day trend per customer');
    const dash = await call('GET', '/admin/v1/dashboard', undefined, token);
    assert.equal(dash.body.hourly.length, 24, 'the last 24 hours, hour by hour');
    assert.equal(dash.body.sentLast24h, 0);
    const one = await call('GET', `/admin/v1/tenants/${customerId}`, undefined, token);
    assert.equal(one.body.daily.length, 14, '14 days for the customer chart');
    assert.equal((await call('POST', '/admin/v1/tenants', { businessName: 'x', email: 'x@push.test' })).status, 401, 'admins only');
  });

  test('remove a customer: gone from the list, can no longer sign in', async () => {
    assert.equal((await call('DELETE', `/admin/v1/tenants/${customerId}`, undefined, token)).status, 200);
    const list = await call('GET', '/admin/v1/tenants', undefined, token);
    assert.ok(!list.body.some((t: any) => t.id === customerId));
    assert.equal((await call('POST', '/v1/auth/login', { email: 'south@push.test', password: customerPassword })).status, 401);
    assert.equal((await call('DELETE', `/admin/v1/tenants/${customerId}`, undefined, token)).status, 404);
  });
});
