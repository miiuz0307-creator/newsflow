/**
 * Phase 2 modules: Telegram management, routes/templates CRUD, support,
 * notifications and the Super Admin API.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken } from '../src/api/auth.js';
import { adminModule, encryptTotpSecret, signAdminToken, verifyAdminToken } from '../src/api/modules/admin.js';
import { WindowLimiter, authModule } from '../src/api/modules/auth.js';
import { manageModule } from '../src/api/modules/manage.js';
import { supportModule } from '../src/api/modules/support.js';
import { ApiServer } from '../src/api/server.js';
import { hashPassword } from '../src/auth/password.js';
import { base32Decode, base32Encode, generateTotpSecret, totpCode, verifyTotp } from '../src/auth/totp.js';
import { MasterKey } from '../src/crypto/keyring.js';
import { PgAuthStore, PgJobQueue, PgKillSwitchStore, TenantKeys, withTenant } from '../src/db/pgStores.js';
import { NotificationService, noticeForSafety } from '../src/notify/notifications.js';
import { FakeTelegramServer } from '../src/telegram/fakeServer.js';
import { TelegramRuntime } from '../src/telegram/runtime.js';
import { ConnectionManager } from '../src/wa/connectionManager.js';
import { FakeWaNetwork, fakeTransportFactory } from '../src/wa/fakeNetwork.js';
import { adminSetTenant, createTestDb, pgAvailable, type TestDb } from './pgHelpers.js';

describe('TOTP (RFC 6238)', () => {
  test('matches the RFC test vector', () => {
    // RFC 6238 SHA-1 secret "12345678901234567890", T=59 → 94287082 (8 digits) → last 6 = 287082
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    assert.equal(totpCode(secret, 59_000), '287082');
    assert.equal(totpCode(secret, 1111111109_000), '081804');
  });
  test('base32 round trip, drift window, bad input', () => {
    const s = generateTotpSecret();
    assert.equal(base32Encode(base32Decode(s)), s);
    const now = Date.now();
    assert.equal(verifyTotp(s, totpCode(s, now - 30_000), now), true);
    assert.equal(verifyTotp(s, totpCode(s, now - 120_000), now), false);
    assert.equal(verifyTotp(s, 'abc', now), false);
  });
  test('admin tokens are separate from customer tokens', () => {
    const secret = 'admin-secret-0123456789abcdefghijklmnop';
    const t = signAdminToken({ adminId: 'a1', role: 'support' }, secret);
    assert.equal(verifyAdminToken(t, secret)?.role, 'support');
    assert.equal(verifyAdminToken(t, secret + 'x'), null);
    const customer = signToken({ tenantId: '11111111-1111-4111-8111-111111111111', userId: 'u', role: 'owner' }, secret);
    assert.equal(verifyAdminToken(customer, secret), null, 'a customer token is not an admin token');
  });
});

const available = await pgAvailable();
const SECRET = 'phase2-customer-secret-0123456789abcdef';
const ADMIN_SECRET = 'phase2-admin-secret-0123456789abcdefgh';
const MASTER = MasterKey.generateB64();

describe('phase 2 API', { skip: !available && 'local test Postgres not running' }, () => {
  let db: TestDb;
  let api: ApiServer;
  let conns: ConnectionManager;
  let runtime: TelegramRuntime;
  const tg = new FakeTelegramServer('phase2_bot');
  let tA: string, tB: string, tokA: string, tokB: string;
  let routesChanged = 0;
  let adminToken = '';
  let supportToken = '';
  let adminSecretTotp = '';

  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const r = await fetch(api.url + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };

  before(async () => {
    db = await createTestDb();
    await tg.start();
    const keys = new TenantKeys(new MasterKey('mk-p2', MasterKey.generateB64()), db.worker);
    tA = await keys.provision(db.app, 'A', 'trial', 'a@x.com');
    await adminSetTenant(db, tA, 'premium');
    tB = await keys.provision(db.app, 'B', 'free', 'b@x.com');
    const uid = async (t: string) => (await withTenant(db.app, t, (c) => c.query<{ id: string }>('SELECT id FROM users'))).rows[0]!.id;
    tokA = signToken({ tenantId: tA, userId: await uid(tA), role: 'owner' }, SECRET);
    tokB = signToken({ tenantId: tB, userId: await uid(tB), role: 'owner' }, SECRET);
    conns = new ConnectionManager({ transportFactory: fakeTransportFactory(new FakeWaNetwork()), storeFactory: async (t, a) => new PgAuthStore(db.worker, t, a, await keys.cipher(t)) });
    runtime = new TelegramRuntime({ workerSql: db.worker, keys, apiOptions: { apiBase: tg.url }, onMessage: () => {}, pollTimeoutSec: 0 });
    api = new ApiServer({
      appPool: db.app, connections: conns, queue: new PgJobQueue(db.worker, db.app), killSwitches: new PgKillSwitchStore(db.worker), tokenSecret: SECRET,
      onRoutesChanged: () => routesChanged++,
      modules: [
        manageModule({ keys, telegram: runtime, onRoutesChanged: () => routesChanged++ }),
        supportModule(),
        authModule({ keys, telegram: runtime, loginLimiter: new WindowLimiter(1000, 60_000), signupLimiter: new WindowLimiter(1000, 60_000) }),
        adminModule({ adminPool: db.admin, adminTokenSecret: ADMIN_SECRET, customerTokenSecret: SECRET, masterKeyB64: MASTER, loginLimiter: new WindowLimiter(1000, 60_000) }),
      ],
    });
    await api.listen();
    adminSecretTotp = generateTotpSecret();
    const pw = await hashPassword('admin password 123');
    await db.owner.query(`INSERT INTO admins (email, password_hash, totp_secret, role) VALUES ('boss@newsflow.test', $1, $2, 'superadmin'), ('help@newsflow.test', $1, $3, 'support')`,
      [pw, encryptTotpSecret(MASTER, 'boss@newsflow.test', adminSecretTotp), encryptTotpSecret(MASTER, 'help@newsflow.test', adminSecretTotp)]);
  });
  after(async () => {
    await api?.close();
    await runtime?.shutdown();
    await conns?.shutdown();
    await tg.stop();
    await db?.drop();
  });

  describe('Telegram management', () => {
    test('connect a bot: token validated, stored encrypted, bot starts', async () => {
      assert.equal((await call('POST', '/v1/tg/bots', { token: 'nope' }, tokA)).body.error.code, 'bad_token');
      const r = await call('POST', '/v1/tg/bots', { token: tg.token }, tokA);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.username, 'phase2_bot');
      const row = await db.worker.query<{ token_blob: string }>('SELECT token_blob FROM tg_bots WHERE id = $1', [r.body.id]);
      assert.ok(!row.rows[0]!.token_blob.includes(tg.token.split(':')[1]!), 'token stored in plaintext');
      const list = await call('GET', '/v1/tg/bots', undefined, tokA);
      assert.equal(list.body[0].running, true);
      assert.equal((await call('POST', '/v1/tg/bots', { token: tg.token }, tokB)).status, 409, 'the same bot cannot join another account');
    });

    test('chats appear when the bot is added; channels can be added by id; B cannot see them', async () => {
      const bots = await call('GET', '/v1/tg/bots', undefined, tokA);
      const botId = bots.body[0].id;
      const group = tg.createChat('קבוצת טלגרם');
      tg.addBot(group, 'member');
      await runtime.get(botId)!.pollOnce(0);
      // Chats are saved in the background after the update is handled.
      let chats: any[] = [];
      for (let i = 0; i < 50 && !chats.length; i++) {
        chats = (await call('GET', `/v1/tg/bots/${botId}/chats`, undefined, tokA)).body;
        if (!chats.length) await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(chats.length, 1);
      const chan = tg.createChat('ערוץ', 'channel');
      // Not admin yet → refused with a helpful message
      assert.equal((await call('POST', `/v1/tg/bots/${botId}/chats`, { chatId: String(chan) }, tokA)).body.error.code, 'chat_unreachable');
      tg.addBot(chan, 'administrator', { can_post_messages: true });
      const added = await call('POST', `/v1/tg/bots/${botId}/chats`, { chatId: String(chan) }, tokA);
      assert.equal(added.body.canSend, true);
      assert.equal((await call('GET', `/v1/tg/bots/${botId}/chats`, undefined, tokB)).status, 404);
    });

    test('plan limit for bots', async () => {
      const second = new FakeTelegramServer('second_bot');
      await second.start();
      // Tenant B is on the free plan (1 bot) and already has one.
      await withTenant(db.app, tB, (c) => c.query(`INSERT INTO tg_bots (tenant_id, username, token_blob) VALUES ($1, 'x', 'x')`, [tB]));
      const r = await call('POST', '/v1/tg/bots', { token: second.token }, tokB);
      assert.equal(r.body.error.code, 'plan_limit');
      await second.stop();
    });

    test('deleting a bot stops it and disables its routes', async () => {
      const bots = await call('GET', '/v1/tg/bots', undefined, tokA);
      const botId = bots.body[0].id;
      const before = routesChanged;
      assert.equal((await call('DELETE', `/v1/tg/bots/${botId}`, undefined, tokA)).status, 200);
      assert.equal(runtime.get(botId), undefined);
      assert.ok(routesChanged > before);
      const row = await db.worker.query<{ status: string; token_blob: string }>('SELECT status, token_blob FROM tg_bots WHERE id = $1', [botId]);
      assert.equal(row.rows[0]!.status, 'deleted');
      assert.equal(row.rows[0]!.token_blob, 'deleted');
    });
  });

  describe('account deletion', () => {
    test('deleting the account stops the tenant\'s Telegram bots too', async () => {
      const s = await call('POST', '/v1/auth/signup', { email: 'gone@example.com', password: 'correct horse battery', businessName: 'זמני', acceptTerms: true });
      const id = (await withTenant(db.app, s.body.tenantId, (c) => c.query<{ id: string }>(`INSERT INTO tg_bots (tenant_id, username, token_blob) VALUES ($1, 'b', 'x') RETURNING id`, [s.body.tenantId]))).rows[0]!.id;
      await runtime.start(s.body.tenantId, id, tg.token);
      assert.ok(runtime.get(id), 'bot running before deletion');
      const del = await call('POST', '/v1/account/delete', { password: 'correct horse battery' }, s.body.accessToken);
      assert.equal(del.status, 200);
      assert.equal(runtime.get(id), undefined, 'bot must be stopped');
    });
  });

  describe('routes and templates', () => {
    test('list, read, delete routes; tenant isolation', async () => {
      const acc = (await withTenant(db.app, tA, (c) => c.query<{ id: string }>(`INSERT INTO wa_accounts (tenant_id) VALUES ($1) RETURNING id`, [tA]))).rows[0]!.id;
      await withTenant(db.app, tA, (c) => c.query(`INSERT INTO chats (tenant_id, platform, account_id, chat_id, title, can_send) VALUES ($1,'wa',$2,'s@g.us','מקור',true), ($1,'wa',$2,'t@g.us','יעד',true)`, [tA, acc]));
      const before = routesChanged;
      const created = await call('POST', '/v1/routes', { name: 'ארצי', sources: [{ platform: 'wa', accountId: acc, chatId: 's@g.us' }], targets: [{ platform: 'wa', accountId: acc, chatId: 't@g.us', title: 'יעד' }] }, tokA);
      assert.equal(created.status, 200);
      assert.equal(routesChanged, before + 1, 'route cache invalidated');
      const list = await call('GET', '/v1/routes', undefined, tokA);
      assert.equal(list.body.length, 1);
      assert.equal(list.body[0].targets[0].title, 'יעד');
      assert.equal((await call('GET', `/v1/routes/${created.body.id}`, undefined, tokB)).status, 404);
      assert.equal((await call('DELETE', `/v1/routes/${created.body.id}`, undefined, tokB)).status, 404);
      assert.equal((await call('DELETE', `/v1/routes/${created.body.id}`, undefined, tokA)).status, 200);
      assert.equal((await call('GET', '/v1/routes', undefined, tokA)).body.length, 0);
    });

    test('templates CRUD', async () => {
      const t = await call('POST', '/v1/templates', { name: 'בסיס', body: '🔴 {תוכן החדשות}' }, tokA);
      await call('PUT', `/v1/templates/${t.body.id}`, { body: '🟢 {content}' }, tokA);
      const list = await call('GET', '/v1/templates', undefined, tokA);
      assert.equal(list.body[0].body, '🟢 {content}');
      assert.equal((await call('PUT', `/v1/templates/${t.body.id}`, { body: 'x' }, tokB)).status, 404);
      assert.equal((await call('DELETE', `/v1/templates/${t.body.id}`, undefined, tokA)).status, 200);
    });
  });

  describe('support and notifications', () => {
    test('customer opens a ticket; staff replies; customer is notified; staff identity hidden', async () => {
      const t = await call('POST', '/v1/tickets', { subject: 'החיבור נופל', category: 'connection', body: 'המספר מתנתק כל שעה' }, tokA);
      assert.equal(t.status, 200);
      assert.equal((await call('GET', `/v1/tickets/${t.body.id}`, undefined, tokB)).status, 404);
      const login = await call('POST', '/admin/v1/login', { email: 'help@newsflow.test', password: 'admin password 123', code: totpCode(adminSecretTotp) });
      supportToken = login.body.token;
      const queue = await call('GET', '/admin/v1/tickets', undefined, supportToken);
      assert.ok(queue.body.some((x: any) => x.id === t.body.id));
      await call('POST', `/admin/v1/tickets/${t.body.id}/reply`, { body: 'בדקנו, נא לחבר מחדש' }, supportToken);
      const view = await call('GET', `/v1/tickets/${t.body.id}`, undefined, tokA);
      assert.equal(view.body.status, 'waiting_customer');
      assert.deepEqual(view.body.messages.map((m: any) => m.from), ['me', 'support']);
      const notes = await call('GET', '/v1/notifications?unread=1', undefined, tokA);
      assert.ok(notes.body.some((n: any) => n.kind === 'ticket_reply'));
      await call('POST', '/v1/notifications/read-all', {}, tokA);
      assert.equal((await call('GET', '/v1/notifications?unread=1', undefined, tokA)).body.length, 0);
      assert.equal((await call('GET', '/v1/notifications', undefined, tokB)).body.length, 0);
    });

    test('safety events become Hebrew notifications', async () => {
      const svc = new NotificationService(db.worker);
      await svc.notify(noticeForSafety({ tenantId: tA, accountId: 'x', kind: 'account_blocked', detail: {}, at: new Date(), stoppedAccount: true }));
      const notes = await call('GET', '/v1/notifications', undefined, tokA);
      assert.equal(notes.body[0].title, 'המספר נחסם על ידי WhatsApp');
    });
  });

  describe('Super Admin', () => {
    test('login needs password AND a valid two-factor code', async () => {
      assert.equal((await call('POST', '/admin/v1/login', { email: 'boss@newsflow.test', password: 'admin password 123', code: '000000' })).status, 401);
      assert.equal((await call('POST', '/admin/v1/login', { email: 'boss@newsflow.test', password: 'wrong', code: totpCode(adminSecretTotp) })).status, 401);
      const ok = await call('POST', '/admin/v1/login', { email: 'boss@newsflow.test', password: 'admin password 123', code: totpCode(adminSecretTotp) });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.role, 'superadmin');
      adminToken = ok.body.token;
    });

    test('a two-factor code works only once; secrets are stored encrypted', async () => {
      const code = totpCode(adminSecretTotp);
      const replay = await call('POST', '/admin/v1/login', { email: 'boss@newsflow.test', password: 'admin password 123', code });
      assert.equal(replay.status, 401, 'the code used by the previous login must not work again');
      const raw = await db.owner.query<{ totp_secret: string }>(`SELECT totp_secret FROM admins WHERE email = 'boss@newsflow.test'`);
      assert.notEqual(raw.rows[0]!.totp_secret, adminSecretTotp);
    });

    test('a deactivated admin token stops working at once', async () => {
      const r = await db.owner.query<{ id: string }>(`SELECT id FROM admins WHERE email = 'help@newsflow.test'`);
      const tmp = signAdminToken({ adminId: r.rows[0]!.id, role: 'support' }, ADMIN_SECRET);
      assert.equal((await call('GET', '/admin/v1/dashboard', undefined, tmp)).status, 200);
      await db.owner.query(`UPDATE admins SET active = false WHERE email = 'help@newsflow.test'`);
      assert.equal((await call('GET', '/admin/v1/dashboard', undefined, tmp)).status, 401);
      await db.owner.query(`UPDATE admins SET active = true WHERE email = 'help@newsflow.test'`);
      // A token claiming superadmin for a support admin is refused for superadmin actions.
      const forged = signAdminToken({ adminId: r.rows[0]!.id, role: 'superadmin' }, ADMIN_SECRET);
      assert.equal((await call('POST', '/admin/v1/broadcast', { title: 'x', body: 'y' }, forged)).status, 403);
    });

    test('a customer cannot overwrite or lift an admin stop', async () => {
      const acc = (await withTenant(db.app, tA, (c) => c.query<{ id: string }>(`SELECT id FROM wa_accounts LIMIT 1`))).rows[0]!.id;
      await call('POST', '/admin/v1/stop', { scope: 'account', id: acc, tenantId: tA, reason: 'review' }, adminToken);
      await call('POST', '/v1/stop', { scope: 'account', id: acc }, tokA);
      const sw = await new PgKillSwitchStore(db.worker).find({ tenantId: tA, accountId: acc });
      assert.ok(sw?.setBy.startsWith('admin:'), 'admin stop must not be replaced by the customer');
      assert.equal((await call('POST', '/v1/resume', { scope: 'account', id: acc }, tokA)).status, 403);
      await call('POST', '/admin/v1/resume', { scope: 'account', id: acc }, adminToken);
    });

    test('customer tokens cannot reach admin routes, admin tokens cannot reach customer routes', async () => {
      assert.equal((await call('GET', '/admin/v1/dashboard', undefined, tokA)).status, 401);
      assert.equal((await call('GET', '/v1/routes', undefined, adminToken)).status, 401);
    });

    test('dashboard shows counts and revenue estimate', async () => {
      const d = await call('GET', '/admin/v1/dashboard', undefined, adminToken);
      assert.equal(d.status, 200);
      assert.equal(d.body.tenants.active, 2);
      assert.equal(d.body.activeByPlan.premium, 1);
      assert.equal(d.body.monthlyRevenueEstimateIls, 250);
    });

    test('search tenants, view details, suspend and reactivate (superadmin only)', async () => {
      const found = await call('GET', '/admin/v1/tenants?q=a@x', undefined, adminToken);
      assert.equal(found.body.length, 1);
      assert.equal(found.body[0].owner_email, 'a@x.com');
      const detail = await call('GET', `/admin/v1/tenants/${tA}`, undefined, adminToken);
      assert.equal(detail.body.tenant.plan_code, 'premium');
      assert.equal((await call('POST', `/admin/v1/tenants/${tB}`, { status: 'suspended' }, supportToken)).status, 403, 'support role cannot suspend');
      assert.equal((await call('POST', `/admin/v1/tenants/${tB}`, { status: 'suspended' }, adminToken)).status, 200);
      const ks = await new PgKillSwitchStore(db.worker).find({ tenantId: tB, accountId: 'any' });
      assert.equal(ks?.setBy, 'admin:status', 'suspension stops sending');
      await call('POST', `/admin/v1/tenants/${tB}`, { status: 'active' }, adminToken);
      assert.equal((await call('POST', `/admin/v1/tenants/${tB}`, { plan: 'nope' }, adminToken)).status, 400);
    });

    test('global stop and resume', async () => {
      await call('POST', '/admin/v1/stop', { scope: 'global', reason: 'WhatsApp protocol change' }, adminToken);
      const ks = new PgKillSwitchStore(db.worker);
      assert.equal((await ks.find({ tenantId: tA, accountId: 'x' }))?.scope, 'global');
      await call('POST', '/admin/v1/resume', { scope: 'global' }, adminToken);
      assert.equal(await ks.find({ tenantId: tA, accountId: 'x' }), null);
    });

    test('prices and limits change without code', async () => {
      assert.equal((await call('PUT', '/admin/v1/plans/premium', { priceAgorot: -1 }, adminToken)).status, 400);
      assert.equal((await call('PUT', '/admin/v1/plans/premium', { priceAgorot: 22000 }, supportToken)).status, 403);
      assert.equal((await call('PUT', '/admin/v1/plans/premium', { priceAgorot: 22000, limits: { waAccounts: 1, targets: 40, dailySends: 2000, tgBots: 2 } }, adminToken)).status, 200);
      const plans = await call('GET', '/admin/v1/plans', undefined, adminToken);
      const p = plans.body.find((x: any) => x.code === 'premium');
      assert.equal(p.price_agorot, 22000);
      assert.equal(p.limits.targets, 40);
    });

    test('broadcast and audit trail', async () => {
      const b = await call('POST', '/admin/v1/broadcast', { title: 'עדכון מערכת', body: 'תחזוקה הלילה' }, adminToken);
      assert.equal(b.body.sent, 2);
      const audit = await call('GET', '/admin/v1/audit', undefined, adminToken);
      const actions = audit.body.map((x: any) => x.action);
      for (const a of ['tenant.admin_update', 'kill_switch.set', 'kill_switch.cleared', 'plan.updated', 'broadcast']) assert.ok(actions.includes(a), a);
    });

    test('the admin database role cannot read sessions, tokens or password hashes', async () => {
      for (const q of ['SELECT * FROM wa_auth', 'SELECT token_blob FROM tg_bots', 'SELECT password_hash FROM users', 'SELECT wrapped_dek FROM tenants']) {
        await assert.rejects(db.admin.query(q), (e: any) => e.code === '42501', q);
      }
    });
  });
});
