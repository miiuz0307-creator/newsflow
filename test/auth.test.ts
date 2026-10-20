import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { WindowLimiter, authModule } from '../src/api/modules/auth.js';
import { ApiServer } from '../src/api/server.js';
import { checkPassword, hashPassword, verifyPassword } from '../src/auth/password.js';
import { MasterKey } from '../src/crypto/keyring.js';
import { PgAuthStore, PgJobQueue, PgKillSwitchStore, TenantKeys, withTenant } from '../src/db/pgStores.js';
import { ConnectionManager } from '../src/wa/connectionManager.js';
import { FakeWaNetwork, fakeTransportFactory } from '../src/wa/fakeNetwork.js';
import { createTestDb, pgAvailable, type TestDb } from './pgHelpers.js';

describe('passwords', () => {
  test('hash and verify', async () => {
    const h = await hashPassword('סיסמה-ארוכה-1');
    assert.match(h, /^scrypt\$32768\$8\$1\$/);
    assert.equal(await verifyPassword('סיסמה-ארוכה-1', h), true);
    assert.equal(await verifyPassword('wrong-password', h), false);
    assert.equal(await verifyPassword('x', null), false);
    assert.equal(await verifyPassword('x', 'garbage'), false);
  });
  test('policy', () => {
    assert.equal(checkPassword('short')?.code, 'too_short');
    assert.equal(checkPassword('password1')?.code, 'too_common');
    assert.equal(checkPassword('michael-2026', 'michael@x.com')?.code, 'contains_email');
    assert.equal(checkPassword('a long passphrase'), null);
  });
  test('window limiter', () => {
    let t = 0;
    const l = new WindowLimiter(2, 1000, () => t);
    assert.equal(l.take('ip'), true);
    assert.equal(l.take('ip'), true);
    assert.equal(l.take('ip'), false);
    t = 1001;
    assert.equal(l.take('ip'), true);
  });
});

const available = await pgAvailable();
const SECRET = 'auth-test-secret-0123456789abcdefghijkl';

