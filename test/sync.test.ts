/**
 * PUSH Sync, end to end: a control group, simulated WhatsApp, the local
 * Telegram fake, and the full worker (pipeline → queue → dispatcher → reports).
 *
 * Every scenario runs twice: on the in-memory stores, and on the real
 * PostgreSQL schema (skipped when no local test server is running).
 */
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MasterKey } from '../src/crypto/keyring.js';
import { PgDedupStore, PgJobQueue, PgKillSwitchStore, PgRouteSource, PgSourceMessageStore, TenantKeys, saveRoute, withTenant } from '../src/db/pgStores.js';
import { MemoryKillSwitchStore } from '../src/delivery/killSwitch.js';
import { MemoryMediaStore } from '../src/delivery/mediaStore.js';
import { MemoryJobQueue, type JobQueue, type StoredJob } from '../src/delivery/queue.js';
import { MemoryRouteSource } from '../src/engine/pipeline.js';
import { finalReportText } from '../src/engine/reporter.js';
import { MemorySourceMessageStore, isDeleteCommand, type SourceMessageStore } from '../src/engine/sync.js';
import { Worker } from '../src/engine/worker.js';
import { MemoryDedupStore } from '../src/routing/dedup.js';
import { REPORT_TAG } from '../src/routing/router.js';
import type { ControlSettings, Route } from '../src/routing/types.js';
import { TelegramAccount } from '../src/telegram/account.js';
import { TelegramBotApi } from '../src/telegram/botApi.js';
import { FakeTelegramServer } from '../src/telegram/fakeServer.js';
import { ConnectionManager } from '../src/wa/connectionManager.js';
import { FakeWaNetwork, WA_EDIT_WINDOW_MS, fakeTransportFactory } from '../src/wa/fakeNetwork.js';
import { memoryStores, waitFor } from './helpers.js';
import { adminSetTenant, createTestDb, pgAvailable, type TestDb } from './pgHelpers.js';

const pgUp = await pgAvailable();

const LINKED = '972500000301'; // the dedicated number connected to PUSH
const CUSTOMER = '972500000302'; // the customer's personal phone
const STRANGER = '972500000303';

interface World {
  net: FakeWaNetwork;
  tg: FakeTelegramServer;
  worker: Worker;
  queue: JobQueue;
  sources: SourceMessageStore;
  tenantId: string;
  acc: string;
  botId: string;
  bot: TelegramAccount;
  /** WhatsApp control group and targets. */
  ctrl: string;
  waTargets: string[];
  tgChannel: number;
  tgCtrl: number;
  routeWa: string;
  routeTg: string;
  saveRoute(r: Omit<Route, 'tenantId'>): Promise<void>;
  drain(): Promise<void>;
  close(): Promise<void>;
}

async function makeWorld(kind: 'memory' | 'pg'): Promise<World> {
  const net = new FakeWaNetwork({ connectDelayMs: 1 });
  const tg = new FakeTelegramServer();
  await tg.start();
  const cleanup: (() => Promise<unknown>)[] = [() => tg.stop()];
  try {
    return await buildWorld(kind, net, tg, cleanup);
  } catch (err) {
    for (const c of cleanup.reverse()) await c().catch(() => {});
    throw err;
  }
}

