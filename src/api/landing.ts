/**
 * Topic pages for search engines: each answers one thing people search for ("מערכת שליחה
 * אוטומטית", "שליחת הודעה לכמה קבוצות וואטסאפ", "תזמון הודעות בוואטסאפ" ...), in plain Hebrew,
 * with the same facts as the home page. Same look as the site, strict CSP (nonce), no scripts
 * apart from the install offer and the animated logo.
 */
import { fontFaceCss } from './fonts.js';
import { installPromptCss, installPromptHtml, installPromptJs } from './installPrompt.js';

export interface LandingPage {
  slug: string;
  /** <title>, about 60 characters. */
  title: string;
  description: string;
  h1: string;
  intro: string;
  sections: { h2: string; body: string[]; list?: string[] }[];
  faq: [string, string][];
}

export const LANDING_PAGES: LandingPage[] = [
  {
    slug: 'automatic-sending',
    title: 'מערכת שליחה אוטומטית לקבוצות וואטסאפ וטלגרם | Groupush',
    description: 'מערכת שליחה אוטומטית שמפיצה כל הודעה מקבוצת שליטה אחת לכל קבוצות הוואטסאפ וערוצי הטלגרם שלכם, עם עריכה ומחיקה מסונכרנות ותזמון. מתחילים בחינם.',
    h1: 'מערכת שליחה אוטומטית לקבוצות וואטסאפ וטלגרם',
    intro: 'Groupush היא מערכת שליחה אוטומטית: כותבים הודעה אחת בקבוצת שליטה בוואטסאפ, והמערכת שולחת אותה לבד לכל הקבוצות והערוצים שבחרתם. בלי להעתיק, בלי להדביק ובלי לפספס קבוצה.',
    sections: [
      { h2: 'איך השליחה האוטומטית עובדת', body: ['מחברים מספר וואטסאפ בסריקת קוד, כמו בוואטסאפ ווב. פותחים קבוצת שליטה קטנה ובוחרים לאן היא מפיצה. מאותו רגע, כל מה שנכתב בקבוצת השליטה יוצא אוטומטית לכל קבוצות היעד.'],
        list: ['טקסט, תמונות, סרטונים, קבצים והקלטות', 'וואטסאפ וטלגרם מאותה קבוצת שליטה', 'דיווח בסוף כל שליחה: לכמה קבוצות הגיעה, ואם משהו נכשל ולמה'] },
      { h2: 'מה קורה אחרי שההודעה יצאה', body: ['טעיתם? עורכים את ההודעה בקבוצת השליטה, וכל העותקים נערכים במקום. "מחק לכולם" מוחק אותה מכל הקבוצות. הודעה שנמחקה לפני שיצאה לא תצא בכלל.'] },
      { h2: 'עובדת בענן, גם כשהטלפון כבוי', body: ['השליחה רצה בשרת. לא צריך להשאיר מחשב או טלפון פתוחים, ולא צריך להיכנס לאתר בכל פרסום: העבודה היומיומית נשארת בוואטסאפ.'] },
      { h2: 'קצב זהיר ושקיפות', body: ['החיבור לוואטסאפ הוא כמכשיר מקושר, לא דרך הממשק העסקי הרשמי. וואטסאפ אוסרת הודעות המוניות, ולכן יש סיכון לחסימת המספר. אנחנו ממליצים על מספר נפרד, שולחים בקצב מבוקר, ושולחים רק לקבוצות שהמספר חבר בהן. אין שליחה לאנשים פרטיים.'] },
    ],
    faq: [
      ['כמה עולה מערכת השליחה?', 'עד 10 קבוצות יעד, כולל טלגרם, בחינם. מסלול Premium מאפשר עד 30 קבוצות, ובו גם כמה קראו כל הודעה ותמיכה אישית.'],
      ['צריך להתקין משהו במחשב?', 'לא. הכול עובד בענן. אפשר להתקין את האפליקציה של Groupush בטלפון ישר ממסך הבית, בלי חנות אפליקציות.'],
      ['אפשר לשלוח גם לאנשים פרטיים?', 'לא. Groupush שולחת רק לקבוצות ולערוצים שבחרתם ושהמספר או הבוט חברים בהם.'],
    ],
  },
  {
    slug: 'whatsapp-groups',
    title: 'שליחת הודעה לכמה קבוצות וואטסאפ בבת אחת | Groupush',
    description: 'איך שולחים הודעה אחת לכמה קבוצות וואטסאפ בבת אחת: כותבים בקבוצת שליטה ו‑Groupush מפיצה לכל הקבוצות, עם תמונות, סרטונים, עריכה ומחיקה מסונכרנות.',
    h1: 'שליחת הודעה לכמה קבוצות וואטסאפ בבת אחת',
    intro: 'בוואטסאפ אפשר להעביר הודעה רק לכמה צ\'אטים בכל פעם, ועדכון שלה אחר כך דורש לעבור קבוצה קבוצה. עם Groupush כותבים פעם אחת, וההודעה מגיעה לכל הקבוצות.',
    sections: [
      { h2: 'שלושה צעדים', body: [], list: ['מחברים מספר וואטסאפ בסריקת קוד QR (מומלץ מספר נפרד, לא האישי)', 'פותחים קבוצת שליטה ובוחרים לאילו קבוצות היא מפיצה ומי רשאי לפרסם ממנה', 'כותבים בקבוצת השליטה, וכל הודעה יוצאת לכל הקבוצות'] },
      { h2: 'יותר מהעברה רגילה', body: ['כל עותק בכל קבוצה נשמר, ולכן עריכה ומחיקה בקבוצת השליטה עוברות לכל הקבוצות. אפשר להוסיף חתימה קבועה מתחת לכל הודעה, ולשים את הלוגו שלכם על תמונות וסרטונים אוטומטית.'] },
      { h2: 'קבוצה לא קיבלה?', body: ['Groupush מנסה שוב רק בקבוצות שנכשלו. אם לא ידוע אם ההודעה הגיעה, היא לא נשלחת שוב לבד, כדי שלא תופיע פעמיים. בדיווח בקבוצת השליטה רואים בדיוק איפה ולמה.'] },
    ],
    faq: [
      ['לכמה קבוצות אפשר לשלוח?', 'בחינם עד 10 קבוצות יעד, ובמסלול Premium עד 30.'],
      ['אפשר לערוך הודעה אחרי שנשלחה לכל הקבוצות?', 'כן, עד 15 דקות מהשליחה (מגבלה של וואטסאפ). עורכים בקבוצת השליטה, וכל העותקים נערכים במקום.'],
      ['חברי הקבוצות רואים מי שלח?', 'ההודעה יוצאת מהמספר שחיברתם, כמו כל הודעה רגילה שלו.'],
    ],
  },
  {
    slug: 'scheduled-messages',
    title: 'תזמון הודעות בוואטסאפ לקבוצות | Groupush',
    description: 'תזמון הודעה בוואטסאפ לשעה מסוימת, לכל הקבוצות בבת אחת: כותבים בשורה הראשונה תזמון (12:20), וההודעה יוצאת בזמן לפי שעון ישראל. עריכה ומחיקה לפני היציאה.',
    h1: 'תזמון הודעות בוואטסאפ, לכל הקבוצות',
    intro: 'רוצים שההודעה תצא בשעה מסוימת? ב‑Groupush מתזמנים ישר מתוך וואטסאפ, בלי לפתוח שום מערכת.',
    sections: [
      { h2: 'איך מתזמנים', body: ['כותבים בשורה הראשונה של ההודעה תזמון ושעה, למשל: תזמון (12:20). ההודעה מחכה, ויוצאת בשעה הזו לפי שעון ישראל לכל הקבוצות, בלי שורת התזמון.'] },
      { h2: 'שינית את דעתך?', body: ['עורכים את ההודעה המתוזמנת בקבוצת השליטה, וייצא הנוסח המעודכן. משנים בה את השעה, והיא זזה לשעה החדשה. מוחקים אותה "לכולם" לפני הזמן, והיא לא תצא בכלל.'] },
      { h2: 'מתאים ל…', body: [], list: ['תזכורות לשידורים, אירועים והרצאות', 'פרסומים שצריכים לצאת בשעה קבועה', 'הודעות שנכתבות בלילה ויוצאות בבוקר'] },
    ],
    faq: [
      ['התזמון עובד גם לטלגרם?', 'כן. אותה הודעה מתוזמנת יוצאת בזמן גם לערוצים ולקבוצות בטלגרם.'],
      ['הטלפון צריך להיות דלוק בשעת השליחה?', 'לא. השליחה רצה בענן.'],
    ],
  },
  {
    slug: 'telegram-channels',
    title: 'הפצת הודעות לערוצים וקבוצות בטלגרם | Groupush',
    description: 'מפיצים הודעות מקבוצת שליטה בוואטסאפ או בטלגרם לכל ערוצי וקבוצות הטלגרם שלכם, עם תמונות, סרטונים, הדגשות, עריכה ומחיקה מסונכרנות. בוט בלחיצה אחת.',
    h1: 'הפצת הודעות לערוצים ולקבוצות בטלגרם',
    intro: 'Groupush מפיצה גם לטלגרם: אותה הודעה מקבוצת השליטה מגיעה לערוצים ולקבוצות שלכם שם, יחד עם קבוצות הוואטסאפ.',
    sections: [
      { h2: 'בוט משלכם, בלחיצה אחת', body: ['מתוך האפליקציה של Groupush יוצרים בוט טלגרם משלכם בלחיצה, בלי BotFather ובלי טוקנים. מוסיפים אותו לערוץ, מאשרים לו לפרסם, והערוץ מופיע במערכת.'] },
      { h2: 'נראה כמו שכתבתם', body: ['הדגשה, נטוי וקו מחיקה שכתבתם בוואטסאפ מגיעים לטלגרם כעיצוב אמיתי. סרטונים מגיעים כסרטונים שמתנגנים, ותמונות עם הכיתוב שלהן.'] },
      { h2: 'עריכה ומחיקה', body: ['עריכה בקבוצת השליטה מעדכנת גם את העותקים בטלגרם, ו"מחק לכולם" מוחק אותם. בקבוצת שליטה בטלגרם עונים "מחק" על הודעה כדי למחוק אותה מכל הקבוצות.'] },
    ],
    faq: [
      ['כמה ערוצי טלגרם אפשר לחבר?', 'הערוצים נספרים יחד עם קבוצות הוואטסאפ: עד 10 בחינם, עד 30 ב‑Premium.'],
      ['יש פרסומות בערוץ שלי?', 'במסלול החינמי Groupush מפרסמת מדי פעם הודעות משלה בערוצי הטלגרם שחיברתם, בהסכמתכם. ב‑Premium אין פרסומים.'],
    ],
  },
  {
    slug: 'news-groups',
    title: 'מערכת לקבוצות עדכונים וחדשות בוואטסאפ | Groupush',
    description: 'מנהלים רשת קבוצות עדכונים, מבזקים וחדשות? Groupush מפיצה כל מבזק מקבוצת שליטה לכל הקבוצות והערוצים, מעדכנת כשהפרטים משתנים ושמה לוגו על כל סרטון.',
    h1: 'מערכת לקבוצות עדכונים, מבזקים וחדשות',
    intro: 'מבזק צריך להגיע לכל הקבוצות עכשיו, ולהתעדכן כשהפרטים משתנים. Groupush בנויה בדיוק לזה.',
    sections: [
      { h2: 'מבזק אחד, כל הרשת', body: ['כותבים את המבזק בקבוצת השליטה, והוא יוצא לכל קבוצות הוואטסאפ וערוצי הטלגרם. אפשר לתת לכמה עורכים לפרסם מאותה קבוצת שליטה, ולהגביל עריכה ומחיקה למספרים מסוימים.'] },
      { h2: 'הפרטים השתנו?', body: ['עורכים את ההודעה פעם אחת, וכל העותקים מתעדכנים במקום, בלי הודעת תיקון חדשה. פרסום שגוי נמחק מכל הקבוצות ב"מחק לכולם".'] },
      { h2: 'המותג שלכם על כל תוכן', body: ['הלוגו שלכם נכנס אוטומטית לתמונות ולסרטונים, וחתימה קבועה עם קישורי ההצטרפות שלכם יורדת מתחת לכל הודעה.'] },
    ],
    faq: [
      ['אפשר לראות כמה קראו כל מבזק?', 'כן, במסלול Premium: כמה נקראה כל הודעה ובאיזו קבוצה.'],
      ['מה אם אחת הקבוצות נכשלה?', 'רואים את זה בדיווח בקבוצת השליטה, ו‑Groupush מנסה שוב רק בקבוצות שנכשלו.'],
    ],
  },
];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function structured(p: LandingPage, origin: string): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', name: p.title, url: `${origin}/${p.slug}`, inLanguage: 'he', description: p.description },
      { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Groupush', item: `${origin}/` },
        { '@type': 'ListItem', position: 2, name: p.h1, item: `${origin}/${p.slug}` }] },
      { '@type': 'FAQPage', mainEntity: p.faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
    ],
  }).replace(/</g, '\\u003c');
}