describe('auth API', { skip: !available && 'local test Postgres not running' }, () => {
  let db: TestDb;
  let api: ApiServer;
  let conns: ConnectionManager;

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(api.url + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  before(async () => {
    db = await createTestDb();
    const keys = new TenantKeys(new MasterKey('mk-auth', MasterKey.generateB64()), db.worker);
    conns = new ConnectionManager({ transportFactory: fakeTransportFactory(new FakeWaNetwork()), storeFactory: async (t, a) => new PgAuthStore(db.worker, t, a, await keys.cipher(t)) });
    api = new ApiServer({
      appPool: db.app, connections: conns, queue: new PgJobQueue(db.worker, db.app), killSwitches: new PgKillSwitchStore(db.worker), tokenSecret: SECRET,
      modules: [authModule({ keys, loginLimiter: new WindowLimiter(1000, 60_000), signupLimiter: new WindowLimiter(1000, 60_000) })],
    });
    await api.listen();
  });
  after(async () => {
    await api?.close();
    await conns?.shutdown();
    await db?.drop();
  });

  const signup = (email: string, over: Record<string, unknown> = {}) =>
    call('POST', '/v1/auth/signup', { email, password: 'correct horse battery', businessName: 'חדשות הצפון', acceptTerms: true, ...over });

  test('sign-up validates input and creates a trial tenant', async () => {
    assert.equal((await signup('not-an-email')).body.error.code, 'bad_email');
    assert.equal((await signup('a@b.co', { password: '123' })).body.error.code, 'too_short');
    assert.equal((await signup('a@b.co', { acceptTerms: false })).body.error.code, 'terms_required');
    const r = await signup('Owner@Example.com', { displayName: 'מיכאל' });
    assert.equal(r.status, 200);
    assert.ok(r.body.accessToken && r.body.refreshToken);
    const me = await call('GET', '/v1/me', undefined, bearer(r.body.accessToken));
    assert.equal(me.body.user.email, 'owner@example.com');
    assert.equal(me.body.user.displayName, 'מיכאל');
    assert.equal(me.body.tenant.plan.code, 'trial');
    assert.equal(me.body.tenant.riskAccepted, false);
    assert.equal((await signup('owner@example.com')).status, 409);
  });

  test('login: generic error, lockout after 5 failures', async () => {
    await signup('lock@example.com');
    const unknown = await call('POST', '/v1/auth/login', { email: 'nobody@example.com', password: 'x' });
    const wrong = await call('POST', '/v1/auth/login', { email: 'lock@example.com', password: 'wrong password!' });
    assert.equal(unknown.status, 401);
    assert.deepEqual(unknown.body, wrong.body, 'same answer whether or not the email exists');
    for (let i = 0; i < 4; i++) await call('POST', '/v1/auth/login', { email: 'lock@example.com', password: 'wrong password!' });
    const locked = await call('POST', '/v1/auth/login', { email: 'lock@example.com', password: 'correct horse battery' });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error.code, 'locked');
  });

  test('login works and a successful login resets the counter', async () => {
    await signup('ok@example.com');
    await call('POST', '/v1/auth/login', { email: 'ok@example.com', password: 'wrong password!' });
    const r = await call('POST', '/v1/auth/login', { email: 'OK@example.com', password: 'correct horse battery' });
    assert.equal(r.status, 200);
    const fl = await db.owner.query<{ failed_logins: number }>(`SELECT failed_logins FROM users WHERE email = 'ok@example.com'`);
    assert.equal(fl.rows[0]!.failed_logins, 0);
  });

  test('per-IP login limit', async () => {
    const strict = new ApiServer({
      appPool: db.app, connections: conns, queue: new PgJobQueue(db.worker, db.app), killSwitches: new PgKillSwitchStore(db.worker), tokenSecret: SECRET,
      modules: [authModule({ keys: new TenantKeys(new MasterKey('mk-x', MasterKey.generateB64()), db.worker), loginLimiter: new WindowLimiter(2, 60_000) })],
    });
    await strict.listen();
    const post = () => fetch(`${strict.url}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.co', password: 'x' }) });
    await post();
    await post();
    assert.equal((await post()).status, 429);
    await strict.close();
  });

  test('refresh rotates tokens; re-using an old one ends all sessions', async () => {
    const s = await signup('refresh@example.com');
    const r1 = await call('POST', '/v1/auth/refresh', { refreshToken: s.body.refreshToken });
    assert.equal(r1.status, 200);
    assert.notEqual(r1.body.refreshToken, s.body.refreshToken);
    const reuse = await call('POST', '/v1/auth/refresh', { refreshToken: s.body.refreshToken });
    assert.equal(reuse.status, 401);
    const afterReuse = await call('POST', '/v1/auth/refresh', { refreshToken: r1.body.refreshToken });
    assert.equal(afterReuse.status, 401, 'the newer token is revoked too');
    assert.equal((await call('POST', '/v1/auth/refresh', { refreshToken: 'garbage' })).status, 401);
    const stored = await db.owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM refresh_tokens WHERE token_hash LIKE '%.%'`);
    assert.equal(stored.rows[0]!.n, 0, 'tokens are stored only as hashes');
  });

  test('logout revokes the refresh token', async () => {
    const s = await signup('logout@example.com');
    await call('POST', '/v1/auth/logout', { refreshToken: s.body.refreshToken }, bearer(s.body.accessToken));
    assert.equal((await call('POST', '/v1/auth/refresh', { refreshToken: s.body.refreshToken })).status, 401);
  });

  test('account deletion needs the password, removes data, and blocks login', async () => {
    const s = await signup('delete@example.com');
    const t = s.body.tenantId;
    await withTenant(db.app, t, (c) => c.query(`INSERT INTO wa_accounts (tenant_id, label) VALUES ($1, 'x')`, [t]));
    await withTenant(db.app, t, (c) => c.query(`INSERT INTO templates (tenant_id, name, body) VALUES ($1, 'x', '{content}')`, [t]));
    assert.equal((await call('DELETE', '/v1/account', undefined, { ...bearer(s.body.accessToken), 'x-confirm-password': 'nope' })).status, 403);
    const del = await call('DELETE', '/v1/account', undefined, { ...bearer(s.body.accessToken), 'x-confirm-password': 'correct horse battery' });
    assert.equal(del.status, 200);
    for (const table of ['wa_accounts', 'templates', 'users', 'refresh_tokens']) {
      const n = await db.owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [t]);
      assert.equal(n.rows[0]!.n, 0, `${table} not cleared`);
    }
    const tenant = await db.owner.query<{ status: string; name: string }>('SELECT status, name FROM tenants WHERE id = $1', [t]);
    assert.equal(tenant.rows[0]!.status, 'deleted');
    assert.equal((await call('POST', '/v1/auth/login', { email: 'delete@example.com', password: 'correct horse battery' })).status, 401);
    assert.equal((await call('POST', '/v1/auth/refresh', { refreshToken: s.body.refreshToken })).status, 401);
    // The email can be used again for a new account.
    assert.equal((await signup('delete@example.com')).status, 200);
  });

  test('only the owner may delete the account', async () => {
    const s = await signup('roles@example.com');
    const { signToken } = await import('../src/api/auth.js');
    const editor = signToken({ tenantId: s.body.tenantId, userId: s.body.userId, role: 'editor' }, SECRET);
    const r = await call('DELETE', '/v1/account', undefined, { ...bearer(editor), 'x-confirm-password': 'correct horse battery' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'forbidden_role');
  });
});
