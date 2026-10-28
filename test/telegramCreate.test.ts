/**
 * "Create a Telegram bot in one tap" (Telegram managed bots): the app gives the customer a
 * link with a ready bot (name = their business); they confirm in Telegram; PUSH's manager bot
 * gets the token and the bot is connected to the right customer, like a bot added by token.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { manageModule } from '../src/api/modules/manage.js';
import { ApiServer } from '../src/api/server.js';
import { signToken } from '../src/api/auth.js';
import { MasterKey } from '../src/crypto/keyring.js';
import { PgJobQueue, PgKillSwitchStore, TenantKeys, withTenant } from '../src/db/pgStores.js';
import { FakeTelegramServer } from '../src/telegram/fakeServer.js';
import { addToChannelLink, suggestBotUsername, TelegramBotManager } from '../src/telegram/manager.js';
import { TelegramRuntime } from '../src/telegram/runtime.js';
import { ConnectionManager } from '../src/wa/connectionManager.js';
import { FakeWaNetwork, fakeTransportFactory } from '../src/wa/fakeNetwork.js';
import { memoryStores } from './helpers.js';
import { adminSetTenant, createTestDb, pgAvailable, type TestDb } from './pgHelpers.js';

const available = await pgAvailable();
const SECRET = 'customer-token-secret-0123456789abcdef';

describe('bot usernames and links', () => {
  test('a username Telegram accepts, from any business name', () => {
    for (const n of ['עדכונים בזמן אמת', 'Real Time News!', '', '123 חדשות', 'A'.repeat(80)]) {
      const u = suggestBotUsername(n);
      assert.match(u, /^[a-z][a-z0-9_]{3,28}bot$/, `${n} → ${u}`);
      assert.ok(u.length <= 32 && u.endsWith('_bot'));
    }
    assert.match(suggestBotUsername('Real Time News'), /^real_time_news_[a-f0-9]{5}_bot$/);
    assert.equal(addToChannelLink('x_bot'), 'https://t.me/x_bot?startchannel&admin=post_messages+edit_messages+delete_messages');
  });
});

describe('create a Telegram bot in one tap', { skip: !available && 'local test Postgres not running' }, () => {
  let db: TestDb, api: ApiServer, conns: ConnectionManager, runtime: TelegramRuntime, mgr: TelegramBotManager, tok = '', tenant = '';
  const manager = new FakeTelegramServer('push_manager_bot');
  const child = new FakeTelegramServer('real_time_news_bot');
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(api.url + path, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };

  before(async () => {
    db = await createTestDb();
    await manager.start();
    await child.start();
    const keys = new TenantKeys(new MasterKey('mk-mgr', MasterKey.generateB64()), db.worker);
    tenant = await keys.provision(db.app, 'עדכונים בזמן אמת', 'trial', 'live@x.com');
    await adminSetTenant(db, tenant, 'free');
    const uid = (await withTenant(db.app, tenant, (c) => c.query<{ id: string }>('SELECT id FROM users'))).rows[0]!.id;
    tok = signToken({ tenantId: tenant, userId: uid, role: 'owner' }, SECRET);
    runtime = new TelegramRuntime({ workerSql: db.worker, keys, apiOptions: { apiBase: child.url }, onMessage: () => {}, pollTimeoutSec: 0 });
    mgr = new TelegramBotManager({ token: manager.token, apiOptions: { apiBase: manager.url }, workerSql: db.worker, pollTimeoutSec: 0 });
    await mgr.init();
    const { factory } = memoryStores();
    conns = new ConnectionManager({ transportFactory: fakeTransportFactory(new FakeWaNetwork()), storeFactory: async (t, a) => factory(t, a) });
    api = new ApiServer({
      appPool: db.app, connections: conns, queue: new PgJobQueue(db.worker, db.app), killSwitches: new PgKillSwitchStore(db.worker), tokenSecret: SECRET,
      modules: [manageModule({ keys, telegram: runtime, botManager: mgr })],
    });
    await api.listen();
  });
  after(async () => { await api?.close(); await runtime?.shutdown(); await conns?.shutdown(); await manager.stop(); await child.stop(); await db?.drop(); });

  test('the link opens a ready bot with the business name; free plan asks for the OK first', async () => {
    const g = await call('GET', '/v1/tg/create');
    assert.deepEqual(g.body, { available: true, request: null });
    const no = await call('POST', '/v1/tg/create', { name: 'עדכונים בזמן אמת' });
    assert.equal(no.status, 403);
    assert.equal(no.body.error.code, 'promo_consent');
    const r = await call('POST', '/v1/tg/create', { name: '  עדכונים   בזמן אמת ', promoOk: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.name, 'עדכונים בזמן אמת');
    assert.match(r.body.username, /^push_[a-z0-9]+_bot$/);
    assert.equal(r.body.link, `https://t.me/newbot/push_manager_bot/${r.body.username}?name=${encodeURIComponent('עדכונים בזמן אמת')}`);
    assert.ok(r.body.qrRows.length > 20, 'a QR for computers');
    assert.equal(r.body.connected, false);
    assert.equal((await call('GET', '/v1/tg/create')).body.request.username, r.body.username);
  });

  test('the customer confirms in Telegram: the bot is connected to them; other bots are ignored', async () => {
    // (The fake child server answers for one username; the request is pointed at it.)
    await db.worker.query('UPDATE tg_bot_requests SET username = $2 WHERE tenant_id = $1', [tenant, child.botUsername]);
    manager.createManagedBot({ id: 555, first_name: 'Someone' }, { id: 999001, username: 'someone_else_bot', first_name: 'X' }, '999001:' + 'B'.repeat(35));
    manager.createManagedBot({ id: 777, first_name: 'Owner' }, { id: Number(child.botId), username: child.botUsername, first_name: 'עדכונים בזמן אמת' }, child.token);
    assert.equal(await mgr.pollOnce(0), 2);
    const bots = await call('GET', '/v1/tg/bots');
    assert.equal(bots.body.length, 1, JSON.stringify(bots.body));
    assert.equal(bots.body[0].username, child.botUsername);
    assert.equal(bots.body[0].running, true);
    assert.equal((await call('GET', '/v1/tg/create')).body.request.connected, true);
    assert.equal(await mgr.pollOnce(0), 0, 'updates are read once');
    // Added to a channel from the link: it shows up as a target.
    const ch = child.createChat('עדכונים בזמן אמת', 'channel');
    child.addBot(ch, 'administrator', { can_post_messages: true });
    const id = bots.body[0].id;
    for (let i = 0; i < 100; i++) {
      if ((await call('GET', `/v1/tg/bots/${id}/chats`)).body.length) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    const chats = (await call('GET', `/v1/tg/bots/${id}/chats`)).body;
    assert.equal(chats[0].title, 'עדכונים בזמן אמת');
    assert.equal(chats[0].canSend, true);
  });

  test('one bot on the free plan', async () => {
    const r = await call('POST', '/v1/tg/create', { name: 'עוד בוט' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'plan_limit');
  });
});
