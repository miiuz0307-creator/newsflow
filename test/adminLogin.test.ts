/**
 * Sign-in to the management panel, second step:
 *  - with a device that receives notifications, a 6-digit code is pushed to it
 *  - "זכור אותי" makes that device trusted: password alone for 30 days
 *  - the recovery code (from the server's environment) also works
 *  - wrong codes are limited; guessing passwords alerts the admin's phone
 * Plus the server's hardening (headers, per-address limit) and what search engines see.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { adminModule, verifyAdminDevice } from '../src/api/modules/admin.js';
import { pushModule } from '../src/api/modules/push.js';
import { WindowLimiter } from '../src/api/modules/auth.js';
import { hashPassword } from '../src/auth/password.js';
import { ApiServer } from '../src/api/server.js';
import { MasterKey } from '../src/crypto/keyring.js';
import { PgJobQueue, PgKillSwitchStore } from '../src/db/pgStores.js';
import { AdminPush } from '../src/notify/adminPush.js';
import { vapidKeysFromSecret } from '../src/notify/webPush.js';
import { ConnectionManager } from '../src/wa/connectionManager.js';
import { FakeWaNetwork, fakeTransportFactory } from '../src/wa/fakeNetwork.js';
import { memoryStores } from './helpers.js';
import { decryptPush, fakeDevice } from './pushHelpers.js';
import { createTestDb, pgAvailable, type TestDb } from './pgHelpers.js';

const available = await pgAvailable();
const SECRET = 'customer-token-secret-0123456789abcdef';
const ADMIN_SECRET = 'admin-token-secret-0123456789abcdef-xyz';
const RECOVERY = 'recovery-code-7f3a91-long';
const EMAIL = 'boss@push.co.il', PW = 'Kvish-Arba-Tsafon-2026!';

describe('admin sign-in, second step', { skip: !available && 'local test Postgres not running' }, () => {
  let db: TestDb, api: ApiServer, conns: ConnectionManager, pushSrv: http.Server, pushUrl = '';
  const pushed: { title: string; body: string; tag?: string }[] = [];
  const dev = fakeDevice();
  const call = async (method: string, path: string, body?: unknown, tok?: string) => {
    const r = await fetch(api.url + path, { method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, body: json, text, headers: r.headers };
  };
  const waitPush = async (n: number) => { for (let i = 0; i < 100 && pushed.length < n; i++) await new Promise((r) => setTimeout(r, 20)); };

  before(async () => {
    db = await createTestDb();
    pushSrv = http.createServer((req, res) => { const p: Buffer[] = []; req.on('data', (d) => p.push(d)); req.on('end', () => { pushed.push(JSON.parse(decryptPush(Buffer.concat(p), dev.priv, dev.auth))); res.writeHead(201); res.end(); }); });
    await new Promise<void>((r) => pushSrv.listen(0, '127.0.0.1', r));
    pushUrl = `http://127.0.0.1:${(pushSrv.address() as { port: number }).port}/push/d1`;
    await db.owner.query(`INSERT INTO admins (email, password_hash, totp_secret, role) VALUES ($1, $2, '', 'superadmin')`, [EMAIL, await hashPassword(PW)]);
    const { factory } = memoryStores();
    conns = new ConnectionManager({ transportFactory: fakeTransportFactory(new FakeWaNetwork()), storeFactory: async (t, a) => factory(t, a) });
    api = new ApiServer({
      appPool: db.app, connections: conns, queue: new PgJobQueue(db.worker, db.app), killSwitches: new PgKillSwitchStore(db.worker), tokenSecret: SECRET,
      modules: [
        pushModule(),
        adminModule({ adminPool: db.admin, adminTokenSecret: ADMIN_SECRET, customerTokenSecret: SECRET, masterKeyB64: MasterKey.generateB64(), loginLimiter: new WindowLimiter(1000, 60_000),
          push: new AdminPush(db.admin, vapidKeysFromSecret('v'.repeat(40)), 'mailto:a@b.c', { allowLocalEndpoints: true }),
          manage: { recoveryCode: RECOVERY } }),
      ],
    });
    await api.listen();
  });
  after(async () => { await api?.close(); await conns?.shutdown(); await new Promise<void>((r) => pushSrv?.close(() => r())); await db?.drop(); });

  let deviceToken = '';
  test('no device yet: the recovery code is the second step', async () => {
    const r = await call('POST', '/admin/v1/login', { email: EMAIL, password: PW });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.step, 'code');
    assert.equal(r.body.via, 'recovery');
    assert.equal(r.body.token, undefined, 'no session before the second step');
    assert.equal((await call('POST', '/admin/v1/login/code', { ticket: r.body.ticket, code: '123456' })).body.error.code, 'bad_code');
    const ok = await call('POST', '/admin/v1/login/code', { ticket: r.body.ticket, code: RECOVERY });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.token);
    assert.equal(ok.body.device, undefined, 'not remembered: no trusted device');
    assert.equal((await call('POST', '/admin/v1/login/code', { ticket: r.body.ticket, code: RECOVERY })).status, 401, 'a ticket works once');
    // Register this phone for notifications.
    assert.equal((await call('POST', '/admin/v1/push/subscribe', { subscription: { endpoint: pushUrl, keys: dev.keys } }, ok.body.token)).status, 200);
  });

  test('with a phone: the code arrives as a notification; "זכור אותי" trusts this device', async () => {
    const before = pushed.length;
    const r = await call('POST', '/admin/v1/login', { email: EMAIL, password: PW, remember: true });
    assert.equal(r.body.step, 'code');
    assert.equal(r.body.via, 'push');
    await waitPush(before + 1);
    const msg = pushed.find((p) => p.tag === 'admin-login-code')!;
    const code = /(\d{6})/.exec(msg.title)![1]!;
    const ok = await call('POST', '/admin/v1/login/code', { ticket: r.body.ticket, code });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.token);
    assert.ok(ok.body.device, 'trusted device token');
    deviceToken = ok.body.device;
    assert.ok(verifyAdminDevice(deviceToken, ADMIN_SECRET));
    assert.equal(verifyAdminDevice(ok.body.token, ADMIN_SECRET), null, 'a session token is not a device token');
    await waitPush(before + 2);
    assert.ok(pushed.some((p) => p.tag === 'admin-login' && /ממכשיר חדש/.test(p.body)), 'sign-in alert');
  });

  test('a trusted device signs in with the password alone; a wrong one does not', async () => {
    const r = await call('POST', '/admin/v1/login', { email: EMAIL, password: PW, device: deviceToken });
    assert.equal(r.status, 200);
    assert.ok(r.body.token);
    const forged = await call('POST', '/admin/v1/login', { email: EMAIL, password: PW, device: deviceToken.slice(0, -2) + 'xx' });
    assert.equal(forged.body.step, 'code');
  });

  test('five wrong codes end the attempt', async () => {
    const r = await call('POST', '/admin/v1/login', { email: EMAIL, password: PW });
    for (let i = 0; i < 4; i++) assert.equal((await call('POST', '/admin/v1/login/code', { ticket: r.body.ticket, code: '000000' })).body.error.code, 'bad_code');
    assert.equal((await call('POST', '/admin/v1/login/code', { ticket: r.body.ticket, code: '000000' })).body.error.code, 'expired');
  });

  test('guessing passwords alerts the phone', async () => {
    const before = pushed.length;
    for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/admin/v1/login', { email: EMAIL, password: 'wrong-password-123' })).status, 401);
    await waitPush(before + 1);
    assert.ok(pushed.slice(before).some((p) => p.tag === 'admin-failed'));
    // A good sign-in resets the count.
    assert.equal((await call('POST', '/admin/v1/login', { email: EMAIL, password: PW, device: deviceToken })).status, 200);
  });

  test('security headers on every answer; search engines see only the home page', async () => {
    const home = await call('GET', '/');
    assert.equal(home.status, 200);
    for (const hname of ['strict-transport-security', 'x-frame-options', 'permissions-policy', 'x-content-type-options']) assert.ok(home.headers.get(hname), hname);
    assert.match(home.text, /<link rel="canonical" href="http:\/\/127\.0\.0\.1:\d+\/">/);
    assert.match(home.text, /application\/ld\+json/);
    assert.match(home.text, /וואטסאפ/);
    const ld = JSON.parse(/<script type="application\/ld\+json" nonce="[^"]+">(.+?)<\/script>/.exec(home.text)![1]!);
    assert.equal(ld['@graph'][1]['@type'], 'FAQPage');
    for (const q of ld['@graph'][1].mainEntity) assert.ok(home.text.includes(`<summary>${q.name}</summary>`), 'every structured question is on the page');
    const robots = await call('GET', '/robots.txt');
    assert.match(robots.text, /Disallow: \/v1\//);
    assert.doesNotMatch(robots.text, /admin/, 'the panel path is not advertised');
    assert.match((await call('GET', '/sitemap.xml')).text, /<loc>http:\/\/127\.0\.0\.1:\d+\/<\/loc>/);
    assert.equal((await call('GET', '/app')).headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal((await call('GET', '/admin')).headers.get('x-robots-tag'), 'noindex');
  });
});

describe('per-address limit', () => {
  test('too many requests from one address get 429 until the minute ends', async () => {
    const { factory } = memoryStores();
    const conns = new ConnectionManager({ transportFactory: fakeTransportFactory(new FakeWaNetwork()), storeFactory: async (t, a) => factory(t, a) });
    const api = new ApiServer({ appPool: undefined as never, connections: conns, queue: undefined as never, killSwitches: undefined as never, tokenSecret: SECRET, perIpPerMinute: 5, modules: [pushModule()] });
    await api.listen();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await fetch(api.url + '/robots.txt')).status);
      assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
      const r = await fetch(api.url + '/robots.txt');
      assert.ok(Number(r.headers.get('retry-after')) > 0);
    } finally {
      await api.close();
      await conns.shutdown();
    }
  });
});
