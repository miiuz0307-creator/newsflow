/**
 * The Groupush marketing site (home page). One static page, Hebrew RTL, served
 * by the API with a strict CSP. Its hero is a live animation of the product
 * itself: one message in the control group spreading to every group.
 */
import { fontFaceCss } from './fonts.js';
import { installPromptCss, installPromptHtml, installPromptJs } from './installPrompt.js';
import { LANDING_PAGES } from './landing.js';

/** Where the site lives (PUBLIC_ORIGIN, e.g. https://push.co.il, once a domain is connected). */
export function publicOrigin(host?: string): string {
  if (process.env.PUBLIC_ORIGIN && /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(process.env.PUBLIC_ORIGIN)) return process.env.PUBLIC_ORIGIN;
  if (process.env.RAILWAY_PUBLIC_DOMAIN && /^[a-z0-9.-]+$/i.test(process.env.RAILWAY_PUBLIC_DOMAIN)) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return host && /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `http://${host}` : 'http://localhost';
}

/** Customers shown on the home page (with their permission). Logo: a path served by /img/clients/. */
const CLIENTS: { name: string; logo?: string }[] = [
  { name: 'עדכונים בזמן אמת' },
  { name: 'המבזקיסט' },
];

const TITLE = 'Groupush (גרופוש) — מערכת שליחה אוטומטית לכל קבוצות הוואטסאפ והטלגרם';
const DESCRIPTION = 'כותבים הודעה אחת בקבוצת שליטה, ו‑Groupush מפיצה אותה לכל קבוצות הוואטסאפ וערוצי הטלגרם שלכם, עם עריכה, מחיקה ותזמון מסונכרנים. מתחילים בחינם.';
/** The questions on the page, also given to search engines as structured data (same text). */
const FAQ: [string, string][] = [["איך שולחים הודעה לכמה קבוצות וואטסאפ בבת אחת?", "מחברים מספר וואטסאפ ל‑Groupush בסריקת קוד, פותחים קבוצת שליטה ובוחרים לאילו קבוצות להפיץ. מאותו רגע כל הודעה שכותבים בקבוצת השליטה, כולל תמונות, סרטונים וקבצים, יוצאת לכל הקבוצות שבחרתם."], ["אפשר לתזמן הודעה לשעה מסוימת?", "כן. כותבים בשורה הראשונה תזמון (12:20), וההודעה יוצאת בשעה הזו לפי שעון ישראל, בלי שורת התזמון."]];

/** Search engines: what the page is, in their structured format. Same facts as the visible page. */
function structuredData(origin: string): string {
  const esc = (o: unknown) => JSON.stringify(o).replace(/</g, '\\u003c');
  return esc({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'SoftwareApplication', name: 'Groupush', alternateName: 'גרופוש', url: `${origin}/`, applicationCategory: 'BusinessApplication', operatingSystem: 'Web, Android, iOS',
        inLanguage: 'he', description: DESCRIPTION, offers: { '@type': 'Offer', price: '0', priceCurrency: 'ILS' } },
      { '@type': 'FAQPage', mainEntity: FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
    ],
  });
}

export function siteHtml(nonce: string, origin = publicOrigin(), googleVerification = process.env.GOOGLE_SITE_VERIFICATION): string {
  const gv = googleVerification && /^[A-Za-z0-9_-]{10,100}$/.test(googleVerification) ? googleVerification : '';
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<meta name="description" content="${DESCRIPTION}">
<link rel="canonical" href="${origin}/">
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:locale" content="he_IL">
<meta property="og:site_name" content="Groupush">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESCRIPTION}">
<meta property="og:url" content="${origin}/">
<meta property="og:image" content="${origin}/app/icon-512.png">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#0A1B33">
<link rel="icon" type="image/png" href="/app/icon-192.png">
<link rel="apple-touch-icon" href="/app/icon-180.png">
<link rel="manifest" href="/app/manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Groupush">
${gv ? `<meta name="google-site-verification" content="${gv}">` : ''}
<script type="application/ld+json" nonce="${nonce}">${structuredData(origin)}</script>
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
.btn{position:relative;overflow:hidden;display:inline-flex;align-items:center;gap:10px;font:600 17px/1 var(--body);padding:16px 26px;border-radius:999px;text-decoration:none;border:0;cursor:pointer;transition:transform .15s,background .15s}
.btn:active{transform:translateY(1px)}
.btn-primary{background:var(--teal);color:var(--ink)}
.btn-primary:hover{background:#2fd8c6}
.btn-quiet{background:transparent;color:var(--white);box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.35)}
.btn-quiet:hover{box-shadow:inset 0 0 0 1.5px var(--teal)}
.btn-dark{background:var(--ink);color:var(--white)}

