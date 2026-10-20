import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { InboundMessage } from '../src/core/types.js';
import { MemoryDedupStore } from '../src/routing/dedup.js';
import { Router, checkFilters, inQuietHours, nextAllowedTime, validateRoute } from '../src/routing/router.js';
import { placeholdersOf, renderTemplate } from '../src/routing/template.js';
import { contentFingerprint, normalizeForMatch, removeInviteLinks } from '../src/routing/text.js';
import type { Route, Template } from '../src/routing/types.js';

const SRC = { platform: 'wa' as const, accountId: 'acc1', chatId: 'src@g.us' };
const T1 = { platform: 'wa' as const, accountId: 'acc1', chatId: 't1@g.us', title: 'חדשות אשדוד' };
const T2 = { platform: 'tg' as const, accountId: 'bot1', chatId: '-100123', title: 'ערוץ הטלגרם' };

function msg(text: string, over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    tenantId: 'ten1',
    source: SRC,
    messageId: `m${Math.random()}`,
    senderId: 'x',
    fromSelf: false,
    isForwarded: false,
    receivedAt: new Date(),
    content: { kind: 'text', text },
    ...over,
  };
}

function route(over: Partial<Route> = {}): Route {
  return { id: 'r1', tenantId: 'ten1', name: 'r', enabled: true, sources: [SRC], targets: [T1, T2], filters: {}, requireApproval: false, ...over };
}

const SPEC_TEMPLATE: Template = {
  id: 'tpl1',
  tenantId: 'ten1',
  name: 'spec',
  body: '🔴 חדשות בזמן אמת\n\n{תוכן החדשות}\n\n━━━━━━━━━━━━\n\n📲 להצטרפות לקבוצת החדשות:\n{קישור WhatsApp}\n\n✈️ לערוץ הטלגרם:\n{קישור Telegram}\n\n━━━━━━━━━━━━\n\nעדכונים מסביב לשעון',
  vars: { whatsapp_link: 'https://chat.whatsapp.com/MINE', telegram_link: 'https://t.me/mine' },
};

function router(templates: Template[] = [SPEC_TEMPLATE], now = () => new Date('2026-10-20T10:00:00Z')) {
  return new Router({ dedup: new MemoryDedupStore(), templates: (_t, id) => templates.find((t) => t.id === id), now });
}

describe('text helpers', () => {
  test('normalization ignores niqqud, case, direction marks, whitespace', () => {
    assert.equal(normalizeForMatch('  שָׁלוֹם‏   WORLD '), 'שלום world');
  });
  test('removes invite links, keeps other links', () => {
    const t = 'מבזק\nhttps://chat.whatsapp.com/AbC123\nt.me/+xyz\nhttps://ynet.co.il/a';
    assert.equal(removeInviteLinks(t), 'מבזק\n\nhttps://ynet.co.il/a');
  });
  test('fingerprint ignores links and formatting', () => {
    assert.equal(contentFingerprint('פיצוץ בנמל  ', undefined), contentFingerprint('פיצוץ בנמל\nhttps://chat.whatsapp.com/X1', undefined));
    assert.notEqual(contentFingerprint('a', { mimeType: 'image/jpeg', size: 1 }), contentFingerprint('a', undefined));
  });
});

