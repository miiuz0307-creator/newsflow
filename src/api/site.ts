/**
 * The PUSH marketing site (home page). One static page, Hebrew RTL, served
 * by the API with a strict CSP. Its hero is a live animation of the product
 * itself: one message in the control group spreading to every group.
 */
import { fontFaceCss } from './fonts.js';

export function siteHtml(nonce: string): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PUSH — הודעה אחת. כל הקבוצות.</title>
<meta name="description" content="PUSH מפיצה הודעה אחת מקבוצת שליטה לכל קבוצות ה‑WhatsApp וה‑Telegram שלכם, ומסנכרנת עריכה ומחיקה בכל העותקים.">
<link rel="preload" href="/fonts/secular-one-hebrew-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/ibm-plex-sans-hebrew-hebrew-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<style nonce="${nonce}">
${fontFaceCss()}
:root{
  --ink:#0A1B33;--navy:#12305C;--navy-2:#1B427A;--teal:#19C6B4;--teal-deep:#0B8A7E;--teal-mist:#E3F8F5;
  --paper:#F5F8FB;--white:#FFFFFF;--muted:#5E6E86;--line:#DCE4EE;--ok:#16A34A;--bad:#DC2626;
  --display:"Secular One","IBM Plex Sans Hebrew",system-ui,sans-serif;--body:"IBM Plex Sans Hebrew",system-ui,sans-serif;
  --r-sm:10px;--r:16px;--r-lg:28px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font-family:var(--body);color:var(--ink);background:var(--white);line-height:1.6;font-size:17px;-webkit-font-smoothing:antialiased}
a{color:inherit}
:focus-visible{outline:3px solid var(--teal);outline-offset:3px;border-radius:6px}
.wrap{max-width:1160px;margin:0 auto;padding:0 24px}
h1,h2,h3{font-family:var(--display);font-weight:400;line-height:1.15;margin:0}
h2{font-size:clamp(30px,4vw,44px);letter-spacing:-.01em}
p{margin:0}
.lead{font-size:clamp(18px,1.6vw,21px);color:var(--muted);max-width:56ch}
.btn{display:inline-flex;align-items:center;gap:10px;font:600 17px/1 var(--body);padding:16px 26px;border-radius:999px;text-decoration:none;border:0;cursor:pointer;transition:transform .15s,background .15s}
.btn:active{transform:translateY(1px)}
.btn-primary{background:var(--teal);color:var(--ink)}
.btn-primary:hover{background:#2fd8c6}
.btn-quiet{background:transparent;color:var(--white);box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.35)}
.btn-quiet:hover{box-shadow:inset 0 0 0 1.5px var(--teal)}
.btn-dark{background:var(--ink);color:var(--white)}

/* ---------- header ---------- */
.top{position:absolute;inset-inline:0;top:0;z-index:5}
.top .wrap{display:flex;align-items:center;gap:28px;height:78px}
.brand{font-family:var(--display);font-size:30px;color:var(--white);text-decoration:none;letter-spacing:.02em;display:flex;align-items:center;gap:10px}
.brand i{display:inline-block;width:12px;height:12px;border-radius:50%;background:var(--teal);box-shadow:0 0 0 5px rgba(25,198,180,.22)}
.nav{display:flex;gap:26px;margin-inline-start:12px}
.nav a{color:rgba(255,255,255,.78);text-decoration:none;font-size:15px}
.nav a:hover{color:var(--white)}
.top .spacer{flex:1}
.top .login{color:var(--white);text-decoration:none;font-size:15px;opacity:.85}
@media (max-width:860px){.nav{display:none}}