async function buildWorld(kind: 'memory' | 'pg', net: FakeWaNetwork, tg: FakeTelegramServer, cleanup: (() => Promise<unknown>)[]): Promise<World> {
  let db: TestDb | undefined;
  let tenantId: string;
  let acc: string;
  let botId: string;
  let queue: JobQueue;
  let sources: SourceMessageStore;
  let saveR: (r: Omit<Route, 'tenantId'>) => Promise<void>;
  const deps: Partial<ConstructorParameters<typeof Worker>[0]> = {};
  let storeFactory: ConstructorParameters<typeof ConnectionManager>[0]['storeFactory'];

  if (kind === 'pg') {
    db = await createTestDb();
    cleanup.push(() => db!.drop());
    const keys = new TenantKeys(new MasterKey('mk-sync', MasterKey.generateB64()), db.worker);
    tenantId = await keys.provision(db.app, 'PUSH test', 'trial', `push-${randomUUID()}@example.com`);
    await adminSetTenant(db, tenantId, 'premium');
    acc = (await withTenant(db.app, tenantId, (c) => c.query<{ id: string }>(`INSERT INTO wa_accounts (tenant_id, label) VALUES ($1, 'push') RETURNING id`, [tenantId]))).rows[0]!.id;
    const blob = (await keys.cipher(tenantId)).encrypt('tg-token', tg.token);
    botId = (await withTenant(db.app, tenantId, (c) => c.query<{ id: string }>(`INSERT INTO tg_bots (tenant_id, username, token_blob) VALUES ($1, 'bot', $2) RETURNING id`, [tenantId, blob]))).rows[0]!.id;
    queue = new PgJobQueue(db.worker, db.app);
    sources = new PgSourceMessageStore(db.worker);
    const routes = new PgRouteSource(db.worker);
    saveR = async (r) => {
      await withTenant(db!.app, tenantId, (c) => saveRoute(c, tenantId, r));
    };
    Object.assign(deps, { routes, dedup: new PgDedupStore(db.worker), killSwitches: new PgKillSwitchStore(db.worker) });
    const { factory } = memoryStores();
    storeFactory = async (t, a) => factory(t, a);
  } else {
    tenantId = randomUUID();
    acc = randomUUID();
    botId = randomUUID();
    queue = new MemoryJobQueue();
    sources = new MemorySourceMessageStore();
    const routes = new MemoryRouteSource();
    saveR = async (r) => routes.upsertRoute({ ...r, tenantId });
    Object.assign(deps, { routes, dedup: new MemoryDedupStore(), killSwitches: new MemoryKillSwitchStore() });
    const { factory } = memoryStores();
    storeFactory = async (t, a) => factory(t, a);
  }

  const conns = new ConnectionManager({ transportFactory: fakeTransportFactory(net), storeFactory });
  const worker = new Worker({
    workerId: `w-sync-${kind}`,
    connections: conns,
    queue,
    sources,
    media: new MemoryMediaStore(),
    dailyCapFor: () => 10_000,
    rulesOverride: {
      wa: { accountMinGapMs: 0, chatMinGapMs: 0, accountPerMinute: 10_000 },
      tg: { accountMinGapMs: 0, chatMinGapMs: 0, accountPerMinute: 10_000 },
    },
    dispatcherOverrides: { retryJitter: 0 },
    ...(deps as Required<Pick<ConstructorParameters<typeof Worker>[0], 'routes' | 'dedup' | 'killSwitches'>>),
  });
  cleanup.push(() => worker.shutdown());

  const ctrl = net.createGroup('שליטה — PUSH', { members: [LINKED, CUSTOMER, STRANGER] });
  const waTargets = [
    net.createGroup('חדשות צפון', { members: [LINKED, '972511110001'] }),
    net.createGroup('חדשות דרום', { members: [LINKED, '972511110002'] }),
    net.createGroup('מבזקים (רק מנהלים)', { members: [LINKED], admins: [LINKED], adminsOnly: true }),
  ];
  const tgChannel = tg.createChat('ערוץ PUSH', 'channel');
  tg.addBot(tgChannel, 'administrator', { can_post_messages: true });
  const tgCtrl = tg.createChat('שליטה בטלגרם');
  tg.addBot(tgCtrl, 'member');

  const bot = new TelegramAccount({
    tenantId, accountId: botId, api: new TelegramBotApi(tg.token, { apiBase: tg.url }), pollTimeoutSec: 0,
    onMessage: (m) => worker.handleTelegram(m),
    onSync: (e) => worker.handleTelegramSync(e),
  });
  await bot.verify();
  await bot.pollOnce(0); // learn the chats it was added to
  worker.addTelegram(bot);

  await conns.connect(tenantId, acc, { method: 'qr' });
  await waitFor(() => !!conns.getState(acc)?.qr);
  net.scanQr(LINKED, conns.getState(acc)!.qr!);
  await waitFor(() => conns.getState(acc)?.status === 'connected');

  const control: ControlSettings = { syncEdits: true, syncDeletes: true, reportMode: 'summary' };
  const routeWa = randomUUID();
  const routeTg = randomUUID();
  await saveR({
    id: routeWa, name: 'PUSH WhatsApp', enabled: true, filters: {}, requireApproval: false, control,
    sources: [{ platform: 'wa', accountId: acc, chatId: ctrl }],
    targets: [
      ...waTargets.map((chatId, i) => ({ platform: 'wa' as const, accountId: acc, chatId, title: ['חדשות צפון', 'חדשות דרום', 'מבזקים'][i] })),
      { platform: 'tg' as const, accountId: botId, chatId: String(tgChannel), title: 'ערוץ PUSH' },
    ],
  });
  await saveR({
    id: routeTg, name: 'PUSH Telegram', enabled: true, filters: {}, requireApproval: false, control,
    sources: [{ platform: 'tg', accountId: botId, chatId: String(tgCtrl) }],
    targets: waTargets.slice(0, 2).map((chatId) => ({ platform: 'wa' as const, accountId: acc, chatId })),
  });

  return {
    net, tg, worker, queue, sources, tenantId, acc, botId, bot, ctrl, waTargets, tgChannel, tgCtrl, routeWa, routeTg,
    saveRoute: saveR,
    async drain() {
      let quiet = 0;
      for (let i = 0; i < 60 && quiet < 2; i++) {
        const polled = await bot.pollOnce(0);
        await worker.settle();
        const s = await worker.dispatcher.tick();
        await worker.settle();
        quiet = polled === 0 && s.claimed === 0 ? quiet + 1 : 0;
      }
    },
    async close() {
      for (const c of cleanup.reverse()) await c().catch(() => {});
    },
  };
}

