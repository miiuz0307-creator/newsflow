/**
 * Live view: the PUSH admin opens a customer's app exactly as the customer sees it.
 * The token reads everything the customer reads and can change nothing; it is short,
 * audited, superadmin-only, and refused for a suspended customer.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { adminModule, signAdminToken } from '../src/api/modules/admin.js';
import { authModule } from '../src/api/modules/auth.js';
import { ApiServer } from '../src/api/server.js';
import { verifyToken } from '../src/api/auth.js';
import { MasterKey } from '../src/crypto/keyring.js';
import { PgJobQueue, PgKillSwitchStore, TenantKeys } from '../src/db/pgStores.js';
import { ConnectionManager } from '../src/wa/connectionManager.js';
import { FakeWaNetwork, fakeTransportFactory } from '../src/wa/fakeNetwork.js';
import { memoryStores } from './helpers.js';
import { adminSetTenant, createTestDb, pgAvailable, type TestDb } from './pgHelpers.js';

const available = await pgAvailable();
const SECRET = 'customer-token-secret-0123456789abcdef';
const ADMIN_SECRET = 'admin-token-secret-0123456789abcdef-xyz';

describe('admin live view of a customer\'s app', { skip: !available && 'local test Postgres not running' }, () => {
  let db: TestDb, api: ApiServer, conns: ConnectionManager;
  let tenant = '', boss = '', helper = '', bossId = '';
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(api.url + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };

  before(async () => {
    db = await createTestDb();
    const keys = new TenantKeys(new MasterKey('mk-view', MasterKey.generateB64()), db.worker);
    tenant = await keys.provision(db.app, 'חדשות הצפון', 'trial', 'north@x.com');
    bossId = (await db.owner.query<{ id: string }>(`INSERT INTO admins (email, password_hash, totp_secret, role) VALUES ('boss@push.co.il', 'x', '', 'superadmin') RETURNING id`)).rows[0]!.id;
    const helperId = (await db.owner.query<{ id: string }>(`INSERT INTO admins (email, password_hash, totp_secret, role) VALUES ('help@push.co.il', 'x', '', 'support') RETURNING id`)).rows[0]!.id;
    boss = signAdminToken({ adminId: bossId, role: 'superadmin' }, ADMIN_SECRET);
    helper = signAdminToken({ adminId: helperId, role: 'support' }, ADMIN_SECRET);
    const { factory } = memoryStores();
    conns = new ConnectionManager({ transportFactory: fakeTransportFactory(new FakeWaNetwork()), storeFactory: async (t, a) => factory(t, a) });
    api = new ApiServer({
      appPool: db.app, connections: conns, queue: new PgJobQueue(db.worker, db.app), killSwitches: new PgKillSwitchStore(db.worker), tokenSecret: SECRET,
      modules: [authModule({ keys }), adminModule({ adminPool: db.admin, adminTokenSecret: ADMIN_SECRET, customerTokenSecret: SECRET, masterKeyB64: MasterKey.generateB64(),
        manage: { resetOwnerPassword: async (t, hash) => (await db.owner.query<{ email: string }>(
          `UPDATE users SET password_hash = $2 WHERE id = (SELECT id FROM users WHERE tenant_id = $1 ORDER BY (role = 'owner') DESC, created_at LIMIT 1) RETURNING email`, [t, hash])).rows[0]?.email ?? null } })],
    });
    await api.listen();
  });
  after(async () => { await api?.close(); await conns?.shutdown(); await db?.drop(); });

  test('the admin sees what the customer sees, and cannot change anything', async () => {
    const v = await call(boss, 'POST', `/admin/v1/tenants/${tenant}/view`);
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.equal(v.body.name, 'חדשות הצפון');
    const claims = verifyToken(v.body.token, SECRET)!;
    assert.equal(claims.view, bossId);
    assert.ok(claims.exp - Date.now() / 1000 <= 30 * 60 + 2, 'half an hour at most');

    const me = await call(v.body.token, 'GET', '/v1/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.tenant.name, 'חדשות הצפון');
    assert.equal(me.body.user.email, 'north@x.com', 'as the customer\'s owner');
    assert.equal((await call(v.body.token, 'GET', '/v1/wa/accounts')).status, 200);

    for (const [m, p, b] of [['POST', '/v1/risk/accept', {}], ['POST', '/v1/stop', { scope: 'tenant' }], ['DELETE', '/v1/wa/accounts/00000000-0000-4000-8000-000000000000', undefined]] as const) {
      const r = await call(v.body.token, m, p, b);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(r.body.error.code, 'view_only');
    }
    const t = await db.owner.query<{ risk_accepted_at: Date | null }>('SELECT risk_accepted_at FROM tenants WHERE id = $1', [tenant]);
    assert.equal(t.rows[0]!.risk_accepted_at, null, 'nothing changed');
    const audit = await db.admin.query(`SELECT 1 FROM audit_log WHERE action = 'tenant.viewed' AND tenant_id = $1 AND actor = $2`, [tenant, `admin:${bossId}`]);
    assert.equal(audit.rowCount, 1, 'recorded');
  });

  test('the admin can also enter the account with full control (audited)', async () => {
    const v = await call(boss, 'POST', `/admin/v1/tenants/${tenant}/view`, { control: true });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.equal(v.body.control, true);
    const claims = verifyToken(v.body.token, SECRET)!;
    assert.equal(claims.admin, bossId);
    assert.equal(claims.view, undefined);
    assert.equal((await call(v.body.token, 'POST', '/v1/risk/accept', {})).status, 200, 'changes are allowed');
    const audit = await db.admin.query(`SELECT 1 FROM audit_log WHERE action = 'tenant.entered' AND tenant_id = $1`, [tenant]);
    assert.equal(audit.rowCount, 1);
  });

  test('a customer who forgot the password gets a temporary one from the admin', async () => {
    assert.equal((await call(helper, 'POST', `/admin/v1/tenants/${tenant}/password`)).status, 403, 'superadmin only');
    const r = await call(boss, 'POST', `/admin/v1/tenants/${tenant}/password`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.email, 'north@x.com');
    assert.match(r.body.temporaryPassword, /^Push-/);
    const login = await call('', 'POST', '/v1/auth/login', { email: 'north@x.com', password: r.body.temporaryPassword });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.ok(login.body.accessToken);
  });

  test('superadmin only; not for a suspended customer', async () => {
    assert.equal((await call(helper, 'POST', `/admin/v1/tenants/${tenant}/view`)).status, 403);
    await adminSetTenant(db, tenant, null, 'suspended');
    const r = await call(boss, 'POST', `/admin/v1/tenants/${tenant}/view`);
    assert.equal(r.status, 409);
    assert.equal((await call(boss, 'POST', '/admin/v1/tenants/00000000-0000-4000-8000-000000000000/view')).status, 404);
  });
});