/* ---------- hero ---------- */
.hero{background:radial-gradient(1200px 600px at 15% 20%,#173d73 0%,transparent 60%),var(--ink);color:var(--white);padding:150px 0 110px;overflow:hidden;position:relative}
.hero .wrap{display:grid;grid-template-columns:1.02fr 1fr;gap:56px;align-items:center}
.hero h1{font-size:clamp(46px,6.6vw,86px);letter-spacing:-.015em}
.hero h1 .l2{display:block;color:var(--teal)}
.hero .lead{color:rgba(255,255,255,.72);margin-top:22px}
.hero .ctas{display:flex;gap:14px;flex-wrap:wrap;margin-top:34px}
.hero .fine{margin-top:18px;font-size:14px;color:rgba(255,255,255,.55)}
@media (max-width:960px){.hero{padding:120px 0 70px}.hero .wrap{grid-template-columns:1fr}}

/* the live fan-out */
.fan{position:relative;height:500px;min-width:0}
.fan svg.wires{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.wire{fill:none;stroke:rgba(25,198,180,.18);stroke-width:1.5}
.wire.go{stroke:var(--teal);stroke-dasharray:6 8;animation:flow 1s linear infinite}
@keyframes flow{to{stroke-dashoffset:-28}}
.ctrl{position:absolute;inset-inline-end:0;top:50%;transform:translateY(-50%);width:230px;background:#0f2748;border:1px solid rgba(255,255,255,.12);border-radius:var(--r-lg);padding:16px 14px 18px;box-shadow:0 30px 60px -20px rgba(0,0,0,.6)}
.ctrl .ttl{display:flex;align-items:center;gap:9px;font-size:13px;color:rgba(255,255,255,.7);padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,.08)}
.ctrl .ttl b{color:var(--white);font-weight:600}
.dot{width:30px;height:30px;border-radius:50%;background:var(--teal);color:var(--ink);display:grid;place-items:center;font-family:var(--display);font-size:13px;flex:none}
.bubble{margin-top:14px;background:#dcf8c6;color:#0b1c10;border-radius:14px 14px 4px 14px;padding:10px 12px;font-size:14px;line-height:1.45;min-height:64px;position:relative}
.bubble .t{white-space:pre-wrap}
.bubble .meta{font-size:11px;color:#3b5a43;text-align:left;margin-top:4px}
.caret{display:inline-block;width:2px;height:1em;background:#0b1c10;vertical-align:-2px;animation:blink 1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
.report{margin-top:10px;background:rgba(25,198,180,.12);border:1px solid rgba(25,198,180,.35);color:#c8fff7;border-radius:12px;padding:8px 10px;font-size:13px;opacity:0;transform:translateY(6px);transition:opacity .4s,transform .4s}
.report.on{opacity:1;transform:none}
.groups{position:absolute;inset-inline-start:0;top:0;bottom:0;width:calc(100% - 300px);display:flex;flex-direction:column;justify-content:space-between}
.g{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:9px 11px;transition:background .35s,border-color .35s}
.g .av{width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,.1);flex:none;display:grid;place-items:center;font-size:12px;color:rgba(255,255,255,.7)}
.g .body{min-width:0;flex:1}
.g .name{font-size:13px;font-weight:600;color:var(--white)}
.g .last{font-size:12px;color:rgba(255,255,255,.45);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.g .tick{font-size:12px;color:var(--teal);opacity:0;transition:opacity .3s}
.g.got{background:rgba(25,198,180,.1);border-color:rgba(25,198,180,.4)}
.g.got .last{color:rgba(255,255,255,.85)}
.g.got .tick{opacity:1}
.count{position:absolute;inset-inline-start:0;bottom:-46px;font-size:14px;color:rgba(255,255,255,.65)}
.count b{font-family:var(--display);font-size:22px;color:var(--white);font-weight:400}
.replay{position:absolute;inset-inline-end:0;bottom:-48px;background:none;border:0;color:rgba(255,255,255,.6);font:inherit;font-size:14px;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
@media (max-width:560px){.fan{height:560px}.ctrl{position:relative;inset:auto;transform:none;width:100%}.groups{position:relative;width:100%;margin-top:22px;gap:8px}.fan svg.wires{display:none}.count{position:relative;bottom:auto;margin-top:12px}.replay{position:relative;bottom:auto;margin-top:6px}}

/* ---------- sections ---------- */
section{padding:110px 0}
.sec-head{max-width:720px;margin-bottom:56px}
.sec-head .lead{margin-top:16px}
.lead.gap{margin-top:16px}
.faq-sec{padding-top:0}

.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:0;counter-reset:s;border-top:2px solid var(--ink)}
.step{padding:28px 0 0 28px;counter-increment:s}
.step+.step{padding-inline-start:28px;border-inline-start:1px solid var(--line)}
.step::before{content:counter(s);font-family:var(--display);font-size:56px;line-height:1;color:var(--teal-deep);display:block;margin-bottom:18px}
.step h3{font-size:24px;margin-bottom:10px}
.step p{color:var(--muted)}
@media (max-width:820px){.steps{grid-template-columns:1fr}.step,.step+.step{padding:26px 0;border-inline-start:0;border-bottom:1px solid var(--line)}}

/* sync demo */
.sync{background:var(--paper)}
.sync .grid{display:grid;grid-template-columns:.9fr 1.1fr;gap:64px;align-items:center}
.sync ul{list-style:none;padding:0;margin:26px 0 0;display:grid;gap:14px}
.sync li{display:flex;gap:12px;align-items:flex-start}
.sync li span{flex:none;width:26px;height:26px;border-radius:8px;background:var(--teal-mist);color:var(--teal-deep);display:grid;place-items:center;font-weight:700;font-size:14px}
.stage{background:var(--white);border:1px solid var(--line);border-radius:var(--r-lg);padding:22px;box-shadow:0 40px 80px -48px rgba(10,27,51,.35)}
.tabs{display:flex;gap:6px;background:var(--paper);padding:5px;border-radius:999px;width:max-content;max-width:100%}
.tabs button{border:0;background:transparent;font:600 15px var(--body);padding:9px 18px;border-radius:999px;cursor:pointer;color:var(--muted)}
.tabs button[aria-pressed=true]{background:var(--ink);color:var(--white)}
.st-grid{display:grid;grid-template-columns:1fr 1.25fr;gap:18px;margin-top:20px}
.col h4{margin:0 0 10px;font-size:13px;color:var(--muted);font-weight:600}
.msg{background:#dcf8c6;border-radius:12px 12px 4px 12px;padding:10px 12px;font-size:14px;line-height:1.45;transition:background .4s}
.copy{border:1px solid var(--line);border-radius:12px;padding:9px 11px;font-size:13.5px;margin-bottom:8px;display:flex;flex-direction:column;gap:2px;transition:background .5s,border-color .5s}
.copy b{font-size:12px;color:var(--muted);font-weight:600}
.copy.flash{background:var(--teal-mist);border-color:var(--teal)}
.copy.gone .txt,.msg.gone{color:var(--muted);font-style:italic}
.stage .note{margin-top:14px;font-size:14px;color:var(--teal-deep);min-height:1.6em}
@media (max-width:900px){.sync .grid{grid-template-columns:1fr;gap:40px}.st-grid{grid-template-columns:1fr}}

/* who */
.who{display:grid;grid-template-columns:repeat(3,1fr);gap:40px}
.who div{border-top:1px solid var(--line);padding-top:22px}
.who h3{font-size:22px;margin-bottom:8px}
.who p{color:var(--muted)}
@media (max-width:820px){.who{grid-template-columns:1fr;gap:26px}}

/* honesty */
.honest{background:var(--ink);color:var(--white)}
.honest .grid{display:grid;grid-template-columns:1fr 1fr;gap:64px}
.honest h2{color:var(--white)}
.honest .lead{color:rgba(255,255,255,.7)}
.honest dl{margin:0;display:grid;gap:22px}
.honest dt{font-weight:700;color:var(--teal);margin-bottom:4px}
.honest dd{margin:0;color:rgba(255,255,255,.75)}
@media (max-width:860px){.honest .grid{grid-template-columns:1fr;gap:36px}}

/* pricing */
.plans{display:grid;grid-template-columns:1fr 1fr;gap:24px;max-width:900px}
.plan{border:1px solid var(--line);border-radius:var(--r-lg);padding:34px}
.plan.main{background:var(--ink);color:var(--white);border-color:var(--ink)}
.plan h3{font-size:26px}
.price{margin:18px 0 6px;display:flex;align-items:baseline;gap:8px}
.price b{font-family:var(--display);font-size:56px;font-weight:400;line-height:1}
.price span{color:var(--muted)}
.price .cur{font-family:var(--body);font-weight:600;font-size:34px;color:inherit;margin-inline-start:6px}
.plan.main .price span{color:rgba(255,255,255,.6)}
.plan ul{list-style:none;padding:0;margin:22px 0 28px;display:grid;gap:10px}
.plan li{padding-inline-start:26px;position:relative}
.plan li::before{content:"";position:absolute;inset-inline-start:0;top:.5em;width:12px;height:7px;border-left:2px solid var(--teal-deep);border-bottom:2px solid var(--teal-deep);transform:rotate(-45deg)}
.plan.main li::before{border-color:var(--teal)}
.plan .tag{font-size:14px;color:var(--muted)}
.plan.main .tag{color:rgba(255,255,255,.6)}
@media (max-width:760px){.plans{grid-template-columns:1fr}}

/* faq */
.faq{max-width:820px}
.faq details{border-bottom:1px solid var(--line);padding:20px 0}
.faq summary{cursor:pointer;font-weight:600;font-size:19px;list-style:none;display:flex;justify-content:space-between;gap:20px}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";font-family:var(--display);font-size:26px;line-height:1;color:var(--teal-deep);transition:transform .2s}
.faq details[open] summary::after{transform:rotate(45deg)}
.faq details p{margin-top:12px;color:var(--muted);max-width:68ch}

/* final */
.final{background:var(--teal);padding:90px 0}
.final .wrap{display:flex;align-items:center;justify-content:space-between;gap:30px;flex-wrap:wrap}
.final h2{color:var(--ink);max-width:16ch}
footer{background:var(--ink);color:rgba(255,255,255,.6);padding:40px 0;font-size:14px}
footer .wrap{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}
footer a{text-decoration:none;color:rgba(255,255,255,.75);margin-inline-start:18px}

@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}html{scroll-behavior:auto}}
</style>
</head>
<body>

<header class="top">
  <div class="wrap">
    <a class="brand" href="/" aria-label="PUSH, דף הבית"><i aria-hidden="true"></i>PUSH</a>
    <nav class="nav" aria-label="ניווט ראשי">
      <a href="#how">איך זה עובד</a><a href="#sync">עריכה ומחיקה</a><a href="#pricing">מחירים</a><a href="#faq">שאלות</a>
    </nav>
    <div class="spacer"></div>
    <a class="login" href="/app">כניסה</a>
  </div>
</header>

<main>
<section class="hero" aria-labelledby="hero-title">
  <div class="wrap">
    <div>
      <h1 id="hero-title">הודעה אחת.<span class="l2">כל הקבוצות.</span></h1>
      <p class="lead">כותבים פעם אחת בקבוצת שליטה ב‑WhatsApp, ו‑PUSH מפיצה לכל קבוצות ה‑WhatsApp וה‑Telegram שלכם. טעות כתיב? עורכים פעם אחת, וכל העותקים מתעדכנים.</p>
      <div class="ctas">
        <a class="btn btn-primary" href="/app">התחילו עכשיו</a>
        <a class="btn btn-quiet" href="#how">איך זה עובד</a>
      </div>
      <p class="fine">בלי להיכנס לאתר בכל פרסום. העבודה היומיומית נשארת ב‑WhatsApp.</p>
    </div>

    <div class="fan" id="fan" aria-label="הדגמה: הודעה מקבוצת השליטה מופצת לשש קבוצות">
      <svg class="wires" id="wires" aria-hidden="true"></svg>
      <div class="ctrl" id="ctrl">
        <div class="ttl"><span class="dot" aria-hidden="true">P</span><span><b>קבוצת שליטה</b><br>אתם ו‑PUSH</span></div>
        <div class="bubble"><span class="t" id="typed"></span><span class="caret" id="caret" aria-hidden="true"></span><div class="meta" id="sent-at"></div></div>
        <div class="report" id="report" role="status"></div>
      </div>
      <div class="groups" id="groups"></div>
      <div class="count" aria-live="polite"><b id="n">0</b> מתוך 6 קבוצות</div>
      <button class="replay" id="replay" type="button">הפעלה מחדש</button>
    </div>
  </div>
</section>

<section id="how" aria-labelledby="how-title">
  <div class="wrap">
    <div class="sec-head">
      <h2 id="how-title">שלושה צעדים, ואתם מפיצים</h2>
      <p class="lead">ההקמה לוקחת כמה דקות. אחריה לא צריך לפתוח שום מערכת: כל מה שתכתבו בקבוצת השליטה יגיע לכל הקבוצות.</p>
    </div>
    <div class="steps">
      <div class="step"><h3>מחברים מספר WhatsApp</h3><p>סורקים קוד QR, כמו ב‑WhatsApp Web. מומלץ מספר נפרד ל‑PUSH, לא המספר האישי.</p></div>
      <div class="step"><h3>פותחים קבוצת שליטה</h3><p>קבוצה קטנה שבה אתם והמספר המחובר. בוחרים לאילו קבוצות יעד היא מפיצה, ומי רשאי לפרסם ממנה.</p></div>
      <div class="step"><h3>כותבים, וזהו</h3><p>כל הודעה בקבוצת השליטה יוצאת לכל הקבוצות. בסוף מגיע דיווח: לכמה קבוצות הגיעה, ואם משהו נכשל ולמה.</p></div>
    </div>
  </div>
</section>

<section class="sync" id="sync" aria-labelledby="sync-title">
  <div class="wrap grid">
    <div>
      <h2 id="sync-title">טעות בהודעה? מתקנים אותה פעם אחת.</h2>
      <p class="lead gap">PUSH זוכרת כל עותק בכל קבוצה, ומחילה עליו את מה שעשיתם בקבוצת השליטה.</p>
      <ul>
        <li><span aria-hidden="true">✓</span><div>עורכים את ההודעה בקבוצת השליטה, וכל העותקים נערכים במקום, בלי הודעה חדשה.</div></li>
        <li><span aria-hidden="true">✓</span><div>"מחק לכולם" מוחק אותה מכל הקבוצות. "מחק אצלי" לא נוגע בכלום.</div></li>
        <li><span aria-hidden="true">✓</span><div>הודעה שנמחקה לפני שיצאה לא תצא בכלל, גם אם הייתה בתור.</div></li>
      </ul>
    </div>
    <div class="stage">
      <div class="tabs" role="group" aria-label="בחרו פעולה">
        <button type="button" data-act="send" aria-pressed="true">שליחה</button>
        <button type="button" data-act="edit" aria-pressed="false">עריכה</button>
        <button type="button" data-act="delete" aria-pressed="false">מחיקה לכולם</button>
      </div>
      <div class="st-grid">
        <div class="col"><h4>קבוצת השליטה</h4><div class="msg" id="src">חיפה: הפסקת מים בכרמל עד 14:00</div></div>
        <div class="col"><h4>מה רואים בקבוצות</h4><div id="copies"></div></div>
      </div>
      <p class="note" id="sync-note" role="status"></p>
    </div>
  </div>
</section>

<section aria-labelledby="who-title">
  <div class="wrap">
    <div class="sec-head"><h2 id="who-title">למי זה מתאים</h2></div>
    <div class="who">
      <div><h3>מנהלי קבוצות חדשות</h3><p>מבזק אחד שצריך להגיע לעשרות קבוצות עכשיו, ולהתעדכן כשהפרטים משתנים.</p></div>
      <div><h3>קהילות וארגונים</h3><p>הודעות לחברים בכמה קבוצות, בלי להעתיק ולהדביק ובלי לפספס אף קבוצה.</p></div>
      <div><h3>עסקים</h3><p>עדכונים ללקוחות בקבוצות WhatsApp ובערוצי Telegram מאותו מקום.</p></div>
    </div>
  </div>
</section>

<section class="honest" aria-labelledby="honest-title">
  <div class="wrap grid">
    <div>
      <h2 id="honest-title">שקיפות מלאה, לפני שמתחילים</h2>
      <p class="lead gap">החיבור ל‑WhatsApp נעשה כמכשיר מקושר (כמו WhatsApp Web), ולא דרך הממשק העסקי הרשמי של WhatsApp. חשוב שתדעו מה זה אומר.</p>
    </div>
    <dl>
      <div><dt>יש סיכון לחסימת המספר</dt><dd>WhatsApp אוסרת הודעות אוטומטיות והמוניות. לכן אנחנו ממליצים על מספר נפרד ל‑PUSH, וקובעים קצב שליחה זהיר.</dd></div>
      <div><dt>רק לקבוצות שמותר לכם לפרסם בהן</dt><dd>PUSH שולחת רק לקבוצות שבחרתם ושהמספר חבר בהן. אין שליחה לאנשים פרטיים.</dd></div>
      <div><dt>אנחנו לא מבטיחים מה שלא בדקנו</dt><dd>עריכה ב‑WhatsApp אפשרית עד 15 דקות מהשליחה. כשמשהו לא אפשרי, הדיווח בקבוצת השליטה אומר לכם בדיוק איפה ולמה.</dd></div>
    </dl>
  </div>
</section>

<section id="pricing" aria-labelledby="pricing-title">
  <div class="wrap">
    <div class="sec-head"><h2 id="pricing-title">מחירים</h2><p class="lead">מתחילים בחינם, ועוברים ל‑Premium כשרוצים להפיץ לכל הקבוצות.</p></div>
    <div class="plans">
      <div class="plan">
        <h3>חינם</h3>
        <div class="price"><b>0<span class="cur">₪</span></b></div>
        <p class="tag">לנסות את PUSH על כמה קבוצות</p>
        <ul><li>קבוצת שליטה אחת</li><li>עד 3 קבוצות יעד</li><li>עריכה ומחיקה מסונכרנות</li><li>דיווחים בקבוצת השליטה</li></ul>
        <a class="btn btn-dark" href="/app">פתיחת חשבון</a>
      </div>
      <div class="plan main">
        <h3>Premium</h3>
        <div class="price"><b>300<span class="cur">₪</span></b><span>לחודש, לפני מע"מ</span></div>
        <p class="tag">לרשתות קבוצות שמפיצות כל יום</p>
        <ul><li>עד 30 קבוצות יעד, WhatsApp ו‑Telegram</li><li>תבניות הודעה עם חתימה וקישורים</li><li>היסטוריה וסטטוס לכל קבוצה</li><li>תמיכה אישית</li></ul>
        <a class="btn btn-primary" href="/app">מתחילים ב‑Premium</a>
      </div>
    </div>
  </div>
</section>

<section class="faq-sec" aria-labelledby="faq-title">
  <div class="wrap">
    <div class="sec-head"><h2 id="faq-title">שאלות שחוזרות</h2></div>
    <div class="faq" id="faq">
      <details><summary>צריך להשאיר את הטלפון פתוח?</summary><p>לא. אחרי סריקת קוד ה‑QR, PUSH עובדת בענן גם כשהטלפון כבוי או רחוק. המספר צריך להישאר מחובר ל‑WhatsApp.</p></details>
      <details><summary>מה קורה אם אחת הקבוצות לא קיבלה את ההודעה?</summary><p>PUSH מנסה שוב רק בקבוצות שנכשלו, אחרי 30 שניות, 2 דקות ו‑5 דקות. אם לא ידוע אם ההודעה הגיעה, היא לא תישלח שוב לבד, כדי שלא תופיע פעמיים.</p></details>
      <details><summary>אפשר להפיץ גם לטלגרם?</summary><p>כן. מחברים בוט טלגרם, ו‑PUSH מפיצה גם לקבוצות ולערוצים שלכם שם. בקבוצת שליטה בטלגרם עונים "מחק" על הודעה כדי למחוק אותה מכל הקבוצות.</p></details>
      <details><summary>מי עוד יכול לפרסם מקבוצת השליטה?</summary><p>אתם קובעים. אפשר להגביל את ההפצה, העריכה והמחיקה למספרים מסוימים בלבד.</p></details>
      <details><summary>מה עם הפרטיות של ההודעות?</summary><p>תוכן ההודעות נשמר רק כמה שצריך כדי להפיץ אותן, ונמחק אוטומטית אחרי 7 ימים. פרטי החיבור ל‑WhatsApp מוצפנים.</p></details>
    </div>
  </div>
</section>

<section class="final">
  <div class="wrap">
    <h2>מוכנים להפסיק להעתיק ולהדביק?</h2>
    <a class="btn btn-dark" href="/app">התחילו עכשיו</a>
  </div>
</section>
</main>

<footer>
  <div class="wrap">
    <span>© ${new Date().getFullYear()} PUSH. הודעה אחת. כל הקבוצות.</span>
    <span><a href="#faq">שאלות נפוצות</a><a href="/app">כניסה למערכת</a></span>
  </div>
</footer>

<script nonce="${nonce}">
(function(){
'use strict';
var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var MESSAGE='🔴 מבזק: כביש 4 נחסם לתנועה לכיוון צפון בעקבות תאונה. מומלץ לנסוע דרך כביש 6.';
var GROUPS=['חדשות חיפה','חדשות הקריות','חדשות נהריה','עדכוני כבישים צפון','מבזקים גליל','ערוץ טלגרם'];
var fan=document.getElementById('fan'),wires=document.getElementById('wires'),groupsEl=document.getElementById('groups');
var typed=document.getElementById('typed'),caret=document.getElementById('caret'),sentAt=document.getElementById('sent-at'),report=document.getElementById('report'),n=document.getElementById('n');
var cards=GROUPS.map(function(name,i){
  var g=document.createElement('div');g.className='g';
  var av=document.createElement('span');av.className='av';av.textContent=name.slice(0,1);
  var b=document.createElement('div');b.className='body';
  var nm=document.createElement('div');nm.className='name';nm.textContent=name;
  var last=document.createElement('div');last.className='last';last.textContent=i===5?'הערוץ שלכם בטלגרם':'עוד לא היום';
  var tick=document.createElement('span');tick.className='tick';tick.textContent='✓✓';tick.setAttribute('aria-hidden','true');
  b.appendChild(nm);b.appendChild(last);g.appendChild(av);g.appendChild(b);g.appendChild(tick);groupsEl.appendChild(g);
  return {el:g,last:last};
});
var NS='http://www.w3.org/2000/svg',paths=[];
function drawWires(){
  wires.replaceChildren();paths=[];
  if(getComputedStyle(wires).display==='none')return;
  var box=fan.getBoundingClientRect(),c=document.getElementById('ctrl').getBoundingClientRect();
  var sy=c.top-box.top+c.height/2;
  cards.forEach(function(card){
    // Wires leave the control group's facing edge and end at the near edge of each group, whatever the direction.
    var r=card.el.getBoundingClientRect(),right=r.left>c.left;
    var sx=(right?c.right:c.left)-box.left,ex=(right?r.left:r.right)-box.left,ey=r.top-box.top+r.height/2,mx=(sx+ex)/2;
    var p=document.createElementNS(NS,'path');p.setAttribute('d','M'+sx+' '+sy+' C'+mx+' '+sy+' '+mx+' '+ey+' '+ex+' '+ey);p.setAttribute('class','wire');
    wires.appendChild(p);paths.push(p);
  });
}
var timers=[];function later(ms,fn){timers.push(setTimeout(fn,ms))}
function reset(){timers.forEach(clearTimeout);timers=[];typed.textContent='';sentAt.textContent='';report.className='report';report.textContent='';n.textContent='0';
  cards.forEach(function(c,i){c.el.classList.remove('got');c.last.textContent=i===5?'הערוץ שלכם בטלגרם':'עוד לא היום'});paths.forEach(function(p){p.setAttribute('class','wire')})}
function finalState(){typed.textContent=MESSAGE;caret.style.display='none';sentAt.textContent='04:21 ✓✓';cards.forEach(function(c){c.el.classList.add('got');c.last.textContent=MESSAGE});n.textContent='6';
  report.textContent='✅ PUSH · ההודעה נשלחה בהצלחה ל‑6 מתוך 6 קבוצות.';report.className='report on'}
function play(){
  reset();drawWires();
  if(reduce)return finalState();
  caret.style.display='';var i=0;
  (function type(){if(i<=MESSAGE.length){typed.textContent=MESSAGE.slice(0,i);i+=2;later(28,type)}else{caret.style.display='none';sentAt.textContent='04:21 ✓✓';send()}})();
}
function send(){
  cards.forEach(function(c,k){
    later(300+k*380,function(){if(paths[k])paths[k].setAttribute('class','wire go')});
    later(800+k*380,function(){c.el.classList.add('got');c.last.textContent=MESSAGE;n.textContent=String(k+1);if(paths[k])paths[k].setAttribute('class','wire')});
  });
  later(800+cards.length*380+400,function(){report.textContent='✅ PUSH · ההודעה נשלחה בהצלחה ל‑6 מתוך 6 קבוצות.';report.className='report on'});
}
document.getElementById('replay').addEventListener('click',play);
window.addEventListener('resize',function(){var on=paths.map(function(p){return p.getAttribute('class')});drawWires();paths.forEach(function(p,k){if(on[k])p.setAttribute('class',on[k])})});
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(play);else play();

// ---- sync demo
var SRC='חיפה: הפסקת מים בכרמל עד 14:00',EDITED='חיפה: הפסקת מים בכרמל עד 16:00 (עודכן)';
var TARGETS=['חדשות חיפה','חדשות הקריות','ערוץ טלגרם'];
var src=document.getElementById('src'),copies=document.getElementById('copies'),note=document.getElementById('sync-note');
var rows=TARGETS.map(function(t){var d=document.createElement('div');d.className='copy';var b=document.createElement('b');b.textContent=t;var x=document.createElement('span');x.className='txt';d.appendChild(b);d.appendChild(x);copies.appendChild(d);return {el:d,txt:x}});
function setAll(text,gone,flash){src.textContent=gone?'🚫 ההודעה נמחקה':text;src.classList.toggle('gone',!!gone);
  rows.forEach(function(r,i){var apply=function(){r.txt.textContent=gone?'🚫 ההודעה נמחקה':text;r.el.classList.toggle('gone',!!gone);if(flash){r.el.classList.add('flash');setTimeout(function(){r.el.classList.remove('flash')},900)}};
    if(flash&&!reduce)setTimeout(apply,200+i*220);else apply()})}
var NOTES={send:'ההודעה נשלחה לשלוש הקבוצות.',edit:'עריכה אחת בקבוצת השליטה, וכל שלושת העותקים נערכו במקום.',delete:'"מחק לכולם" בקבוצת השליטה, וההודעה נמחקה מכל הקבוצות.'};
document.querySelectorAll('.tabs button').forEach(function(b){b.addEventListener('click',function(){
  document.querySelectorAll('.tabs button').forEach(function(x){x.setAttribute('aria-pressed',String(x===b))});
  var a=b.getAttribute('data-act');setAll(a==='edit'?EDITED:SRC,a==='delete',a!=='send');note.textContent=NOTES[a];
})});
setAll(SRC,false,false);note.textContent=NOTES.send;
})();
</script>
</body>
</html>`;
}
