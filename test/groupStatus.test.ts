/**
 * "!סטטוס" in the control group: the copies go up as the status of every WhatsApp target group
 * (WhatsApp's group status), without the command. Telegram channels are left out; a status
 * already up is not edited.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { InboundMessage } from '../src/core/types.js';
import { MemoryDedupStore } from '../src/routing/dedup.js';
import { Router } from '../src/routing/router.js';
import { parseStatusCommand } from '../src/routing/statusCommand.js';
import type { Route } from '../src/routing/types.js';
import { GROUP_STATUS_META, markGroupStatus, toBaileysPayload, wrapGroupStatus } from '../src/wa/baileysTransport.js';
import { finalReportText } from '../src/engine/reporter.js';

const SRC = { platform: 'wa' as const, accountId: 'acc1', chatId: 'ctrl@g.us' };
const G1 = { platform: 'wa' as const, accountId: 'acc1', chatId: 'g1@g.us', title: 'קבוצה 1' };
const G2 = { platform: 'wa' as const, accountId: 'acc1', chatId: 'g2@g.us', title: 'קבוצה 2' };
const TG = { platform: 'tg' as const, accountId: 'bot1', chatId: '-100123', title: 'ערוץ' };

const msg = (text: string, kind: 'text' | 'image' = 'text'): InboundMessage => ({
  tenantId: 't', source: SRC, messageId: `m${Math.random()}`, senderId: 'x', fromSelf: true, isForwarded: false, receivedAt: new Date(),
  content: kind === 'text' ? { kind, text } : { kind, text, media: { mimeType: 'image/jpeg', size: 10 } },
});
const route = (over: Partial<Route> = {}): Route => ({
  id: 'r1', tenantId: 't', name: 'שליטה', enabled: true, sources: [SRC], targets: [G1, G2, TG], filters: {}, requireApproval: false,
  control: { reportMode: 'summary' }, ...over,
} as Route);
const router = () => new Router({ dedup: new MemoryDedupStore(), templates: () => undefined, now: () => new Date('2026-11-08T10:00:00Z') });

describe('!סטטוס', () => {
  test('the command is recognised in its usual spellings, and only at the start', () => {
    assert.deepEqual(parseStatusCommand('!סטטוס שלום'), { status: true, rest: 'שלום' });
    assert.deepEqual(parseStatusCommand('! סטטוס\nשורה 1\nשורה 2'), { status: true, rest: 'שורה 1\nשורה 2' });
    assert.deepEqual(parseStatusCommand('!סטטוס: *מבזק*'), { status: true, rest: '*מבזק*' });
    assert.deepEqual(parseStatusCommand('!STATUS hello'), { status: true, rest: 'hello' });
    assert.equal(parseStatusCommand('!סטטוסים חדשים').status, false);
    assert.equal(parseStatusCommand('מה הסטטוס? !סטטוס').status, false);
    assert.equal(parseStatusCommand(undefined).status, false);
  });

  test('copies go to the WhatsApp groups as status, without the command; Telegram is left out', async () => {
    const plan = await router().plan(msg('!סטטוס *מבזק:* עומסים בכביש 1'), [route()]);
    assert.deepEqual(plan.jobs.map((j) => j.target.chatId), ['g1@g.us', 'g2@g.us']);
    for (const j of plan.jobs) assert.deepEqual(j.content, { kind: 'text', text: '*מבזק:* עומסים בכביש 1', asStatus: true });
    assert.deepEqual(plan.skipped, [{ routeId: 'r1', reason: 'status_whatsapp_only', target: 'tg:bot1:-100123' }]);
  });

  test('a normal message is unchanged; the command means nothing outside a control group', async () => {
    const plain = await router().plan(msg('שלום'), [route()]);
    assert.equal(plain.jobs.length, 3);
    assert.ok(plain.jobs.every((j) => !j.content.asStatus));
    const notControl = await router().plan(msg('!סטטוס שלום'), [route({ control: undefined })]);
    assert.ok(notControl.jobs.every((j) => !j.content.asStatus && j.content.text === '!סטטוס שלום'));
  });

  test('a photo with "!סטטוס" as caption: status photo without caption; with a schedule line too; the signature stays', async () => {
    const photo = await router().plan(msg('!סטטוס', 'image'), [route({ targets: [G1] })]);
    assert.equal(photo.jobs[0]!.content.asStatus, true);
    assert.equal(photo.jobs[0]!.content.text, '');
    const sched = await router().plan(msg('תזמון (14:30)\n!סטטוס ערב טוב'), [route({ targets: [G1], control: { reportMode: 'summary', signature: '— Groupush' } })]);
    assert.equal(sched.jobs[0]!.content.text, 'ערב טוב\n\n— Groupush');
    assert.equal(sched.jobs[0]!.content.asStatus, true);
    assert.ok(sched.jobs[0]!.scheduledAt);
    const empty = await router().plan(msg('!סטטוס   '), [route()]);
    assert.equal(empty.jobs.length, 0, 'nothing to post');
  });

  test('the WhatsApp message: marked isGroupStatus with a messageSecret, wrapped in groupStatusMessageV2 on the wire', () => {
    const secret = { messageSecret: Buffer.alloc(32, 1) };
    const marked = markGroupStatus({ extendedTextMessage: { text: 'שלום', backgroundArgb: 1 }, messageContextInfo: secret });
    assert.deepEqual(marked, { extendedTextMessage: { text: 'שלום', backgroundArgb: 1, contextInfo: { isGroupStatus: true } }, messageContextInfo: secret });
    assert.deepEqual(wrapGroupStatus(marked), {
      messageContextInfo: secret,
      groupStatusMessageV2: { message: { extendedTextMessage: { text: 'שלום', backgroundArgb: 1, contextInfo: { isGroupStatus: true } } } },
    });
    assert.equal(wrapGroupStatus(wrapGroupStatus(marked)).groupStatusMessageV2.message.groupStatusMessageV2, undefined, 'wrapping twice is safe');
    const conv = markGroupStatus({ conversation: 'היי' });
    assert.deepEqual(conv.extendedTextMessage, { text: 'היי', contextInfo: { isGroupStatus: true } });
    assert.equal(conv.messageContextInfo.messageSecret.length, 32, 'a secret is added when missing');
    const img = markGroupStatus({ imageMessage: { url: 'u', caption: 'c', contextInfo: { stanzaId: 'x' } } });
    assert.deepEqual(img.imageMessage.contextInfo, { stanzaId: 'x', isGroupStatus: true });
    // Ordinary messages pass the send hook untouched.
    const normal = { extendedTextMessage: { text: 'רגיל' } };
    assert.equal(wrapGroupStatus(normal), normal);
    assert.deepEqual(GROUP_STATUS_META, { tag: 'meta', attrs: { is_group_status: 'true', origin: 'group_status' } });
    assert.throws(() => markGroupStatus({ documentMessage: {} }));
    assert.deepEqual(toBaileysPayload({ kind: 'text', text: 'a', asStatus: true }), { text: 'a' }, 'the content itself is built as usual');
  });

  test('the control group is told the status went up', () => {
    const s = { total: 5, sent: 5, failed: 0, skipped: 0, cancelled: 0, unknown: 0, pending: 0, reasons: {}, failedTargets: [], cancelledReasons: {} } as any;
    assert.match(finalReportText('send', s, { status: true }), /✅ Groupush · הסטטוס הועלה בהצלחה ב-5 מתוך 5 קבוצות\./);
    assert.match(finalReportText('send', { ...s, sent: 4, failed: 1, failedTargets: ['קבוצה 3'] }, { status: true }), /⚠️ Groupush · הסטטוס עלה ב-4 מתוך 5 קבוצות\.\n1 לא הצליחו: קבוצה 3/);
    assert.match(finalReportText('send', s), /ההודעה נשלחה בהצלחה/);
  });
});
