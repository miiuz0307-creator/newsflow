/**
 * Regressions from the independent review of PUSH Sync (October 2026). Each
 * test reproduces a race or gap the review found and asserts the fixed
 * behaviour: a deleted message is never sent, only allowed senders may
 * delete, and reports count exactly what happened.
 */
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryKillSwitchStore } from '../src/delivery/killSwitch.js';
import { MemoryMediaStore } from '../src/delivery/mediaStore.js';
import { MemoryJobQueue } from '../src/delivery/queue.js';
import { MemoryRouteSource } from '../src/engine/pipeline.js';
import { MemorySourceMessageStore } from '../src/engine/sync.js';
import { Worker } from '../src/engine/worker.js';
import { MemoryDedupStore } from '../src/routing/dedup.js';
import type { ControlSettings } from '../src/routing/types.js';
import { TelegramAccount } from '../src/telegram/account.js';
import { TelegramBotApi } from '../src/telegram/botApi.js';
import { FakeTelegramServer } from '../src/telegram/fakeServer.js';
import { ConnectionManager } from '../src/wa/connectionManager.js';
import { FakeWaNetwork, fakeTransportFactory } from '../src/wa/fakeNetwork.js';
import { memoryStores, waitFor } from './helpers.js';

const LINKED = '972500000301';
const CUSTOMER = '972500000302';
const STRANGER = '972500000303';

async function world(control: ControlSettings, opts: { batchSize?: number } = {}) {
  const net = new FakeWaNetwork({ connectDelayMs: 1 });
  const tg = new FakeTelegramServer();
  await tg.start();
  const tenantId = randomUUID(), acc = randomUUID(), botId = randomUUID();
  const queue = new MemoryJobQueue();
  const sources = new MemorySourceMessageStore();
  const routes = new MemoryRouteSource();
  const { factory } = memoryStores();
  const conns = new ConnectionManager({ transportFactory: fakeTransportFactory(net), storeFactory: async (t, a) => factory(t, a) });
  const worker = new Worker({
    workerId: 'w', connections: conns, queue, sources, media: new MemoryMediaStore(), dailyCapFor: () => 10_000,
    rulesOverride: { wa: { accountMinGapMs: 0, chatMinGapMs: 0, accountPerMinute: 10_000 }, tg: { accountMinGapMs: 0, chatMinGapMs: 0, accountPerMinute: 10_000 } },
    dispatcherOverrides: { retryJitter: 0, ...(opts.batchSize ? { batchSize: opts.batchSize } : {}) },
    routes, dedup: new MemoryDedupStore(), killSwitches: new MemoryKillSwitchStore(),
  });
  const ctrl = net.createGroup('ctrl', { members: [LINKED, CUSTOMER, STRANGER], admins: [STRANGER] });
  const targets = [0, 1, 2, 3].map((i) => net.createGroup(`t${i}`, { members: [LINKED, `97251111000${i}`] }));
  const tgCtrl = tg.createChat('tg ctrl');
  tg.addBot(tgCtrl, 'member');
  const bot = new TelegramAccount({
    tenantId, accountId: botId, api: new TelegramBotApi(tg.token, { apiBase: tg.url }), pollTimeoutSec: 0,
    onMessage: (m) => worker.handleTelegram(m), onSync: (e) => worker.handleTelegramSync(e),
  });
  await bot.verify();
  await bot.pollOnce(0);
  worker.addTelegram(bot);
  await conns.connect(tenantId, acc, { method: 'qr' });
  await waitFor(() => !!conns.getState(acc)?.qr);
  net.scanQr(LINKED, conns.getState(acc)!.qr!);
  await waitFor(() => conns.getState(acc)?.status === 'connected');
  const routeWa = randomUUID(), routeTg = randomUUID();
  routes.upsertRoute({ id: routeWa, tenantId, name: 'wa', enabled: true, filters: {}, requireApproval: false, control,
    sources: [{ platform: 'wa', accountId: acc, chatId: ctrl }], targets: targets.map((chatId, i) => ({ platform: 'wa', accountId: acc, chatId, title: `t${i}` })) });
  routes.upsertRoute({ id: routeTg, tenantId, name: 'tg', enabled: true, filters: {}, requireApproval: false, control,
    sources: [{ platform: 'tg', accountId: botId, chatId: String(tgCtrl) }], targets: targets.map((chatId) => ({ platform: 'wa', accountId: acc, chatId })) });
  const drain = async () => {
    let quiet = 0;
    for (let i = 0; i < 60 && quiet < 2; i++) {
      const polled = await bot.pollOnce(0);
      await worker.settle();
      const s = await worker.dispatcher.tick();
      await worker.settle();
      quiet = polled === 0 && s.claimed === 0 ? quiet + 1 : 0;
    }
  };
  const live = (jid: string) => net.groupLog(jid).filter((e) => !e.deleted).map((e) => e.content.text);
  const reports = () => net.groupLog(ctrl).filter((e) => e.from === LINKED).map((e) => e.content.text ?? '');
  const close = async () => { await worker.shutdown(); await tg.stop(); };
  return { net, tg, worker, queue, sources, tenantId, acc, botId, ctrl, targets, tgCtrl, drain, live, reports, close, routeWa };
}


