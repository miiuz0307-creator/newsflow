/**
 * End-to-end: two tenants, simulated WhatsApp, a local fake Telegram server,
 * and the real PostgreSQL schema. Walks through linking, routing, templates,
 * filters, duplicates, media, Telegram→WhatsApp, approval, a ban, and checks
 * that one tenant's traffic never reaches another's groups.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MasterKey } from '../src/crypto/keyring.js';
import {
  PgAuthStore, PgDedupStore, PgJobQueue, PgKillSwitchStore, PgRouteSource, TenantKeys,
  recordConnectionEvent, recordSafetyEvent, saveRoute, withTenant,
} from '../src/db/pgStores.js';
import { MemoryMediaStore } from '../src/delivery/mediaStore.js';
import { Worker } from '../src/engine/worker.js';
import { TelegramAccount } from '../src/telegram/account.js';
import { TelegramBotApi } from '../src/telegram/botApi.js';
import { FakeTelegramServer } from '../src/telegram/fakeServer.js';
import { ConnectionManager } from '../src/wa/connectionManager.js';
import { FakeWaNetwork, fakeTransportFactory } from '../src/wa/fakeNetwork.js';
import { waitFor } from './helpers.js';
import { adminSetTenant, createTestDb, pgAvailable, type TestDb } from './pgHelpers.js';

const available = await pgAvailable();

const PHONE_A = '972500000101';
const PHONE_B = '972500000202';
const EDITOR = '972500000999';

const SPEC_TEMPLATE = '🔴 חדשות בזמן אמת\n\n{תוכן החדשות}\n\n━━━━━━━━━━━━\n\n📲 להצטרפות לקבוצת החדשות:\n{קישור WhatsApp}\n\n✈️ לערוץ הטלגרם:\n{קישור Telegram}\n\n━━━━━━━━━━━━\n\nעדכונים מסביב לשעון';

describe('end to end', { skip: !available && 'local test Postgres not running' }, () => {
  let db: TestDb;
  const net = new FakeWaNetwork({ connectDelayMs: 1 });
  const tg = new FakeTelegramServer();
  let worker: Worker;
  let conns: ConnectionManager;
  let tA: string, tB: string, accA: string, accB: string, botRow: string;
  const g: Record<string, string> = {};
  let tgChannel: number, tgSource: number;

  async function drain() {
    await worker.settle();
    for (let i = 0; i < 20; i++) {
      const s = await worker.dispatcher.tick();
      if (!s.claimed) break;
    }
  }

  before(async () => {
    db = await createTestDb();
    await tg.start();
    const keys = new TenantKeys(new MasterKey('mk-e2e', MasterKey.generateB64()), db.worker);
    tA = await keys.provision(db.app, 'חדשות ארצי בע"מ', 'trial', 'owner-a@example.com');
    await adminSetTenant(db, tA, 'premium');
    tB = await keys.provision(db.app, 'Tenant B', 'free', 'owner-b@example.com');
    accA = (await withTenant(db.app, tA, (c) => c.query<{ id: string }>(`INSERT INTO wa_accounts (tenant_id, label) VALUES ($1, 'ראשי') RETURNING id`, [tA]))).rows[0]!.id;
    accB = (await withTenant(db.app, tB, (c) => c.query<{ id: string }>(`INSERT INTO wa_accounts (tenant_id, label) VALUES ($1, 'main') RETURNING id`, [tB]))).rows[0]!.id;

    g.source = net.createGroup('חדשות ארצי', { members: [PHONE_A, EDITOR] });
    g.ashdod = net.createGroup('חדשות אשדוד', { members: [PHONE_A, '972511111111'] });
    g.jerusalem = net.createGroup('חדשות ירושלים', { members: [PHONE_A] });
    g.flash = net.createGroup('קבוצת המבזקים שלי', { members: [PHONE_A], admins: [PHONE_A], adminsOnly: true });
    g.locked = net.createGroup('נעולה', { members: [PHONE_A], adminsOnly: true });
    g.bTarget = net.createGroup('B יעד', { members: [PHONE_B] });
    g.bSource = net.createGroup('B מקור', { members: [PHONE_B, EDITOR] });

    tgChannel = tg.createChat('ערוץ החדשות', 'channel');
    tg.addBot(tgChannel, 'administrator', { can_post_messages: true });
    tgSource = tg.createChat('מקור טלגרם');
    tg.addBot(tgSource, 'member');

    conns = new ConnectionManager({
      transportFactory: fakeTransportFactory(net),
      storeFactory: async (tenantId, accountId) => new PgAuthStore(db.worker, tenantId, accountId, await keys.cipher(tenantId)),
    });
    const planCaps: Record<string, number> = { [accA]: 2000, [accB]: 100 };
    worker = new Worker({
      workerId: 'w-e2e',
      connections: conns,
      queue: new PgJobQueue(db.worker, db.app),
      routes: new PgRouteSource(db.worker),
      dedup: new PgDedupStore(db.worker),
      killSwitches: new PgKillSwitchStore(db.worker),
      media: new MemoryMediaStore(),
      dailyCapFor: (acc) => planCaps[acc] ?? 2000,
      rulesOverride: { wa: { accountMinGapMs: 0, chatMinGapMs: 0, accountPerMinute: 1000 }, tg: { chatMinGapMs: 0 } },
      onSafetyEvent: (e) => recordSafetyEvent(db.worker, e),
      onStatus: (e) => recordConnectionEvent(db.worker, e.state.tenantId, e.state.accountId, e.state.status, e.state.lastDisconnect?.reason),
    });

    const tokenBlob = (await keys.cipher(tA)).encrypt('tg-token', tg.token);
    botRow = (await withTenant(db.app, tA, (c) => c.query<{ id: string }>(`INSERT INTO tg_bots (tenant_id, username, token_blob) VALUES ($1, 'news_test_bot', $2) RETURNING id`,
      [tA, tokenBlob]))).rows[0]!.id;
    const bot = new TelegramAccount({
      tenantId: tA, accountId: botRow, api: new TelegramBotApi(tg.token, { apiBase: tg.url }), pollTimeoutSec: 0,
      onMessage: (m) => worker.handleTelegram(m),
    });
    await bot.verify();
    worker.addTelegram(bot);
    (worker as unknown as { bot: TelegramAccount }).bot = bot;
  });

  after(async () => {
    await worker?.shutdown();
    await tg.stop();
    await db?.drop();
  });

  test('1. customer links a number with a QR code; session is stored encrypted', async () => {
    await conns.connect(tA, accA, { method: 'qr' });
    await waitFor(() => !!conns.getState(accA)?.qr);
    net.scanQr(PHONE_A, conns.getState(accA)!.qr!);
    await waitFor(() => conns.getState(accA)?.status === 'connected');
    await conns.connect(tB, accB, { method: 'pairing_code', phoneNumber: PHONE_B });
    await waitFor(() => !!conns.getState(accB)?.pairingCode);
    net.enterPairingCode(PHONE_B, conns.getState(accB)!.pairingCode!);
    await waitFor(() => conns.getState(accB)?.status === 'connected');
    await worker.settle();
    const row = await withTenant(db.app, tA, (c) => c.query<{ status: string; last_connected_at: Date }>('SELECT status, last_connected_at FROM wa_accounts'));
    assert.equal(row.rows[0]!.status, 'connected');
    assert.ok(row.rows[0]!.last_connected_at);
    const raw = await db.worker.query<{ blob: string }>('SELECT blob FROM wa_auth WHERE account_id = $1', [accA]);
    assert.ok(raw.rowCount > 0);
    assert.ok(raw.rows.every((r) => !r.blob.includes(PHONE_A)));
  });

  test('2. groups are listed with send permission; routes are validated and saved', async () => {
    const chats = await conns.listChats(accA);
    const can = Object.fromEntries(chats.map((c) => [c.title, c.canSend]));
    assert.deepEqual(can, { 'חדשות ארצי': true, 'חדשות אשדוד': true, 'חדשות ירושלים': true, 'קבוצת המבזקים שלי': true, 'נעולה': false });

    const tpl = (await withTenant(db.app, tA, (c) => c.query<{ id: string }>(
      `INSERT INTO templates (tenant_id, name, body, vars) VALUES ($1, 'ברירת מחדל', $2, $3) RETURNING id`,
      [tA, SPEC_TEMPLATE, { whatsapp_link: 'https://chat.whatsapp.com/OURS', telegram_link: 'https://t.me/ours' }]))).rows[0]!.id;

    await withTenant(db.app, tA, (c) => saveRoute(c, tA, {
      name: 'ארצי → כל הקבוצות', enabled: true, templateId: tpl, requireApproval: false,
      filters: { excludeAny: ['פרסומת'] },
      sources: [{ platform: 'wa', accountId: accA, chatId: g.source! }],
      targets: [
        { platform: 'wa', accountId: accA, chatId: g.ashdod!, title: 'חדשות אשדוד' },
        { platform: 'wa', accountId: accA, chatId: g.jerusalem!, title: 'חדשות ירושלים' },
        { platform: 'wa', accountId: accA, chatId: g.flash!, title: 'קבוצת המבזקים שלי' },
        { platform: 'tg', accountId: botRow, chatId: String(tgChannel), title: 'ערוץ החדשות' },
      ],
    }));
    await withTenant(db.app, tA, (c) => saveRoute(c, tA, {
      name: 'טלגרם → וואטסאפ', enabled: true, requireApproval: true, filters: {},
      sources: [{ platform: 'tg', accountId: botRow, chatId: String(tgSource) }],
      targets: [{ platform: 'wa', accountId: accA, chatId: g.jerusalem!, title: 'חדשות ירושלים' }],
    }));
    await withTenant(db.app, tB, (c) => saveRoute(c, tB, {
      name: 'B', enabled: true, requireApproval: false, filters: {},
      sources: [{ platform: 'wa', accountId: accB, chatId: g.bSource! }],
      targets: [{ platform: 'wa', accountId: accB, chatId: g.bTarget! }],
    }));
  });

  test('3. a news post is delivered to every target with the template', async () => {
    net.humanPost(EDITOR, g.source!, { kind: 'text', text: 'אזעקה באשדוד\nhttps://chat.whatsapp.com/COMPETITOR' });
    await drain();
    for (const k of ['ashdod', 'jerusalem', 'flash'] as const) {
      const log = net.groupLog(g[k]!).filter((m) => m.from === PHONE_A);
      assert.equal(log.length, 1, `${k} should get exactly one message`);
      const text = log[0]!.content.text!;
      assert.ok(text.startsWith('🔴 חדשות בזמן אמת\n\nאזעקה באשדוד'));
      assert.ok(text.includes('https://chat.whatsapp.com/OURS'));
      assert.ok(!text.includes('COMPETITOR'));
    }
    const posts = tg.posts(tgChannel);
    assert.equal(posts.length, 1);
    assert.ok(posts[0]!.text!.includes('אזעקה באשדוד'));
    assert.equal(net.groupLog(g.locked!).length, 0);
  });

  test('4. our own messages in target groups do not loop back', async () => {
    await drain();
    const jobs = await db.worker.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbound_jobs WHERE tenant_id = $1`, [tA]);
    assert.equal(jobs.rows[0]!.n, 4);
  });

  test('5. filtered and duplicate posts are not sent', async () => {
    net.humanPost(EDITOR, g.source!, { kind: 'text', text: 'פרסומת: מבצע על מזגנים' });
    net.humanPost(EDITOR, g.source!, { kind: 'text', text: 'אזעקה באשדוד' }); // same news again
    await drain();
    assert.equal(net.groupLog(g.ashdod!).filter((m) => m.from === PHONE_A).length, 1);
    assert.equal(tg.posts(tgChannel).length, 1);
  });

  test('6. images are delivered to WhatsApp and Telegram', async () => {
    net.humanPost(EDITOR, g.source!, { kind: 'image', text: 'תיעוד מהזירה', media: { mimeType: 'image/jpeg', data: Buffer.from('JPEGBYTES') } });
    await drain();
    const last = net.groupLog(g.jerusalem!).at(-1)!;
    assert.equal(last.content.kind, 'image');
    assert.equal(last.content.media?.data?.toString(), 'JPEGBYTES');
    assert.ok(last.content.text!.includes('תיעוד מהזירה'));
    const tgLast = tg.posts(tgChannel).at(-1)!;
    assert.ok(tgLast.photo?.length);
    assert.ok(tgLast.caption!.includes('תיעוד מהזירה'));
  });

  test('7. Telegram → WhatsApp with manual approval', async () => {
    tg.userPost(tgSource, { text: 'עדכון מטלגרם' });
    await (worker as unknown as { bot: TelegramAccount }).bot.pollOnce(0);
    await drain();
    const before = net.groupLog(g.jerusalem!).length;
    const pending = await new PgJobQueue(db.worker, db.app).listPendingApproval(tA);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.content.text, 'עדכון מטלגרם');
    assert.equal(await new PgJobQueue(db.worker, db.app).approve(tA, pending[0]!.id), true);
    await drain();
    assert.equal(net.groupLog(g.jerusalem!).length, before + 1);
    assert.equal(net.groupLog(g.jerusalem!).at(-1)!.content.text, 'עדכון מטלגרם');
  });

  test('8. tenants are isolated end to end', async () => {
    net.humanPost(EDITOR, g.bSource!, { kind: 'text', text: 'חדשות של B' });
    await drain();
    assert.equal(net.groupLog(g.bTarget!).filter((m) => m.from === PHONE_B).length, 1);
    for (const k of ['ashdod', 'jerusalem', 'flash'] as const) {
      assert.ok(!net.groupLog(g[k]!).some((m) => m.content.text?.includes('חדשות של B')));
    }
    const aSees = await withTenant(db.app, tA, (c) => c.query(`SELECT 1 FROM outbound_jobs WHERE target_chat_id = $1`, [g.bTarget]));
    assert.equal(aSees.rowCount, 0);
  });

  test('9. a ban stops the number, is recorded, and nothing more is sent from it', async () => {
    net.ban(PHONE_A);
    await waitFor(() => conns.getState(accA)?.status === 'blocked');
    await worker.settle();
    const ks = await new PgKillSwitchStore(db.worker).find({ tenantId: tA, accountId: accA });
    assert.equal(ks?.setBy, 'system:auto');
    const ev = await withTenant(db.app, tA, (c) => c.query<{ kind: string }>(`SELECT kind FROM safety_events`));
    assert.deepEqual(ev.rows.map((r) => r.kind), ['account_blocked']);
    const conn = await withTenant(db.app, tA, (c) => c.query<{ status: string; last_disconnect_reason: string }>('SELECT status, last_disconnect_reason FROM wa_accounts'));
    assert.equal(conn.rows[0]!.status, 'blocked');
    assert.equal(conn.rows[0]!.last_disconnect_reason, 'account_blocked');

    // Tenant B keeps working.
    net.humanPost(EDITOR, g.bSource!, { kind: 'text', text: 'B ממשיך לעבוד' });
    await drain();
    assert.ok(net.groupLog(g.bTarget!).some((m) => m.content.text === 'B ממשיך לעבוד'));
    // The audit trail recorded the automatic stop.
    const audit = await withTenant(db.app, tA, (c) => c.query<{ actor: string }>(`SELECT actor FROM audit_log WHERE action = 'kill_switch.set'`));
    assert.deepEqual(audit.rows.map((r) => r.actor), ['system:auto']);
  });

  test('10. summary numbers', async () => {
    const r = await db.worker.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM outbound_jobs GROUP BY status ORDER BY status`);
    const by = Object.fromEntries(r.rows.map((x) => [x.status, x.n]));
    assert.equal(by.sent, 11); // 4 news + 4 image... (3 wa + 1 tg) ×2, +1 telegram→wa, +2 tenant B
    assert.equal(by.failed ?? 0, 0);
  });
});