const text = (net: FakeWaNetwork, jid: string) => net.groupLog(jid).filter((e) => !e.deleted).map((e) => e.content.text);
const reports = (w: World) => w.net.groupLog(w.ctrl).filter((e) => e.from === LINKED).map((e) => e.content.text ?? '');
const tgTexts = (w: World, chat: number) => w.tg.posts(chat).filter((p) => p.from?.is_bot).map((p) => p.text ?? p.caption);

for (const kind of ['memory', 'pg'] as const) {
  describe(`PUSH Sync (${kind})`, { skip: kind === 'pg' && !pgUp && 'local test Postgres not running' }, () => {
    let w: World;
    before(async () => {
      w = await makeWorld(kind);
    });
    after(async () => {
      await w?.close();
    });

    test('one message in the control group reaches every target once; a summary comes back', async () => {
      w.net.humanPost(CUSTOMER, w.ctrl, { kind: 'text', text: 'מבזק: כביש 6 נחסם' });
      await w.drain();
      for (const g of w.waTargets) assert.deepEqual(text(w.net, g), ['מבזק: כביש 6 נחסם']);
      assert.deepEqual(tgTexts(w, w.tgChannel), ['מבזק: כביש 6 נחסם']);
      const r = reports(w);
      assert.equal(r.length, 1, 'one summary');
      assert.match(r[0]!, /✅ PUSH · ההודעה נשלחה בהצלחה ל-4 מתוך 4 קבוצות/);
      // The summary itself was never distributed.
      for (const g of w.waTargets) assert.ok(!text(w.net, g).some((t) => t?.includes(REPORT_TAG)));
    });

    test('an edit in the control group edits every copy in place (no new messages)', async () => {
      const id = w.net.humanPost(CUSTOMER, w.ctrl, { kind: 'text', text: 'ירושלים: תאונה ברחוב יפו' });
      await w.drain();
      w.net.humanEdit(CUSTOMER, w.ctrl, id, { kind: 'text', text: 'ירושלים: תאונה ברחוב יפו, הכביש נפתח' });
      await w.drain();
      for (const g of w.waTargets) {
        const log = w.net.groupLog(g);
        assert.equal(log.at(-1)!.content.text, 'ירושלים: תאונה ברחוב יפו, הכביש נפתח');
        assert.ok(log.at(-1)!.editedAt, 'edited, not re-sent');
        assert.equal(log.filter((e) => e.content.text?.startsWith('ירושלים')).length, 1);
      }
      assert.equal(tgTexts(w, w.tgChannel).at(-1), 'ירושלים: תאונה ברחוב יפו, הכביש נפתח');
      assert.equal((await w.sources.state({ platform: 'wa', accountId: w.acc, chatId: w.ctrl }, id))?.version, 2);
      assert.match(reports(w).at(-1)!, /✏️ PUSH · ההודעה עודכנה ב-4 קבוצות/);
    });

    test('read receipts count once per reader on the copy that was read', async () => {
      const id = w.net.humanPost(CUSTOMER, w.ctrl, { kind: 'text', text: 'מי קרא?' });
      await w.drain();
      const [g1, g2] = w.waTargets as [string, string];
      const c1 = w.net.groupLog(g1).at(-1)!.id, c2 = w.net.groupLog(g2).at(-1)!.id;
      w.net.read(g1, c1, '972540000011');
      w.net.read(g1, c1, '972540000011');
      w.net.read(g2, c2, '972540000012');
      w.net.read(w.ctrl, id, '972540000013');
      await w.drain();
      const copies = await w.queue.copiesOf(w.tenantId, { platform: 'wa', accountId: w.acc, chatId: w.ctrl }, id);
      const byChat = new Map(copies.filter((j) => j.action === 'send').map((j) => [j.target.chatId, j.readCount ?? 0]));
      assert.equal(byChat.get(g1), 1);
      assert.equal(byChat.get(g2), 1);
      assert.equal([...byChat.values()].reduce((a, b) => a + b, 0), 2, 'the control-group read and the repeat are not counted');
    });

    test('rapid edits: only the newest version ends up in the groups', async () => {
      const id = w.net.humanPost(CUSTOMER, w.ctrl, { kind: 'text', text: 'גרסה 1' });
      await w.drain();
      w.net.humanEdit(CUSTOMER, w.ctrl, id, { kind: 'text', text: 'גרסה 2' });
      w.net.humanEdit(CUSTOMER, w.ctrl, id, { kind: 'text', text: 'גרסה 3' });
      await w.drain();
      for (const g of w.waTargets) assert.equal(w.net.groupLog(g).at(-1)!.content.text, 'גרסה 3');
      assert.equal(tgTexts(w, w.tgChannel).at(-1), 'גרסה 3');
      const copies = await w.queue.copiesOf(w.tenantId, { platform: 'wa', accountId: w.acc, chatId: w.ctrl }, id);
      assert.equal(copies.length, 4, 'still exactly one copy per target');
    });

    test('"delete for everyone" deletes every copy; "delete for me" does nothing', async () => {
      const keep = w.net.humanPost(CUSTOMER, w.ctrl, { kind: 'text', text: 'הודעה שנשארת' });
      const gone = w.net.humanPost(CUSTOMER, w.ctrl, { kind: 'text', text: 'הודעה שגויה' });
      await w.drain();
      w.net.humanDeleteForMe(CUSTOMER, w.ctrl, keep);
      w.net.humanDeleteForEveryone(CUSTOMER, w.ctrl, gone);
      await w.drain();
      for (const g of w.waTargets) {
        assert.ok(text(w.net, g).includes('הודעה שנשארת'), 'delete-for-me changed nothing');
        assert.ok(!text(w.net, g).includes('הודעה שגויה'), 'deleted everywhere');
        assert.equal(w.net.groupLog(g).filter((e) => e.content.text === 'הודעה שגויה' && e.deleted).length, 1);
      }
      assert.ok(!tgTexts(w, w.tgChannel).includes('הודעה שגויה'));
      assert.ok(tgTexts(w, w.tgChannel).includes('הודעה שנשארת'));
      assert.match(reports(w).at(-1)!, /🗑️ PUSH · ההודעה נמחקה ב-4 קבוצות/);
    });

    test('with a sending delay, an edit changes the queued copies and a delete cancels them before they go out', async () => {
      const route = { id: w.routeWa, name: 'PUSH WhatsApp (delayed)', enabled: true, filters: {}, requireApproval: false, delaySeconds: 3600,
        control: { reportMode: 'summary' as const },
        sources: [{ platform: 'wa' as const, accountId: w.acc, chatId: w.ctrl }],
        targets: w.waTargets.map((chatId) => ({ platform: 'wa' as const, accountId: w.acc, chatId })) };
      await w.saveRoute(route);
      const before = w.waTargets.map((g) => w.net.groupLog(g).length);

      const a = w.net.humanPost(CUSTOMER, w.ctrl, { kind: 'text', text: 'טיוטה עם שגיאה' });
      await w.drain();
      w.net.humanEdit(CUSTOMER, w.ctrl, a, { kind: 'text', text: 'טיוטה מתוקנת' });
      const b = w.net.humanPost(CUSTOMER, w.ctrl, { kind: 'text', text: 'לא לפרסם' });
      await w.drain();
      w.net.humanDeleteForEveryone(CUSTOMER, w.ctrl, b);
      await w.drain();

      const src = { platform: 'wa' as const, accountId: w.acc, chatId: w.ctrl };
      const copiesA = await w.queue.copiesOf(w.tenantId, src, a);
      assert.ok(copiesA.every((c) => c.status === 'queued' && c.content.text === 'טיוטה מתוקנת' && c.version === 2), 'queued copies carry the edit');
      const copiesB = await w.queue.copiesOf(w.tenantId, src, b);
      assert.ok(copiesB.every((c) => c.status === 'cancelled' && c.errorKind === 'source_deleted'));
      assert.deepEqual(w.waTargets.map((g) => w.net.groupLog(g).length), before, 'nothing was sent yet');
      assert.match(reports(w).join('\n'), /ההודעה נמחקה לפני שיצאה: 3 שליחות בוטלו/);
      assert.match(reports(w).join('\n'), /ההודעה עודכנה לפני השליחה ב-3 קבוצות/);

      // Back to immediate sending for the next tests.
      await w.saveRoute({ ...route, delaySeconds: 0, control: { reportMode: 'summary' } ,
        targets: [...route.targets, { platform: 'tg', accountId: w.botId, chatId: String(w.tgChannel) }] });
    });

    test('a send with no answer is "pending verification", never resent; edits skip it', async () => {
      w.net.loseNextAck(LINKED);
      const id = w.net.humanPost(CUSTOMER, w.ctrl, { kind: 'text', text: 'בדיקת אימות' });
      await w.drain();
      const src = { platform: 'wa' as const, accountId: w.acc, chatId: w.ctrl };
      const copies = await w.queue.copiesOf(w.tenantId, src, id);
      assert.equal(copies.filter((c) => c.status === 'unknown').length, 1);
      assert.equal(copies.filter((c) => c.status === 'sent').length, 3);
      // The unknown copy really did reach its group once, and was not sent again.
      const unknownTarget = copies.find((c) => c.status === 'unknown')!.target.chatId;
      assert.equal(text(w.net, unknownTarget).filter((t) => t === 'בדיקת אימות').length, 1);
      assert.match(reports(w).at(-1)!, /1 ממתינות לאימות/);

      w.net.humanEdit(CUSTOMER, w.ctrl, id, { kind: 'text', text: 'בדיקת אימות (תוקן)' });
      await w.drain();
      assert.equal(text(w.net, unknownTarget).filter((t) => t?.startsWith('בדיקת אימות')).length, 1, 'still one copy, never duplicated');
      assert.ok((await w.queue.copiesOf(w.tenantId, src, id)).some((c) => c.status === 'unknown'));
    });

    test('after WhatsApp\'s 15-minute window, WhatsApp copies are not edited (Telegram ones are) and the report says why', async () => {
      const id = w.net.humanPost(CUSTOMER, w.ctrl, { kind: 'text', text: 'ישן' });
      await w.drain();
      const realClock = w.net.clock;
      w.net.clock = () => realClock() + WA_EDIT_WINDOW_MS + 60_000;
      try {
        // The customer's own edit is also past 15 minutes on a real phone; the fake lets the
        // control group edit through so we can test what PUSH does with the copies.
        const g = w.net.groupLog(w.ctrl).find((e) => e.id === id)!;
        g.at = new Date(w.net.clock());
        w.net.humanEdit(CUSTOMER, w.ctrl, id, { kind: 'text', text: 'ישן (עודכן)' });
        await w.drain();
      } finally {
        w.net.clock = realClock;
      }
      for (const g of w.waTargets) assert.equal(text(w.net, g).at(-1), 'ישן', 'WhatsApp copy unchanged');
      assert.equal(tgTexts(w, w.tgChannel).at(-1), 'ישן (עודכן)');
      const last = reports(w).at(-1)!;
      assert.match(last, /עודכנה ב-1 קבוצות/);
      assert.match(last, /חלון הזמן של הפלטפורמה נסגר \(3\)/);
    });

    test('the same text posted twice in a control group goes out twice (no silent duplicate skip)', async () => {
      w.net.humanPost(CUSTOMER, w.ctrl, { kind: 'text', text: 'עדכון חוזר' });
      await w.drain();
      w.net.humanPost(CUSTOMER, w.ctrl, { kind: 'text', text: 'עדכון חוזר' });
      await w.drain();
      for (const g of w.waTargets) assert.equal(text(w.net, g).filter((t) => t === 'עדכון חוזר').length, 2);
    });

    test('only allowed senders distribute from a control group', async () => {
      await w.saveRoute({
        id: w.routeWa, name: 'PUSH WhatsApp', enabled: true, filters: {}, requireApproval: false,
        control: { reportMode: 'off', allowedSenders: ['+972-50-000-0302'] },
        sources: [{ platform: 'wa', accountId: w.acc, chatId: w.ctrl }],
        targets: w.waTargets.map((chatId) => ({ platform: 'wa' as const, accountId: w.acc, chatId })),
      });
      w.net.humanPost(STRANGER, w.ctrl, { kind: 'text', text: 'מישהו אחר כותב' });
      w.net.humanPost(CUSTOMER, w.ctrl, { kind: 'text', text: 'הלקוח כותב' });
      await w.drain();
      for (const g of w.waTargets) {
        assert.ok(!text(w.net, g).includes('מישהו אחר כותב'));
        assert.ok(text(w.net, g).includes('הלקוח כותב'));
      }
    });

    test('Telegram control group: post, edit, and reply "מחק" to delete the WhatsApp copies', async () => {
      const id = w.tg.userPost(w.tgCtrl, { text: 'מטלגרם לוואטסאפ' });
      await w.drain();
      for (const g of w.waTargets.slice(0, 2)) assert.equal(text(w.net, g).at(-1), 'מטלגרם לוואטסאפ');
      w.tg.userEdit(w.tgCtrl, id, 'מטלגרם לוואטסאפ — עודכן');
      await w.drain();
      for (const g of w.waTargets.slice(0, 2)) assert.equal(text(w.net, g).at(-1), 'מטלגרם לוואטסאפ — עודכן');
      w.tg.userPost(w.tgCtrl, { text: 'מחק', replyTo: id });
      await w.drain();
      for (const g of w.waTargets.slice(0, 2)) {
        assert.ok(!text(w.net, g).includes('מטלגרם לוואטסאפ — עודכן'));
        assert.ok(!text(w.net, g).includes('מחק'), 'the command itself is never distributed');
      }
      const tgReports = w.tg.posts(w.tgCtrl).filter((p) => p.from?.is_bot).map((p) => p.text ?? '');
      assert.match(tgReports.join('\n'), /🗑️ PUSH · ההודעה נמחקה ב-2 קבוצות/);
    });
  });
}

