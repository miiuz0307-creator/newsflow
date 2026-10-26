/**
 * Customers' notifications: a device subscribes in the app, gets a test, gets
 * connection alerts, and "what's new"; another customer never sees it.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WindowLimiter, authModule } from '../src/api/modules/auth.js';
import { notifyPushModule } from '../src/api/modules/notifyPush.js';
import { ApiServer } from '../src/api/server.js';
import { MasterKey } from '../src/crypto/keyring.js';
import { PgJobQueue, PgKillSwitchStore, TenantKeys } from '../src/db/pgStores.js';
import { CustomerPush } from '../src/notify/customerPush.js';
import { NotificationService } from '../src/notify/notifications.js';
import { vapidKeysFromSecret } from '../src/notify/webPush.js';
import { RELEASES } from '../src/releases.js';
import { ConnectionManager } from '../src/wa/connectionManager.js';
import { FakeWaNetwork, fakeTransportFactory } from '../src/wa/fakeNetwork.js';
import { memoryStores } from './helpers.js';
import { createTestDb, pgAvailable, type TestDb } from './pgHelpers.js';
import { decryptPush, fakeDevice } from './pushHelpers.js';

const available = await pgAvailable();

describe('customer notifications', { skip: !available && 'local test Postgres not running' }, () => {
  let db: TestDb;
  let api: ApiServer;
  let conns: ConnectionManager;
  let push: CustomerPush;
  let srv: http.Server;
  let endpoint = '';
  const got: string[] = [];
  const dev = fakeDevice();
  const call = async (method: string, path: string, body?: unknown, tok?: string) => {
    const r = await fetch(api.url + path, { method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, body: json };
  };
  const signup = async (email: string, name: string) =>
    (await call('POST', '/v1/auth/signup', { email, password: 'Shalom-Olam-Tov-2026!', businessName: name, acceptTerms: true })).body as { tenantId: string; accessToken: string };

  before(async () => {
    db = await createTestDb();
    srv = http.createServer((req, res) => { const p: Buffer[] = []; req.on('data', (d) => p.push(d)); req.on('end', () => { got.push(decryptPush(Buffer.concat(p), dev.priv, dev.auth)); res.writeHead(201); res.end(); }); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    endpoint = `http://127.0.0.1:${(srv.address() as { port: number }).port}/push/phone`;
    push = new CustomerPush(db.worker, vapidKeysFromSecret('c'.repeat(40)), 'mailto:a@b.c');
    const keys = new TenantKeys(new MasterKey('mk-cp', MasterKey.generateB64()), db.worker);
    const { factory } = memoryStores();
    conns = new ConnectionManager({ transportFactory: fakeTransportFactory(new FakeWaNetwork({ connectDelayMs: 1 })), storeFactory: async (t, a) => factory(t, a) });
    api = new ApiServer({
      appPool: db.app, connections: conns, queue: new PgJobQueue(db.worker, db.app), killSwitches: new PgKillSwitchStore(db.worker), tokenSecret: 'customer-token-secret-0123456789abcdef',
      modules: [authModule({ keys, loginLimiter: new WindowLimiter(1000, 60_000), signupLimiter: new WindowLimiter(1000, 60_000) }),
        notifyPushModule({ push, version: 'v-test', allowLocalEndpoints: true })],
    });
    await api.listen();
  });
  after(async () => { await api?.close(); await conns?.shutdown(); srv?.close(); await db?.drop(); });

  test('version and what\'s new are public', async () => {
    assert.equal((await call('GET', '/v1/version')).body.version, 'v-test');
    assert.equal((await call('GET', '/v1/releases')).body[0].id, RELEASES[0]!.id);
  });

  test('a device subscribes, gets a test, connection alerts and release notes; another customer sees none of it', async () => {
    const a = await signup('a@push.test', 'לקוח א'), b = await signup('b@push.test', 'לקוח ב');
    assert.equal((await call('GET', '/v1/notify/push', undefined, a.accessToken)).body.devices, 0);
    assert.equal((await call('POST', '/v1/notify/push/subscribe', { subscription: { endpoint: 'https://evil.example/x', keys: dev.keys } }, a.accessToken)).status, 400);
    const s = await call('POST', '/v1/notify/push/subscribe', { subscription: { endpoint, keys: dev.keys } }, a.accessToken);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.devices, 1);
    assert.equal((await call('GET', '/v1/notify/push', undefined, b.accessToken)).body.devices, 0, 'B does not see A\'s device');
    assert.equal((await call('POST', '/v1/notify/push/test', undefined, b.accessToken)).status, 502, 'B has no device');

    assert.equal((await call('POST', '/v1/notify/push/test', undefined, a.accessToken)).status, 200);
    assert.equal(JSON.parse(got.at(-1)!).tag, 'test');

    await new NotificationService(db.worker, push).notify({ tenantId: a.tenantId, kind: 'logged_out', title: 'המספר נותק מהטלפון', body: 'יש לחבר מחדש' });
    assert.equal(JSON.parse(got.at(-1)!).title, 'המספר נותק מהטלפון');
    const before = got.length;
    await new NotificationService(db.worker, push).notify({ tenantId: b.tenantId, kind: 'logged_out', title: 'ל-B', body: '' });
    assert.equal(got.length, before, 'nothing reaches A for B\'s alert');

    const r = await push.sendToAll({ title: RELEASES[0]!.title, body: 'מה חדש', url: '/app#whatsnew' });
    assert.equal(r.sent, 1);
    assert.equal(JSON.parse(got.at(-1)!).url, '/app#whatsnew');

    assert.equal((await call('POST', '/v1/notify/push/unsubscribe', { endpoint }, a.accessToken)).body.devices, 0);
  });
});