describe('PUSH Sync — review regressions', () => {
  test('Telegram "מחק" from a member not on the allowed list deletes nothing and is not distributed', async () => {
    const w = await world({ syncEdits: true, syncDeletes: true, reportMode: 'summary', allowedSenders: ['42'] });
    try {
      const id = w.tg.userPost(w.tgCtrl, { text: 'news from the editor' });
      await w.drain();
      w.worker.handleTelegram({
        tenantId: w.tenantId, source: { platform: 'tg', accountId: w.botId, chatId: String(w.tgCtrl) }, messageId: '9999',
        senderId: '7777777', fromSelf: false, isForwarded: false, receivedAt: new Date(), content: { kind: 'text', text: 'מחק' },
        replyToMessageId: String(id),
      });
      await w.drain();
      for (const g of w.targets) assert.deepEqual(w.live(g), ['news from the editor']);
    } finally { await w.close(); }
  });

  test('a WhatsApp admin who is not an allowed sender cannot delete the copies', async () => {
    const w = await world({ syncEdits: true, syncDeletes: true, reportMode: 'summary', allowedSenders: [CUSTOMER] });
    try {
      const id = w.net.humanPost(CUSTOMER, w.ctrl, { kind: 'text', text: 'customer news' });
      await w.drain();
      w.net.humanDeleteForEveryone(STRANGER, w.ctrl, id);
      await w.drain();
      for (const g of w.targets) assert.deepEqual(w.live(g), ['customer news']);
    } finally { await w.close(); }
  });

  test('a copy that goes back to the queue between cancel and lookup is still never sent after the delete', async () => {
    const w = await world({ syncEdits: true, syncDeletes: true, reportMode: 'summary' });
    try {
      const id = w.net.humanPost(CUSTOMER, w.ctrl, { kind: 'text', text: 'WRONG — delete me' });
      await w.worker.settle();
      const claimed = await w.queue.claim('other', 100, 60_000);
      assert.equal(claimed.length, 4);
      const origCopies = w.queue.copiesOf.bind(w.queue);
      let once = false;
      (w.queue as any).copiesOf = async (...a: Parameters<typeof origCopies>) => {
        if (!once) { once = true; for (const j of claimed) await w.queue.retry(j.id, new Date(0), 'transient', 'boom'); }
        return origCopies(...a);
      };
      w.net.humanDeleteForEveryone(CUSTOMER, w.ctrl, id);
      await w.drain();
      for (const g of w.targets) assert.ok(!w.live(g).includes('WRONG — delete me'), 'never delivered');
      assert.ok(claimed.every((j) => ['skipped', 'cancelled'].includes(w.queue.jobs.get(j.id)!.status)));
    } finally { await w.close(); }
  });

  test('copies already claimed in a batch are not sent once the delete is planned', async () => {
    const w = await world({ syncEdits: true, syncDeletes: true, reportMode: 'summary' });
    try {
      const id = w.net.humanPost(CUSTOMER, w.ctrl, { kind: 'text', text: 'WRONG2' });
      await w.worker.settle();
      const batch = await w.queue.claim('w', 100, 60_000);
      const d = w.worker.dispatcher as any;
      await d.process(batch[0]);
      w.net.humanDeleteForEveryone(CUSTOMER, w.ctrl, id);
      await w.worker.settle();
      for (const j of batch.slice(1)) await d.process(j);
      const sentAfter = batch.slice(1).filter((j) => w.net.groupLog(j.target.chatId).some((e) => e.content.text === 'WRONG2')).length;
      assert.equal(sentAfter, 0);
      await w.drain();
      for (const g of w.targets) assert.ok(!w.live(g).includes('WRONG2'));
    } finally { await w.close(); }
  });

  test('delete report warns about an unknown copy; a retry of it is never sent', async () => {
    const w = await world({ syncEdits: true, syncDeletes: true, reportMode: 'summary' });
    try {
      w.net.loseNextAck(LINKED);
      const id = w.net.humanPost(CUSTOMER, w.ctrl, { kind: 'text', text: 'oops' });
      await w.drain();
      const unk = [...w.queue.jobs.values()].find((j) => j.status === 'unknown')!;
      w.net.humanDeleteForEveryone(CUSTOMER, w.ctrl, id);
      await w.drain();
      assert.match(w.reports().at(-1)!, /🗑️ PUSH · ההודעה נמחקה ב-3 קבוצות/);
      assert.match(w.reports().at(-1)!, /1 עותקים ממתינים לאימות, ולכן לא נמחקו/);
      await w.queue.requeue(w.tenantId, unk.id);
      await w.drain();
      assert.equal(w.net.groupLog(unk.target.chatId).filter((e) => e.content.text === 'oops').length, 1, 'not sent a second time');
      assert.equal(w.queue.jobs.get(unk.id)!.errorKind, 'source_deleted');
    } finally { await w.close(); }
  });

  test('a retried unknown copy carries the latest edit', async () => {
    const w = await world({ syncEdits: true, syncDeletes: true, reportMode: 'summary' });
    try {
      w.net.loseNextAck(LINKED);
      const id = w.net.humanPost(CUSTOMER, w.ctrl, { kind: 'text', text: 'v1 text' });
      await w.drain();
      const unk = [...w.queue.jobs.values()].find((j) => j.status === 'unknown')!;
      w.net.humanEdit(CUSTOMER, w.ctrl, id, { kind: 'text', text: 'v2 corrected' });
      await w.drain();
      await w.queue.requeue(w.tenantId, unk.id);
      await w.drain();
      assert.equal(w.live(unk.target.chatId).at(-1), 'v2 corrected');
    } finally { await w.close(); }
  });

  test('the edit report counts copies updated before sending', async () => {
    const w = await world({ syncEdits: true, syncDeletes: true, reportMode: 'summary' }, { batchSize: 2 });
    try {
      const id = w.net.humanPost(CUSTOMER, w.ctrl, { kind: 'text', text: 'first' });
      await w.worker.settle();
      await w.worker.dispatcher.tick();
      await w.worker.settle();
      w.net.humanEdit(CUSTOMER, w.ctrl, id, { kind: 'text', text: 'second' });
      await w.drain();
      for (const g of w.targets) assert.equal(w.live(g).at(-1), 'second');
      assert.ok(w.reports().some((r) => /ההודעה עודכנה ב-4 קבוצות \(2 מהן עוד לפני השליחה\)/.test(r)), w.reports().join(' | '));
    } finally { await w.close(); }
  });

  test('another route reading the control group never hides or mixes into the report', async () => {
    const w = await world({ syncEdits: true, syncDeletes: true, reportMode: 'summary' });
    try {
      const archive = w.net.createGroup('archive', { members: [LINKED] });
      (w.worker as any).o.routes.upsertRoute({ id: randomUUID(), tenantId: w.tenantId, name: 'archive', enabled: true, filters: { ignoreFromSelf: false }, requireApproval: false,
        sources: [{ platform: 'wa', accountId: w.acc, chatId: w.ctrl }], targets: [{ platform: 'wa', accountId: w.acc, chatId: archive, title: 'archive' }] });
      w.net.humanPost(CUSTOMER, w.ctrl, { kind: 'text', text: 'hello' });
      await w.drain();
      const finals = w.reports().filter((r) => r.includes('נשלחה'));
      assert.deepEqual(finals, ['✅ PUSH · ההודעה נשלחה בהצלחה ל-4 מתוך 4 קבוצות.']);
      assert.deepEqual(w.live(archive), ['hello'], 'the archive gets the message, never the report');
    } finally { await w.close(); }
  });
});
