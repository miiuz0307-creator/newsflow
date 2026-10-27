/**
 * Free plan on Telegram: PUSH publishes its own posts in the customer's channels.
 *  - connecting Telegram on the free plan needs the customer's OK (recorded once)
 *  - the posts reach only free customers who agreed, through their own bot, never a
 *    suspended customer or a stopped bot; they can be removed from every channel again
 *  - the admin can stop one customer's Telegram without touching WhatsApp
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { adminModule, signAdminToken } from '../src/api/modules/admin.js';
import { manageModule } from '../src/api/modules/manage.js';
import { ApiServer } from '../src/api/server.js';
import { signToken } from '../src/api/auth.js';
import type { MessageContent } from '../src/core/types.js';
import { MasterKey } from '../src/crypto/keyring.js';
import { PgJobQueue, PgKillSwitchStore, TenantKeys, withTenant } from '../src/db/pgStores.js';
import { FakeTelegramServer } from '../src/telegram/fakeServer.js';
import { TelegramPromo } from '../src/telegram/promo.js';
import { TelegramRuntime } from '../src/telegram/runtime.js';
import { ConnectionManager } from '../src/wa/connectionManager.js';
import { FakeWaNetwork, fakeTransportFactory } from '../src/wa/fakeNetwork.js';
import { memoryStores } from './helpers.js';
import { adminSetTenant, createTestDb, pgAvailable, type TestDb } from './pgHelpers.js';

const available = await pgAvailable();
const SECRET = 'customer-token-secret-0123456789abcdef';
const ADMIN_SECRET = 'admin-token-secret-0123456789abcdef-xyz';
async function until(cond: () => Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms;
  while (!(await cond())) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 30)); }
}

describe('Telegram promos for the free plan', { skip: !available && 'local test Postgres not running' }, () => {
  let db: TestDb, api: ApiServer, conns: ConnectionManager, runtime: TelegramRuntime, keys: TenantKeys, promo: TelegramPromo;
  const tg = new FakeTelegramServer('push_free_bot');
  let freeTok = '', adminTok = '';
  let freeT = '', paidT = '', noOkT = '', suspT = '';
  const fakeBots = new Map<string, { sent: { chatId: string; text: string; id: string }[]; removed: string[] }>();
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(api.url + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };
  /** A tenant with a bot row and one channel the bot may post in (no real bot needed). */
  const tenantWithChannel = async (name: string, plan: string, ok: boolean) => {
    const t = await keys.provision(db.app, name, 'trial', `${name.replace(/\s/g, '')}@x.com`);
    await adminSetTenant(db, t, plan);
    const bot = (await withTenant(db.app, t, (c) => c.query<{ id: string }>(`INSERT INTO tg_bots (tenant_id, username, token_blob) VALUES ($1, $2, 'x') RETURNING id`, [t, `${name}_bot`]))).rows[0]!.id;
    await db.worker.query(`INSERT INTO chats (tenant_id, platform, account_id, chat_id, title, type, can_send, is_admin) VALUES ($1, 'tg', $2, $3, $4, 'channel', true, true)`,
      [t, bot, `-100${Math.floor(Math.random() * 1e9)}`, `ערוץ ${name}`]);
    if (ok) await db.owner.query('UPDATE tenants SET tg_promo_ok_at = now() WHERE id = $1', [t]);
    return { t, bot };
  };

  before(async () => {
    db = await createTestDb();
    await tg.start();
    keys = new TenantKeys(new MasterKey('mk-promo', MasterKey.generateB64()), db.worker);
    runtime = new TelegramRuntime({ workerSql: db.worker, keys, apiOptions: { apiBase: tg.url }, onMessage: () => {}, pollTimeoutSec: 0 });

    // The customer who connects through the app (free plan).
    freeT = await keys.provision(db.app, 'חדשות חינם', 'trial', 'free@x.com');
    await adminSetTenant(db, freeT, 'free');
    const uid = (await withTenant(db.app, freeT, (c) => c.query<{ id: string }>('SELECT id FROM users'))).rows[0]!.id;
    freeTok = signToken({ tenantId: freeT, userId: uid, role: 'owner' }, SECRET);

    const adminId = (await db.owner.query<{ id: string }>(`INSERT INTO admins (email, password_hash, totp_secret, role) VALUES ('boss@push.co.il', 'x', '', 'superadmin') RETURNING id`)).rows[0]!.id;
    adminTok = signAdminToken({ adminId, role: 'superadmin' }, ADMIN_SECRET);

    promo = new TelegramPromo({
      workerSql: db.worker, gapMs: 5,
      // Real bot for the app-connected customer; recording fakes for the others.
      sender: (botId) => runtime.get(botId) ?? (fakeBots.has(botId) ? {
        send: async (chatId: string, c: MessageContent) => { const id = String(Math.random()).slice(2, 8); fakeBots.get(botId)!.sent.push({ chatId, text: c.text ?? '', id }); return { messageId: id, sentAt: new Date() }; },
        remove: async (_chatId: string, id: string) => { fakeBots.get(botId)!.removed.push(id); },
      } : undefined),
    });

    const { factory } = memoryStores();
    conns = new ConnectionManager({ transportFactory: fakeTransportFactory(new FakeWaNetwork()), storeFactory: async (tt, a) => factory(tt, a) });
    api = new ApiServer({
      appPool: db.app, connections: conns, queue: new PgJobQueue(db.worker, db.app), killSwitches: new PgKillSwitchStore(db.worker), tokenSecret: SECRET,
      modules: [
        manageModule({ keys, telegram: runtime }),
        adminModule({ adminPool: db.admin, adminTokenSecret: ADMIN_SECRET, customerTokenSecret: SECRET, masterKeyB64: MasterKey.generateB64(), tgPromo: promo }),
      ],
    });
    await api.listen();
  });
  after(async () => { await api?.close(); await runtime?.shutdown(); await conns?.shutdown(); await tg.stop(); await db?.drop(); });

  test('free plan: connecting Telegram needs the customer\'s OK, recorded once', async () => {
    const no = await call(freeTok, 'POST', '/v1/tg/bots', { token: tg.token });
    assert.equal(no.status, 403);
    assert.equal(no.body.error.code, 'promo_consent');
    assert.equal((await call(freeTok, 'GET', '/v1/tg/bots')).body.length, 0, 'nothing connected');
    const yes = await call(freeTok, 'POST', '/v1/tg/bots', { token: tg.token, promoOk: true });
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    const r = await db.owner.query<{ tg_promo_ok_at: Date | null }>('SELECT tg_promo_ok_at FROM tenants WHERE id = $1', [freeT]);
    assert.ok(r.rows[0]!.tg_promo_ok_at, 'agreement recorded');
    const audit = await db.admin.query(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'tg_promo.accepted'`, [freeT]);
    assert.equal(audit.rowCount, 1);
    // The bot is added to a channel; Telegram tells the bot.
    const ch = tg.createChat('הערוץ של חינם', 'channel');
    tg.addBot(ch, 'administrator', { can_post_messages: true });
    await until(async () => (await db.worker.query(`SELECT 1 FROM chats WHERE tenant_id = $1 AND platform = 'tg' AND can_send`, [freeT])).rowCount > 0);
  });

  test('premium: no agreement needed', async () => {
    const t = await keys.provision(db.app, 'פרימיום', 'trial', 'paid-app@x.com');
    await adminSetTenant(db, t, 'premium');
    const uid = (await withTenant(db.app, t, (c) => c.query<{ id: string }>('SELECT id FROM users'))).rows[0]!.id;
    const tk = signToken({ tenantId: t, userId: uid, role: 'owner' }, SECRET);
    const other = new FakeTelegramServer('push_paid_bot');
    // Only the consent check matters here: the token is rejected later by Telegram, not by the plan.
    const r = await call(tk, 'POST', '/v1/tg/bots', { token: other.token });
    assert.notEqual(r.body.error?.code, 'promo_consent');
  });

  test('a post reaches only free customers who agreed, through their own bot; it can be removed again', async () => {
    const paid = await tenantWithChannel('פרימיום2', 'premium', true);
    const noOk = await tenantWithChannel('בלי אישור', 'free', false);
    const susp = await tenantWithChannel('מושעה', 'free', true);
    const other = await tenantWithChannel('חינם שני', 'free', true);
    paidT = paid.t; noOkT = noOk.t; suspT = susp.t;
    for (const b of [paid, noOk, susp, other]) fakeBots.set(b.bot, { sent: [], removed: [] });
    await adminSetTenant(db, susp.t, null, 'suspended');

    const g = await call(adminTok, 'GET', '/admin/v1/tg-promo');
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.equal(g.body.audience.tenants, 2, 'the app customer and "חינם שני"');
    assert.equal(g.body.audience.channels, 2);
    assert.equal(g.body.audience.awaitingConsent, 1);
    assert.deepEqual(g.body.audience.list.map((x: { name: string }) => x.name).sort(), ['חדשות חינם', 'חינם שני'].sort());

    const s = await call(adminTok, 'POST', '/admin/v1/tg-promo', { body: '*PUSH* — הפצה לכל הקבוצות שלכם' });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.targets, 2);
    await until(async () => (await call(adminTok, 'GET', '/admin/v1/tg-promo')).body.history[0].status === 'done');
    const h = (await call(adminTok, 'GET', '/admin/v1/tg-promo')).body.history[0];
    assert.equal(h.sent, 2);
    assert.equal(h.failed, 0);
    assert.equal(fakeBots.get(other.bot)!.sent.length, 1);
    for (const b of [paid, noOk, susp]) assert.equal(fakeBots.get(b.bot)!.sent.length, 0, 'premium, no agreement, suspended: nothing');
    const ch = (await db.worker.query<{ chat_id: string }>(`SELECT chat_id FROM chats WHERE tenant_id = $1 AND platform = 'tg'`, [freeT])).rows[0]!.chat_id;
    assert.equal(tg.posts(Number(ch)).filter((p) => p.from?.username === 'push_free_bot' || p.text?.includes('PUSH')).length, 1, 'posted through the customer\'s own bot');

    const rm = await call(adminTok, 'POST', `/admin/v1/tg-promo/${h.id}/remove`);
    assert.equal(rm.status, 200, JSON.stringify(rm.body));
    assert.equal(rm.body.removed, 2);
    assert.equal(tg.posts(Number(ch)).filter((p) => p.text?.includes('PUSH')).length, 0, 'gone from the channel');
    assert.equal(fakeBots.get(other.bot)!.removed.length, 1);
    assert.equal((await call(adminTok, 'GET', '/admin/v1/tg-promo')).body.history[0].status, 'retracted');
    assert.equal((await call(adminTok, 'POST', `/admin/v1/tg-promo/${h.id}/remove`)).status, 404, 'already removed');
  });

  test('admin stops one customer\'s Telegram: no posts there, shown in the list; resume', async () => {
    const st = await call(adminTok, 'POST', `/admin/v1/tenants/${freeT}/telegram`, { stopped: true });
    assert.equal(st.status, 200, JSON.stringify(st.body));
    const list = (await call(adminTok, 'GET', '/admin/v1/tenants')).body as { id: string; tg_stopped: boolean; tg_promo_ok: boolean }[];
    assert.equal(list.find((x) => x.id === freeT)!.tg_stopped, true);
    assert.equal(list.find((x) => x.id === freeT)!.tg_promo_ok, true);
    assert.equal(list.find((x) => x.id === noOkT)!.tg_promo_ok, false);
    // The dispatcher's check sees the stop for that bot.
    const bot = (await db.worker.query<{ id: string }>('SELECT id FROM tg_bots WHERE tenant_id = $1', [freeT])).rows[0]!.id;
    const ks = await new PgKillSwitchStore(db.worker).find({ tenantId: freeT, accountId: bot });
    assert.equal(ks?.scope, 'account');
    assert.equal((await call(adminTok, 'GET', '/admin/v1/tg-promo')).body.audience.tenants, 1, 'stopped customer left out');
    const d = (await call(adminTok, 'GET', `/admin/v1/tenants/${freeT}`)).body;
    assert.ok(d.activeStops.some((x: { scope: string; scope_id: string }) => x.scope === 'account' && x.scope_id === bot));
    assert.equal((await call(adminTok, 'POST', `/admin/v1/tenants/${freeT}/telegram`, { stopped: false })).status, 200);
    assert.equal(await new PgKillSwitchStore(db.worker).find({ tenantId: freeT, accountId: bot }), null);
    assert.equal((await call(adminTok, 'GET', '/admin/v1/tg-promo')).body.audience.tenants, 2);
    assert.equal((await call(adminTok, 'POST', `/admin/v1/tenants/${paidT}/telegram`, { stopped: true })).status, 200);
    assert.equal((await call(adminTok, 'POST', `/admin/v1/tenants/${suspT}/telegram`, { stopped: false })).status, 200);
  });

  test('nothing to send: refused without recording a post', async () => {
    await db.owner.query(`UPDATE tenants SET plan_code = 'premium' WHERE plan_code = 'free'`);
    const before = (await call(adminTok, 'GET', '/admin/v1/tg-promo')).body.history.length;
    const r = await call(adminTok, 'POST', '/admin/v1/tg-promo', { body: 'שלום' });
    assert.equal(r.status, 409);
    assert.equal((await call(adminTok, 'GET', '/admin/v1/tg-promo')).body.history.length, before);
  });
});
