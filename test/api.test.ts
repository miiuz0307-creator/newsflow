import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken } from '../src/api/auth.js';
import { ApiServer } from '../src/api/server.js';
import { MasterKey } from '../src/crypto/keyring.js';
import { PgAuthStore, PgJobQueue, PgKillSwitchStore, TenantKeys } from '../src/db/pgStores.js';
import { ConnectionManager } from '../src/wa/connectionManager.js';
import { FakeWaNetwork, fakeTransportFactory } from '../src/wa/fakeNetwork.js';
import { waitFor } from './helpers.js';
import { adminSetTenant, createTestDb, pgAvailable, type TestDb } from './pgHelpers.js';

const SECRET = 'test-secret-that-is-long-enough-1234567890';

describe('tokens', () => {
  const tid = '11111111-1111-4111-8111-111111111111';
  test('sign and verify', () => {
    const t = signToken({ tenantId: tid, userId: 'u1', role: 'owner' }, SECRET);
    assert.equal(verifyToken(t, SECRET)?.tenantId, tid);
  });
  test('rejects tampering, wrong secret, expiry', () => {
    const t = signToken({ tenantId: tid, userId: 'u1', role: 'owner' }, SECRET, 60);
    const [p, s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ tenantId: '22222222-2222-4222-8222-222222222222', userId: 'u1', role: 'owner', exp: 9e9 })).toString('base64url');
    assert.equal(verifyToken(`${forged}.${s}`, SECRET), null);
    assert.equal(verifyToken(`${p}.${s}`, SECRET + 'x'), null);
    assert.equal(verifyToken(t, SECRET, Date.now() + 61_000), null);
    assert.equal(verifyToken('garbage', SECRET), null);
  });
  test('refuses a short secret', () => {
    assert.throws(() => signToken({ tenantId: tid, userId: 'u', role: 'owner' }, 'short'));
  });
});

const available = await pgAvailable();