/* ---------- header ---------- */
.top{position:fixed;inset-inline:0;top:0;z-index:50;transition:background .35s,box-shadow .35s,backdrop-filter .35s}
.top.solid{background:rgba(10,27,51,.82);-webkit-backdrop-filter:blur(14px) saturate(1.4);backdrop-filter:blur(14px) saturate(1.4);box-shadow:0 10px 30px -18px rgba(0,0,0,.6)}
.top .wrap{display:flex;align-items:center;gap:28px;height:78px;transition:height .35s}
.top.solid .wrap{height:64px}
.brand{font-family:var(--display);font-size:30px;color:var(--white);text-decoration:none;letter-spacing:.02em;display:flex;align-items:center;gap:10px}
.brand i{position:relative;display:inline-block;width:12px;height:12px;border-radius:50%;background:var(--teal);box-shadow:0 0 12px 2px rgba(25,198,180,.7);animation:beat 2.4s ease-in-out infinite}
.brand i::before,.brand i::after{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid var(--teal);animation:wave 2.4s cubic-bezier(.2,.6,.3,1) infinite}
.brand i::after{animation-delay:1.2s}
@keyframes wave{from{transform:scale(1);opacity:.9}to{transform:scale(3.4);opacity:0}}
@keyframes beat{0%,100%{transform:scale(1)}12%{transform:scale(1.35)}24%{transform:scale(.92)}36%{transform:scale(1.12)}}
.brand .bt{background:linear-gradient(100deg,#fff 0%,#fff 38%,#19C6B4 46%,#b9fff7 50%,#19C6B4 54%,#fff 62%,#fff 100%);background-size:260% 100%;background-position:100% 0;-webkit-background-clip:text;background-clip:text;color:transparent;animation:logoshine 4.8s ease-in-out infinite}
@keyframes logoshine{0%,30%{background-position:100% 0}70%,100%{background-position:0% 0}}
.brand:hover .bt{animation-duration:1.6s}
.nav{display:flex;gap:26px;margin-inline-start:12px}
.nav a{color:rgba(255,255,255,.78);text-decoration:none;font-size:15px}
.nav a:hover{color:var(--white)}
.top .spacer{flex:1}
.top .login{color:var(--white);text-decoration:none;font-size:15px;opacity:.85}
.top .get{display:inline-flex;align-items:center;gap:7px;background:rgba(25,198,180,.14);color:var(--teal);border:1px solid rgba(25,198,180,.45);border-radius:999px;padding:8px 14px;font:600 14px var(--body);cursor:pointer;text-decoration:none;transition:background .2s,color .2s}
.top .get:hover{background:var(--teal);color:var(--ink)}
.top .get svg{width:16px;height:16px}
@media (max-width:420px){.top .wrap{gap:14px}.top .get span{display:none}.top .get{padding:8px 10px}}
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
@property --ang{syntax:'<angle>';initial-value:0deg;inherits:false}
.stage{position:relative;isolation:isolate;overflow:hidden;color:#fff;border-radius:var(--r-lg);padding:22px;
  background:radial-gradient(110% 90% at 100% 0%,#1E4C8C 0%,transparent 55%),radial-gradient(90% 80% at 0% 100%,rgba(25,198,180,.38) 0%,transparent 60%),#0A1B33;
  box-shadow:0 40px 90px -40px rgba(10,27,51,.75)}
.stage::before{content:"";position:absolute;inset:-40px;z-index:-1;background-image:radial-gradient(rgba(255,255,255,.12) 1px,transparent 1.3px);background-size:22px 22px;animation:gridmove 14s linear infinite;-webkit-mask-image:radial-gradient(80% 70% at 60% 40%,#000,transparent);mask-image:radial-gradient(80% 70% at 60% 40%,#000,transparent)}
@keyframes gridmove{to{transform:translate(22px,22px)}}
.stage::after{content:"";position:absolute;inset:0;border-radius:inherit;padding:1.5px;pointer-events:none;
  background:conic-gradient(from var(--ang),rgba(25,198,180,.15) 0 62%,#19C6B4 76%,#b9fff7 82%,#5b8cff 88%,rgba(25,198,180,.15) 96%);
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;animation:spin 5s linear infinite}
@keyframes spin{to{--ang:360deg}}
.stage .orb{position:absolute;z-index:-1;width:220px;height:220px;border-radius:50%;filter:blur(50px);background:rgba(25,198,180,.35);top:30%;inset-inline-start:-60px;animation:orb 9s ease-in-out infinite alternate;pointer-events:none}
@keyframes orb{to{transform:translate(-160px,-60px) scale(1.25);background:rgba(91,140,255,.32)}}
.tabs{display:flex;gap:6px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.1);padding:5px;border-radius:999px;width:max-content;max-width:100%}
.tabs button{white-space:nowrap;position:relative;overflow:hidden;border:0;background:transparent;font:600 15px var(--body);padding:9px 18px;border-radius:999px;cursor:pointer;color:rgba(255,255,255,.7);transition:background .3s,color .3s}
.tabs button[aria-pressed=true]{background:var(--teal);color:var(--ink);box-shadow:0 6px 20px -6px rgba(25,198,180,.8)}
.tabs button::after{content:"";position:absolute;inset-inline-start:14px;inset-inline-end:14px;bottom:4px;height:2px;border-radius:2px;background:rgba(10,27,51,.55);transform:scaleX(0);transform-origin:right}
.tabs button.auto::after{animation:tabfill var(--cycle,3.6s) linear forwards}
@keyframes tabfill{to{transform:scaleX(1)}}
@media (max-width:420px){.tabs button{padding:9px 13px;font-size:14px}}
.st-grid{display:grid;grid-template-columns:1fr 1.25fr;gap:18px;margin-top:20px}
.col h4{margin:0 0 10px;font-size:13px;color:rgba(255,255,255,.6);font-weight:600}
.msg{background:#dcf8c6;color:#0b1c10;border-radius:12px 12px 4px 12px;padding:10px 12px;font-size:14px;line-height:1.45;transition:background .4s,box-shadow .4s}
.msg.pop{animation:pop .5s cubic-bezier(.2,.9,.25,1.4)}
@keyframes pop{40%{transform:scale(1.05);box-shadow:0 0 0 6px rgba(25,198,180,.35)}}
.copy{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);border-radius:12px;padding:9px 11px;font-size:13.5px;margin-bottom:8px;display:flex;flex-direction:column;gap:2px;transition:background .5s,border-color .5s,transform .4s}
.copy b{font-size:12px;color:rgba(255,255,255,.55);font-weight:600}
.copy.flash{background:rgba(25,198,180,.22);border-color:var(--teal);transform:translateX(-6px)}
.copy.gone .txt{color:rgba(255,255,255,.45);font-style:italic}
.msg.gone{color:#5b6b5e;font-style:italic}
.stage .note{margin-top:14px;font-size:14px;color:#8ff5ea;min-height:1.6em}
@media (max-width:900px){.sync .grid{grid-template-columns:1fr;gap:40px}.st-grid{grid-template-columns:1fr}}

/* clients */
.clients{padding:64px 0 10px}
.eyebrow{margin:0 0 22px;text-align:center;font-size:14px;letter-spacing:.12em;color:var(--muted);font-weight:600}
.logos{list-style:none;padding:0;margin:0;display:flex;justify-content:center;flex-wrap:wrap;gap:18px}
.client{display:flex;align-items:center;gap:14px;background:var(--white);border:1px solid var(--line);border-radius:20px;padding:14px 22px 14px 26px;box-shadow:0 18px 40px -30px rgba(10,27,51,.45);transition:transform .25s,box-shadow .25s,border-color .25s}
.client:hover{transform:translateY(-3px);border-color:var(--teal);box-shadow:0 24px 44px -28px rgba(10,27,51,.5)}
.client img,.client .mono{width:56px;height:56px;border-radius:50%;object-fit:cover;flex:none}
.client .mono{display:grid;place-items:center;background:linear-gradient(140deg,var(--navy),var(--ink));color:var(--teal);font-family:var(--display);font-size:24px}
.client b{font-family:var(--display);font-weight:400;font-size:22px}
@media (max-width:560px){.client{padding:12px 16px 12px 20px}.client b{font-size:19px}}

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

/* topics */
.topics{padding:0 0 90px}
.topics h2{font-size:clamp(24px,3vw,32px);margin-bottom:18px}
.topics ul{list-style:none;padding:0;margin:0;display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
.topics a{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid var(--line);border-radius:16px;padding:16px 18px;text-decoration:none;font-weight:600;transition:border-color .2s,transform .2s,box-shadow .2s}
.topics a::after{content:"←";color:var(--teal-deep);font-family:var(--display)}
.topics a:hover{border-color:var(--teal);transform:translateY(-2px);box-shadow:0 14px 30px -20px rgba(10,27,51,.4)}

/* final */
.final{background:var(--teal);padding:90px 0}
.final .wrap{display:flex;align-items:center;justify-content:space-between;gap:30px;flex-wrap:wrap}
.final h2{color:var(--ink);max-width:16ch}
footer{background:var(--ink);color:rgba(255,255,255,.6);padding:40px 0;font-size:14px}
footer .wrap{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}
footer a{text-decoration:none;color:rgba(255,255,255,.75);margin-inline-start:18px}


/* ---------- eye candy ---------- */
.progress{position:fixed;top:0;inset-inline:0;height:3px;z-index:60;background:linear-gradient(270deg,var(--teal),#8ff5ea,#5b8cff);transform-origin:right center;transform:scaleX(0);pointer-events:none}
.hero::before,.hero::after{content:"";position:absolute;border-radius:50%;filter:blur(90px);pointer-events:none;will-change:transform}
.hero::before{width:560px;height:560px;background:rgba(25,198,180,.42);top:-200px;inset-inline-start:-140px;animation:drift 16s ease-in-out infinite alternate}
.hero::after{width:620px;height:620px;background:rgba(70,110,230,.38);bottom:-300px;inset-inline-end:-200px;animation:drift2 21s ease-in-out infinite alternate}
@keyframes drift{to{transform:translate(-90px,70px) scale(1.18)}}
@keyframes drift2{to{transform:translate(110px,-60px) scale(.9)}}
.hero .dots{position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.09) 1px,transparent 1.2px);background-size:26px 26px;-webkit-mask-image:radial-gradient(65% 60% at 50% 40%,#000,transparent);mask-image:radial-gradient(65% 60% at 50% 40%,#000,transparent);pointer-events:none}
.hero .wrap{position:relative;z-index:1}
.hero h1 .l2{background:linear-gradient(90deg,#19C6B4 0%,#9ff7ee 25%,#19C6B4 50%,#5fe0d2 75%,#19C6B4 100%);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:shine 5s linear infinite}
@keyframes shine{to{background-position:-200% 0}}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:22px}
.chip{display:inline-flex;align-items:center;gap:8px;font-size:13.5px;color:rgba(255,255,255,.85);background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:6px 13px;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.chip .live{width:8px;height:8px;border-radius:50%;background:#2ee59d;box-shadow:0 0 0 0 rgba(46,229,157,.7);animation:ping 1.8s infinite}
@keyframes ping{70%{box-shadow:0 0 0 9px rgba(46,229,157,0)}100%{box-shadow:0 0 0 0 rgba(46,229,157,0)}}
.btn-primary{position:relative;overflow:hidden;box-shadow:0 10px 30px -10px rgba(25,198,180,.7)}
.btn-primary::after{content:"";position:absolute;top:0;bottom:0;left:0;width:35%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.65),transparent);transform:translateX(-160%) skewX(-20deg);animation:sweep 3.4s ease-in-out infinite;pointer-events:none}
@keyframes sweep{55%,100%{transform:translateX(420%) skewX(-20deg)}}
.btn:hover{transform:translateY(-2px)}
.ripple{position:absolute;border-radius:50%;background:rgba(255,255,255,.55);transform:scale(0);animation:rip .6s ease-out forwards;pointer-events:none}
@keyframes rip{to{transform:scale(4);opacity:0}}
.ctrl{animation:floaty 6s ease-in-out infinite}
@keyframes floaty{50%{transform:translateY(calc(-50% - 8px))}}
@media (max-width:560px){.ctrl{animation:none}}
.spark{position:absolute;width:7px;height:7px;border-radius:50%;pointer-events:none;animation:spark .95s cubic-bezier(.15,.8,.3,1) forwards;z-index:3}
@keyframes spark{from{transform:translate(0,0) scale(1);opacity:1}to{transform:translate(var(--tx),var(--ty)) scale(.2);opacity:0}}

.ticker{background:var(--teal);color:var(--ink);overflow:hidden;white-space:nowrap;padding:15px 0;font-family:var(--display);font-size:clamp(17px,2vw,21px);position:relative;z-index:2;box-shadow:0 -1px 0 rgba(0,0,0,.05)}
.ticker .track{display:inline-flex;align-items:center;gap:34px;padding-inline-end:34px;animation:marq 32s linear infinite;will-change:transform}
.ticker .track span{display:inline-flex;align-items:center;gap:34px}
.ticker .track span::after{content:"✦";font-size:.8em;opacity:.55}
.ticker:hover .track{animation-play-state:paused}
@keyframes marq{to{transform:translateX(50%)}}

.rv{opacity:0;transform:translateY(30px);transition:opacity .8s cubic-bezier(.2,.7,.2,1),transform .8s cubic-bezier(.2,.7,.2,1);transition-delay:var(--d,0s)}
.rv.in{opacity:1;transform:none}
.step::before{background:linear-gradient(160deg,var(--teal),var(--teal-deep));-webkit-background-clip:text;background-clip:text;color:transparent}
.spot{position:relative;isolation:isolate;transition:transform .25s ease,box-shadow .3s}
.spot::before{content:"";position:absolute;inset:0;border-radius:inherit;background:radial-gradient(380px circle at var(--mx,50%) var(--my,50%),rgba(25,198,180,.22),transparent 45%);opacity:0;transition:opacity .3s;z-index:-1;pointer-events:none}
.spot:hover::before{opacity:1}
.plan.spot:hover{box-shadow:0 30px 60px -30px rgba(10,27,51,.45)}

/* the app section */
.appsec{background:linear-gradient(180deg,var(--white),var(--paper));overflow:hidden}
.appsec .grid{display:grid;grid-template-columns:1fr 1fr;gap:70px;align-items:center}
.perks{list-style:none;padding:0;margin:26px 0 30px;display:grid;gap:14px}
.perks li{display:flex;gap:12px;align-items:flex-start}
.perks li i{flex:none;width:34px;height:34px;border-radius:11px;background:var(--teal-mist);display:grid;place-items:center;font-style:normal;font-size:17px}
.appsec .ctas{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.appsec .how{color:var(--teal-deep);font-weight:600;text-decoration:none}
.phone-wrap{position:relative;display:grid;place-items:center;min-height:560px}
.phone-wrap::before{content:"";position:absolute;width:420px;height:420px;border-radius:50%;background:radial-gradient(circle,rgba(25,198,180,.35),transparent 65%);filter:blur(10px);animation:glow 5s ease-in-out infinite alternate}
@keyframes glow{to{transform:scale(1.15);opacity:.7}}
.phone{position:relative;width:280px;height:560px;border-radius:44px;background:#0b1424;padding:12px;box-shadow:0 50px 90px -30px rgba(10,27,51,.55),inset 0 0 0 2px #26344d;transform:rotate(-4deg);animation:phonefloat 7s ease-in-out infinite}
@keyframes phonefloat{50%{transform:rotate(-2deg) translateY(-12px)}}
.phone::before{content:"";position:absolute;top:20px;left:50%;width:90px;height:24px;margin-left:-45px;border-radius:20px;background:#0b1424;z-index:2}
.screen{height:100%;border-radius:34px;background:var(--paper);overflow:hidden;display:flex;flex-direction:column}
.ph-top{background:var(--ink);color:#fff;padding:52px 16px 14px;display:flex;align-items:center;justify-content:space-between}
.ph-top b{font-family:var(--display);font-weight:400;font-size:20px;letter-spacing:.04em}
.ph-live{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#bfe9e3}
.ph-live i{width:7px;height:7px;border-radius:50%;background:#2ee59d;animation:ping 1.8s infinite}
.ph-list{padding:12px;display:grid;gap:10px}
.ph-card{background:#fff;border-radius:16px;padding:11px 12px;box-shadow:0 6px 16px -10px rgba(10,27,51,.35);opacity:0;transform:translateY(14px) scale(.98);transition:opacity .5s,transform .5s cubic-bezier(.2,.9,.25,1.2)}
.ph-card.in{opacity:1;transform:none}
.ph-card p{margin:0;font-size:12.5px;line-height:1.45;color:var(--ink)}
.ph-meta{display:flex;justify-content:space-between;align-items:center;margin-top:8px;font-size:11.5px;color:var(--muted)}
.ph-bar{height:5px;border-radius:5px;background:var(--line);overflow:hidden;margin-top:7px}
.ph-bar i{display:block;height:100%;width:0;background:linear-gradient(270deg,var(--teal),var(--teal-deep));border-radius:5px;transition:width 1.6s cubic-bezier(.2,.8,.2,1)}
.ph-eye{font-weight:600;color:var(--teal-deep)}
.ph-toast{position:absolute;top:118px;inset-inline:22px;z-index:3;background:rgba(10,27,51,.94);color:#fff;border-radius:16px;padding:10px 12px;font-size:12.5px;display:flex;gap:10px;align-items:center;box-shadow:0 18px 40px -14px rgba(0,0,0,.6);transform:translateY(-30px) scale(.95);opacity:0;transition:transform .5s cubic-bezier(.2,.9,.25,1.3),opacity .4s}
.ph-toast.on{transform:none;opacity:1}
.ph-toast img{width:28px;height:28px;border-radius:8px}
.ph-tag{position:absolute;inset-inline-end:-6px;bottom:30px;background:var(--white);border:1px solid var(--line);border-radius:999px;padding:7px 14px;font-size:13px;color:var(--muted);box-shadow:0 10px 30px -16px rgba(10,27,51,.4)}
@media (max-width:900px){.appsec .grid{grid-template-columns:1fr;gap:30px}.phone-wrap{min-height:520px;order:2}}
@media (max-width:420px){.phone{width:250px;height:510px}}
.final .ctas{display:flex;gap:12px;flex-wrap:wrap}
.btn-ink-ghost{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 2px var(--ink)}
.btn svg{width:18px;height:18px}
${installPromptCss()}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}html{scroll-behavior:auto}.rv{opacity:1;transform:none}.ph-card{opacity:1;transform:none}}
</style>
</head>
<body>
<div class="progress" id="progress" aria-hidden="true"></div>

<header class="top" id="top">
  <div class="wrap">
    <a class="brand" href="/" aria-label="Groupush, דף הבית"><i aria-hidden="true"></i><span class="bt">Groupush</span></a>
    <nav class="nav" aria-label="ניווט ראשי">
      <a href="#how">איך זה עובד</a><a href="#sync">עריכה ומחיקה</a><a href="#pricing">מחירים</a><a href="#faq">שאלות</a>
    </nav>
    <div class="spacer"></div>
    <a class="get" href="/app/install" data-install="1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg><span>התקנת האפליקציה</span></a>
    <a class="login" href="/app">כניסה</a>
  </div>
</header>

<main>
<section class="hero" aria-labelledby="hero-title">
  <div class="dots" aria-hidden="true"></div>
  <div class="wrap">
    <div>
      <div class="chips"><span class="chip"><i class="live" aria-hidden="true"></i>עובד בענן, גם כשהטלפון כבוי</span><span class="chip">WhatsApp + Telegram</span></div>
      <h1 id="hero-title">הודעה אחת.<span class="l2">כל הקבוצות.</span></h1>
      <p class="lead">כותבים פעם אחת בקבוצת שליטה ב‑WhatsApp, ו‑Groupush מפיצה לכל קבוצות ה‑WhatsApp וה‑Telegram שלכם. טעות כתיב? עורכים פעם אחת, וכל העותקים מתעדכנים.</p>
      <div class="ctas">
        <a class="btn btn-primary" href="/app#signup">התחילו עכשיו</a>
        <a class="btn btn-quiet" href="#how">איך זה עובד</a>
      </div>
      <p class="fine">בלי להיכנס לאתר בכל פרסום. העבודה היומיומית נשארת ב‑WhatsApp.</p>
    </div>

    <div class="fan" id="fan" aria-label="הדגמה: הודעה מקבוצת השליטה מופצת לשש קבוצות">
      <svg class="wires" id="wires" aria-hidden="true"></svg>
      <div class="ctrl" id="ctrl">
        <div class="ttl"><span class="dot" aria-hidden="true">P</span><span><b>קבוצת שליטה</b><br>אתם ו‑Groupush</span></div>
        <div class="bubble"><span class="t" id="typed"></span><span class="caret" id="caret" aria-hidden="true"></span><div class="meta" id="sent-at"></div></div>
        <div class="report" id="report" role="status"></div>
      </div>
      <div class="groups" id="groups"></div>
      <div class="count" aria-live="polite"><b id="n">0</b> מתוך 6 קבוצות</div>
      <button class="replay" id="replay" type="button">הפעלה מחדש</button>
    </div>
  </div>
</section>

<div class="ticker" aria-hidden="true"><div class="track"><span>הודעה אחת לכל הקבוצות</span><span>עריכה מסונכרנת</span><span>מחיקה לכולם</span><span>תזמון לשעה מדויקת</span><span>הלוגו שלכם על תמונות וסרטונים</span><span>דיווח בקבוצת השליטה</span><span>WhatsApp וגם Telegram</span><span>כמה קראו כל הודעה</span><span>הודעה אחת לכל הקבוצות</span><span>עריכה מסונכרנת</span><span>מחיקה לכולם</span><span>תזמון לשעה מדויקת</span><span>הלוגו שלכם על תמונות וסרטונים</span><span>דיווח בקבוצת השליטה</span><span>WhatsApp וגם Telegram</span><span>כמה קראו כל הודעה</span></div></div>

<section id="how" aria-labelledby="how-title">
  <div class="wrap">
    <div class="sec-head">
      <h2 id="how-title">שלושה צעדים, ואתם מפיצים</h2>
      <p class="lead">ההקמה לוקחת כמה דקות. אחריה לא צריך לפתוח שום מערכת: כל מה שתכתבו בקבוצת השליטה יגיע לכל הקבוצות.</p>
    </div>
    <div class="steps">
      <div class="step"><h3>מחברים מספר WhatsApp</h3><p>סורקים קוד QR, כמו ב‑WhatsApp Web. מומלץ מספר נפרד ל‑Groupush, לא המספר האישי.</p></div>
      <div class="step"><h3>פותחים קבוצת שליטה</h3><p>קבוצה קטנה שבה אתם והמספר המחובר. בוחרים לאילו קבוצות יעד היא מפיצה, ומי רשאי לפרסם ממנה.</p></div>
      <div class="step"><h3>כותבים, וזהו</h3><p>כל הודעה בקבוצת השליטה יוצאת לכל הקבוצות. בסוף מגיע דיווח: לכמה קבוצות הגיעה, ואם משהו נכשל ולמה.</p></div>
    </div>
  </div>
</section>

<section class="sync" id="sync" aria-labelledby="sync-title">
  <div class="wrap grid">
    <div>
      <h2 id="sync-title">טעות בהודעה? מתקנים אותה פעם אחת.</h2>
      <p class="lead gap">Groupush זוכרת כל עותק בכל קבוצה, ומחילה עליו את מה שעשיתם בקבוצת השליטה.</p>
      <ul>
        <li><span aria-hidden="true">✓</span><div>עורכים את ההודעה בקבוצת השליטה, וכל העותקים נערכים במקום, בלי הודעה חדשה.</div></li>
        <li><span aria-hidden="true">✓</span><div>"מחק לכולם" מוחק אותה מכל הקבוצות. "מחק אצלי" לא נוגע בכלום.</div></li>
        <li><span aria-hidden="true">✓</span><div>הודעה שנמחקה לפני שיצאה לא תצא בכלל, גם אם הייתה בתור.</div></li>
      </ul>
    </div>
    <div class="stage" id="stage">
      <span class="orb" aria-hidden="true"></span>
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

<section class="clients" aria-labelledby="clients-title">
  <div class="wrap">
    <p class="eyebrow" id="clients-title">הלקוחות שלנו</p>
    <ul class="logos">
${CLIENTS.map((c) => `      <li class="client">${c.logo ? `<img src="${c.logo}" alt="" width="64" height="64" loading="lazy">` : `<span class="mono" aria-hidden="true">${c.name.slice(0, 1)}</span>`}<b>${c.name}</b></li>`).join('\n')}
    </ul>
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

<section class="appsec" id="app" aria-labelledby="app-title">
  <div class="wrap grid">
    <div class="phone-wrap" aria-hidden="true">
      <div class="phone" id="phone">
        <div class="ph-toast" id="ph-toast"><img src="/app/icon-192.png" alt="" width="28" height="28"><span><b>Groupush</b><br>ההודעה הגיעה ל‑12 מתוך 12 קבוצות</span></div>
        <div class="screen">
          <div class="ph-top"><b>Groupush</b><span class="ph-live"><i></i>WhatsApp מחובר</span></div>
          <div class="ph-list" id="ph-list">
            <div class="ph-card"><p>🔴 מבזק: עומסים כבדים בכניסה לירושלים</p><div class="ph-bar"><i data-w="100"></i></div><div class="ph-meta"><span>12/12 קבוצות</span><span class="ph-eye">👁 <b data-to="1840">0</b></span></div></div>
            <div class="ph-card"><p>⚡ עדכון: הכביש נפתח מחדש לתנועה</p><div class="ph-bar"><i data-w="100"></i></div><div class="ph-meta"><span>12/12 קבוצות</span><span class="ph-eye">👁 <b data-to="960">0</b></span></div></div>
            <div class="ph-card"><p>📷 תמונה עם הלוגו שלכם, אוטומטית</p><div class="ph-bar"><i data-w="100"></i></div><div class="ph-meta"><span>12/12 קבוצות</span><span class="ph-eye">👁 <b data-to="2315">0</b></span></div></div>
            <div class="ph-card"><p>🕐 12:30 · תזכורת: שידור חי בעוד חצי שעה</p><div class="ph-bar"><i data-w="35"></i></div><div class="ph-meta"><span>מתוזמנת</span><span class="ph-eye">⏳</span></div></div>
          </div>
        </div>
      </div>
      <span class="ph-tag">הדגמה</span>
    </div>
    <div>
      <h2 id="app-title">Groupush גם בכיס שלכם</h2>
      <p class="lead gap">מתקינים את האפליקציה ישר ממסך הבית: בלי חנות אפליקציות, בלי הורדה כבדה, ונפתחת בלחיצה אחת.</p>
      <ul class="perks">
        <li><i aria-hidden="true">📤</i><div>כל הודעה שיצאה, ולאילו קבוצות הגיעה</div></li>
        <li><i aria-hidden="true">👁</i><div>כמה אנשים קראו כל הודעה</div></li>
        <li><i aria-hidden="true">🔔</i><div>התראה לטלפון מיד כשהמספר מתנתק או כשמשהו עוצר את השליחה</div></li>
        <li><i aria-hidden="true">⚙️</i><div>חתימה, לוגו וקבוצות, לשינוי מתי שרוצים</div></li>
      </ul>
      <div class="ctas">
        <a class="btn btn-primary" href="/app/install" data-install="1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>התקנת האפליקציה</a>
        <a class="how" href="/app/install">איך מתקינים באייפון ובאנדרואיד ←</a>
      </div>
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
      <div><dt>יש סיכון לחסימת המספר</dt><dd>WhatsApp אוסרת הודעות אוטומטיות והמוניות. לכן אנחנו ממליצים על מספר נפרד ל‑Groupush, וקובעים קצב שליחה זהיר.</dd></div>
      <div><dt>רק לקבוצות שמותר לכם לפרסם בהן</dt><dd>Groupush שולחת רק לקבוצות שבחרתם ושהמספר חבר בהן. אין שליחה לאנשים פרטיים.</dd></div>
      <div><dt>אנחנו לא מבטיחים מה שלא בדקנו</dt><dd>עריכה ב‑WhatsApp אפשרית עד 15 דקות מהשליחה. כשמשהו לא אפשרי, הדיווח בקבוצת השליטה אומר לכם בדיוק איפה ולמה.</dd></div>
    </dl>
  </div>
</section>

<section id="pricing" aria-labelledby="pricing-title">
  <div class="wrap">
    <div class="sec-head"><h2 id="pricing-title">מחירים</h2><p class="lead">עד 10 קבוצות, כולל טלגרם, בחינם. כשהרשת גדלה, עוברים ל‑Premium.</p></div>
    <div class="plans">
      <div class="plan">
        <h3>חינם</h3>
        <div class="price"><b>0<span class="cur">₪</span></b></div>
        <p class="tag">לרשת קטנה של קבוצות</p>
        <ul><li>עד 10 קבוצות יעד, WhatsApp ו‑Telegram</li><li>עריכה ומחיקה מסונכרנות</li><li>חתימה קבועה מתחת לכל הודעה</li><li>דיווחים בקבוצת השליטה</li><li>Groupush מפרסמת מדי פעם הודעות משלה בערוצי הטלגרם שחיברתם</li></ul>
        <a class="btn btn-dark" href="/app#signup">פתיחת חשבון</a>
      </div>
      <div class="plan main">
        <h3>Premium</h3>
        <div class="price"><b>300<span class="cur">₪</span></b><span>לחודש, לפני מע"מ</span></div>
        <p class="tag">לרשתות קבוצות שמפיצות כל יום</p>
        <ul><li>עד 30 קבוצות יעד, WhatsApp ו‑Telegram</li><li>כמה נקראה כל הודעה, ובאיזו קבוצה</li><li>היסטוריה וסטטוס לכל קבוצה</li><li>תמיכה אישית</li><li>בלי פרסומים של Groupush</li></ul>
        <a class="btn btn-primary" href="/app#signup">מתחילים ב‑Premium</a>
      </div>
    </div>
  </div>
</section>

<section class="faq-sec" aria-labelledby="faq-title">
  <div class="wrap">
    <div class="sec-head"><h2 id="faq-title">שאלות שחוזרות</h2></div>
    <div class="faq" id="faq">
${FAQ.map(([q, a]) => `      <details><summary>${q}</summary><p>${a}</p></details>`).join('\n')}
      <details><summary>צריך להשאיר את הטלפון פתוח?</summary><p>לא. אחרי סריקת קוד ה‑QR, Groupush עובדת בענן גם כשהטלפון כבוי או רחוק. המספר צריך להישאר מחובר ל‑WhatsApp.</p></details>
      <details><summary>מה קורה אם אחת הקבוצות לא קיבלה את ההודעה?</summary><p>Groupush מנסה שוב רק בקבוצות שנכשלו, אחרי 30 שניות, 2 דקות ו‑5 דקות. אם לא ידוע אם ההודעה הגיעה, היא לא תישלח שוב לבד, כדי שלא תופיע פעמיים.</p></details>
      <details><summary>אפשר להפיץ גם לטלגרם?</summary><p>כן. מחברים בוט טלגרם, ו‑Groupush מפיצה גם לקבוצות ולערוצים שלכם שם. בקבוצת שליטה בטלגרם עונים "מחק" על הודעה כדי למחוק אותה מכל הקבוצות.</p></details>
      <details><summary>מי עוד יכול לפרסם מקבוצת השליטה?</summary><p>אתם קובעים. אפשר להגביל את ההפצה, העריכה והמחיקה למספרים מסוימים בלבד.</p></details>
      <details><summary>מה עם הפרטיות של ההודעות?</summary><p>תוכן ההודעות נשמר רק כמה שצריך כדי להפיץ אותן, ונמחק אוטומטית אחרי 7 ימים. פרטי החיבור ל‑WhatsApp מוצפנים.</p></details>
    </div>
  </div>
</section>

<nav class="topics" aria-label="מדריכים">
  <div class="wrap">
    <h2>מה אפשר לעשות עם Groupush</h2>
    <ul>${LANDING_PAGES.map((p) => `<li><a href="/${p.slug}">${p.h1}</a></li>`).join('')}</ul>
  </div>
</nav>

<section class="final">
  <div class="wrap">
    <h2>מוכנים להפסיק להעתיק ולהדביק?</h2>
    <div class="ctas"><a class="btn btn-dark" href="/app#signup">התחילו עכשיו</a><a class="btn btn-ink-ghost" href="/app/install" data-install="1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>התקנת האפליקציה</a></div>
  </div>
</section>
</main>

<footer>
  <div class="wrap">
    <span>© ${new Date().getFullYear()} Groupush. הודעה אחת. כל הקבוצות.</span>
    <span><a href="#faq">שאלות נפוצות</a><a href="/app">כניסה למערכת</a></span>
  </div>
</footer>

${installPromptHtml()}

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
  report.textContent='✅ Groupush · ההודעה נשלחה בהצלחה ל‑6 מתוך 6 קבוצות.';report.className='report on'}
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
  later(800+cards.length*380+400,function(){report.textContent='✅ Groupush · ההודעה נשלחה בהצלחה ל‑6 מתוך 6 קבוצות.';report.className='report on'});
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
// The three actions play by themselves (send → edit → delete) while the demo is on screen;
// a tap on one stops the autoplay for a while so the visitor can look.
var tabBtns=[].slice.call(document.querySelectorAll('.tabs button')),CYCLE=3600,curTab=0,pauseUntil=0,stageOn=false,autoTimer=null;
function choose(i,auto){curTab=i;var b=tabBtns[i];
  tabBtns.forEach(function(x){x.setAttribute('aria-pressed',String(x===b));x.classList.remove('auto')});
  var a=b.getAttribute('data-act');setAll(a==='edit'?EDITED:SRC,a==='delete',a!=='send');note.textContent=NOTES[a];
  if(a!=='send'&&!reduce){src.classList.remove('pop');void src.offsetWidth;src.classList.add('pop')}
  if(auto&&!reduce){void b.offsetWidth;b.style.setProperty('--cycle',CYCLE+'ms');b.classList.add('auto')}}
function schedule(){clearTimeout(autoTimer);if(reduce)return;autoTimer=setTimeout(function(){
  if(stageOn&&Date.now()>=pauseUntil)choose((curTab+1)%tabBtns.length,true);else if(stageOn)tabBtns[curTab].classList.remove('auto');
  schedule()},Date.now()<pauseUntil?pauseUntil-Date.now()+50:CYCLE)}
tabBtns.forEach(function(b,i){b.addEventListener('click',function(){pauseUntil=Date.now()+12000;choose(i,false);schedule()})});
var stageEl=document.getElementById('stage');
stageEl.addEventListener('pointerenter',function(){if(fineHover){pauseUntil=Date.now()+600000;tabBtns[curTab].classList.remove('auto')}});
stageEl.addEventListener('pointerleave',function(){if(fineHover){pauseUntil=0;choose(curTab,true);schedule()}});
var fineHover=window.matchMedia&&matchMedia('(hover: hover) and (pointer: fine)').matches;
setAll(SRC,false,false);note.textContent=NOTES.send;
if('IntersectionObserver' in window){new IntersectionObserver(function(es){var was=stageOn;stageOn=es[0].isIntersecting;if(stageOn&&!was){choose(curTab,true);schedule()}},{threshold:.4}).observe(stageEl)}
else{stageOn=true;choose(0,true);schedule()}

// ---- eye candy: scroll progress, glass header, reveal on scroll, spotlight + tilt, ripples, sparks, the phone demo
var hdr=document.getElementById('top'),bar=document.getElementById('progress'),ticking=false;
function onScroll(){if(ticking)return;ticking=true;requestAnimationFrame(function(){ticking=false;
  var h=document.documentElement,max=h.scrollHeight-h.clientHeight,y=h.scrollTop||document.body.scrollTop;
  bar.style.transform='scaleX('+(max>0?Math.min(1,y/max):0)+')';hdr.classList.toggle('solid',y>30)})}
window.addEventListener('scroll',onScroll,{passive:true});onScroll();

var revealTargets=document.querySelectorAll('.client,.sec-head,.step,.who>div,.plan,.faq details,.stage,.sync li,.honest dl>div,.honest h2,.honest .lead,.final h2,.final .ctas,.perks li,.appsec h2,.appsec .lead,.appsec .ctas');
if('IntersectionObserver' in window&&!reduce){
  var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}})},{rootMargin:'0px 0px -8% 0px',threshold:.12});
  var groupsSeen=new Map();
  [].forEach.call(revealTargets,function(el){var p=el.parentElement,k=(groupsSeen.get(p)||0);groupsSeen.set(p,k+1);
    el.style.setProperty('--d',(Math.min(k,6)*0.09)+'s');el.classList.add('rv');io.observe(el)});
}

var fine=window.matchMedia&&matchMedia('(hover: hover) and (pointer: fine)').matches;
[].forEach.call(document.querySelectorAll('.plan,.who>div'),function(el){
  el.classList.add('spot');
  el.addEventListener('pointermove',function(e){var r=el.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;
    el.style.setProperty('--mx',x+'px');el.style.setProperty('--my',y+'px');
    if(fine&&!reduce&&el.classList.contains('plan')){var rx=((y/r.height)-.5)*-6,ry=((x/r.width)-.5)*6;el.style.transform='perspective(900px) rotateX('+rx+'deg) rotateY('+ry+'deg) translateY(-4px)'}});
  el.addEventListener('pointerleave',function(){el.style.transform=''});
});

[].forEach.call(document.querySelectorAll('.btn'),function(b){b.addEventListener('pointerdown',function(e){if(reduce)return;
  var r=b.getBoundingClientRect(),s=Math.max(r.width,r.height),d=document.createElement('span');d.className='ripple';
  d.style.width=d.style.height=s+'px';d.style.left=(e.clientX-r.left-s/2)+'px';d.style.top=(e.clientY-r.top-s/2)+'px';
  b.appendChild(d);setTimeout(function(){d.remove()},650)})});

var ctrl=document.getElementById('ctrl');
function sparks(){if(reduce)return;var colors=['#19C6B4','#8ff5ea','#ffffff','#2ee59d','#5b8cff'];
  var rr=report.getBoundingClientRect(),cr=ctrl.getBoundingClientRect(),ox=rr.left-cr.left+rr.width/2,oy=rr.top-cr.top+rr.height/2;
  for(var i=0;i<22;i++){var p=document.createElement('span');p.className='spark';var a=Math.random()*Math.PI*2,dist=50+Math.random()*90;
    p.style.left=ox+'px';p.style.top=oy+'px';p.style.background=colors[i%colors.length];
    p.style.setProperty('--tx',Math.cos(a)*dist+'px');p.style.setProperty('--ty',Math.sin(a)*dist+'px');
    ctrl.appendChild(p);(function(x){setTimeout(function(){x.remove()},1000)})(p)}}
new MutationObserver(function(){if(report.classList.contains('on'))sparks()}).observe(report,{attributes:true,attributeFilter:['class']});

var phoneCards=[].slice.call(document.querySelectorAll('.ph-card')),toast=document.getElementById('ph-toast'),phoneRan=false;
function countUp(el,to){if(reduce){el.textContent=to.toLocaleString('he-IL');return}var t0=performance.now(),dur=1800;
  (function f(t){var k=Math.min(1,(t-t0)/dur),v=Math.round(to*(1-Math.pow(1-k,3)));el.textContent=v.toLocaleString('he-IL');if(k<1)requestAnimationFrame(f)})(t0)}
function runPhone(){if(phoneRan)return;phoneRan=true;
  phoneCards.forEach(function(c,i){setTimeout(function(){c.classList.add('in');
    var b=c.querySelector('.ph-bar i');if(b)setTimeout(function(){b.style.width=b.getAttribute('data-w')+'%'},150);
    var n=c.querySelector('[data-to]');if(n)setTimeout(function(){countUp(n,Number(n.getAttribute('data-to')))},300)},reduce?0:300+i*450)});
  setTimeout(function(){toast.classList.add('on');setTimeout(function(){toast.classList.remove('on')},3600)},reduce?0:2200)}
if('IntersectionObserver' in window){var pio=new IntersectionObserver(function(es){if(es.some(function(e){return e.isIntersecting})){runPhone();pio.disconnect()}},{threshold:.35});pio.observe(document.getElementById('phone'))}else runPhone();
})();
</script>
<script nonce="${nonce}">${installPromptJs(4000)}</script>
</body>
</html>`;
}