const DL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';

export function landingHtml(p: LandingPage, nonce: string, origin: string): string {
  const others = LANDING_PAGES.filter((x) => x.slug !== p.slug);
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.description)}">
<link rel="canonical" href="${origin}/${p.slug}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="article">
<meta property="og:locale" content="he_IL">
<meta property="og:site_name" content="Groupush">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.description)}">
<meta property="og:url" content="${origin}/${p.slug}">
<meta property="og:image" content="${origin}/app/icon-512.png">
<meta name="theme-color" content="#0A1B33">
<link rel="icon" type="image/png" href="/app/icon-192.png">
<link rel="apple-touch-icon" href="/app/icon-180.png">
<link rel="manifest" href="/app/manifest.webmanifest">
<script type="application/ld+json" nonce="${nonce}">${structured(p, origin)}</script>
<style nonce="${nonce}">
${fontFaceCss()}
:root{--ink:#0A1B33;--teal:#19C6B4;--teal-deep:#0B8A7E;--teal-mist:#E3F8F5;--paper:#F5F8FB;--muted:#5E6E86;--line:#DCE4EE;
  --display:"Secular One","IBM Plex Sans Hebrew",system-ui,sans-serif;--body:"IBM Plex Sans Hebrew",system-ui,sans-serif}
*{box-sizing:border-box}
body{margin:0;font-family:var(--body);color:var(--ink);background:#fff;line-height:1.7;font-size:17px;-webkit-font-smoothing:antialiased}
a{color:inherit}
:focus-visible{outline:3px solid var(--teal);outline-offset:3px;border-radius:6px}
.wrap{max-width:860px;margin:0 auto;padding:0 22px}
h1,h2,h3{font-family:var(--display);font-weight:400;line-height:1.2;margin:0}
.top{background:var(--ink)}
.top .wrap{max-width:1160px;display:flex;align-items:center;gap:18px;height:70px}
.brand{font-family:var(--display);font-size:26px;color:#fff;text-decoration:none;display:flex;align-items:center;gap:10px}
.brand i{position:relative;width:11px;height:11px;border-radius:50%;background:var(--teal);box-shadow:0 0 12px 2px rgba(25,198,180,.7);animation:beat 2.4s ease-in-out infinite}
.brand i::before,.brand i::after{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid var(--teal);animation:wave 2.4s cubic-bezier(.2,.6,.3,1) infinite}
.brand i::after{animation-delay:1.2s}
@keyframes wave{from{transform:scale(1);opacity:.9}to{transform:scale(3.4);opacity:0}}
@keyframes beat{0%,100%{transform:scale(1)}12%{transform:scale(1.35)}24%{transform:scale(.92)}36%{transform:scale(1.12)}}
.top .sp{flex:1}
.top .get{display:inline-flex;align-items:center;gap:7px;color:var(--teal);border:1px solid rgba(25,198,180,.45);border-radius:999px;padding:7px 13px;font:600 14px var(--body);text-decoration:none}
.top .get svg{width:16px;height:16px}
.top .login{color:#fff;opacity:.85;text-decoration:none;font-size:15px}
.head{background:radial-gradient(900px 400px at 85% 0%,#1B427A,transparent 60%),var(--ink);color:#fff;padding:56px 0 64px}
.crumbs{font-size:14px;color:rgba(255,255,255,.6);margin-bottom:14px}
.crumbs a{color:rgba(255,255,255,.8);text-decoration:none}
.head h1{font-size:clamp(32px,5vw,52px)}
.head p{margin:18px 0 0;color:rgba(255,255,255,.78);font-size:19px;max-width:60ch}
.head .ctas{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}
.btn{display:inline-flex;align-items:center;gap:9px;font:600 17px/1 var(--body);padding:15px 24px;border-radius:999px;text-decoration:none;border:0;cursor:pointer}
.btn svg{width:18px;height:18px}
.btn-primary{background:var(--teal);color:var(--ink);box-shadow:0 10px 30px -10px rgba(25,198,180,.7)}
.btn-quiet{color:#fff;box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.35)}
main section{padding:44px 0 6px}
main h2{font-size:clamp(25px,3.2vw,32px);margin-bottom:12px}
main p{margin:0 0 12px;color:#34465f}
main ul{margin:6px 0 12px;padding:0;list-style:none;display:grid;gap:10px}
main li{position:relative;padding-inline-start:28px;color:#34465f}
main li::before{content:"";position:absolute;inset-inline-start:2px;top:.55em;width:12px;height:7px;border-left:2px solid var(--teal-deep);border-bottom:2px solid var(--teal-deep);transform:rotate(-45deg)}
.faq{margin-top:14px}
.faq details{border-bottom:1px solid var(--line);padding:16px 0}
.faq summary{cursor:pointer;font-weight:600;font-size:18px;list-style:none;display:flex;justify-content:space-between;gap:16px}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";font-family:var(--display);font-size:24px;line-height:1;color:var(--teal-deep);transition:transform .2s}
.faq details[open] summary::after{transform:rotate(45deg)}
.faq details p{margin-top:10px}
.cta{margin:56px 0 0;background:var(--teal);padding:44px 0}
.cta .wrap{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap}
.cta h2{font-size:clamp(26px,3.6vw,36px);color:var(--ink);max-width:20ch}
.cta .btn{background:var(--ink);color:#fff}
.more{background:var(--paper);padding:40px 0}
.more h2{font-size:24px;margin-bottom:14px}
.more ul{list-style:none;padding:0;margin:0;display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
.more a{display:block;background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px 16px;text-decoration:none;font-weight:600;transition:border-color .2s,transform .2s}
.more a:hover{border-color:var(--teal);transform:translateY(-2px)}
footer{background:var(--ink);color:rgba(255,255,255,.6);padding:30px 0;font-size:14px}
footer .wrap{max-width:1160px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
footer a{color:rgba(255,255,255,.8);text-decoration:none;margin-inline-start:16px}
${installPromptCss()}
@media (max-width:420px){.top .get span{display:none}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="/" aria-label="Groupush, דף הבית"><i aria-hidden="true"></i>Groupush</a>
  <span class="sp"></span>
  <a class="get" href="/app/install" data-install="1">${DL}<span>התקנת האפליקציה</span></a>
  <a class="login" href="/app">כניסה</a>
</div></header>
<div class="head"><div class="wrap">
  <nav class="crumbs" aria-label="מיקום"><a href="/">Groupush</a> › ${esc(p.h1)}</nav>
  <h1>${esc(p.h1)}</h1>
  <p>${esc(p.intro)}</p>
  <div class="ctas"><a class="btn btn-primary" href="/app#signup">מתחילים בחינם</a><a class="btn btn-quiet" href="/#how">איך זה עובד</a></div>
</div></div>
<main><div class="wrap">
${p.sections.map((s) => `  <section><h2>${esc(s.h2)}</h2>${s.body.map((b) => `<p>${esc(b)}</p>`).join('')}${s.list ? `<ul>${s.list.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}</section>`).join('\n')}
  <section><h2>שאלות נפוצות</h2><div class="faq">${p.faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div></section>
</div></main>
<div class="cta"><div class="wrap"><h2>כותבים פעם אחת. מגיע לכל הקבוצות.</h2><a class="btn" href="/app#signup">פתיחת חשבון בחינם</a></div></div>
<nav class="more" aria-label="עוד נושאים"><div class="wrap"><h2>עוד ב‑Groupush</h2><ul>${others.map((o) => `<li><a href="/${o.slug}">${esc(o.h1)}</a></li>`).join('')}</ul></div></nav>
<footer><div class="wrap"><span>© ${new Date().getFullYear()} Groupush (גרופוש)</span><span><a href="/">דף הבית</a><a href="/app">כניסה למערכת</a></span></div></footer>
${installPromptHtml()}
<script nonce="${nonce}">${installPromptJs(6000)}</script>
</body>
</html>`;
}