describe('API', { skip: !available && 'local test Postgres not running' }, () => {
  let db: TestDb;
  let api: ApiServer;
  let conns: ConnectionManager;
  const net = new FakeWaNetwork({ connectDelayMs: 1 });
  let tA: string, tB: string, tokA: string, tokB: string;

  async function call(method: string, path: string, token?: string, body?: unknown) {
    const res = await fetch(api.url + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  before(async () => {
    db = await createTestDb();
    const keys = new TenantKeys(new MasterKey('mk-api', MasterKey.generateB64()), db.worker);
    tA = await keys.provision(db.app, 'A', 'trial', 'a@x.com');
    await adminSetTenant(db, tA, 'premium');
    tB = await keys.provision(db.app, 'B', 'free', 'b@x.com');
    conns = new ConnectionManager({
      transportFactory: fakeTransportFactory(net),
      storeFactory: async (t, a) => new PgAuthStore(db.worker, t, a, await keys.cipher(t)),
    });
    api = new ApiServer({
      appPool: db.app, connections: conns, queue: new PgJobQueue(db.worker, db.app), killSwitches: new PgKillSwitchStore(db.worker),
      tokenSecret: SECRET, devTokens: true,
    });
    await api.listen();
    tokA = (await call('POST', '/v1/dev/token', undefined, { tenantId: tA, userId: 'ua' })).body.token;
    tokB = (await call('POST', '/v1/dev/token', undefined, { tenantId: tB, userId: 'ub' })).body.token;
  });
  after(async () => {
    await api?.close();
    await conns?.shutdown();
    await db?.drop();
  });

  test('requires a valid token', async () => {
    assert.equal((await call('GET', '/v1/stats')).status, 401);
    assert.equal((await call('GET', '/v1/stats', 'bad.token')).status, 401);
    assert.equal((await call('GET', '/v1/health')).status, 200);
  });

  test('linking requires accepting the risk first; then QR flow works and status streams', async () => {
    const acc = (await call('POST', '/v1/wa/accounts', tokA, { label: 'ראשי' })).body.id;
    const refused = await call('POST', `/v1/wa/accounts/${acc}/connect`, tokA, { method: 'qr' });
    assert.equal(refused.status, 412);
    assert.equal(refused.body.error.code, 'risk_not_accepted');
    await call('POST', '/v1/risk/accept', tokA, {});

    // Live status stream (Server-Sent Events)
    const events: any[] = [];
    const ctrl = new AbortController();
    const stream = fetch(`${api.url}/v1/wa/accounts/${acc}/events`, { headers: { authorization: `Bearer ${tokA}` }, signal: ctrl.signal }).then(async (r) => {
      const reader = r.body!.getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        for (const block of buf.split('\n\n').slice(0, -1)) {
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
        buf = buf.split('\n\n').at(-1)!;
      }
    }).catch(() => {});

    const r = await call('POST', `/v1/wa/accounts/${acc}/connect`, tokA, { method: 'qr' });
    assert.equal(r.status, 200);
    await waitFor(() => events.some((e) => e?.qr));
    const qr = events.find((e) => e?.qr).qr;
    net.createGroup('מקור', { members: ['972500000300', '972500000301'] });
    net.createGroup('יעד', { members: ['972500000300'] });
    net.scanQr('972500000300', qr);
    await waitFor(() => events.some((e) => e?.status === 'connected'));
    ctrl.abort();
    await stream;

    const st = await call('GET', `/v1/wa/accounts/${acc}`, tokA);
    assert.equal(st.body.status, 'connected');
    assert.equal(st.body.qr, null);

    const chats = await call('GET', `/v1/wa/accounts/${acc}/chats`, tokA);
    assert.equal(chats.body.length, 2);
    const src = chats.body.find((c: any) => c.title === 'מקור').chatId;
    const tgt = chats.body.find((c: any) => c.title === 'יעד').chatId;

    // Tenant B can't see or touch A's account.
    assert.equal((await call('GET', `/v1/wa/accounts/${acc}`, tokB)).status, 404);
    assert.equal((await call('GET', `/v1/wa/accounts/${acc}/chats`, tokB)).status, 404);
    assert.equal((await call('DELETE', `/v1/wa/accounts/${acc}`, tokB)).status, 404);
    assert.equal((await call('POST', '/v1/stop', tokB, { scope: 'account', id: acc })).status, 404);

    // Route validation catches problems; a valid route saves.
    const bad = await call('POST', '/v1/routes', tokA, { name: 'x', sources: [{ platform: 'wa', accountId: acc, chatId: src }], targets: [{ platform: 'wa', accountId: acc, chatId: src }] });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.error.details.some((p: any) => p.code === 'target_is_source'));
    const good = await call('POST', '/v1/routes', tokA, { name: 'ארצי', sources: [{ platform: 'wa', accountId: acc, chatId: src }], targets: [{ platform: 'wa', accountId: acc, chatId: tgt, title: 'יעד' }] });
    assert.equal(good.status, 200);
    // B cannot build a route on A's account.
    const steal = await call('POST', '/v1/routes', tokB, { name: 'x', sources: [{ platform: 'wa', accountId: acc, chatId: src }], targets: [{ platform: 'wa', accountId: acc, chatId: tgt }] });
    assert.equal(steal.status, 422);
    assert.ok(steal.body.error.details.every((p: any) => p.code === 'foreign_account'));

    // Emergency stop and resume, scoped to the tenant.
    assert.equal((await call('POST', '/v1/stop', tokA, { scope: 'account', id: acc, reason: 'בדיקה' })).status, 200);
    const stops = await call('GET', '/v1/stops', tokA);
    assert.equal(stops.body[0].scope, 'account');
    assert.equal((await call('GET', '/v1/stops', tokB)).body.length, 0);
    assert.equal((await call('POST', '/v1/resume', tokB, { scope: 'account', id: acc })).status, 404);
    assert.equal((await call('POST', '/v1/resume', tokA, { scope: 'account', id: acc })).status, 200);

    // Disconnect and delete wipes the session.
    assert.equal((await call('DELETE', `/v1/wa/accounts/${acc}`, tokA)).status, 200);
    const left = await db.worker.query('SELECT 1 FROM wa_auth WHERE account_id = $1', [acc]);
    assert.equal(left.rowCount, 0);
  });

  test('plan limits: free plan allows one number', async () => {
    assert.equal((await call('POST', '/v1/wa/accounts', tokB, {})).status, 200);
    const second = await call('POST', '/v1/wa/accounts', tokB, {});
    assert.equal(second.status, 403);
    assert.equal(second.body.error.code, 'plan_limit');
  });

  test('pairing code requires a valid phone number', async () => {
    await call('POST', '/v1/risk/accept', tokB, {});
    const acc = (await db.worker.query<{ id: string }>('SELECT id FROM wa_accounts WHERE tenant_id = $1', [tB])).rows[0]!.id;
    const r = await call('POST', `/v1/wa/accounts/${acc}/connect`, tokB, { method: 'pairing_code', phoneNumber: '050-1234567' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'bad_phone');
    const ok = await call('POST', `/v1/wa/accounts/${acc}/connect`, tokB, { method: 'pairing_code', phoneNumber: '972501234567' });
    assert.equal(ok.status, 200);
    await waitFor(() => !!conns.getState(acc)?.pairingCode);
    assert.match((await call('GET', `/v1/wa/accounts/${acc}`, tokB)).body.pairingCode, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  });

  test('template preview reports placeholders and unknowns', async () => {
    const r = await call('POST', '/v1/templates/preview', tokA, { body: '🔴 {תוכן החדשות}\n{קישור WhatsApp}\n{משהו}', vars: { whatsapp_link: 'https://chat.whatsapp.com/X' } });
    assert.ok(r.body.text.startsWith('🔴 דוגמה לתוכן החדשות'));
    assert.deepEqual(r.body.unknown, ['משהו']);
  });

  test('dev token endpoint is off unless enabled; audit log records actions', async () => {
    const off = new ApiServer({ appPool: db.app, connections: conns, queue: new PgJobQueue(db.worker, db.app), killSwitches: new PgKillSwitchStore(db.worker), tokenSecret: SECRET });
    await off.listen();
    const r = await fetch(`${off.url}/v1/dev/token`, { method: 'POST', body: JSON.stringify({ tenantId: tA }), headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 404);
    await off.close();
    const audit = await db.app.transaction(async (c) => {
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tA]);
      return c.query<{ action: string }>('SELECT action FROM audit_log ORDER BY id');
    });
    const actions = audit.rows.map((r) => r.action);
    for (const a of ['risk.accepted', 'wa_account.created', 'wa_account.connect', 'route.saved', 'kill_switch.set', 'kill_switch.cleared', 'wa_account.deleted']) {
      assert.ok(actions.includes(a), `missing audit action ${a}`);
    }
  });
});
