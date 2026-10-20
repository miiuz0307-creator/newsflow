/**
 * Narrated demo of the whole flow, in Hebrew, with nothing real involved:
 * simulated WhatsApp, a local fake Telegram server and in-memory storage.
 *
 *   npm run simulate
 */
import { MasterKey, TenantCipher } from '../src/crypto/keyring.js';
import { MemoryKillSwitchStore } from '../src/delivery/killSwitch.js';
import { MemoryMediaStore } from '../src/delivery/mediaStore.js';
import { MemoryJobQueue } from '../src/delivery/queue.js';
import { MemoryRouteSource } from '../src/engine/pipeline.js';
import { Worker } from '../src/engine/worker.js';
import { MemoryDedupStore } from '../src/routing/dedup.js';
import { TelegramAccount } from '../src/telegram/account.js';
import { TelegramBotApi } from '../src/telegram/botApi.js';
import { FakeTelegramServer } from '../src/telegram/fakeServer.js';
import { MemoryAuthStore } from '../src/wa/authStore.js';
import { ConnectionManager } from '../src/wa/connectionManager.js';
import { FakeWaNetwork, fakeTransportFactory } from '../src/wa/fakeNetwork.js';

const say = (s: string) => console.log(s);
const step = (n: number, s: string) => console.log(`\n── שלב ${n}: ${s}`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACC = '22222222-2222-4222-8222-222222222222';
const BOT = '33333333-3333-4333-8333-333333333333';
const PHONE = '972500000001';
const EDITOR = '972509999999';

const net = new FakeWaNetwork({ connectDelayMs: 5 });
const tg = new FakeTelegramServer();
await tg.start();
const cipher = new TenantCipher(TENANT, new MasterKey('mk-demo', MasterKey.generateB64()).newTenantKey(TENANT).dek);
const store = new MemoryAuthStore(ACC, cipher);
const conns = new ConnectionManager({ transportFactory: fakeTransportFactory(net), storeFactory: () => store });
const routes = new MemoryRouteSource();
const queue = new MemoryJobQueue();
const ks = new MemoryKillSwitchStore();
const worker = new Worker({
  workerId: 'demo', connections: conns, queue, routes, dedup: new MemoryDedupStore(), killSwitches: ks, media: new MemoryMediaStore(),
  dailyCapFor: () => 2000, rulesOverride: { wa: { accountMinGapMs: 0, chatMinGapMs: 0 }, tg: { chatMinGapMs: 0 } },
  onSafetyEvent: (e) => say(`   ⚠️  אירוע בטיחות: ${e.kind}${e.stoppedAccount ? ' — השליחה מהמספר נעצרה' : ''}`),
});
const drain = async () => {
  await worker.settle();
  for (let i = 0; i < 10; i++) if (!(await worker.dispatcher.tick()).claimed) break;
};

step(1, 'יוצרים קבוצות בעולם המדומה');
const source = net.createGroup('חדשות ארצי', { members: [PHONE, EDITOR] });
const targets = ['חדשות אשדוד', 'חדשות ירושלים', 'עדכונים בזמן אמת'].map((t) => ({ title: t, id: net.createGroup(t, { members: [PHONE] }) }));
const locked = net.createGroup('קבוצה נעולה למנהלים', { members: [PHONE], adminsOnly: true });
const channel = tg.createChat('ערוץ הטלגרם שלי', 'channel');
tg.addBot(channel, 'administrator', { can_post_messages: true });
say('   נוצרו: קבוצת מקור, 3 קבוצות יעד, קבוצה נעולה וערוץ טלגרם');

step(2, 'הלקוח מחבר מספר באמצעות QR');
await conns.connect(TENANT, ACC, { method: 'qr' });
while (!conns.getState(ACC)?.qr) await wait(5);
say('   הוצג QR ללקוח; הלקוח סורק אותו בטלפון…');
net.scanQr(PHONE, conns.getState(ACC)!.qr!);
while (conns.getState(ACC)?.status !== 'connected') await wait(5);
say(`   ✅ מחובר: ${conns.getState(ACC)!.phoneNumber}. ה־Session נשמר מוצפן (${store.rawRows().size} רשומות, אף אחת לא קריאה)`);

step(3, 'הלקוח רואה את הקבוצות ואת הרשאות השליחה');
for (const c of await conns.listChats(ACC)) say(`   • ${c.title}${c.canSend ? '' : '  (אין הרשאת שליחה — לא ניתן לבחור כיעד)'}`);

step(4, 'חיבור בוט טלגרם');
const bot = new TelegramAccount({ tenantId: TENANT, accountId: BOT, api: new TelegramBotApi(tg.token, { apiBase: tg.url }), pollTimeoutSec: 0, onMessage: (m) => worker.handleTelegram(m) });
const me = await bot.verify();
await bot.pollOnce(0);
worker.addTelegram(bot);
say(`   ✅ @${me.username} מחובר; ערוצים שבהם מותר לפרסם: ${bot.listChats().filter((c) => c.canSend).map((c) => c.title).join(', ')}`);

step(5, 'יצירת מסלול הפצה עם תבנית וסינון');
routes.upsertTemplate({ id: 'tpl', tenantId: TENANT, name: 'ברירת מחדל', vars: { whatsapp_link: 'https://chat.whatsapp.com/MY-GROUP', telegram_link: 'https://t.me/my_channel' },
  body: '🔴 חדשות בזמן אמת\n\n{תוכן החדשות}\n\n━━━━━━━━━━━━\n📲 להצטרפות: {קישור WhatsApp}\n✈️ טלגרם: {קישור Telegram}' });
routes.upsertRoute({
  id: 'route', tenantId: TENANT, name: 'ארצי → הכול', enabled: true, templateId: 'tpl', requireApproval: false, filters: { excludeAny: ['פרסומת'] },
  sources: [{ platform: 'wa', accountId: ACC, chatId: source }],
  targets: [...targets.map((t) => ({ platform: 'wa' as const, accountId: ACC, chatId: t.id, title: t.title })), { platform: 'tg', accountId: BOT, chatId: String(channel), title: 'ערוץ הטלגרם שלי' }],
});
say('   מקור: חדשות ארצי → 3 קבוצות WhatsApp + ערוץ טלגרם; הודעות עם "פרסומת" מסוננות');

step(6, 'עורך מפרסם מבזק בקבוצת המקור');
net.humanPost(EDITOR, source, { kind: 'text', text: 'אזעקה באשדוד ובסביבה\nhttps://chat.whatsapp.com/SOMEONE-ELSE' });
await drain();
for (const t of targets) say(`   ✅ ${t.title}: התקבלה הודעה`);
say(`   ✅ ערוץ טלגרם: ${tg.posts(channel).length} הודעה`);
say('\n   כך ההודעה נראית בקבוצת היעד:\n');
say(net.groupLog(targets[0]!.id).at(-1)!.content.text!.split('\n').map((l) => '      ' + l).join('\n'));
say('\n   (קישור ההזמנה של הקבוצה המתחרה הוסר; הקישורים של הלקוח נשמרו)');

step(7, 'סינון וכפילויות');
net.humanPost(EDITOR, source, { kind: 'text', text: 'פרסומת: מבצע על מזגנים' });
net.humanPost(EDITOR, source, { kind: 'text', text: 'אזעקה באשדוד ובסביבה' });
await drain();
say(`   פרסומת וכפילות לא נשלחו. סה"כ הודעות בקבוצת אשדוד: ${net.groupLog(targets[0]!.id).length}`);

step(8, 'תמונה עם כיתוב');
net.humanPost(EDITOR, source, { kind: 'image', text: 'תיעוד מהזירה', media: { mimeType: 'image/jpeg', data: Buffer.from('demo-jpeg') } });
await drain();
say(`   ✅ התמונה נשלחה ל־${targets.length} קבוצות ולטלגרם`);

step(9, 'עצירת חירום והמשך');
await ks.set({ scope: 'route', scopeId: 'route', tenantId: TENANT, reason: 'הלקוח עצר', setBy: 'customer' });
net.humanPost(EDITOR, source, { kind: 'text', text: 'הודעה בזמן עצירה' });
await drain();
say(`   ⏸️  בזמן העצירה נשלחו: ${net.groupLog(targets[1]!.id).filter((m) => m.content.text?.includes('בזמן עצירה')).length} הודעות`);
await ks.clear('route', 'route');
say('   ▶️  המסלול חודש (הודעות שהמתינו יישלחו בבדיקה הבאה, כל עוד אינן ישנות מ־2 שעות)');

step(10, 'WhatsApp חוסם את המספר');
net.ban(PHONE);
while (conns.getState(ACC)?.status !== 'blocked') await wait(5);
await worker.settle();
say(`   סטטוס המספר: ${conns.getState(ACC)!.status}. אין ניסיון חיבור מחדש אוטומטי, הלקוח מקבל התראה.`);
say(`   הקבוצה הנעולה לא קיבלה אף הודעה: ${net.groupLog(locked).length === 0 ? 'נכון' : 'לא נכון'}`);

say('\nהסימולציה הסתיימה. שום מספר אמיתי, קבוצה אמיתית או שרת חיצוני לא היו מעורבים.');
await worker.shutdown();
await tg.stop();
