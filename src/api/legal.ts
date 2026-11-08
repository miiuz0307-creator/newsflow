/**
 * The legal pages: terms of use (/terms), privacy policy (/privacy) and accessibility
 * statement (/accessibility). Plain Hebrew, same look as the site.
 *
 * Who runs the service comes from the server's environment, so the details can be filled in
 * or corrected without a code change:
 *   BUSINESS_NAME      e.g. "מיכאל ... – Groupush"
 *   BUSINESS_ID        e.g. "עוסק מורשה 123456789" / "ח.פ. 51-...."
 *   BUSINESS_ADDRESS   optional
 *   CONTACT_EMAIL      for questions, privacy requests and accessibility
 *   CONTACT_PHONE      optional
 *
 * Not legal advice: the texts are a careful starting point and should be reviewed by a lawyer.
 */
import { fontFaceCss } from './fonts.js';

/** Bumped whenever the terms or the privacy policy change in substance (stored with each signup). */
export const TERMS_VERSION = '2026-11-08.2';
const UPDATED = '8 בנובמבר 2026';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface Operator { name: string; id: string; address: string; email: string; phone: string }

export function operator(env: NodeJS.ProcessEnv = process.env): Operator {
  const clean = (v: string | undefined, max: number) => (v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
  const email = clean(env.CONTACT_EMAIL, 120);
  return {
    name: clean(env.BUSINESS_NAME, 120) || 'מפעיל שירות Groupush',
    id: clean(env.BUSINESS_ID, 80),
    address: clean(env.BUSINESS_ADDRESS, 160),
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '',
    phone: clean(env.CONTACT_PHONE, 30),
  };
}

/** The business number is shown only in the terms (where the law expects it), not on every page. */
function contactHtml(o: Operator, withId: boolean): string {
  const lines = [
    `<b>${esc(o.name)}</b>${withId && o.id ? ` · ${esc(o.id)}` : ''}`,
    o.address ? esc(o.address) : '',
    o.email ? `אימייל: <a href="mailto:${esc(o.email)}">${esc(o.email)}</a>` : '',
    o.phone ? `טלפון: <a href="tel:${esc(o.phone.replace(/[^\d+]/g, ''))}">${esc(o.phone)}</a>` : '',
  ].filter(Boolean);
  return `<p class="contact">${lines.join('<br>')}</p>`;
}

type Block = { h: string; p?: string[]; ul?: string[] };

function termsBlocks(o: Operator): Block[] {
  return [
    { h: '1. כללי', p: [
      `תנאים אלה חלים על השימוש באתר Groupush, באפליקציה ובשירות ההפצה ("השירות"), המופעלים על ידי ${esc(o.name)}${o.id ? ` (${esc(o.id)})` : ''} ("אנחנו"). פתיחת חשבון או שימוש בשירות מהווים הסכמה לתנאים ולמדיניות הפרטיות.`,
      'השירות מיועד לבני 18 ומעלה ולעסקים. התנאים כתובים בלשון זכר או רבים מטעמי נוחות, ומתייחסים לכל המגדרים.'] },
    { h: '2. מה השירות עושה', p: [
      'השירות מפיץ הודעות שנכתבות בקבוצת שליטה לקבוצות ולערוצים שהלקוח בחר, בוואטסאפ ובטלגרם, ומסנכרן עריכות ומחיקות. החיבור לוואטסאפ נעשה כמכשיר מקושר למספר שהלקוח חיבר, והחיבור לטלגרם באמצעות בוט של הלקוח.'] },
    { h: '3. אין קשר לוואטסאפ, מטא או טלגרם', p: [
      'Groupush הוא שירות עצמאי. הוא אינו קשור ל‑WhatsApp, ל‑Meta Platforms או ל‑Telegram, אינו מאושר ואינו ממומן על ידן. השמות שלהן מוזכרים רק כדי לתאר את השירות, והם שייכים לבעליהם.'] },
    { h: '4. סיכון לחסימת מספר הוואטסאפ', p: [
      'החיבור לוואטסאפ אינו דרך הממשק העסקי הרשמי של וואטסאפ. תנאי השימוש של וואטסאפ אוסרים הודעות אוטומטיות והמוניות, ולכן וואטסאפ עלולה להגביל או לחסום את המספר המחובר, בכל עת ובלי הודעה מראש.',
      'הלקוח מבין את הסיכון ומקבל אותו. אנחנו ממליצים לחבר מספר נפרד ולא את המספר האישי. איננו אחראים לחסימה, להגבלה או לאובדן של מספר, קבוצות, אנשי קשר או היסטוריה בעקבות השימוש.'] },
    { h: '5. אחריות הלקוח לתוכן ולשליחה', p: ['הלקוח לבדו אחראי לכל תוכן שנשלח דרך השירות ולכך שמותר לו לשלוח אותו. בפרט, הלקוח מתחייב:'],
      ul: [
        'לשלוח רק לקבוצות ולערוצים שהוא מנהל או שמותר לו לפרסם בהם, ובהתאם לכללי כל קבוצה.',
        'לא לשלוח "דבר פרסומת" לנמען שלא הסכים לקבלו, בניגוד לסעיף 30א לחוק התקשורת (בזק ושידורים), התשמ"ב‑1982.',
        'לא לשלוח תוכן לא חוקי, משמיץ, מאיים, מסית, פוגעני, מטעה, פורנוגרפי, או תוכן שפוגע בפרטיות, בזכויות יוצרים או בסימני מסחר של אחרים.',
        'לא להשתמש בשירות להטרדה, להונאה, להפצת נוזקות או לפגיעה בשירות, בוואטסאפ או בטלגרם.',
        'לשמור את פרטי הכניסה בסוד, ולהודיע לנו מיד על שימוש לא מורשה.',
      ] },
    { h: '6. שיפוי', p: [
      'הלקוח ישפה אותנו על כל נזק, הוצאה או תביעה של צד שלישי שנובעים מתוכן ששלח או מהפרת התנאים, ובכלל זה הוצאות משפט סבירות, בכפוף להודעה מצדנו ולאפשרות להתגונן.'] },
    { h: '7. מסלולים, מחירים ותשלום', ul: [
      'מסלול חינמי: עד 10 קבוצות וערוצי יעד. במסלול החינמי אנחנו מפרסמים מדי פעם הודעות של Groupush: בערוצי ובקבוצות הטלגרם שהלקוח חיבר, בהסכמתו כפי שניתנה בעת חיבור הטלגרם; ובקבוצות הוואטסאפ שאליהן הלקוח מפיץ, דרך המספר שחיבר, רק אם אישר זאת בנפרד באפליקציה. איננו מפרסמים בקבוצת השליטה או בקבוצות אחרות שהמספר חבר בהן. פרסום דרך מספר הוואטסאפ נשלח באותו קצב ובאותן מגבלות כמו ההודעות של הלקוח, וחלים עליו אותם סיכונים של חיבור לא רשמי שהלקוח אישר. אפשר לבטל את ההסכמה במעבר למסלול בתשלום, ולבקש מאיתנו להסיר פרסום מסוים.',
      'מסלול Premium: 300 ₪ לחודש, מחיר סופי (העסק הוא עוסק פטור ואינו גובה מע"מ), עד 30 קבוצות וערוצי יעד, בלי פרסומים של Groupush.',
      'מחירים ותכולת מסלולים עשויים להשתנות. שינוי במחיר של מנוי קיים ייכנס לתוקף רק אחרי הודעה מראש של 30 יום לפחות.',
    ] },
    { h: '8. ביטול', p: [
      'אפשר להפסיק את השימוש ולמחוק את החשבון בכל עת מתוך האפליקציה. מנוי בתשלום מבוטל בהודעה, והחיוב נפסק מתום תקופת החיוב שבה נמסרה ההודעה.',
      'צרכן רשאי לבטל עסקה ולקבל החזר בהתאם להוראות חוק הגנת הצרכן, התשמ"א‑1981, ותקנות הגנת הצרכן (ביטול עסקה), התשע"א‑2010, ככל שהן חלות.'] },
    { h: '9. זמינות השירות', p: [
      'אנחנו עושים מאמץ שהשירות יפעל ברציפות ובאמינות, אבל הוא ניתן "כמות שהוא" (AS IS) ואיננו מתחייבים שיפעל בלי הפסקות, שכל הודעה תגיע לכל קבוצה או שתגיע בזמן מסוים. השירות תלוי בוואטסאפ, בטלגרם ובספקי תשתית שאינם בשליטתנו, והם עשויים לשנות או להפסיק יכולות.',
      'מותר לנו לבצע תחזוקה ועדכונים, ולשנות, להוסיף או להסיר יכולות.'] },
    { h: '10. הגבלת אחריות', p: [
      'ככל שהדין מתיר: לא נהיה אחראים לנזק עקיף, תוצאתי או מיוחד, לאובדן רווחים, הכנסות, מוניטין או מידע, ולנזק שנגרם בגלל וואטסאפ, טלגרם, חסימת מספר, תוכן של לקוח או של צד שלישי, או כוח עליון.',
      'בכל מקרה, האחריות הכוללת שלנו כלפי לקוח מוגבלת לסכום ששילם לנו בשלושת החודשים שלפני האירוע. ההגבלות אינן חלות על נזק שנגרם בזדון או ברשלנות רבתי.'] },
    { h: '11. השעיה וסגירה', p: [
      'מותר לנו להשהות שליחה, להשעות או לסגור חשבון אם יש חשד סביר להפרת התנאים או הדין, לשימוש לרעה, או לסיכון לשירות או לאחרים. ככל שאפשר, נודיע על כך מראש או מיד לאחר מכן.'] },
    { h: '12. קניין רוחני', p: [
      'השירות, הקוד, העיצוב והסימנים של Groupush שייכים לנו. התוכן שהלקוח שולח שייך לו. הלקוח מעניק לנו רשות לעבד, לשמור לזמן הדרוש ולשלוח את התוכן רק לצורך מתן השירות.'] },
    { h: '13. פרטיות', p: ['השימוש במידע אישי מתואר ב<a href="/privacy">מדיניות הפרטיות</a>, שהיא חלק מהתנאים.'] },
    { h: '14. שינויים בתנאים', p: [
      'אנחנו עשויים לעדכן את התנאים. שינוי מהותי יפורסם באתר ויימסר ללקוחות מראש. המשך השימוש לאחר כניסת השינוי לתוקף מהווה הסכמה לו.'] },
    { h: '15. דין וסמכות שיפוט', p: [
      'על התנאים ועל השימוש בשירות חל הדין הישראלי בלבד. סמכות השיפוט הייחודית נתונה לבתי המשפט המוסמכים בישראל, בכפוף לזכויות שהדין מקנה לצרכן.'] },
  ];
}

function privacyBlocks(o: Operator): Block[] {
  return [
    { h: '1. מי אנחנו', p: [
      `מדיניות זו מסבירה איזה מידע ${esc(o.name)} ("אנחנו") אוסף בשירות Groupush, למה, למי הוא מועבר ומה הזכויות שלכם. היא נכתבה בהתאם לחוק הגנת הפרטיות, התשמ"א‑1981, ולתיקון 13 לחוק.`,
      'אינכם חייבים לפי חוק למסור לנו מידע, אבל בלי המידע המתואר כאן לא נוכל לתת את השירות.'] },
    { h: '2. איזה מידע נאסף', ul: [
      'פרטי חשבון: שם העסק או הקבוצה, אימייל, שם תצוגה, וסיסמה (נשמרת רק כגיבוב מוצפן, לא כטקסט).',
      'חיבור וואטסאפ: מספר הטלפון המחובר ומפתחות החיבור (נשמרים מוצפנים). רשימת הקבוצות של המספר, שמות הקבוצות, והמזהים של חברי הקבוצות כפי שוואטסאפ מעבירה אותם.',
      'חיבור טלגרם: פרטי הבוט והטוקן שלו (נשמר מוצפן), והערוצים והקבוצות שהבוט חבר בהם.',
      'תוכן: ההודעות, התמונות, הסרטונים והקבצים שנכתבים בקבוצות השליטה, והעותקים שנשלחו.',
      'נתוני שימוש: מתי ולאן נשלחה כל הודעה, מצב כל עותק, ואישורי קריאה מהקבוצות (במסלול שבו מוצגת כמות הקריאות).',
      'נתונים טכניים: כתובת IP, סוג הדפדפן או המכשיר, זמני כניסה, ומנוי להתראות בדפדפן אם אישרתם.',
    ] },
    { h: '3. למה אנחנו משתמשים במידע', ul: [
      'כדי לתת את השירות: להפיץ, לערוך ולמחוק הודעות, לדווח על מצב השליחה ולהציג סטטיסטיקה.',
      'אבטחה, מניעת שימוש לרעה, ותמיכה.',
      'הודעות שירות: התראות על ניתוק, על עצירת שליחה ועל עדכונים במערכת.',
      'עמידה בדרישות הדין.',
    ], p: ['איננו מוכרים מידע אישי, ואיננו משתמשים בתוכן ההודעות לפרסום או לפרופיל שיווקי.'] },
    { h: '4. כמה זמן המידע נשמר', ul: [
      'תוכן הודעות: נמחק אוטומטית אחרי 7 ימים. קבצי מדיה זמניים נמחקים אחרי כ‑30 שעות.',
      'פרטי החשבון והחיבורים: כל עוד החשבון פעיל. מחיקת החשבון מוחקת אותם.',
      'רישומים טכניים ורישומי אבטחה: לתקופה מוגבלת, לצורכי אבטחה ובירור תקלות.',
    ] },
    { h: '5. למי המידע מועבר', ul: [
      'WhatsApp (Meta) ו‑Telegram: ההודעות עוברות דרכן כדי להגיע לקבוצות, בהתאם לתנאים ולמדיניות שלהן.',
      'Railway: ספק האחסון והשרתים של השירות. השרתים ממוקמים בארצות הברית, ולכן המידע מועבר לחו"ל ונשמר שם, בכפוף להגנות חוזיות ולאמצעי אבטחה.',
      'שירותי ההתראות של הדפדפנים (Google, Apple, Mozilla, Microsoft), אם אישרתם התראות.',
      'רשויות מוסמכות, רק כשהדין מחייב.',
    ] },
    { h: '6. מידע על חברי הקבוצות שלכם', p: [
      'כשאתם מפיצים לקבוצות, אתם האחראים על הקבוצות ועל המידע שבהן, ואנחנו מעבדים את המידע בשמכם ולפי הוראותיכם. עליכם לוודא שיש לכם בסיס חוקי לשלוח לקבוצות ולעבד את המידע של חבריהן.'] },
    { h: '7. אבטחת מידע', p: [
      'אנחנו מגינים על המידע באמצעים מקובלים: הצפנה בתעבורה, הצפנה של מפתחות וטוקנים, הפרדה בין לקוחות ברמת מסד הנתונים, הגבלת ניסיונות כניסה, אימות דו‑שלבי לניהול ומחיקה אוטומטית של תוכן. שום מערכת אינה חסינה לחלוטין, ונודיע על אירוע אבטחה חמור כפי שהדין מחייב.'] },
    { h: '8. עוגיות ואחסון בדפדפן', p: [
      'אין באתר עוגיות פרסום או מעקב, ואין כלי סטטיסטיקה של צד שלישי. הדפדפן שומר אצלכם רק מה שנחוץ לפעולה: חיבור לחשבון והעדפות קטנות (למשל שבחרתם "לא עכשיו" בהצעת ההתקנה).'] },
    { h: '9. הזכויות שלכם', ul: [
      'לעיין במידע עליכם (סעיף 13 לחוק).',
      'לבקש לתקן מידע לא נכון, לא שלם או לא מדויק, או למחוק אותו (סעיף 14 לחוק).',
      'למחוק את החשבון וכל המידע שבו, מתוך האפליקציה או בפנייה אלינו.',
      'להפסיק לקבל התראות בכל עת מהגדרות הדפדפן או מהאפליקציה.',
      'להגיש תלונה לרשות להגנת הפרטיות.',
    ], p: ['בקשות מטפלים בהן תוך 30 יום. כדי להגן עליכם, ייתכן שנבקש לוודא שאתם בעלי החשבון.'] },
    { h: '10. קטינים', p: ['השירות אינו מיועד למי שטרם מלאו לו 18, ואיננו אוספים ביודעין מידע עליהם.'] },
    { h: '11. שינויים במדיניות', p: ['נעדכן כאן כל שינוי, עם תאריך העדכון. על שינוי מהותי נודיע ללקוחות מראש.'] },
  ];
}

function accessibilityBlocks(o: Operator): Block[] {
  return [
    { h: 'המחויבות שלנו', p: [
      'אנחנו רוצים שכל אחד יוכל להשתמש ב‑Groupush, כולל אנשים עם מוגבלות. האתר והאפליקציה נבנו כדי לעמוד בדרישות תקנות שוויון זכויות לאנשים עם מוגבלות (התאמות נגישות לשירות), התשע"ג‑2013, ובתקן הישראלי ת"י 5568, המבוסס על הנחיות WCAG 2.0 ברמה AA.'] },
    { h: 'מה עשינו', ul: [
      'מבנה תקין של כותרות, אזורים ורשימות, וקוד שמתאים לקוראי מסך.',
      'ניווט מלא במקלדת, עם סימון ברור של הרכיב שבפוקוס.',
      'טקסט חלופי לתמונות בעלות משמעות, והסתרה של עיטורים מקוראי מסך.',
      'ניגודיות צבעים מספקת וגופנים קריאים, ותצוגה שמתאימה לכל גודל מסך והגדלה עד 200%.',
      'מי שביקש מהמערכת "פחות תנועה" לא יראה אנימציות.',
      'הודעות מצב (למשל "ההודעה נשלחה") מוקראות אוטומטית בקוראי מסך.',
      'כתיבה מימין לשמאל ושפת עמוד מוגדרת לעברית.',
    ] },
    { h: 'מה עוד לא מושלם', p: [
      'ההדגמות המונפשות בדף הבית הן להמחשה, ואותו מידע כתוב גם בטקסט. תוכן שמגיע מוואטסאפ ומטלגרם (שמות קבוצות, הודעות) מוצג כפי שהוא. אם נתקלתם במשהו שלא נגיש, נשמח לדעת.'] },
    { h: 'פנייה בנושא נגישות', p: ['רכז הנגישות שלנו ישמח לעזור ולקבל הערות. נענה תוך 7 ימי עבודה.'] },
  ];
}

const PAGES: Record<string, { title: string; h1: string; blocks: (o: Operator) => Block[]; description: string }> = {
  terms: { title: 'תנאי שימוש | Groupush', h1: 'תנאי שימוש', blocks: termsBlocks, description: 'תנאי השימוש בשירות Groupush להפצת הודעות לקבוצות וואטסאפ וטלגרם.' },
  privacy: { title: 'מדיניות פרטיות | Groupush', h1: 'מדיניות פרטיות', blocks: privacyBlocks, description: 'איזה מידע Groupush אוסף, למה, כמה זמן הוא נשמר ומה הזכויות שלכם.' },
  accessibility: { title: 'הצהרת נגישות | Groupush', h1: 'הצהרת נגישות', blocks: accessibilityBlocks, description: 'הצהרת הנגישות של אתר ואפליקציית Groupush.' },
};

export const LEGAL_SLUGS = Object.keys(PAGES);

/** The links every page carries in its footer. */
export function legalLinksHtml(): string {
  return '<a href="/terms">תנאי שימוש</a><a href="/privacy">מדיניות פרטיות</a><a href="/accessibility">הצהרת נגישות</a>';
}
export const NOT_AFFILIATED = 'Groupush אינו קשור ל‑WhatsApp, ל‑Meta או ל‑Telegram, ואינו מאושר על ידן.';

export function legalHtml(slug: string, nonce: string, origin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const page = PAGES[slug];
  if (!page) return null;
  const o = operator(env);
  const blocks = page.blocks(o);
  // Paragraph text is our own fixed copy; only the operator details are escaped (they come from the environment).
  const body = blocks.map((b) => `<section><h2>${b.h}</h2>${(b.p ?? []).map((x) => `<p>${x}</p>`).join('')}${b.ul ? `<ul>${b.ul.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}</section>`).join('\n');
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title}</title>
<meta name="description" content="${page.description}">
<link rel="canonical" href="${origin}/${slug}">
<meta name="theme-color" content="#0A1B33">
<link rel="icon" type="image/png" href="/app/icon-192.png">
<style nonce="${nonce}">
${fontFaceCss()}
:root{--ink:#0A1B33;--teal:#19C6B4;--teal-deep:#0B8A7E;--muted:#5E6E86;--line:#DCE4EE;--paper:#F5F8FB}
*{box-sizing:border-box}
body{margin:0;font-family:"IBM Plex Sans Hebrew",system-ui,sans-serif;color:var(--ink);background:var(--paper);line-height:1.75;font-size:17px;-webkit-font-smoothing:antialiased}
a{color:var(--teal-deep)}
:focus-visible{outline:3px solid var(--teal);outline-offset:3px;border-radius:4px}
.top{background:var(--ink)}
.top div{max-width:860px;margin:0 auto;padding:0 22px;height:64px;display:flex;align-items:center;justify-content:space-between}
.brand{font-family:"Secular One",sans-serif;font-size:24px;color:#fff;text-decoration:none;display:flex;gap:9px;align-items:center}
.brand i{width:10px;height:10px;border-radius:50%;background:var(--teal);box-shadow:0 0 10px 2px rgba(25,198,180,.6)}
.top a.back{color:rgba(255,255,255,.8);text-decoration:none;font-size:15px}
main{max-width:860px;margin:0 auto;padding:34px 22px 50px}
.doc{background:#fff;border:1px solid var(--line);border-radius:20px;padding:30px clamp(18px,4vw,40px)}
h1{font-family:"Secular One",sans-serif;font-weight:400;font-size:clamp(30px,5vw,42px);margin:0}
.upd{color:var(--muted);font-size:15px;margin:6px 0 10px}
h2{font-family:"Secular One",sans-serif;font-weight:400;font-size:22px;margin:28px 0 8px}
p{margin:0 0 10px}
ul{margin:4px 0 12px;padding-inline-start:22px;display:grid;gap:6px}
.contact{background:var(--paper);border-radius:14px;padding:14px 16px;margin-top:10px}
footer{text-align:center;color:var(--muted);font-size:14px;padding:0 22px 34px}
footer a{margin:0 8px;color:var(--muted)}
</style>
</head>
<body>
<header class="top"><div><a class="brand" href="/"><i aria-hidden="true"></i>Groupush</a><a class="back" href="/">לדף הבית</a></div></header>
<main><article class="doc">
<h1>${page.h1}</h1>
<p class="upd">עודכן לאחרונה: ${UPDATED}</p>
${body}
<section><h2>יצירת קשר</h2><p>שאלות, בקשות בנושא פרטיות ונגישות, ופניות בכל נושא:</p>${contactHtml(o, slug === 'terms')}</section>
</article></main>
<footer><p>${NOT_AFFILIATED}</p><p>${legalLinksHtml()}</p></footer>
</body>
</html>`;
}
