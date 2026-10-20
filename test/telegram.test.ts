import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { InboundMessage } from '../src/core/types.js';
import { TelegramAccount } from '../src/telegram/account.js';
import { TelegramBotApi, isValidBotToken, mapTelegramError } from '../src/telegram/botApi.js';
import { FakeTelegramServer } from '../src/telegram/fakeServer.js';
import { waitFor } from './helpers.js';

describe('Telegram — pure', () => {
  test('token format', () => {
    assert.equal(isValidBotToken('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1'), true);
    assert.equal(isValidBotToken('abc'), false);
    assert.equal(isValidBotToken('123:short'), false);
  });

  test('refuses the real API without approval', () => {
    assert.throws(() => new TelegramBotApi('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1'), /disabled/);
    assert.doesNotThrow(() => new TelegramBotApi('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1', { allowReal: true }));
  });

  test('error mapping', () => {
    const r = mapTelegramError('sendMessage', 429, 'Too Many Requests', { retry_after: 12 });
    assert.equal(r.kind, 'rate_limited');
    assert.equal(r.retryAfterMs, 12_000);
    assert.equal(mapTelegramError('x', 401, 'Unauthorized').kind, 'account_blocked');
    assert.equal(mapTelegramError('x', 403, 'Forbidden: bot was kicked').kind, 'forbidden');
    assert.equal(mapTelegramError('x', 400, 'Bad Request: chat not found').kind, 'not_found');
    assert.equal(mapTelegramError('x', 400, 'Bad Request: need administrator rights in the channel chat').kind, 'forbidden');
    assert.equal(mapTelegramError('x', 400, 'Bad Request: message text is empty').kind, 'invalid');
    assert.equal(mapTelegramError('x', 502, 'Bad Gateway').kind, 'transient');
  });
});

describe('Telegram — against the local fake server', () => {
  const srv = new FakeTelegramServer();
  let api: TelegramBotApi;

  before(async () => {
    await srv.start();
    api = new TelegramBotApi(srv.token, { apiBase: srv.url });
  });
  after(() => srv.stop());

  function account(received: InboundMessage[] = []) {
    return new TelegramAccount({ tenantId: 't1', accountId: 'bot-row-1', api, onMessage: (m) => received.push(m), pollTimeoutSec: 0 });
  }

  test('verifies the bot', async () => {
    const acc = account();
    const me = await acc.verify();
    assert.equal(me.username, 'news_test_bot');
  });

  test('learns chats when added, with posting rights', async () => {
    const group = srv.createChat('קבוצת חדשות');
    const chanNoRights = srv.createChat('ערוץ', 'channel');
    const chanAdmin = srv.createChat('ערוץ שלי', 'channel');
    srv.addBot(group, 'member');
    srv.addBot(chanNoRights, 'member');
    srv.addBot(chanAdmin, 'administrator', { can_post_messages: true });
    const acc = account();
    await acc.verify();
    await acc.pollOnce(0);
    const byId = new Map(acc.listChats().map((c) => [Number(c.ref.chatId), c]));
    assert.equal(byId.get(group)?.canSend, true);
    assert.equal(byId.get(chanNoRights)?.canSend, false);
    assert.equal(byId.get(chanAdmin)?.canSend, true);
    assert.equal(byId.get(chanAdmin)?.type, 'channel');
    srv.removeBot(group);
    await acc.pollOnce(0);
    assert.equal(acc.listChats().some((c) => Number(c.ref.chatId) === group), false);
  });

  test('receives text and photos; downloads media on demand', async () => {
    const g = srv.createChat('מקור טלגרם');
    srv.addBot(g);
    const got: InboundMessage[] = [];
    const acc = account(got);
    await acc.verify();
    srv.userPost(g, { text: 'מבזק מטלגרם' });
    srv.userPost(g, { photo: Buffer.from('PNGDATA'), caption: 'תמונה' });
    await acc.pollOnce(0);
    const mine = got.filter((m) => Number(m.source.chatId) === g);
    assert.equal(mine.length, 2);
    assert.equal(mine[0]!.content.text, 'מבזק מטלגרם');
    assert.equal(mine[1]!.content.kind, 'image');
    assert.equal((await mine[1]!.content.media!.load!()).toString(), 'PNGDATA');
    // offset advanced: nothing new on the next poll
    const before = got.length;
    await acc.pollOnce(0);
    assert.equal(got.length, before);
  });

  test('sends text and uploads media', async () => {
    const g = srv.createChat('יעד טלגרם');
    srv.addBot(g);
    const acc = account();
    const r = await acc.send(String(g), { kind: 'text', text: 'שלום' });
    assert.ok(Number(r.messageId) > 0);
    await acc.send(String(g), { kind: 'image', text: 'כיתוב', media: { mimeType: 'image/jpeg', data: Buffer.from('JPEG') } });
    const posts = srv.posts(g);
    assert.equal(posts[0]!.text, 'שלום');
    assert.equal(posts[1]!.caption, 'כיתוב');
    assert.ok(posts[1]!.photo?.length);
  });

  test('maps failures: not a member, channel without rights, rate limit, revoked token', async () => {
    const acc = account();
    const notIn = srv.createChat('לא חבר');
    await assert.rejects(acc.send(String(notIn), { kind: 'text', text: 'x' }), { kind: 'forbidden' });
    const chan = srv.createChat('ערוץ בלי הרשאה', 'channel');
    srv.addBot(chan, 'member');
    await assert.rejects(acc.send(String(chan), { kind: 'text', text: 'x' }), { kind: 'forbidden' });
    await assert.rejects(acc.send('-1', { kind: 'text', text: 'x' }), { kind: 'not_found' });
    const busy = srv.createChat('עמוסה');
    srv.addBot(busy);
    srv.setRateLimit(busy, 1, 60_000);
    await acc.send(String(busy), { kind: 'text', text: '1' });
    await assert.rejects(acc.send(String(busy), { kind: 'text', text: '2' }), (e: any) => e.kind === 'rate_limited' && e.retryAfterMs === 7000);
    await assert.rejects(acc.send(String(busy), { kind: 'text', text: '' }), { kind: 'invalid' });
  });

  test('a revoked token stops the polling loop', async () => {
    const s2 = new FakeTelegramServer();
    await s2.start();
    const acc = new TelegramAccount({ tenantId: 't1', accountId: 'b2', api: new TelegramBotApi(s2.token, { apiBase: s2.url }), pollTimeoutSec: 0 });
    await acc.start();
    s2.revokeToken();
    await waitFor(() => (acc as any).running === false, 2000, 'loop stopped');
    await acc.stop();
    await s2.stop();
  });
});