describe('PUSH Sync — units', () => {
  test('delete commands', () => {
    for (const t of ['/delete', '/מחק', 'מחק', ' מחק לכולם ', '/delete@my_bot']) assert.ok(isDeleteCommand(t), t);
    for (const t of ['מחקתי', 'delete this', '', undefined]) assert.ok(!isDeleteCommand(t), String(t));
  });

  test('report wording', () => {
    const s = { total: 50, sent: 48, failed: 2, skipped: 0, cancelled: 0, unknown: 0, pending: 0, reasons: { forbidden: 2 }, cancelledReasons: {}, failedTargets: ['א', 'ב'] };
    const t = finalReportText('send', s);
    assert.match(t, /^⚠️ PUSH · ההודעה נשלחה ל-48 מתוך 50 קבוצות\./);
    assert.match(t, /2 לא הצליחו: א, ב/);
    assert.match(t, /אין הרשאה לשלוח בקבוצה \(2\)/);
    const ok = finalReportText('send', { ...s, sent: 50, failed: 0, reasons: {}, failedTargets: [] });
    assert.equal(ok, '✅ PUSH · ההודעה נשלחה בהצלחה ל-50 מתוך 50 קבוצות.');
  });

  test('an older edit job never overwrites a newer version (dispatcher version guard)', async () => {
    const q = new MemoryJobQueue();
    const sources = new MemorySourceMessageStore();
    const src = { platform: 'wa' as const, accountId: 'a', chatId: 'ctrl' };
    await sources.record('t', src, 'm1', 'v1');
    await q.enqueue([{ tenantId: 't', routeId: 'r', source: src, sourceMessageId: 'm1', target: { platform: 'wa', accountId: 'a', chatId: 'g' }, content: { kind: 'text', text: 'v1' }, notBefore: new Date(), requiresApproval: false, idempotencyKey: 'k' }]);
    const [parent] = await q.claim('w', 10, 60_000);
    await q.complete(parent!.id, { messageId: 'out1', sentAt: new Date() });
    await sources.bump('t', src, 'm1', 'v2');
    await sources.bump('t', src, 'm1', 'v3');
    await q.enqueue([
      { ...parent!, idempotencyKey: 'k|edit|v2', action: 'edit', parentJobId: parent!.id, version: 2, content: { kind: 'text', text: 'v2' } },
      { ...parent!, idempotencyKey: 'k|edit|v3', action: 'edit', parentJobId: parent!.id, version: 3, content: { kind: 'text', text: 'v3' } },
    ]);
    const edits: string[] = [];
    const { Dispatcher } = await import('../src/delivery/dispatcher.js');
    const { RateLimiter } = await import('../src/delivery/rateLimiter.js');
    const { SafetyMonitor } = await import('../src/delivery/safety.js');
    const ks = new MemoryKillSwitchStore();
    const limiter = new RateLimiter(() => ({ accountMinGapMs: 0, accountPerMinute: 999, chatMinGapMs: 0, dailyCap: 999 }), async () => 0);
    const d = new Dispatcher({
      workerId: 'w', queue: q, killSwitches: ks, limiter, safety: new SafetyMonitor({ killSwitches: ks, limiter }),
      senderFor: () => ({ platform: 'wa', accountId: 'a', send: async () => ({ messageId: 'x', sentAt: new Date() }), edit: async (_c, _m, c) => void edits.push(c.text!) }),
      sourceState: (j: StoredJob) => sources.state(j.source, j.sourceMessageId),
    });
    const s = await d.tick();
    assert.equal(s.skipped, 1, 'v2 skipped as superseded');
    assert.deepEqual(edits, ['v3']);
  });
});
