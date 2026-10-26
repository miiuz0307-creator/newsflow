/**
 * Telegram by QR / phone: the customer signs in once, picks channels, we create the
 * bot, add it as admin, log out of their account and connect the bot like any bot.
 * A fake Telegram user client stands in for GramJS; the Bot API is the fake server.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { manageModule } from '../src/api/modules/manage.js';
import { ApiServer } from '../src/api/server.js';
import { signToken } from '../src/api/auth.js';
import { MasterKey } from '../src/crypto/keyring.js';
import { PgJobQueue, PgKillSwitchStore, TenantKeys, withTenant } from '../src/db/pgStores.js';
import { FakeTelegramServer } from '../src/telegram/fakeServer.js';
import { TelegramPhoneLinker, randomBotUsername, tokenInReply, type AdminChat, type TelegramUserClient } from '../src/telegram/phoneLink.js';
import { TelegramRuntime } from '../src/telegram/runtime.js';
import { ConnectionManager } from '../src/wa/connectionManager.js';
import { FakeWaNetwork, fakeTransportFactory } from '../src/wa/fakeNetwork.js';
import { memoryStores } from './helpers.js';
import { adminSetTenant, createTestDb, pgAvailable, type TestDb } from './pgHelpers.js';

const available = await pgAvailable();
const SECRET = 'customer-token-secret-0123456789abcdef';
async function until(cond: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await cond())) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 30)); }
}

class FakeUser implements TelegramUserClient {
  scanned!: () => void;
  password: string | null = null;
  loggedOut = false;
  admins: string[] = [];
  constructor(private readonly tg: FakeTelegramServer, readonly chats: AdminChat[]) {}
  async startQr(onQr: (url: string) => void, ask: () => Promise<string>, onErr: (m: string) => void) {
    onQr('tg://login?token=AAAA');
    await new Promise<void>((r) => { this.scanned = r; });
    while (this.password) { if ((await ask()) === this.password) break; onErr('הסיסמה שגויה'); }
  }
  async sendCode() {}
  async signIn(code: string) { if (code !== '12345') throw new Error('bad'); return this.password ? 'password' as const : 'ok' as const; }
  async checkPassword(p: string) { if (p !== this.password) throw new Error('bad'); }
  async adminChats() { return this.chats; }
  async createBot() { return { token: this.tg.token, username: this.tg.botUsername }; }
  async addBotAsAdmin(chatId: string) { this.admins.push(chatId); this.tg.addBot(Number(chatId), 'administrator', { can_post_messages: true }); }
  async logOut() { this.loggedOut = true; }
}

describe('Telegram link helpers', () => {
  test('bot usernames and the token in a BotFather reply', () => {
    assert.match(randomBotUsername(), /^push_[a-z0-9]{8}_bot$/);
    assert.equal(tokenInReply('Done! Congratulations on your new bot.\nUse this token to access the HTTP API:\n7001234567:AAHk3jK9xYzT4fQ1-2_abcdefghijklmnop\nKeep your token secure'), '7001234567:AAHk3jK9xYzT4fQ1-2_abcdefghijklmnop');
    assert.equal(tokenInReply('Sorry, this username is already taken.'), null);
  });
});

describe('Telegram by QR / phone', { skip: !available && 'local test Postgres not running' }, () => {
  let db: TestDb, api: ApiServer, conns: ConnectionManager, runtime: TelegramRuntime, tok = '';
  const tg = new FakeTelegramServer('push_test1234_bot');
  let fake: FakeUser;
  let channel = 0, noRights = 0;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(api.url + path, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };

  before(async () => {
    db = await createTestDb();
    await tg.start();
    channel = tg.createChat('ערוץ החדשות', 'channel');
    noRights = tg.createChat('ערוץ של אחרים', 'channel');
    const keys = new TenantKeys(new MasterKey('mk-tgl', MasterKey.generateB64()), db.worker);
    const t = await keys.provision(db.app, 'חדשות הדרום', 'trial', 'south@x.com');
    await adminSetTenant(db, t, 'premium');
    const uid = (await withTenant(db.app, t, (c) => c.query<{ id: string }>('SELECT id FROM users'))).rows[0]!.id;
    tok = signToken({ tenantId: t, userId: uid, role: 'owner' }, SECRET);
    runtime = new TelegramRuntime({ workerSql: db.worker, keys, apiOptions: { apiBase: tg.url }, onMessage: () => {}, pollTimeoutSec: 0 });
    const chats: AdminChat[] = [
      { chatId: String(channel), title: 'ערוץ החדשות', type: 'channel', canAddBot: true },
      { chatId: String(noRights), title: 'ערוץ של אחרים', type: 'channel', canAddBot: false },
    ];
    const linker = new TelegramPhoneLinker({ clientFactory: () => (fake = new FakeUser(tg, chats)) });
    const { factory } = memoryStores();
    conns = new ConnectionManager({ transportFactory: fakeTransportFactory(new FakeWaNetwork()), storeFactory: async (tt, a) => factory(tt, a) });
    api = new ApiServer({
      appPool: db.app, connections: conns, queue: new PgJobQueue(db.worker, db.app), killSwitches: new PgKillSwitchStore(db.worker), tokenSecret: SECRET,
      modules: [manageModule({ keys, telegram: runtime, phoneLinker: linker })],
    });
    await api.listen();
  });
  after(async () => { await api?.close(); await runtime?.shutdown(); await conns?.shutdown(); await tg.stop(); await db?.drop(); });

  test('QR: scan, 2-step password (a wrong one first), pick channels; the bot is created, added and connected; we log out', async () => {
    assert.deepEqual((await call('GET', '/v1/tg/link')).body, { available: true, step: 'none' });
    const q = await call('POST', '/v1/tg/link/qr');
    assert.equal(q.body.step, 'qr');
    assert.ok(q.body.qrRows.length > 20, 'a QR to draw');
    fake.password = 'סוד123';
    fake.scanned();
    await until(async () => (await call('GET', '/v1/tg/link')).body.step === 'password');
    const wrong = await call('POST', '/v1/tg/link/password', { password: 'לא' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.code, 'bad_password');
    const ok = await call('POST', '/v1/tg/link/password', { password: 'סוד123' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    await until(async () => (await call('GET', '/v1/tg/link')).body.step === 'chats');
    const st = (await call('GET', '/v1/tg/link')).body;
    assert.equal(st.chats.length, 2);
    assert.equal(st.chats.find((c: AdminChat) => c.title === 'ערוץ של אחרים').canAddBot, false);

    const fin = await call('POST', '/v1/tg/link/finish', { chatIds: [String(channel), String(noRights)] });
    assert.equal(fin.status, 200, JSON.stringify(fin.body));
    assert.equal(fin.body.bot.username, 'push_test1234_bot');
    assert.deepEqual(fake.admins, [String(channel)], 'only where the customer may add admins');
    assert.equal(fin.body.chats.length, 1);
    assert.equal(fin.body.chats[0].canSend, true);
    assert.ok(fake.loggedOut, 'logged out of the customer\'s account');
    assert.equal((await call('GET', '/v1/tg/link')).body.step, 'none', 'nothing kept');
    const bots = await call('GET', '/v1/tg/bots');
    assert.equal(bots.body.length, 1);
    assert.equal(bots.body[0].running, true);
  });

  test('phone: code, then the chosen channels; a second bot on the plan is refused before anything is created', async () => {
    const s = await call('POST', '/v1/tg/link/phone', { phone: '050-1234567' });
    assert.equal(s.body.step, 'code');
    assert.equal((await call('POST', '/v1/tg/link/code', { code: '12345' })).body.step, 'chats');
    const fin = await call('POST', '/v1/tg/link/finish', { chatIds: [String(channel)] });
    // premium allows 2 bots; the same bot token is already connected → refused, and we still log out
    assert.equal(fin.status, 409);
    assert.ok(fake.loggedOut);
  });
});
