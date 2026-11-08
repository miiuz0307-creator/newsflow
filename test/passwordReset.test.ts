/**
 * "Forgot password": a 6-digit code by email (15 minutes, 5 tries), then a new password.
 * The answer never tells whether an email has an account; a reset lifts a lockout and signs
 * every session out.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { authModule, WindowLimiter } from '../src/api/modules/auth.js';
import { ApiServer } from '../src/api/server.js';
import { MasterKey } from '../src/crypto/keyring.js';
import { PgJobQueue, PgKillSwitchStore, TenantKeys } from '../src/db/pgStores.js';
import { ConnectionManager } from '../src/wa/connectionManager.js';
import { FakeWaNetwork, fakeTransportFactory } from '../src/wa/fakeNetwork.js';
import { mailerFromEnv, type Mail } from '../src/notify/mailer.js';
import { memoryStores } from './helpers.js';
import { createTestDb, pgAvailable, type TestDb } from './pgHelpers.js';

const available = await pgAvailable();
const SECRET = 'customer-token-secret-0123456789abcdef';

describe('forgot password', { skip: !available && 'local test Postgres not running' }, () => {
  let db: TestDb, api: ApiServer, conns: ConnectionManager;
  const mails: Mail[] = [];
  const call = async (method: string, path: string, body?: unknown, tok?: string) => {
    const r = await fetch(api.url + path, { method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  const codeFrom = () => /(\d{6})/.exec(mails.at(-1)!.subject)![1]!;

  before(async () => {
    db = await createTestDb();
    const keys = new TenantKeys(new MasterKey('mk-reset', MasterKey.generateB64()), db.worker);
    const { factory } = memoryStores();
    conns = new ConnectionManager({ transportFactory: fakeTransportFactory(new FakeWaNetwork()), storeFactory: async (t, a) => factory(t, a) });
    api = new ApiServer({
      appPool: db.app, connections: conns, queue: new PgJobQueue(db.worker, db.app), killSwitches: new PgKillSwitchStore(db.worker), tokenSecret: SECRET,
      modules: [authModule({ keys, mailer: async (m) => { mails.push(m); }, resetLimiter: new WindowLimiter(100, 60_000), loginLimiter: new WindowLimiter(100, 60_000) })],
    });
    await api.listen();
    const s = await call('POST', '/v1/auth/signup', { email: 'owner@reset.test', password: 'old password 123', businessName: 'עדכונים', acceptTerms: true });
    assert.equal(s.status, 200, JSON.stringify(s.body));
  });
  after(async () => { await api?.close(); await conns?.shutdown(); await db?.drop(); });

  test('unknown email: same answer, nothing sent', async () => {
    const r = await call('POST', '/v1/auth/forgot', { email: 'nobody@reset.test' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { sent: true });
    assert.equal(mails.length, 0);
  });

  test('code by email, wrong code counted, right code sets the password, lifts a lockout and signs sessions out', async () => {
    const login0 = await call('POST', '/v1/auth/login', { email: 'owner@reset.test', password: 'old password 123' });
    assert.equal(login0.status, 200);
    await db.owner.query(`UPDATE users SET failed_logins = 9, locked_until = now() + interval '1 hour' WHERE email = 'owner@reset.test'`);

    assert.equal((await call('POST', '/v1/auth/forgot', { email: 'Owner@Reset.test' })).status, 200);
    assert.equal(mails.length, 1);
    assert.equal(mails[0]!.to, 'owner@reset.test');
    const code = codeFrom();
    const stored = await db.owner.query<{ code_hash: string }>('SELECT code_hash FROM password_resets');
    assert.ok(!stored.rows[0]!.code_hash.includes(code), 'only a hash is stored');

    const wrong = await call('POST', '/v1/auth/reset', { email: 'owner@reset.test', code: code === '000000' ? '111111' : '000000', password: 'brand new pass 456' });
    assert.equal(wrong.body.error.code, 'bad_code');
    const ok = await call('POST', '/v1/auth/reset', { email: 'owner@reset.test', code, password: 'brand new pass 456' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await call('POST', '/v1/auth/reset', { email: 'owner@reset.test', code, password: 'another pass 789' })).body.error.code, 'expired', 'a code works once');

    assert.equal((await call('POST', '/v1/auth/login', { email: 'owner@reset.test', password: 'old password 123' })).status, 401);
    assert.equal((await call('POST', '/v1/auth/login', { email: 'owner@reset.test', password: 'brand new pass 456' })).status, 200, 'the lockout is lifted');
    assert.equal((await call('POST', '/v1/auth/refresh', { refreshToken: login0.body.refreshToken })).status, 401, 'old sessions are signed out');
  });

  test('five wrong codes end the code', async () => {
    await call('POST', '/v1/auth/forgot', { email: 'owner@reset.test' });
    const code = codeFrom();
    const bad = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/v1/auth/reset', { email: 'owner@reset.test', code: bad, password: 'brand new pass 999' })).body.error.code, 'bad_code');
    assert.equal((await call('POST', '/v1/auth/reset', { email: 'owner@reset.test', code, password: 'brand new pass 999' })).body.error.code, 'expired');
  });

  test('without an email service the app says so', () => {
    assert.equal(mailerFromEnv({} as NodeJS.ProcessEnv), undefined);
    assert.equal(mailerFromEnv({ BREVO_API_KEY: 'k' } as NodeJS.ProcessEnv), undefined, 'needs MAIL_FROM too');
    assert.ok(mailerFromEnv({ BREVO_API_KEY: 'k', MAIL_FROM: 'Groupush <a@b.co>' } as NodeJS.ProcessEnv));
  });
});