describe('templates', () => {
  test('renders the spec template with Hebrew placeholders', () => {
    const r = renderTemplate(SPEC_TEMPLATE, { content: 'אזעקה באשדוד', platform: 'wa', isCaption: false });
    assert.ok(r.text.startsWith('🔴 חדשות בזמן אמת\n\nאזעקה באשדוד'));
    assert.ok(r.text.includes('https://chat.whatsapp.com/MINE'));
    assert.ok(r.text.includes('https://t.me/mine'));
    assert.deepEqual(r.unknown, []);
  });
  test('reports unknown placeholders', () => {
    const r = renderTemplate({ body: '{content} {מספר טלפון}', vars: {} }, { content: 'x', platform: 'wa', isCaption: false });
    assert.deepEqual(r.unknown, ['מספר_טלפון']);
  });
  test('group name, date and time', () => {
    const r = renderTemplate({ body: '{שם הקבוצה} {date} {time}', vars: {} }, {
      content: '', groupName: 'חדשות ירושלים', now: new Date('2026-10-20T10:05:00Z'), platform: 'wa', isCaption: false,
    });
    assert.equal(r.text, 'חדשות ירושלים 20.10.2026 13:05');
  });
  test('shortens only the content to fit Telegram limits', () => {
    const long = 'א'.repeat(5000);
    const r = renderTemplate(SPEC_TEMPLATE, { content: long, platform: 'tg', isCaption: false });
    assert.equal(r.truncated, true);
    assert.ok([...r.text].length <= 4096);
    assert.ok(r.text.includes('https://t.me/mine'), 'footer must survive');
    const cap = renderTemplate(undefined, { content: long, platform: 'wa', isCaption: true });
    assert.ok([...cap.text].length <= 1024);
  });
  test('lists placeholders', () => {
    assert.deepEqual(placeholdersOf(SPEC_TEMPLATE.body).sort(), ['content', 'telegram_link', 'whatsapp_link']);
  });
});

describe('filters', () => {
  test('own messages are ignored by default (loop guard)', () => {
    assert.equal(checkFilters({}, msg('x', { fromSelf: true })), 'from_self');
    assert.equal(checkFilters({ ignoreFromSelf: false }, msg('x', { fromSelf: true })), null);
  });
  test('kinds, keywords, length, forwarded', () => {
    assert.equal(checkFilters({ kinds: ['image'] }, msg('x')), 'kind_not_allowed');
    assert.equal(checkFilters({ includeAny: ['אשדוד'] }, msg('אזעקה בירושלים')), 'missing_keyword');
    assert.equal(checkFilters({ includeAny: ['אשדוד'] }, msg('אזעקה באַשְׁדּוֹד')), null);
    assert.equal(checkFilters({ excludeAny: ['פרסומת'] }, msg('פרסומת: מבצע')), 'excluded_keyword');
    assert.equal(checkFilters({ minTextLength: 5 }, msg('👍')), 'too_short');
    assert.equal(checkFilters({ ignoreForwarded: true }, msg('x', { isForwarded: true })), 'forwarded');
    assert.equal(checkFilters({}, msg('x', { content: { kind: 'sticker' } })), 'kind_not_allowed');
  });
});

describe('router', () => {
  test('one message fans out to all targets with the template', async () => {
    const plan = await router().plan(msg('אזעקה באשדוד https://chat.whatsapp.com/THEIRS'), [route({ templateId: 'tpl1' })]);
    assert.equal(plan.jobs.length, 2);
    const wa = plan.jobs.find((j) => j.target.platform === 'wa')!;
    assert.ok(wa.content.text!.includes('אזעקה באשדוד'));
    assert.ok(!wa.content.text!.includes('THEIRS'), 'competitor invite link removed');
    assert.ok(wa.content.text!.includes('chat.whatsapp.com/MINE'), 'own link kept');
  });

  test('same news from a second source is not sent twice', async () => {
    const r = router();
    const SRC2 = { ...SRC, chatId: 'src2@g.us' };
    const routes = [route({ sources: [SRC, SRC2] })];
    const a = await r.plan(msg('פיצוץ בנמל'), routes);
    const b = await r.plan(msg('פיצוץ בנמל', { source: SRC2 }), routes);
    assert.equal(a.jobs.length, 2);
    assert.equal(b.jobs.length, 0);
    assert.equal(b.skipped.filter((s) => s.reason === 'duplicate').length, 2);
  });

  test('idempotency key is stable for the same inbound message', async () => {
    const m = msg('x1');
    const a = await router().plan(m, [route()]);
    const b = await router().plan(m, [route()]);
    assert.deepEqual(a.jobs.map((j) => j.idempotencyKey), b.jobs.map((j) => j.idempotencyKey));
  });

  test('never routes across tenants or into the source itself', async () => {
    const plan = await router().plan(msg('x'), [route({ tenantId: 'other' }), route({ id: 'r2', targets: [SRC, T1] })]);
    assert.equal(plan.jobs.length, 1);
    assert.equal(plan.jobs[0]!.target.chatId, 't1@g.us');
  });

  test('disabled route, approval flag, delay', async () => {
    const p1 = await router().plan(msg('a'), [route({ enabled: false })]);
    assert.deepEqual(p1.skipped.map((s) => s.reason), ['route_disabled']);
    const p2 = await router().plan(msg('b'), [route({ requireApproval: true, delaySeconds: 30 })]);
    assert.equal(p2.jobs[0]!.requiresApproval, true);
    assert.equal(p2.jobs[0]!.notBefore.toISOString(), '2026-10-20T10:00:30.000Z');
  });

  test('media keeps its bytes and gets a caption-sized template', async () => {
    const media = { mimeType: 'image/jpeg', size: 10, data: Buffer.from('img') };
    const plan = await router().plan(msg('', { content: { kind: 'image', text: 'כיתוב', media } }), [route({ templateId: 'tpl1' })]);
    assert.equal(plan.jobs[0]!.content.media?.data?.toString(), 'img');
    assert.ok(plan.jobs[0]!.content.text!.includes('כיתוב'));
  });

  test('text that is only an invite link is dropped', async () => {
    const plan = await router().plan(msg('https://chat.whatsapp.com/ABC'), [route()]);
    assert.deepEqual(plan.skipped.map((s) => s.reason), ['empty_after_cleanup']);
  });
});

