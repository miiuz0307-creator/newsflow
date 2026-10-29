/**
 * Bold and other WhatsApp formatting arrive as formatting in Telegram, not as stars.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramAccount } from '../src/telegram/account.js';
import { TelegramBotApi } from '../src/telegram/botApi.js';
import { FakeTelegramServer } from '../src/telegram/fakeServer.js';
import { waToTelegramHtml } from '../src/telegram/format.js';

describe('WhatsApp formatting → Telegram', () => {
  test('marks become tags, the way WhatsApp reads them', () => {
    assert.equal(waToTelegramHtml('*מבזק:* פיגוע בצפון'), '<b>מבזק:</b> פיגוע בצפון');
    assert.equal(waToTelegramHtml('רגיל *מודגש* _נטוי_ ~מחוק~'), 'רגיל <b>מודגש</b> <i>נטוי</i> <s>מחוק</s>');
    assert.equal(waToTelegramHtml('*_שניהם_*'), '<b><i>שניהם</i></b>');
    assert.equal(waToTelegramHtml('*א* *ב*'), '<b>א</b> <b>ב</b>');
    assert.equal(waToTelegramHtml('> ציטוט\n> שני\nרגיל'), '<blockquote>ציטוט\nשני</blockquote>\nרגיל');
    assert.equal(waToTelegramHtml('קוד `*לא*`'), 'קוד <code>*לא*</code>');
  });

  test('what WhatsApp does not format stays as typed, and HTML is escaped', () => {
    assert.equal(waToTelegramHtml('2*3*4 a*b*c'), '2*3*4 a*b*c');
    assert.equal(waToTelegramHtml('* פריט\n* פריט'), '* פריט\n* פריט');
    assert.equal(waToTelegramHtml('* לא *'), '* לא *');
    assert.equal(waToTelegramHtml('snake_case_name'), 'snake_case_name');
    assert.equal(waToTelegramHtml('https://x.com/a_b/_c_ *כן*'), 'https://x.com/a_b/_c_ <b>כן</b>');
    assert.equal(waToTelegramHtml('<b>x</b> & *y*'), '&lt;b&gt;x&lt;/b&gt; &amp; <b>y</b>');
  });

  describe('sending', () => {
    const srv = new FakeTelegramServer();
    let acc: TelegramAccount;
    let chan = 0;
    before(async () => {
      await srv.start();
      acc = new TelegramAccount({ tenantId: 't1', accountId: 'b1', api: new TelegramBotApi(srv.token, { apiBase: srv.url }), onMessage: () => {}, pollTimeoutSec: 0 });
      await acc.verify();
      chan = srv.createChat('ערוץ', 'channel');
      srv.addBot(chan, 'administrator', { can_post_messages: true });
    });
    after(() => srv.stop());

    test('a bold message and its edit arrive formatted; plain text is sent plain', async () => {
      const r = await acc.send(String(chan), { kind: 'text', text: '*מבזק* חדשות' });
      const post = srv.posts(chan).find((p) => String(p.message_id) === r.messageId) as any;
      assert.equal(post.text, 'מבזק חדשות', 'no stars');
      assert.equal(post.html, '<b>מבזק</b> חדשות');
      await acc.edit(String(chan), r.messageId, { kind: 'text', text: '*מבזק* חדשות _מעודכן_' });
      assert.equal(post.text, 'מבזק חדשות מעודכן');
      const plain = await acc.send(String(chan), { kind: 'text', text: 'רגיל <ok>' });
      const p2 = srv.posts(chan).find((p) => String(p.message_id) === plain.messageId) as any;
      assert.equal(p2.text, 'רגיל <ok>');
      assert.equal(p2.html, undefined);
    });

    test('if Telegram refuses the formatting, the plain text still goes out', async () => {
      const text = '*א _ב* ג_';
      assert.match(waToTelegramHtml(text), /<b>.*<i>.*<\/b>.*<\/i>/, 'crossed marks make crossed tags');
      const r = await acc.send(String(chan), { kind: 'text', text });
      const post = srv.posts(chan).find((p) => String(p.message_id) === r.messageId) as any;
      assert.equal(post.text, text);
    });

        test('a caption on a photo is formatted too', async () => {
      const r = await acc.send(String(chan), { kind: 'image', text: '*כותרת*', media: { mimeType: 'image/jpeg', data: Buffer.from('img') } });
      const post = srv.posts(chan).find((p) => String(p.message_id) === r.messageId) as any;
      assert.equal(post.caption, 'כותרת');
    });
  });
});