describe('quiet hours', () => {
  const q = { start: '23:00', end: '06:00', timeZone: 'Asia/Jerusalem' };
  test('window across midnight', () => {
    assert.equal(inQuietHours(new Date('2026-10-20T21:30:00Z'), q), true); // 00:30 local
    assert.equal(inQuietHours(new Date('2026-10-20T10:00:00Z'), q), false); // 13:00 local
  });
  test('pushes sends to the end of the window', () => {
    const t = nextAllowedTime(new Date('2026-10-20T21:30:00Z'), q);
    assert.equal(t.toISOString(), '2026-10-21T03:00:00.000Z'); // 06:00 local (UTC+3)
  });
  test('router applies quiet hours', async () => {
    const r = router([], () => new Date('2026-10-20T21:30:00Z'));
    const plan = await r.plan(msg('לילה'), [route({ quietHours: q })]);
    assert.equal(plan.jobs[0]!.notBefore.toISOString(), '2026-10-21T03:00:00.000Z');
  });
});

describe('route validation', () => {
  const chats = new Map([
    ['wa:acc1:src@g.us', { canSend: true, title: 'מקור' }],
    ['wa:acc1:t1@g.us', { canSend: true, title: 'יעד' }],
    ['wa:acc1:locked@g.us', { canSend: false, title: 'נעולה' }],
  ]);
  const ctx = { chats, ownAccounts: new Set(['acc1']), maxTargets: 2 };
  test('valid route has no problems', () => {
    assert.deepEqual(validateRoute({ sources: [SRC], targets: [T1] }, ctx), []);
  });
  test('catches each problem', () => {
    const codes = (r: Parameters<typeof validateRoute>[0]) => validateRoute(r, ctx).map((p) => p.code).sort();
    assert.deepEqual(codes({ sources: [], targets: [] }), ['no_sources', 'no_targets']);
    assert.deepEqual(codes({ sources: [SRC], targets: [{ ...SRC }] }), ['target_is_source']);
    assert.deepEqual(codes({ sources: [SRC], targets: [{ ...SRC, chatId: 'locked@g.us' }] }), ['cannot_send']);
    assert.deepEqual(codes({ sources: [SRC], targets: [{ ...SRC, accountId: 'acc-of-someone-else' }] }), ['foreign_account']);
    assert.deepEqual(codes({ sources: [SRC], targets: [T1, { ...SRC, chatId: 'x@g.us' }, { ...SRC, chatId: 'y@g.us' }] }), ['too_many_targets', 'unknown_chat', 'unknown_chat']);
    assert.deepEqual(codes({ sources: [SRC], targets: [T1], quietHours: { start: '25:99x', end: '06:00', timeZone: 'Asia/Jerusalem' } }), ['bad_quiet_hours']);
  });
});
