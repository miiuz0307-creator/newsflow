/**
 * The PUSH customer app (served at /app): sign in / sign up, overview,
 * distribution history with the status of every copy, the simulation (demo
 * servers only) and platform capabilities. One static page, Hebrew RTL,
 * same design system as the marketing site.
 *
 * All server text is inserted with textContent (never innerHTML), and the
 * page runs under a strict Content-Security-Policy with a nonce.
 */
import { fontFaceCss } from './fonts.js';

export function dashboardHtml(nonce: string): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PUSH — המערכת</title>
<link rel="preload" href="/fonts/ibm-plex-sans-hebrew-hebrew-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<style nonce="${nonce}">
${fontFaceCss()}
:root{
  --ink:#0A1B33;--navy:#12305C;--teal:#19C6B4;--teal-deep:#0B8A7E;--teal-mist:#E3F8F5;
  --bg:#F3F6FA;--card:#FFFFFF;--text:#0A1B33;--muted:#5E6E86;--line:#E1E8F0;--soft:#F7F9FC;
  --ok:#0F9F6E;--ok-soft:#E3F7EF;--bad:#D63B3B;--bad-soft:#FCE9E9;--warn:#B7791F;--warn-soft:#FDF3E1;--info:#2563EB;--info-soft:#E8EFFD;
  --wa:#DCF8C6;--wa-ink:#0b1c10;
  --display:"Secular One","IBM Plex Sans Hebrew",system-ui,sans-serif;--body:"IBM Plex Sans Hebrew",system-ui,sans-serif;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#071225;--card:#0D1C33;--text:#E7EEF8;--muted:#93A4BD;--line:#1C3152;--soft:#0A1830;--teal-mist:#0E3A3A;
  --ok-soft:#0D2E25;--bad-soft:#3A1717;--warn-soft:#352812;--info-soft:#14254A;--wa:#1F4D36;--wa-ink:#E6F5EC;
}}
*{box-sizing:border-box}
body{margin:0;font-family:var(--body);background:var(--bg);color:var(--text);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:var(--display);font-weight:400;margin:0;line-height:1.2}
button{font:inherit;color:inherit}
:focus-visible{outline:3px solid var(--teal);outline-offset:2px;border-radius:6px}
[hidden]{display:none!important}

/* ---------- auth ---------- */
.auth{min-height:100vh;display:grid;grid-template-columns:1fr 1.1fr}
.auth-brand{background:radial-gradient(900px 500px at 80% 10%,#183f75 0%,transparent 60%),var(--ink);color:#fff;padding:56px;display:flex;flex-direction:column;justify-content:space-between}
.logo{font-family:var(--display);font-size:28px;display:flex;align-items:center;gap:10px;color:#fff;text-decoration:none}
.logo i{width:11px;height:11px;border-radius:50%;background:var(--teal);box-shadow:0 0 0 5px rgba(25,198,180,.22)}
.auth-brand h1{font-size:clamp(40px,4.4vw,60px)}
.auth-brand h1 span{display:block;color:var(--teal)}
.auth-brand p{color:rgba(255,255,255,.7);max-width:38ch;margin-top:16px;font-size:17px}
.auth-brand small{color:rgba(255,255,255,.45)}
.auth-form{display:flex;align-items:center;justify-content:center;padding:40px 24px;background:var(--card)}
.form{width:100%;max-width:380px}
.form h2{font-size:30px}
.form .sub{color:var(--muted);margin:6px 0 26px}
.seg{display:flex;background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:4px;margin-bottom:24px}
.seg button{flex:1;border:0;background:none;padding:9px;border-radius:9px;cursor:pointer;font-weight:600;color:var(--muted)}
.seg button[aria-pressed=true]{background:var(--card);color:var(--text);box-shadow:0 1px 3px rgba(10,27,51,.12)}
label.f{display:block;margin-bottom:14px}
label.f span{display:block;font-size:13px;font-weight:600;margin-bottom:6px}
input.i,textarea.i{width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:11px;background:var(--soft);color:var(--text);font:inherit;font-size:15px}
input.i:focus,textarea.i:focus{outline:none;border-color:var(--teal);box-shadow:0 0 0 3px rgba(25,198,180,.2)}
.check{display:flex;gap:9px;align-items:flex-start;font-size:13px;color:var(--muted);margin:4px 0 18px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;border-radius:11px;padding:11px 18px;font-weight:600;cursor:pointer;text-decoration:none;transition:background .15s}
.btn-primary{background:var(--teal);color:var(--ink)}.btn-primary:hover{background:#2fd8c6}
.btn-dark{background:var(--ink);color:#fff}
.btn-ghost{background:transparent;border:1px solid var(--line)}
.btn-danger{background:var(--bad-soft);color:var(--bad)}
.btn-sm{padding:6px 11px;font-size:13px;border-radius:9px}
.btn-block{width:100%;padding:13px}
.err{color:var(--bad);font-size:14px;min-height:1.5em;margin-top:10px}
.hint{font-size:13px;color:var(--muted);margin-top:14px;text-align:center}
@media (max-width:860px){.auth{grid-template-columns:1fr}.auth-brand{padding:32px 24px;gap:26px}.auth-brand small{display:none}}

/* ---------- shell ---------- */
.shell{display:grid;grid-template-columns:248px 1fr;min-height:100vh}
.side{background:var(--ink);color:#fff;padding:24px 16px;display:flex;flex-direction:column;gap:6px;position:sticky;top:0;height:100vh}
.side .logo{padding:0 10px 22px}
.nav a{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;color:rgba(255,255,255,.72);text-decoration:none;font-weight:500}
.nav a:hover{background:rgba(255,255,255,.06);color:#fff}
.nav a[aria-current=page]{background:rgba(25,198,180,.14);color:#fff}
.nav a[aria-current=page] svg{color:var(--teal)}
.nav svg{width:19px;height:19px;flex:none}
.side .who{margin-top:auto;padding:14px 12px;border-top:1px solid rgba(255,255,255,.1);font-size:13px;color:rgba(255,255,255,.6)}
.side .who b{display:block;color:#fff;font-weight:600;font-size:14px}
.side .who button{background:none;border:0;color:rgba(255,255,255,.6);padding:0;margin-top:8px;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
main{padding:34px 40px 80px;min-width:0}
.page-h{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:26px;flex-wrap:wrap}
.page-h h1{font-size:34px}
.page-h p{color:var(--muted);margin-top:4px}
.mob{display:none}
@media (max-width:900px){
  .shell{grid-template-columns:1fr}.side{display:none}
  .mob{display:flex;align-items:center;justify-content:space-between;background:var(--ink);padding:14px 18px;position:sticky;top:0;z-index:5}
  .mob .logo{font-size:22px}
  .tabbar{position:fixed;bottom:0;inset-inline:0;background:var(--card);border-top:1px solid var(--line);display:flex;z-index:5;padding-bottom:env(safe-area-inset-bottom)}
  .tabbar a{flex:1;text-align:center;padding:9px 4px 8px;font-size:11px;color:var(--muted);text-decoration:none;display:flex;flex-direction:column;align-items:center;gap:2px}
  .tabbar a[aria-current=page]{color:var(--teal-deep)}
  .tabbar svg{width:21px;height:21px}
  main{padding:22px 16px 96px}.page-h h1{font-size:28px}
}
@media (min-width:901px){.tabbar{display:none}}

/* ---------- panels ---------- */
.panel{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px}
.panel h2{font-size:21px}
.panel .ph{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:16px}
.panel .ph a{font-size:14px;color:var(--teal-deep);font-weight:600;text-decoration:none}
.grid-2{display:grid;grid-template-columns:1.35fr 1fr;gap:20px;margin-top:20px;align-items:start}
@media (max-width:1100px){.grid-2{grid-template-columns:1fr}}

.kpis{display:grid;grid-template-columns:repeat(4,1fr);background:var(--card);border:1px solid var(--line);border-radius:18px}
.kpi{padding:20px 22px}
.kpi+.kpi{border-inline-start:1px solid var(--line)}
.kpi .k{color:var(--muted);font-size:13px;font-weight:500}
.kpi .v{font-family:var(--display);font-size:36px;line-height:1.1;margin-top:6px}
.kpi .s{font-size:12.5px;color:var(--muted);margin-top:2px}
.kpi.bad .v{color:var(--bad)}.kpi.warn .v{color:var(--warn)}.kpi.good .v{color:var(--ok)}
@media (max-width:760px){.kpis{grid-template-columns:1fr 1fr}.kpi:nth-child(3){border-inline-start:0}.kpi:nth-child(n+3){border-top:1px solid var(--line)}}

.chart{width:100%;height:190px;display:block}
.chart .bar{fill:var(--teal)}.chart .barbad{fill:var(--bad)}
.chart .axis{fill:var(--muted);font-size:11px;font-family:var(--body)}
.chart .grid{stroke:var(--line)}
.legend{display:flex;gap:16px;font-size:12.5px;color:var(--muted);margin-top:8px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-inline-end:6px;vertical-align:-1px}
.lg-ok{background:var(--teal)}.lg-bad{background:var(--bad)}
.grid-2.one{grid-template-columns:1fr}
.panel .kpis{grid-template-columns:1fr 1fr;border:0;border-radius:0}
.panel .kpi{padding:8px 4px}
.notice{background:var(--card);border:1px solid var(--line);border-inline-start:4px solid var(--teal);border-radius:14px;padding:16px 18px;margin-bottom:20px}
.notice h3{font-size:18px;margin-bottom:4px}.notice p{color:var(--muted)}

/* distributions */
.dists{display:flex;flex-direction:column}
.dist{border-top:1px solid var(--line)}
.dist:first-child{border-top:0}
.dist>button{all:unset;box-sizing:border-box;display:grid;grid-template-columns:1fr auto;gap:6px 16px;width:100%;padding:16px 4px;cursor:pointer}
.dist>button:focus-visible{outline:3px solid var(--teal);border-radius:10px}
.dist .txt{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dist .when{font-size:13px;color:var(--muted);white-space:nowrap}
.dist .meta{grid-column:1/-1;display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:13px;color:var(--muted)}
.dbar{display:flex;height:6px;border-radius:99px;overflow:hidden;background:var(--line);width:140px;flex:none}
.dbar span{display:block;height:100%}
.dbar .s{background:var(--ok)}.dbar .f{background:var(--bad)}.dbar .u{background:var(--warn)}.dbar .p{background:var(--info)}
.pill{display:inline-flex;align-items:center;gap:5px;border-radius:99px;padding:2px 9px;font-size:12px;font-weight:600}
.pill.ok{background:var(--ok-soft);color:var(--ok)}.pill.bad{background:var(--bad-soft);color:var(--bad)}.pill.warn{background:var(--warn-soft);color:var(--warn)}
.pill.info{background:var(--info-soft);color:var(--info)}.pill.mute{background:var(--soft);color:var(--muted);border:1px solid var(--line)}
.detail{padding:4px 4px 20px}
.versions{list-style:none;padding:0;margin:0 0 14px;display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
.versions b{color:var(--text);font-weight:600}
.copies{width:100%;border-collapse:collapse;font-size:14px}
.copies th{text-align:right;font-size:12px;color:var(--muted);font-weight:600;padding:8px;border-bottom:1px solid var(--line)}
.copies td{padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.copies .why{display:block;font-size:12px;color:var(--muted);margin-top:3px}
.plat{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)}
.plat i{width:8px;height:8px;border-radius:50%;background:#25D366}.plat.tg i{background:#2AABEE}
.tablewrap{overflow-x:auto}
@media (max-width:640px){.copies .c-plat{display:none}.dbar{width:100px}}

.empty{text-align:center;padding:42px 20px;color:var(--muted)}
.empty h3{font-size:20px;color:var(--text);margin-bottom:6px}
.empty .btn{margin-top:16px}

/* ---------- simulation ---------- */
.sim{display:grid;grid-template-columns:minmax(300px,420px) 1fr;gap:20px;align-items:start}
@media (max-width:1000px){.sim{grid-template-columns:1fr}.phone{height:560px}}
.phone{background:var(--card);border:1px solid var(--line);border-radius:22px;overflow:hidden;display:flex;flex-direction:column;height:640px}
.phone .bar{background:var(--ink);color:#fff;display:flex;align-items:center;gap:10px;padding:12px 14px}
.phone .av{width:34px;height:34px;border-radius:50%;background:var(--teal);color:var(--ink);display:grid;place-items:center;font-family:var(--display)}
.phone .bar small{display:block;color:rgba(255,255,255,.6);font-size:12px}
.chat{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;background:var(--soft)}
.b{max-width:86%;padding:8px 11px 6px;border-radius:12px;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere;position:relative}
.b.me{align-self:flex-start;background:var(--wa);color:var(--wa-ink);border-start-start-radius:3px}
.b.push{align-self:flex-end;background:var(--card);border:1px solid var(--line);border-start-end-radius:3px}
.b.push .who{font-size:12px;font-weight:700;color:var(--teal-deep)}
.b .t{font-size:11px;opacity:.65;margin-top:3px;text-align:left}
.b.del{font-style:italic;opacity:.7}
.b .acts{display:flex;gap:6px;margin-top:6px}
.b .acts button{border:0;background:rgba(10,27,51,.08);border-radius:7px;padding:3px 9px;font-size:12px;cursor:pointer;color:inherit}
.compose{border-top:1px solid var(--line);padding:10px;background:var(--card)}
.compose textarea{resize:none;height:64px}
.compose .row{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap}
.compose label{font-size:12.5px;color:var(--muted);display:flex;gap:6px;align-items:center}
.status{font-size:13px;min-height:1.4em;padding:0 12px 10px;color:var(--teal-deep);background:var(--card)}
.status.bad{color:var(--bad)}
.tgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
.tg{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;display:flex;flex-direction:column;max-height:300px}
.tg h3{font-family:var(--body);font-weight:600;font-size:14px;padding:11px 13px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px}
.tg h3 i{width:8px;height:8px;border-radius:50%;background:#25D366;flex:none}
.tg .chat{padding:10px;gap:6px}
.tg .b{max-width:100%;font-size:13px}
.tg .b.copy{align-self:stretch;background:var(--card);border:1px solid var(--line)}
.tg .none{font-size:13px;color:var(--muted);text-align:center;padding:20px 0}
.banner{background:var(--teal-mist);border:1px solid rgba(25,198,180,.35);border-radius:14px;padding:12px 16px;font-size:14px;margin-bottom:18px}

.caps{width:100%;border-collapse:collapse;font-size:14px}
.caps th,.caps td{text-align:right;padding:11px 10px;border-bottom:1px solid var(--line)}
.caps th{font-size:12px;color:var(--muted);font-weight:600}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
/* ---------- overview: today ---------- */
.hero-band{position:relative;overflow:hidden;border-radius:22px;color:#fff;padding:26px 28px 28px;background:radial-gradient(700px 360px at 12% 0%,rgba(25,198,180,.28) 0%,transparent 60%),radial-gradient(800px 420px at 95% 110%,#1d4a86 0%,transparent 60%),var(--ink)}
.hero-band::after{content:"";position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.07) 1px,transparent 1px);background-size:22px 22px;pointer-events:none;mask-image:linear-gradient(180deg,#000,transparent 85%)}
.hb-head{position:relative;z-index:1;display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:22px}
.hb-head .btn{white-space:nowrap;flex:none}.hb-head h1{font-size:40px}.hb-head p{color:rgba(255,255,255,.66);margin-top:2px}
.hb-body{position:relative;z-index:1;display:grid;grid-template-columns:1.4fr 1fr;gap:18px;align-items:stretch}
.hstats{display:grid;grid-template-columns:repeat(3,1fr);background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:16px}
.hstat{padding:18px 20px}.hstat+.hstat{border-inline-start:1px solid rgba(255,255,255,.12)}
.hv{font-family:var(--display);font-size:46px;line-height:1.05;color:#fff}
.hstat:last-child .hv{color:var(--teal)}
.hk{font-size:14px;color:rgba(255,255,255,.82);margin-top:4px}
.hs{font-size:11.5px;color:rgba(255,255,255,.5);margin-top:2px;line-height:1.35}
.top{background:linear-gradient(160deg,rgba(25,198,180,.2),rgba(25,198,180,.05));border:1px solid rgba(25,198,180,.4);border-radius:16px;padding:18px 20px;display:flex;flex-direction:column}
.top-k{font-size:12.5px;font-weight:700;color:var(--teal);letter-spacing:.02em}
.top-t{margin:8px 0 12px;font-size:16px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;flex:1}
.top-n{display:flex;align-items:baseline;gap:8px;color:rgba(255,255,255,.7);font-size:13px}
.top-n b{font-family:var(--display);font-weight:400;font-size:30px;color:#fff}
.empty-top .top-t{color:rgba(255,255,255,.66);font-size:14px}
@media (max-width:1100px){.hb-body{grid-template-columns:1fr}}
@media (max-width:620px){.hero-band{padding:20px 18px;border-radius:18px}.hb-head h1{font-size:32px}.hstats{grid-template-columns:1fr}.hstat+.hstat{border-inline-start:0;border-top:1px solid rgba(255,255,255,.12)}.hstat{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding:12px 16px}.hv{font-size:34px}.hs{flex-basis:100%}}
.alert{display:flex;width:100%;align-items:center;justify-content:space-between;gap:12px;margin-top:16px;padding:12px 16px;border-radius:12px;background:var(--warn-soft);color:var(--warn);border:1px solid transparent;font:inherit;font-size:14px;cursor:pointer;text-align:start}
.alert span{text-decoration:underline;text-underline-offset:3px}
.board{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px;counter-reset:b}
.board li{counter-increment:b;position:relative;padding-inline-start:34px}
.board li::before{content:counter(b);position:absolute;inset-inline-start:0;top:0;width:24px;height:24px;border-radius:8px;background:var(--teal-mist);color:var(--teal-deep);font-family:var(--display);display:grid;place-items:center;font-size:14px}
.board li:first-child::before{background:var(--teal);color:var(--ink)}
.bt{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.btx{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14.5px}
.bt b{font-family:var(--display);font-weight:400;font-size:18px;flex:none}
.btrack{display:block;height:5px;border-radius:99px;background:var(--line);margin:6px 0 4px;overflow:hidden}
.bfill{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--teal-deep),var(--teal))}
.bm{font-size:12px;color:var(--muted)}
.chart .bsent{fill:var(--navy)}.chart .bread{fill:var(--teal)}
.lg-read{background:var(--teal)}
.chart .val{fill:var(--text);font-weight:600}
.lg-num{font-size:11px;color:var(--text);margin-inline-end:6px}
.kbd-hint{font-size:12px;color:var(--muted)}
.grid-2>*,.hb-body>*,.board li,.bt,.btx{min-width:0}
.reads{display:inline-flex;align-items:center;gap:5px;color:var(--teal-deep);font-weight:600}
.reads svg{width:15px;height:15px}
.copies .num{font-variant-numeric:tabular-nums}
/* ---------- settings ---------- */
.hint.left{text-align:start;margin:4px 0 14px}
textarea.sig{resize:vertical;min-height:110px;line-height:1.5}
select.i{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:11px;background:var(--soft);color:var(--text);font:inherit}
label.f.mode{margin-top:18px}
.save-row{display:flex;align-items:center;gap:14px}.save-row .hint{margin:0}
.preview{background:var(--soft);background-image:radial-gradient(var(--line) 1px,transparent 1px);background-size:16px 16px;border-radius:14px;padding:22px 16px;margin-top:14px;display:flex;flex-direction:column}
.b.pv{align-self:flex-end;background:var(--card);border:1px solid var(--line);border-start-end-radius:3px;max-width:92%}
.pv-s{margin-top:8px;padding-top:8px;border-top:1px dashed var(--line);color:var(--teal-deep)}
.settings .panel h2{margin-bottom:6px}
/* ---------- connect ---------- */
.steps-bar{list-style:none;display:flex;gap:10px;margin:0 0 20px;padding:0;flex-wrap:wrap}
.steps-bar li{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:14px;font-weight:600}
.steps-bar li+li::before{content:"";width:28px;height:2px;background:var(--line);border-radius:2px;margin-inline-end:2px}
.steps-bar .n{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:var(--soft);border:1px solid var(--line);font-size:13px}
.steps-bar .n svg{width:15px;height:15px}
.steps-bar .cur{color:var(--text)}.steps-bar .cur .n{background:var(--ink);color:#fff;border-color:var(--ink)}
.steps-bar .done .n{background:var(--teal);color:var(--ink);border-color:var(--teal)}
.risk{max-width:720px}
.risk-list{list-style:none;padding:0;margin:14px 0 18px;display:flex;flex-direction:column;gap:12px}
.risk-list li{padding-inline-start:16px;border-inline-start:3px solid var(--teal);line-height:1.5}
.risk-list b{display:block;font-size:15.5px}.risk-list span{color:var(--muted);font-size:14px}
.panel.link{display:grid;grid-template-columns:auto 1fr;gap:34px;align-items:start}
.qr-col{display:flex;flex-direction:column;align-items:center;gap:10px;width:300px}
.qr-box{width:300px;height:300px;border-radius:18px;background:var(--soft);border:1px solid var(--line);display:grid;place-items:center;overflow:hidden}
.qr-box .qr{width:100%;height:100%;display:block}
.qr-empty{display:grid;place-items:center;padding:20px;text-align:center}
.qr-wait{width:38px;height:38px;border-radius:50%;border:3px solid var(--line);border-top-color:var(--teal);animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.qr-wait{animation:none}}
.qr-state{font-size:13px;color:var(--muted);text-align:center;min-height:1.4em;margin:0}
.pair-code{font-family:var(--display);font-size:40px;letter-spacing:.08em;color:var(--text)}
.qr-side h2{font-size:24px;margin-bottom:10px}
.how{margin:0 0 18px;padding-inline-start:22px;display:flex;flex-direction:column;gap:8px;font-size:15px}
.how li::marker{color:var(--teal-deep);font-weight:700}
.pair-form{display:flex;gap:10px;align-items:flex-end;max-width:420px}.pair-form label.f{flex:1;margin:0}
.linkish{background:none;border:0;padding:0;margin-top:16px;color:var(--teal-deep);font:inherit;font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.sim-scan{width:100%}
@media (max-width:820px){.panel.link{grid-template-columns:1fr}.qr-col{width:100%}.qr-box{width:min(300px,100%);height:auto;aspect-ratio:1}}
.conn-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.conn-num{display:flex;gap:10px;flex-wrap:wrap;align-items:baseline}.conn-num span{color:var(--muted)}
.conn-ok{display:flex;align-items:center;gap:12px}.conn-ok .dot{width:12px;height:12px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 5px var(--ok-soft)}
.btn-sm{padding:7px 12px;font-size:13px}
.glist{display:flex;flex-direction:column;max-height:420px;overflow-y:auto;margin-top:10px;border:1px solid var(--line);border-radius:12px}
.grow{display:flex;align-items:center;gap:10px;padding:11px 12px;cursor:pointer;border-top:1px solid var(--line)}
.grow:first-child{border-top:0}.grow.on{background:var(--teal-mist)}.grow.dis{opacity:.5;cursor:not-allowed}
.grow input{accent-color:var(--teal-deep);width:17px;height:17px;flex:none}
.gt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gm{font-size:12px;color:var(--muted);flex:none}
.gcount{font-size:13px;color:var(--muted)}
.save-bar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:18px}
.save-bar .err{margin:0}
.ok-msg{color:var(--ok);font-weight:600;margin:0}
@media (max-width:620px){.steps-bar{gap:6px}.steps-bar li+li::before{width:12px}.steps-bar li{font-size:13px}}
.notice.cta{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-top:20px;margin-bottom:0}
@media (max-width:620px){.notice.cta{flex-direction:column;align-items:stretch}}
.err-alt{margin-top:6px;color:var(--text)}.err-alt .linkish{margin:0}
.refresh-row{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap}.refresh-row .hint{margin:0}.refresh-row .linkish{margin:0}
.picked{margin:10px 0 0;font-size:13.5px;font-weight:600;color:var(--teal-deep)}.glist-empty{padding:14px;margin:0}
.stopwrap{padding:24px 40px 0}
@media (max-width:760px){.stopwrap{padding:16px 16px 0}}
.stop{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;background:var(--warn-soft);border:1px solid rgba(183,121,31,.35);border-radius:14px;padding:14px 18px}
.stop b{display:block;color:var(--warn);font-size:15px}.stop span{font-size:14px}
.stop-act{display:flex;align-items:center;gap:10px}.stop-err{color:var(--bad);font-size:13px}
/* ---------- logo ---------- */
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.drop{display:grid;grid-template-columns:auto 1fr;grid-template-rows:auto auto;column-gap:14px;align-items:center;border:1.5px dashed var(--line);border-radius:14px;padding:14px 16px;margin:12px 0 18px;cursor:pointer;background:var(--soft)}
.drop:hover,.drop:focus-within{border-color:var(--teal)}
.drop .thumb{grid-row:1/3;width:64px;height:64px;object-fit:contain;border-radius:10px;background:repeating-conic-gradient(#e9eef4 0 25%,#fff 0 50%) 0 0/14px 14px}
.drop-t{font-weight:700;color:var(--teal-deep)}.drop-s{font-size:12.5px;color:var(--muted)}
.ctl{margin-top:16px}.ctl-h{display:flex;justify-content:space-between;align-items:baseline;font-size:14px;font-weight:600;margin-bottom:8px}
.range-v{font-weight:500;color:var(--muted);font-size:13px}
.ctl input[type=range]{width:100%;accent-color:var(--teal-deep)}
.ctl .check{margin:6px 0;color:var(--text);font-size:14px}
.pos-grid{display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,26px);gap:6px;width:150px;padding:8px;border-radius:12px;background:var(--soft);border:1px solid var(--line)}
.pos{border:1px solid var(--line);border-radius:6px;background:var(--card);cursor:pointer;display:grid;place-items:center;padding:0}
.pos i{width:8px;height:8px;border-radius:2px;background:var(--muted)}
.pos[aria-pressed=true]{background:var(--teal);border-color:var(--teal)}.pos[aria-pressed=true] i{background:var(--ink)}
.pos.top-right{grid-area:1/1}.pos.top-left{grid-area:1/3}.pos.center{grid-area:2/2}.pos.bottom-right{grid-area:3/1}.pos.bottom-left{grid-area:3/3}
.seg.mini{margin:0;padding:3px}.seg.mini button{padding:5px 12px;font-size:12.5px;white-space:nowrap}
.pv-stage{display:flex;justify-content:center;background:var(--soft);border-radius:14px;padding:18px}
.pv-frame{position:relative;overflow:hidden;border-radius:12px;background:#0b1626;box-shadow:0 10px 30px rgba(10,27,51,.25)}
.pv-frame.vert{width:min(240px,100%);aspect-ratio:9/16}.pv-frame.horiz{width:100%;aspect-ratio:16/9}
.pv-scene{position:absolute;inset:0;background:radial-gradient(120% 80% at 70% 20%,#2a5d8f 0%,transparent 60%),radial-gradient(90% 70% at 20% 90%,#0f7e74 0%,transparent 60%),#0b1626}
.pv-bar{position:absolute;inset-inline:12%;height:7%;border-radius:6px;background:rgba(255,255,255,.12)}.pv-bar.a{top:58%}.pv-bar.b{top:70%;inset-inline-end:35%}
.pv-play{position:absolute;left:50%;top:38%;width:16%;aspect-ratio:1;transform:translate(-50%,-50%);border-radius:50%;background:rgba(255,255,255,.18)}
.pv-logo{position:absolute;height:auto;max-height:60%;object-fit:contain}
.pv-frame.vert.at-top-left .pv-logo,.pv-frame.vert.at-top-right .pv-logo{top:1.69%}.pv-frame.vert.at-bottom-left .pv-logo,.pv-frame.vert.at-bottom-right .pv-logo{bottom:1.69%}
.pv-frame.horiz.at-top-left .pv-logo,.pv-frame.horiz.at-top-right .pv-logo{top:5.33%}.pv-frame.horiz.at-bottom-left .pv-logo,.pv-frame.horiz.at-bottom-right .pv-logo{bottom:5.33%}
.pv-frame.at-top-left .pv-logo,.pv-frame.at-bottom-left .pv-logo{left:3%}.pv-frame.at-top-right .pv-logo,.pv-frame.at-bottom-right .pv-logo{right:3%}
.pv-frame.at-center .pv-logo{left:50%;top:50%;transform:translate(-50%,-50%)}
.logo-grid{grid-template-columns:1fr 1fr}
@media (max-width:1100px){.logo-grid{grid-template-columns:1fr}}
.bg-box{margin:-6px 0 14px}.bg-row{display:flex;gap:8px;flex-wrap:wrap}
.bg-tune{margin-top:12px}.bg-tune input[type=range]{width:100%;accent-color:var(--teal-deep)}.bg-tune .check{margin:8px 0 0;color:var(--text);font-size:13.5px}
.bg-msg{margin:10px 0 0}
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
(function(){
'use strict';
// ---------------- helpers
var store={get:function(k){try{return sessionStorage.getItem(k)}catch(e){return null}},set:function(k,v){try{sessionStorage.setItem(k,v)}catch(e){}},del:function(k){try{sessionStorage.removeItem(k)}catch(e){}}};
var mem={};function tok(k){return mem[k]||store.get(k)}function setTok(a,r){mem.at=a;mem.rt=r;store.set('at',a);store.set('rt',r)}function clearTok(){mem={};store.del('at');store.del('rt')}
function h(tag,attrs,kids){var e=document.createElement(tag);if(attrs)for(var k in attrs){var v=attrs[k];if(v==null||v===false)continue;if(k==='text')e.textContent=v;else if(k==='cls')e.className=v;else if(k.slice(0,2)==='on')e.addEventListener(k.slice(2),v);else e.setAttribute(k,v===true?'':v)}
  (kids||[]).forEach(function(c){if(c!=null&&c!==false)e.appendChild(typeof c==='string'?document.createTextNode(c):c)});return e}
var SVGNS='http://www.w3.org/2000/svg';
function s(tag,attrs,kids){var e=document.createElementNS(SVGNS,tag);for(var k in attrs)e.setAttribute(k,attrs[k]);(kids||[]).forEach(function(c){e.appendChild(typeof c==='string'?document.createTextNode(c):c)});return e}
var ICON={
  home:'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  send:'M4 12 20 4l-4 16-4-6-8-2zm8 2 4-6',
  lab:'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3',
  info:'M12 8h.01M11 12h1v5h1M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  link:'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  check:'M5 12.5l4.5 4.5L19 7',
  image:'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15.5 9.5h.01',
  pen:'M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3zM13.5 6.5l3 3',
  eye:'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'
};
function icon(name){return s('svg',{viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'},[s('path',{d:ICON[name]})])}
async function api(method,path,body,retried){
  var res=await fetch(path,{method:method,headers:Object.assign({'content-type':'application/json'},tok('at')?{authorization:'Bearer '+tok('at')}:{}),body:body?JSON.stringify(body):undefined});
  if(res.status===401&&!retried&&tok('rt')&&path.indexOf('/v1/auth/')!==0){
    var r=await fetch('/v1/auth/refresh',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({refreshToken:tok('rt')})});
    if(r.ok){var j=await r.json();setTok(j.accessToken,j.refreshToken);return api(method,path,body,true)}
    clearTok();showAuth('login','יש להתחבר מחדש');throw new Error('יש להתחבר מחדש');
  }
  var data=await res.json().catch(function(){return {}});
  if(!res.ok)throw Object.assign(new Error((data.error&&data.error.message)||('שגיאה '+res.status)),{code:data.error&&data.error.code,details:data.error&&data.error.details,status:res.status});
  return data;
}
var root=document.getElementById('root');
var STATUS={sent:['נשלח','ok'],failed:['נכשל','bad'],unknown:['ממתין לאימות','warn'],queued:['בתור','info'],sending:['נשלח עכשיו','info'],pending_approval:['ממתין לאישור','info'],skipped:['דולג','mute'],cancelled:['בוטל','mute']};
var REASON={forbidden:'אין הרשאה לשלוח בקבוצה',not_found:'הקבוצה או ההודעה לא נמצאו',window_closed:'עבר חלון הזמן של הפלטפורמה',rate_limited:'הפלטפורמה ביקשה להאט',transient:'תקלה זמנית',disconnected:'החיבור מנותק',account_blocked:'המספר חסום',invalid:'תוכן לא תקין',stale:'עבר יותר מדי זמן',source_deleted:'נמחקה בקבוצת השליטה',superseded:'הוחלפה בעריכה חדשה',merged_into_send:'עודכנה לפני השליחה',copy_not_sent:'העותק לא נשלח',copy_unknown:'מצב העותק לא ידוע',not_supported:'הפלטפורמה לא תומכת',unknown:'אין תשובה מהפלטפורמה',cancelled_before_send:'בוטלה לפני השליחה'};
function pill(st){var x=STATUS[st]||[st,'mute'];return h('span',{cls:'pill '+x[1],text:x[0]})}
function timeOf(d){try{return new Date(d).toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'})}catch(e){return ''}}
function whenOf(d){try{var x=new Date(d),now=new Date();var same=x.toDateString()===now.toDateString();return same?'היום, '+timeOf(d):x.toLocaleDateString('he-IL',{day:'numeric',month:'numeric'})+', '+timeOf(d)}catch(e){return ''}}

// ---------------- auth screens
function showAuth(mode,msg,prefill){
  clearInterval(timer);
  var err=h('div',{cls:'err',role:'alert',text:msg||''});
  var email=h('input',{cls:'i',type:'email',autocomplete:'username',required:true,dir:'ltr'});if(prefill)email.value=prefill;
  var pw=h('input',{cls:'i',type:'password',autocomplete:mode==='login'?'current-password':'new-password',required:true,dir:'ltr'});
  var biz=h('input',{cls:'i',type:'text',autocomplete:'organization',required:mode==='signup'});
  var terms=h('input',{type:'checkbox',id:'terms'});
  var submit=h('button',{cls:'btn btn-primary btn-block',type:'submit',text:mode==='login'?'כניסה':'פתיחת חשבון'});
  var form=h('form',{cls:'form',novalidate:true,onsubmit:async function(e){
    e.preventDefault();err.textContent='';submit.disabled=true;
    try{
      var r=mode==='login'?await api('POST','/v1/auth/login',{email:email.value,password:pw.value})
        :await api('POST','/v1/auth/signup',{email:email.value,password:pw.value,businessName:biz.value,acceptTerms:terms.checked});
      setTok(r.accessToken,r.refreshToken);start();
    }catch(x){
      err.replaceChildren(x.message);submit.disabled=false;
      // A new visitor often tries "כניסה" first: offer to open the account instead.
      if(mode==='login'&&x.code==='bad_credentials')err.append(h('div',{cls:'err-alt'},['אין לך עדיין חשבון? ',
        h('button',{cls:'linkish',type:'button',text:'פתיחת חשבון חדש',onclick:function(){showAuth('signup','',email.value)}})]));
    }
  }},[
    h('h2',{text:mode==='login'?'ברוכים השבים':'פתיחת חשבון'}),
    h('p',{cls:'sub',text:mode==='login'?'התחברו כדי לראות את ההפצות שלכם.':'כמה פרטים, ואתם בפנים. אפשר להתחיל בחינם.'}),
    h('div',{cls:'seg',role:'group','aria-label':'כניסה או הרשמה'},[
      h('button',{type:'button','aria-pressed':String(mode==='login'),text:'כניסה',onclick:function(){showAuth('login','',email.value)}}),
      h('button',{type:'button','aria-pressed':String(mode==='signup'),text:'הרשמה',onclick:function(){showAuth('signup','',email.value)}})]),
    mode==='signup'?h('label',{cls:'f'},[h('span',{text:'שם העסק או רשת הקבוצות'}),biz]):null,
    h('label',{cls:'f'},[h('span',{text:'אימייל'}),email]),
    h('label',{cls:'f'},[h('span',{text:'סיסמה'}),pw]),
    mode==='signup'?h('label',{cls:'check',for:'terms'},[terms,h('span',{text:'קראתי ואני מסכים לתנאי השימוש ולמדיניות הפרטיות, ומבין שהחיבור ל‑WhatsApp אינו רשמי וכרוך בסיכון לחסימת המספר.'})]):null,
    submit,err,
    h('p',{cls:'hint',text:mode==='login'?'אין לכם חשבון? עברו ל"הרשמה" למעלה.':'יש לכם כבר חשבון? עברו ל"כניסה" למעלה.'})
  ]);
  root.replaceChildren(h('div',{cls:'auth'},[
    h('aside',{cls:'auth-brand'},[
      h('a',{cls:'logo',href:'/'},[h('i',{'aria-hidden':'true'}),'PUSH']),
      h('div',null,[h('h1',null,['הודעה אחת.',h('span',{text:'כל הקבוצות.'})]),h('p',{text:'כותבים פעם אחת בקבוצת השליטה. PUSH מפיצה לכל הקבוצות, ומסנכרנת עריכה ומחיקה בכל העותקים.'})]),
      h('small',{text:'© '+new Date().getFullYear()+' PUSH'})]),
    h('div',{cls:'auth-form'},[form])]));
  setTimeout(function(){(mode==='signup'?biz:email).focus()},0);
}

// ---------------- app shell
var formDrawn=null,me=null,demo=false,simulated=false,timer=null,route='overview',dists=[],caps=null;
var ROUTES=[{id:'overview',label:'סקירה',icon:'home'},{id:'dists',label:'הפצות',icon:'send'},{id:'sim',label:'סימולציה',icon:'lab',demo:true},{id:'connect',label:'חיבור',icon:'link'},{id:'settings',label:'חתימה',icon:'pen'},{id:'logo',label:'לוגו',icon:'image'}];
async function start(){
  try{me=await api('GET','/v1/me')}catch(e){return showAuth('login')}
  try{await api('GET','/v1/demo/state');demo=true}catch(e){demo=false}
  try{simulated=!!(await api('GET','/v1/demo/env')).simulated}catch(e){simulated=false}
  // A new customer starts at "חיבור" until a number is linked.
  var linked=demo;if(!demo){try{linked=(await api('GET','/v1/wa/accounts')).some(function(x){return x.status==='connected'||x.phoneNumber})}catch(e){}}
  var r=(location.hash||'').slice(1);route=ROUTES.some(function(x){return x.id===r&&(!x.demo||demo)})?r:(demo?'sim':linked?'overview':'connect');
  buildShell();await refresh();
  clearInterval(timer);timer=setInterval(refresh,demo?3000:10000);
}
var mainEl,stopEl,navLinks=[];
function navItems(cls){return ROUTES.filter(function(x){return !x.demo||demo}).map(function(x){
  var a=h('a',{href:'#'+x.id,'data-r':x.id,onclick:function(e){e.preventDefault();go(x.id)}},[icon(x.icon),h('span',{text:x.label})]);navLinks.push(a);return a})}
function buildShell(){
  navLinks=[];formDrawn=null;
  mainEl=h('main',{id:'main'});stopEl=h('div',{cls:'stopwrap',hidden:true,role:'alert'});
  var logout=h('button',{type:'button',text:'יציאה',onclick:async function(){try{await api('POST','/v1/auth/logout',{refreshToken:tok('rt')})}catch(e){}clearTok();showAuth('login')}});
  root.replaceChildren(h('div',{cls:'shell'},[
    h('aside',{cls:'side'},[h('a',{cls:'logo',href:'/'},[h('i',{'aria-hidden':'true'}),'PUSH']),h('nav',{cls:'nav','aria-label':'ניווט'},navItems()),
      h('div',{cls:'who'},[h('b',{text:me.tenant.name}),h('span',{text:'מסלול '+me.tenant.plan.name}),h('br'),logout])]),
    h('div',null,[h('div',{cls:'mob'},[h('a',{cls:'logo',href:'/'},[h('i',{'aria-hidden':'true'}),'PUSH']),
      h('button',{cls:'btn btn-sm btn-ghost',type:'button',text:'יציאה',style:null,onclick:function(){logout.click()}})]),stopEl,mainEl]),
    h('nav',{cls:'tabbar','aria-label':'ניווט'},navItems())]));
  markNav();
}
function markNav(){navLinks.forEach(function(a){if(a.getAttribute('data-r')===route)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current')})}
function go(r){route=r;try{history.replaceState(null,'','#'+r)}catch(e){}markNav();draw(true);window.scrollTo(0,0)}
// A paused number (emergency stop) is shown on every screen, with the reason and, when allowed, a way to resume.
var STOP_HE=[[/blocked/,'WhatsApp חסם או הגביל את המספר. אי אפשר לחדש מכאן; כדאי לבדוק את המספר בטלפון.',false],
  [/rate limited twice/,'WhatsApp ביקש להאט פעמיים בשעה האחרונה. השליחה נעצרה כדי לשמור על המספר.',false],
  [/logged_out/,'המספר נותק מ‑WhatsApp (מכשירים מקושרים). צריך לחבר אותו מחדש במסך "חיבור".',false],
  [/failed sends in a row/,'כמה שליחות ברצף נכשלו, אז השליחה נעצרה לבדיקה.',true],
  [/reconnect_exhausted/,'לא הצלחנו להתחבר מחדש ל‑WhatsApp לאורך זמן.',true]];
async function refreshStops(){
  var list=[];try{list=await api('GET','/v1/stops')}catch(e){return}
  var s=list.filter(function(x){return x.scope==='account'||x.scope==='tenant'})[0];
  if(!s){stopEl.hidden=true;stopEl.replaceChildren();return}
  var m=STOP_HE.find(function(x){return x[0].test(s.reason)});
  var mine=String(s.setBy||'').indexOf('user:')===0;
  var canResume=mine||(String(s.setBy).indexOf('system')===0&&!!m&&m[2]);
  var err=h('span',{cls:'stop-err'});
  var btn=canResume?h('button',{cls:'btn btn-dark btn-sm',type:'button',text:'חידוש השליחה',onclick:async function(){btn.disabled=true;
    try{await api('POST','/v1/resume',{scope:s.scope,id:s.id});await refreshStops();refresh()}catch(e){err.textContent=e.message;btn.disabled=false}}}):null;
  stopEl.replaceChildren(h('div',{cls:'stop'},[h('div',null,[h('b',{text:'השליחה מושהית'}),h('span',{text:mine?'עצרתם את השליחה.':m?m[1]:'השליחה נעצרה אוטומטית לבדיקה.'})]),
    h('div',{cls:'stop-act'},[btn,err])]));stopEl.hidden=false;
}
async function refresh(){
  void refreshStops();
  try{dists=await api('GET','/v1/distributions?limit=100')}catch(e){return}
  if(route==='sim')await simFetch();
  draw(false);
}
function draw(full){
  if(route==='sim'){if(full||!simEl)mainEl.replaceChildren(simPage());else simDraw();return}
  simEl=null;
  // Forms are drawn once when the page is opened (also on first load or a refresh), never redrawn under the user.
  if(route==='settings'||route==='connect'||route==='logo'){if(full||formDrawn!==route){formDrawn=route;mainEl.replaceChildren(route==='settings'?settingsPage():route==='logo'?logoPage():connectPage())}return}
  formDrawn=null;
  mainEl.replaceChildren(route==='dists'?distsPage():overviewPage());
}

// ---------------- overview
// The overview counts the last 24 hours, so it is not empty right after midnight.
function isToday(d){return Date.now()-new Date(d).getTime()<864e5}
function fmt(n){return Number(n||0).toLocaleString('he-IL')}
function overviewPage(){
  var today=dists.filter(function(d){return isToday(d.createdAt)});
  var sentToday=0,readsToday=0;today.forEach(function(d){sentToday+=d.copies.sent;readsToday+=d.reads||0});
  var top=today.slice().sort(function(a,b){return (b.reads||0)-(a.reads||0)})[0];
  var dateLine=new Date().toLocaleDateString('he-IL',{weekday:'long',day:'numeric',month:'long'});
  var stat=function(v,k,sub){return h('div',{cls:'hstat'},[h('div',{cls:'hv',text:fmt(v)}),h('div',{cls:'hk',text:k}),sub?h('div',{cls:'hs',text:sub}):null])};
  var topCard=top&&top.reads?h('div',{cls:'top'},[
      h('div',{cls:'top-k',text:'ההודעה הנקראת ביותר'}),h('p',{cls:'top-t',text:top.preview}),
      h('div',{cls:'top-n'},[h('b',{text:fmt(top.reads)}),h('span',{text:'אנשים קראו · '+top.copies.sent+' קבוצות · '+whenOf(top.createdAt)})])])
    :h('div',{cls:'top empty-top'},[h('div',{cls:'top-k',text:'ההודעה הנקראת ביותר'}),h('p',{cls:'top-t',text:today.length?'מספר הקוראים מתעדכן כל הזמן, ככל שאנשים פותחים את ההודעה.':'לא נשלחו הודעות ב‑24 השעות האחרונות.'})]);
  var hero=h('section',{cls:'hero-band'},[
    h('div',{cls:'hb-head'},[h('div',null,[h('h1',{text:'24 השעות האחרונות'}),h('p',{text:dateLine+' · '+me.tenant.name})]),
      demo?h('button',{cls:'btn btn-primary',type:'button',text:'שליחת הודעה',onclick:function(){go('sim')}}):null]),
    h('div',{cls:'hb-body'},[h('div',{cls:'hstats'},[stat(today.length,'הודעות הופצו'),stat(sentToday,'עותקים נשלחו'),stat(readsToday,'אנשים קראו','בכל הקבוצות יחד. מי שכיבה אישורי קריאה ב‑WhatsApp לא נספר')]),topCard])]);
  var bad=0,unk=0;dists.forEach(function(d){bad+=d.copies.failed;unk+=d.copies.unknown});
  var alert=bad||unk?h('button',{cls:'alert',type:'button',onclick:function(){go('dists')}},[h('b',{text:(bad?bad+' עותקים לא הגיעו':'')+(bad&&unk?' · ':'')+(unk?unk+' ממתינים לאימות':'')}),h('span',{text:'לפרטים ולשליחה חוזרת'})]):null;
  var most=dists.filter(function(d){return d.reads}).sort(function(a,b){return b.reads-a.reads}).slice(0,5);
  var maxR=most.length?most[0].reads:1;
  var board=h('section',{cls:'panel'},[h('div',{cls:'ph'},[h('h2',{text:'הנקראות ביותר'}),h('span',{cls:'hint',text:'30 הימים האחרונים'})]),
    most.length?h('ol',{cls:'board'},most.map(function(d){var bar=h('span',{cls:'bfill'});bar.style.width=(100*d.reads/maxR)+'%';
      return h('li',null,[h('div',{cls:'bt'},[h('span',{cls:'btx',text:d.preview}),h('b',{text:fmt(d.reads)})]),h('span',{cls:'btrack','aria-hidden':'true'},[bar]),h('span',{cls:'bm',text:whenOf(d.createdAt)+' · '+d.copies.sent+' קבוצות'})])}))
    :h('p',{cls:'hint',text:'כשאנשים יקראו את ההודעות, הן יופיעו כאן לפי מספר הקוראים.'})]);
  var chartPanel=h('section',{cls:'panel'},[h('div',{cls:'ph'},[h('h2',{text:'14 הימים האחרונים'})]),chart(dists),
    h('div',{cls:'legend'},[h('span',null,[h('i',{cls:'lg-read'}),'אנשים שקראו, בכל יום']),h('span',null,[h('b',{cls:'lg-num',text:'3'}),'מספר ההודעות שהופצו'])])]);
  var recent=h('section',{cls:'panel'},[h('div',{cls:'ph'},[h('h2',{text:'הפצות אחרונות'}),h('a',{href:'#dists',text:'לכל ההפצות',onclick:function(e){e.preventDefault();go('dists')}})]),distList(dists.slice(0,5),true)]);
  var notice=!demo&&!dists.length?h('div',{cls:'notice cta'},[h('div',null,[h('h3',{text:'השלב הבא: חיבור מספר WhatsApp'}),
    h('p',{text:'סורקים קוד QR מהטלפון, בוחרים קבוצת שליטה וקבוצות יעד, ומתחילים להפיץ. לוקח שתי דקות.'})]),
    h('button',{cls:'btn btn-primary',type:'button',text:'לחיבור',onclick:function(){go('connect')}})]):null;
  return h('div',null,[hero,notice,alert,h('div',{cls:'grid-2'},[chartPanel,board]),h('div',{cls:'grid-2 one'},[recent])]);
}
function chart(list){
  var days=[],now=new Date();now.setHours(0,0,0,0);
  for(var i=13;i>=0;i--){var d=new Date(now.getTime()-i*864e5);days.push({d:d,sent:0,reads:0,msgs:0})}
  list.forEach(function(x){var d=new Date(x.createdAt);d.setHours(0,0,0,0);var day=days.find(function(y){return y.d.getTime()===d.getTime()});if(day){day.msgs++;day.sent+=x.copies.sent;day.reads+=x.reads||0}});
  var W=640,H=210,pad=30,top=22,max=Math.max(10,Math.max.apply(null,days.map(function(x){return x.reads})));
  var step=(W-pad)/days.length,bw=Math.min(24,step*.56),kids=[],y=function(v){return H-pad-(H-pad-top)*(v/max)};
  [0,.5,1].forEach(function(f){var yy=y(max*f);kids.push(s('line',{x1:0,x2:W-pad,y1:yy,y2:yy,'class':'grid'}));kids.push(s('text',{x:W-2,y:yy+4,'class':'axis','text-anchor':'end'},[fmt(Math.round(max*f))]))});
  days.forEach(function(x,i){var cx=(W-pad)-(i+.5)*step,label=x.d.toLocaleDateString('he-IL')+': '+x.msgs+' הודעות, '+x.sent+' עותקים, '+fmt(x.reads)+' קראו';
    if(x.msgs){var hgt=Math.max(3,H-pad-y(x.reads));kids.push(s('rect',{x:cx-bw/2,y:H-pad-hgt,width:bw,height:hgt,rx:4,'class':'bread'},[s('title',{},[label])]));
      kids.push(s('text',{x:cx,y:H-pad-hgt-6,'class':'axis val','text-anchor':'middle'},[String(x.msgs)]))}
    if(i%2===1||i===13)kids.push(s('text',{x:cx,y:H-9,'class':'axis','text-anchor':'middle'},[i===13?'היום':x.d.getDate()+'.'+(x.d.getMonth()+1)]))});
  return s('svg',{'class':'chart',direction:'ltr',viewBox:'0 0 '+W+' '+H,role:'img','aria-label':'קריאות והודעות בכל יום ב‑14 הימים האחרונים'},kids);
}

// ---------------- connect WhatsApp
var cn={acc:null,poll:null,pairPhone:''};
function connectPage(){
  var body=h('div',null,[h('p',{cls:'hint',text:'טוען…'})]);
  var steps=h('ol',{cls:'steps-bar'});
  var wrap=h('div',null,[h('div',{cls:'page-h'},[h('div',null,[h('h1',{text:'חיבור WhatsApp'}),h('p',{text:'מחברים את המספר שיפיץ את ההודעות, ובוחרים מאיזו קבוצה לאילו קבוצות.'})])]),steps,body]);
  var setStep=function(n){steps.replaceChildren.apply(steps,['אישור','חיבור המספר','בחירת קבוצות'].map(function(t,i){
    return h('li',{cls:i+1<n?'done':i+1===n?'cur':''},[h('span',{cls:'n'},[i+1<n?icon('check'):String(i+1)]),h('span',{text:t})])}))};
  var stopPoll=function(){clearTimeout(cn.poll);cn.poll=null};
  var linked=function(a){return a&&a.status==='connected'};
  async function load(){
    stopPoll();
    try{var list=await api('GET','/v1/wa/accounts');cn.acc=list[0]||null}catch(e){body.replaceChildren(h('p',{cls:'err',text:e.message}));return}
    if(!me.tenant.riskAccepted){setStep(1);body.replaceChildren(riskStep());return}
    if(!linked(cn.acc)){setStep(2);body.replaceChildren(linkStep());return}
    setStep(3);body.replaceChildren(await groupsStep());
  }
  // ---- step 1
  function riskStep(){
    var ok=h('input',{type:'checkbox',id:'risk-ok'});
    var err=h('p',{cls:'err'});
    var go2=h('button',{cls:'btn btn-primary',type:'button',text:'הבנתי, ממשיכים',onclick:async function(){
      if(!ok.checked){err.textContent='סמנו שקראתם לפני שממשיכים';return}
      go2.disabled=true;try{await api('POST','/v1/risk/accept',{});me.tenant.riskAccepted=true;load()}catch(e){err.textContent=e.message;go2.disabled=false}}});
    var li=function(t,b){return h('li',null,[h('b',{text:t}),h('span',{text:b})])};
    return h('section',{cls:'panel risk'},[h('h2',{text:'לפני שמחברים מספר'}),
      h('ul',{cls:'risk-list'},[
        li('חיבור כמו WhatsApp Web.','PUSH מתחבר למספר כ"מכשיר מקושר", כמו WhatsApp במחשב. זה לא ממשק רשמי של WhatsApp.'),
        li('עדיף מספר ייעודי.','WhatsApp עלול להגביל או לחסום מספר ששולח הרבה הודעות. מומלץ לחבר מספר של העסק, לא את המספר האישי.'),
        li('קצב מבוקר.','PUSH שולח בהפרשים, עוצר לבד כשיש סימנים לחסימה, ומודיע לכם.'),
        li('ניתוק בכל רגע.','מכאן, או בטלפון: הגדרות ← מכשירים מקושרים.')]),
      h('label',{cls:'check',for:'risk-ok'},[ok,'קראתי והבנתי']),h('div',{cls:'save-row'},[go2]),err]);
  }
  // ---- step 2
  function linkStep(){
    var box=h('div',{cls:'qr-box'});
    var info=h('p',{cls:'qr-state',role:'status'});
    var err=h('p',{cls:'err'});
    var mode='qr';
    var startBtn=h('button',{cls:'btn btn-primary',type:'button',text:'הצגת קוד QR',onclick:function(){start('qr')}});
    var phone=h('input',{cls:'i',type:'tel',dir:'ltr',placeholder:'050-1234567',autocomplete:'tel'});phone.value=cn.pairPhone;
    var pairBtn=h('button',{cls:'btn btn-dark',type:'button',text:'קבלת קוד',onclick:function(){cn.pairPhone=phone.value;start('pairing_code')}});
    var sim=simulated?h('button',{cls:'btn btn-ghost sim-scan',type:'button',text:'סימולציה: סריקה מהטלפון',hidden:true,onclick:async function(){
      sim.disabled=true;try{await api('POST','/v1/demo/scan',{accountId:cn.acc.id,phone:intlPhone(cn.pairPhone)});poll(300)}catch(e){err.textContent=e.message}sim.disabled=false}}):null;
    var qrSteps=h('ol',{cls:'how'},[h('li',{text:'פותחים WhatsApp בטלפון של המספר שרוצים לחבר'}),h('li',{text:'הגדרות ← מכשירים מקושרים ← קישור מכשיר'}),h('li',{text:'מכוונים את המצלמה לקוד שעל המסך'})]);
    var pairSteps=h('ol',{cls:'how'},[h('li',{text:'פותחים WhatsApp בטלפון של המספר הזה'}),h('li',{text:'הגדרות ← מכשירים מקושרים ← קישור מכשיר'}),h('li',{text:'בוחרים "קישור עם מספר טלפון במקום זאת" ומקלידים את הקוד'})]);
    var pairForm=h('div',{cls:'pair-form',hidden:true},[h('label',{cls:'f'},[h('span',{text:'המספר שרוצים לחבר'}),phone]),pairBtn]);
    var swap=h('button',{cls:'linkish',type:'button',onclick:function(){mode=mode==='qr'?'pair':'qr';paint()}});
    var side=h('div',{cls:'qr-side'});
    function paint(){
      var pair=mode==='pair';
      side.replaceChildren.apply(side,[h('h2',{text:pair?'חיבור עם קוד':'סורקים מהטלפון'}),pair?pairSteps:qrSteps,pair?pairForm:null,swap,err].filter(Boolean));
      pairForm.hidden=!pair;
      swap.textContent=pair?'חזרה לסריקת קוד QR':'מחברים מהטלפון עצמו? חיבור עם קוד במקום סריקה';
      drawCode();
    }
    function drawCode(){
      var a=cn.acc,st=a&&a.status;
      var pair=mode==='pair';
      if(sim)sim.hidden=!(a&&(a.qrRows&&!pair||a.pairingCode&&pair));
      if(!pair&&a&&a.qrRows){box.replaceChildren(qrSvg(a.qrRows));info.textContent='הקוד מתחלף כל כ-20 שניות. ממתינים לסריקה…'}
      else if(pair&&a&&a.pairingCode){box.replaceChildren(h('div',{cls:'pair-code',dir:'ltr',text:a.pairingCode.replace(/[^0-9A-Za-z]/g,'').replace(/^(.{4})(.{4})$/,'$1-$2')}));info.textContent='הקלידו את הקוד בטלפון. ממתינים…'}
      else if(st==='connecting'||st==='reconnecting'){box.replaceChildren(h('div',{cls:'qr-wait'}));info.textContent='מתחבר…'}
      else if(st==='link_expired'||st==='needs_relink'||st==='logged_out'){box.replaceChildren(h('div',{cls:'qr-empty'},[pair?pairForm:startBtn]));info.textContent='הקוד פג. אפשר להציג קוד חדש.'}
      else if(st==='blocked'){box.replaceChildren(h('div',{cls:'qr-empty'}));info.textContent='WhatsApp חסם את המספר הזה. אי אפשר לחבר אותו.'}
      else{box.replaceChildren(h('div',{cls:'qr-empty'},[pair?h('p',{cls:'hint',text:'הזינו את המספר ולחצו "קבלת קוד"'}):startBtn]));info.textContent=''}
    }
    async function start(method){
      err.textContent='';startBtn.disabled=pairBtn.disabled=true;
      try{
        if(!cn.acc)cn.acc=Object.assign({id:(await api('POST','/v1/wa/accounts',{label:'PUSH'})).id});
        var b={method:method};if(method==='pairing_code')b.phoneNumber=intlPhone(phone.value);
        cn.acc=Object.assign(cn.acc,await api('POST','/v1/wa/accounts/'+cn.acc.id+'/connect',b));
        drawCode();poll(1500);
      }catch(e){err.textContent=e.message}
      startBtn.disabled=pairBtn.disabled=false;
    }
    function poll(ms){
      stopPoll();cn.poll=setTimeout(async function(){
        if(route!=='connect')return;
        try{var a=await api('GET','/v1/wa/accounts/'+cn.acc.id);if(a)cn.acc=Object.assign(cn.acc,a)}catch(e){}
        if(linked(cn.acc)){load();return}
        drawCode();poll(2000);
      },ms);
    }
    paint();
    if(cn.acc&&/linking|connecting/.test(cn.acc.status||''))poll(500);
    return h('section',{cls:'panel link'},[h('div',{cls:'qr-col'},[box,info,sim]),side]);
  }
  // ---- step 3
  async function groupsStep(fresh){
    var a=cn.acc,chats,settingsRes;
    try{chats=await api('GET','/v1/wa/accounts/'+a.id+'/chats'+(fresh?'?fresh=1':''));settingsRes=await api('GET','/v1/push/settings')}catch(e){return h('p',{cls:'err',text:e.message})}
    var groups=chats.filter(function(c){return c.type==='group'||c.type==='community'}).sort(function(x,y){return x.title.localeCompare(y.title,'he')});
    var existing=(settingsRes.controlGroups||[]).find(function(r){return r.source&&r.source.accountId===a.id})||null;
    var max=(me.tenant.plan.limits&&me.tenant.plan.limits.targets)||10;
    var guess=groups.find(function(g){return g.title.indexOf('שליטה')>=0});
    var ctrl=existing?existing.source.chatId:guess?guess.chatId:null;
    var picked=new Set(existing?existing.targets.map(function(t){return t.chatId}):[]);
    var q=h('input',{cls:'i',type:'search',placeholder:'חיפוש קבוצת יעד…','aria-label':'חיפוש קבוצת יעד'});
    var qc=h('input',{cls:'i',type:'search',placeholder:'חיפוש קבוצת שליטה…','aria-label':'חיפוש קבוצת שליטה'});
    var ctrlNow=h('p',{cls:'picked'});
    var listEl=h('div',{cls:'glist'}),ctrlEl=h('div',{cls:'glist ctrl'});
    var count=h('span',{cls:'gcount'}),err=h('p',{cls:'err'}),done=h('p',{cls:'ok-msg',role:'status'});
    var save=h('button',{cls:'btn btn-primary',type:'button',text:existing?'שמירת השינויים':'שמירה והפעלה',onclick:async function(){
      err.textContent='';done.textContent='';
      if(!ctrl){err.textContent='בחרו קבוצת שליטה';return}
      if(!picked.size){err.textContent='בחרו לפחות קבוצת יעד אחת';return}
      save.disabled=true;
      var cg=groups.find(function(g){return g.chatId===ctrl});
      var payload={name:'PUSH — '+(cg?cg.title:'קבוצת שליטה'),control:(existing&&existing.control)||{reportMode:'summary'},
        sources:[{platform:'wa',accountId:a.id,chatId:ctrl}],
        targets:groups.filter(function(g){return picked.has(g.chatId)}).map(function(g){return {platform:'wa',accountId:a.id,chatId:g.chatId,title:g.title}})};
      if(existing)payload.id=existing.id;
      try{var r=await api('POST','/v1/routes',payload);existing=Object.assign(existing||{},{id:r.id,control:payload.control});save.textContent='שמירת השינויים';
        done.textContent='מוכן. כל הודעה שתכתבו ב"'+(cg?cg.title:'')+'" תופץ ל-'+picked.size+' קבוצות.'}
      catch(e){err.textContent=(e.details&&e.details.length?e.details.map(function(p){return p.message}).join(' · '):e.message)}
      save.disabled=false}});
    var row=function(g,kind){
      var isCtrl=kind==='ctrl',on=isCtrl?ctrl===g.chatId:picked.has(g.chatId);
      var dis=!isCtrl&&(g.chatId===ctrl||!g.canSend||(!on&&picked.size>=max));
      var why=!isCtrl&&g.chatId===ctrl?'קבוצת השליטה':!isCtrl&&!g.canSend?'רק מנהלים כותבים בה':'';
      var inp=h('input',{type:isCtrl?'radio':'checkbox',name:isCtrl?'ctrl':null,checked:on,disabled:dis,onchange:function(){
        if(isCtrl){ctrl=g.chatId;picked.delete(g.chatId)}else{if(inp.checked)picked.add(g.chatId);else picked.delete(g.chatId)}paintLists()}});
      return h('label',{cls:'grow'+(on?' on':'')+(dis?' dis':'')},[inp,h('span',{cls:'gt',text:g.title}),
        h('span',{cls:'gm',text:why||(g.participantCount?fmt(g.participantCount)+' חברים':'')})]);
    };
    var matcher=function(input){var f=input.value.trim().toLowerCase();return function(g){return !f||g.title.toLowerCase().indexOf(f)>=0}};
    var none=function(){return h('p',{cls:'hint glist-empty',text:'לא נמצאה קבוצה בשם הזה'})};
    function paintLists(){
      // Chosen groups first, so a choice stays visible while searching a long list.
      var ctrlRows=groups.filter(matcher(qc)).sort(function(x,y){return (y.chatId===ctrl)-(x.chatId===ctrl)}).map(function(g){return row(g,'ctrl')});
      var tRows=groups.filter(matcher(q)).sort(function(x,y){return picked.has(y.chatId)-picked.has(x.chatId)}).map(function(g){return row(g,'t')});
      ctrlEl.replaceChildren.apply(ctrlEl,ctrlRows.length?ctrlRows:[none()]);
      listEl.replaceChildren.apply(listEl,tRows.length?tRows:[none()]);
      var cg=groups.find(function(g){return g.chatId===ctrl});
      ctrlNow.textContent=cg?'נבחרה: '+cg.title:'עדיין לא נבחרה קבוצת שליטה';
      count.textContent=picked.size+' מתוך '+max+' קבוצות במסלול שלכם';
    }
    q.addEventListener('input',paintLists);qc.addEventListener('input',paintLists);paintLists();
    var discon=h('button',{cls:'btn btn-ghost btn-sm',type:'button',text:'ניתוק המספר',onclick:async function(){
      if(discon.getAttribute('data-sure')!=='1'){discon.setAttribute('data-sure','1');discon.textContent='לחצו שוב לאישור הניתוק';return}
      discon.disabled=true;try{await api('DELETE','/v1/wa/accounts/'+a.id);cn.acc=null;load()}catch(e){err.textContent=e.message;discon.disabled=false}}});
    if(!groups.length)return h('section',{cls:'panel'},[h('div',{cls:'conn-head'},[h('div',null,[h('h2',{text:'המספר מחובר'}),h('p',{cls:'hint left',text:'+'+(a.phoneNumber||'')})]),discon]),
      h('p',{text:'לא מצאנו קבוצות במספר הזה. הוסיפו את המספר לקבוצות ב-WhatsApp, ואז רעננו את העמוד.'})]);
    return h('div',null,[
      h('section',{cls:'panel conn-head'},[h('div',{cls:'conn-ok'},[h('span',{cls:'dot'}),h('div',{cls:'conn-num'},[h('b',{text:'המספר מחובר'}),h('span',{dir:'ltr',text:'+'+(a.phoneNumber||'')})])]),discon]),
      h('div',{cls:'grid-2 pick'},[
        h('section',{cls:'panel'},[h('div',{cls:'ph'},[h('h2',{text:'קבוצת שליטה'}),h('span',{cls:'gcount',text:groups.length+' קבוצות במספר'})]),
          h('p',{cls:'hint left',text:'הקבוצה שבה אתם כותבים. כל מה שנכתב בה יופץ, ועריכה או מחיקה בה יעודכנו בכל הקבוצות.'}),qc,ctrlNow,ctrlEl,
          h('div',{cls:'refresh-row'},[h('span',{cls:'hint',text:'חסרה קבוצה? המספר צריך להיות חבר בה.'}),
            h('button',{cls:'linkish',type:'button',text:'רענון הרשימה מ‑WhatsApp',onclick:async function(){this.disabled=true;body.replaceChildren(await groupsStep(true))}})])]),
        h('section',{cls:'panel'},[h('div',{cls:'ph'},[h('h2',{text:'קבוצות יעד'}),count]),q,listEl])]),
      h('div',{cls:'save-bar'},[save,done,err])]);
  }
  load();
  return wrap;
}
// 050-1234567 → 972501234567 (Israeli local format to international); +44… stays as is.
function intlPhone(v){var d=String(v||'').replace(/[^0-9]/g,'');if(/^0[1-9]/.test(d))d='972'+d.slice(1);return d}
function qrSvg(rows){
  var n=rows.length,q=3,d='';
  rows.forEach(function(r,y){for(var x=0;x<n;x++)if(r.charCodeAt(x)===49){var run=1;while(x+run<n&&r.charCodeAt(x+run)===49)run++;d+='M'+(x+q)+' '+(y+q)+'h'+run+'v1h-'+run+'z';x+=run-1}});
  return s('svg',{'class':'qr',viewBox:'0 0 '+(n+2*q)+' '+(n+2*q),role:'img','aria-label':'קוד QR לחיבור WhatsApp','shape-rendering':'crispEdges'},[s('rect',{width:n+2*q,height:n+2*q,fill:'#fff'}),s('path',{d:d,fill:'#0A1B33'})]);
}

// ---------------- logo on videos
var POS=[['top-right','ימין למעלה'],['top-left','שמאל למעלה'],['center','מרכז'],['bottom-right','ימין למטה'],['bottom-left','שמאל למטה']];
/**
 * Makes a logo's plain background transparent. The background colour is the most common colour
 * on the image's border; it is removed from the edges inwards (flood fill), so the same colour
 * inside the logo stays unless asked otherwise. Edge pixels are softened so there is no halo.
 */
function removeBackground(src,tol,everywhere,done){
  var im=new Image();
  im.onload=function(){
    var max=800,k=Math.min(1,max/Math.max(im.naturalWidth,im.naturalHeight));
    var w=Math.max(1,Math.round(im.naturalWidth*k)),hh=Math.max(1,Math.round(im.naturalHeight*k));
    var c=document.createElement('canvas');c.width=w;c.height=hh;var x=c.getContext('2d');x.drawImage(im,0,0,w,hh);
    var d=x.getImageData(0,0,w,hh),p=d.data,n=w*hh;
    // background = most common (quantised) opaque colour on the border
    var counts={},best=null,bestN=0,transparentEdge=0,edge=0;
    var look=function(i){edge++;if(p[i*4+3]<20){transparentEdge++;return}var key=(p[i*4]>>4)+','+(p[i*4+1]>>4)+','+(p[i*4+2]>>4);var v=(counts[key]||0)+1;counts[key]=v;if(v>bestN){bestN=v;best=i}};
    for(var i=0;i<w;i++){look(i);look((hh-1)*w+i)}for(var j=0;j<hh;j++){look(j*w);look(j*w+w-1)}
    if(transparentEdge>edge*0.6||best===null){done({error:'נראה שלתמונה כבר אין רקע.'});return}
    var br=p[best*4],bg=p[best*4+1],bb=p[best*4+2];
    var dist=function(i){var a=p[i*4]-br,b=p[i*4+1]-bg,cc=p[i*4+2]-bb;return Math.sqrt(a*a+b*b+cc*cc)};
    var gone=new Uint8Array(n),removed=0;
    var cut=function(i){gone[i]=1;p[i*4+3]=0;removed++};
    if(everywhere){for(var q=0;q<n;q++)if(p[q*4+3]>=20&&dist(q)<=tol)cut(q)}
    else{
      var stack=[];var push=function(q){if(!gone[q]&&p[q*4+3]>=20&&dist(q)<=tol){cut(q);stack.push(q)}};
      for(var i2=0;i2<w;i2++){push(i2);push((hh-1)*w+i2)}for(var j2=0;j2<hh;j2++){push(j2*w);push(j2*w+w-1)}
      while(stack.length){var q2=stack.pop(),qx=q2%w,qy=(q2-qx)/w;if(qx>0)push(q2-1);if(qx<w-1)push(q2+1);if(qy>0)push(q2-w);if(qy<hh-1)push(q2+w)}
    }
    // soften the border between logo and removed background
    for(var r=0;r<n;r++){if(gone[r])continue;var rx=r%w,ry=(r-rx)/w;
      var near=(rx>0&&gone[r-1])||(rx<w-1&&gone[r+1])||(ry>0&&gone[r-w])||(ry<hh-1&&gone[r+w]);
      if(near){var dd=dist(r);if(dd<tol*2.2)p[r*4+3]=Math.round(p[r*4+3]*Math.min(1,(dd-tol)/(tol*1.2)+0.25))}}
    if(!removed){done({error:'לא נמצא רקע אחיד להסרה. אפשר להגדיל את הרגישות.'});return}
    x.putImageData(d,0,0);
    done({url:c.toDataURL('image/png'),removed:Math.round(100*removed/n)});
  };
  im.onerror=function(){done({error:'לא הצלחנו לקרוא את התמונה'})};
  im.src=src;
}
function logoPage(){
  var wrap=h('div',null,[h('div',{cls:'page-h'},[h('div',null,[h('h1',{text:'לוגו על הסרטונים'}),h('p',{text:'הלוגו שלכם יופיע על כל סרטון שיוצא מקבוצת השליטה, בכל הקבוצות.'})])]),h('p',{cls:'hint',text:'טוען…'})]);
  (async function(){
    var cur;try{cur=await api('GET','/v1/push/logo')}catch(e){wrap.lastChild.replaceWith(h('p',{cls:'err',text:e.message}));return}
    var st={original:cur.logo,cut:false,logo:cur.logo,position:cur.position,sizePct:cur.sizePct,opacityPct:cur.opacityPct,applyVideo:cur.applyVideo,applyImage:cur.applyImage,newLogo:null,shape:'v'};
    var msg=h('p',{cls:'hint save-msg',role:'status'}),err=h('p',{cls:'err'});
    // ---- preview
    var img=h('img',{cls:'pv-logo',alt:'הלוגו'});
    var frame=h('div',{cls:'pv-frame'},[h('div',{cls:'pv-scene'},[h('span',{cls:'pv-bar a'}),h('span',{cls:'pv-bar b'}),h('span',{cls:'pv-play'})]),img]);
    var shapeBtns=[['v','אנכי'],['h','אופקי']].map(function(o){return h('button',{type:'button','aria-pressed':String(st.shape===o[0]),text:o[1],onclick:function(){st.shape=o[0];paint()}})});
    // ---- controls
    var file=h('input',{type:'file',accept:'image/png,image/jpeg,image/webp',cls:'sr-only',id:'logo-file'});
    var thumb=h('img',{cls:'thumb',alt:''});
    var drop=h('label',{cls:'drop',for:'logo-file'},[thumb,h('span',{cls:'drop-t'}),h('span',{cls:'drop-s',text:'PNG עם רקע שקוף נראה הכי טוב · עד 1MB'})]);
    file.addEventListener('change',function(){
      var f=file.files&&file.files[0];if(!f)return;err.textContent='';
      if(!/^image\\/(png|jpeg|webp)$/.test(f.type)){err.textContent='אפשר להעלות PNG, JPG או WEBP';return}
      if(f.size>1024*1024){err.textContent='הקובץ גדול מדי (עד 1MB)';return}
      var r=new FileReader();r.onload=function(){st.newLogo=String(r.result);st.logo=st.newLogo;st.original=st.logo;st.cut=false;bgMsg.textContent='';paint()};r.readAsDataURL(f);
    });
    // ---- background removal (in the browser; the result is saved like an uploaded PNG)
    var bgMsg=h('p',{cls:'hint left bg-msg',role:'status'});
    var tol=h('input',{type:'range',min:'5',max:'120',step:'5','aria-label':'רגישות הסרת הרקע'});tol.value='40';
    var inner=h('input',{type:'checkbox'});
    var cutBtn=h('button',{cls:'btn btn-dark btn-sm',type:'button',text:'הסרת רקע',onclick:function(){runCut()}});
    var undoBtn=h('button',{cls:'btn btn-ghost btn-sm',type:'button',text:'החזרת המקור',onclick:function(){st.logo=st.original;st.newLogo=st.original===cur.logo?null:st.original;st.cut=false;bgMsg.textContent='';paint()}});
    var tune=h('div',{cls:'bg-tune'},[h('div',{cls:'ctl-h'},[h('span',{text:'רגישות'}),h('span',{cls:'range-v',text:'יותר = מסיר גם גוונים קרובים'})]),tol,
      h('label',{cls:'check'},[inner,'להסיר את הצבע הזה גם בתוך הלוגו (למשל בתוך אותיות)'])]);
    var bgBox=h('div',{cls:'bg-box'},[h('div',{cls:'bg-row'},[cutBtn,undoBtn]),tune,bgMsg]);
    tol.addEventListener('change',function(){if(st.cut)runCut()});inner.addEventListener('change',function(){if(st.cut)runCut()});
    function runCut(){
      if(!st.original)return;
      removeBackground(st.original,Number(tol.value),inner.checked,function(res){
        if(res.error){bgMsg.textContent=res.error;return}
        st.logo=res.url;st.newLogo=res.url;st.cut=true;
        bgMsg.textContent='הרקע הוסר ('+res.removed+'% מהתמונה). בדקו בתצוגה; אם נשארו שאריות, הגדילו את הרגישות.';paint();
      });
    }
    var posBox=h('div',{cls:'pos-grid',role:'group','aria-label':'מיקום הלוגו'},POS.map(function(p){
      return h('button',{type:'button',cls:'pos '+p[0],'data-p':p[0],title:p[1],'aria-label':p[1],onclick:function(){st.position=p[0];paint()}},[h('i')])}));
    var posName=h('span',{cls:'range-v'});
    var size=h('input',{type:'range',min:'5',max:'40',step:'1','aria-label':'גודל'});size.value=String(st.sizePct);
    var sizeV=h('span',{cls:'range-v'});size.addEventListener('input',function(){st.sizePct=Number(size.value);paint()});
    var op=h('input',{type:'range',min:'20',max:'100',step:'5','aria-label':'שקיפות'});op.value=String(st.opacityPct);
    var opV=h('span',{cls:'range-v'});op.addEventListener('input',function(){st.opacityPct=Number(op.value);paint()});
    var vid=h('input',{type:'checkbox',checked:st.applyVideo,onchange:function(){st.applyVideo=vid.checked}});
    var pic=h('input',{type:'checkbox',checked:st.applyImage,onchange:function(){st.applyImage=pic.checked}});
    var save=h('button',{cls:'btn btn-primary',type:'button',text:'שמירה',onclick:async function(){
      err.textContent='';msg.textContent='';if(!st.logo){err.textContent='בחרו קובץ לוגו';return}
      save.disabled=true;
      try{var b={position:st.position,sizePct:st.sizePct,opacityPct:st.opacityPct,applyVideo:st.applyVideo,applyImage:st.applyImage};if(st.newLogo)b.logo=st.newLogo;
        await api('PUT','/v1/push/logo',b);st.newLogo=null;msg.textContent=st.applyVideo||st.applyImage?'נשמר. מעכשיו הלוגו יתווסף אוטומטית.':'נשמר. הלוגו כבוי כרגע (לא נבחרו סרטונים או תמונות).';paint()}
      catch(e){err.textContent=e.message}
      save.disabled=false}});
    var remove=h('button',{cls:'btn btn-ghost',type:'button',text:'הסרת הלוגו',onclick:async function(){
      if(remove.getAttribute('data-sure')!=='1'){remove.setAttribute('data-sure','1');remove.textContent='לחצו שוב להסרה';return}
      try{await api('DELETE','/v1/push/logo');st.logo=null;st.newLogo=null;msg.textContent='הלוגו הוסר.';remove.removeAttribute('data-sure');remove.textContent='הסרת הלוגו';paint()}catch(e){err.textContent=e.message}}});
    function paint(){
      frame.className='pv-frame '+(st.shape==='v'?'vert':'horiz')+' at-'+st.position;
      shapeBtns.forEach(function(b,i){b.setAttribute('aria-pressed',String(st.shape===(i?'h':'v')))});
      img.hidden=!st.logo;if(st.logo)img.src=st.logo;
      img.style.width=st.sizePct+'%';img.style.opacity=String(st.opacityPct/100);
      thumb.hidden=!st.logo;if(st.logo)thumb.src=st.logo;
      bgBox.hidden=!st.logo;undoBtn.hidden=!st.cut;tune.hidden=!st.cut;cutBtn.textContent=st.cut?'הסרה מחדש':'הסרת רקע';
      drop.querySelector('.drop-t').textContent=st.logo?'החלפת הלוגו':'העלאת לוגו';
      [].forEach.call(posBox.children,function(b){b.setAttribute('aria-pressed',String(b.getAttribute('data-p')===st.position))});
      posName.textContent=(POS.find(function(p){return p[0]===st.position})||[0,''])[1];
      sizeV.textContent=st.sizePct+'% מרוחב הסרטון';opV.textContent=st.opacityPct===100?'אטום':st.opacityPct+'%';
      remove.hidden=!cur.logo&&!st.logo;
    }
    var row=function(label,ctrl,val){return h('div',{cls:'ctl'},[h('div',{cls:'ctl-h'},[h('span',{text:label}),val||null]),ctrl])};
    var controls=h('section',{cls:'panel logo-ctl'},[
      h('h2',{text:'הלוגו'}),file,drop,bgBox,
      row('מיקום',posBox,posName),row('גודל',size,sizeV),row('שקיפות',op,opV),
      h('div',{cls:'ctl'},[h('div',{cls:'ctl-h'},[h('span',{text:'להוסיף ל:'})]),h('label',{cls:'check'},[vid,'סרטונים']),h('label',{cls:'check'},[pic,'תמונות'])]),
      cur.available?null:h('p',{cls:'hint left',text:'בשרת הזה (דמו) ההגדרות נשמרות, אבל הלוגו מתווסף רק בגרסה האמיתית.'}),
      h('div',{cls:'save-row'},[save,remove]),msg,err]);
    var preview=h('section',{cls:'panel logo-pv'},[h('div',{cls:'ph'},[h('h2',{text:'כך זה ייראה'}),h('div',{cls:'seg mini'},shapeBtns)]),
      h('div',{cls:'pv-stage'},[frame]),h('p',{cls:'hint',text:'התצוגה קרובה למה שיישלח. הלוגו נצרב בסרטון עצמו, ולכן נשאר גם כשמעבירים אותו הלאה.'})]);
    paint();
    wrap.lastChild.replaceWith(h('div',{cls:'grid-2 logo-grid'},[controls,preview]));
  })();
  return wrap;
}

// ---------------- settings (signature)
var settings=null;
function settingsPage(){
  var wrap=h('div',null,[h('div',{cls:'page-h'},[h('div',null,[h('h1',{text:'חתימה והגדרות'}),h('p',{text:'מה מתווסף מתחת לכל הודעה, ואיזה דיווח מגיע לקבוצת השליטה.'})])]),h('p',{cls:'hint',text:'טוען…'})]);
  (async function(){
    try{settings=await api('GET','/v1/push/settings')}catch(e){wrap.replaceChildren(h('p',{cls:'err',text:e.message}));return}
    if(!settings.controlGroups.length){wrap.lastChild.replaceWith(h('div',{cls:'notice'},[h('h3',{text:'עדיין אין קבוצת שליטה'}),h('p',{text:'אחרי חיבור WhatsApp ובחירת קבוצת שליטה, כאן קובעים את החתימה.'})]));return}
    var sig=h('textarea',{cls:'i sig',rows:'4',maxlength:'1000',placeholder:'לדוגמה:\\n📲 להצטרפות לקבוצה: https://chat.whatsapp.com/...\\n✈️ בטלגרם: https://t.me/...'});sig.value=settings.signature;
    var sample='🔴 מבזק: כביש 4 נחסם לתנועה לכיוון צפון בעקבות תאונה.';
    var prevText=h('div',{cls:'pv-t'});var prevSig=h('div',{cls:'pv-s'});
    var upd=function(){prevText.textContent=sample;prevSig.textContent=sig.value.trim();prevSig.hidden=!sig.value.trim()};sig.addEventListener('input',upd);upd();
    var mode=h('select',{cls:'i'},[['summary','סיכום בסוף כל הפצה'],['all','כל שלב: התקבלה, נשלחה, נערכה'],['failures','רק כשמשהו לא הצליח'],['off','בלי דיווחים']].map(function(o){return h('option',{value:o[0],text:o[1]})}));mode.value=settings.reportMode;
    var msg=h('p',{cls:'hint save-msg',role:'status'});
    var save=h('button',{cls:'btn btn-primary',type:'button',text:'שמירה',onclick:async function(){save.disabled=true;msg.textContent='';
      try{await api('PUT','/v1/push/settings',{signature:sig.value,reportMode:mode.value});msg.textContent='נשמר. ההודעות הבאות יישלחו עם החתימה.'}catch(e){msg.textContent=e.message}save.disabled=false}});
    wrap.lastChild.replaceWith(h('div',{cls:'grid-2 settings'},[
      h('section',{cls:'panel'},[h('h2',{text:'חתימה קבועה'}),h('p',{cls:'hint left',text:'טקסט או קישור שיופיעו מתחת לכל הודעה, בכל הקבוצות. אפשר להשתמש גם ב-{תאריך} וב-{שעה}.'}),
        sig,h('label',{cls:'f mode'},[h('span',{text:'דיווח בקבוצת השליטה'}),mode]),h('div',{cls:'save-row'},[save,msg])]),
      h('section',{cls:'panel'},[h('h2',{text:'כך זה ייראה בקבוצות'}),h('div',{cls:'preview'},[h('div',{cls:'b copy pv'},[prevText,prevSig,h('div',{cls:'t',text:'12:00'})])])])]));
  })();
  return wrap;
}

// ---------------- distributions
var open={};
function keyOf(d){return encodeURIComponent(d.source.platform)+'/'+encodeURIComponent(d.source.accountId)+'/'+encodeURIComponent(d.source.chatId)+'/'+encodeURIComponent(d.messageId)}
function dbar(c){var total=Math.max(1,c.total-c.cancelled-c.skipped);var seg=function(n,cls){return n?h('span',{cls:cls,style:null,'data-w':String(n/total)}):null};
  var bar=h('span',{cls:'dbar','aria-hidden':'true'},[seg(c.sent,'s'),seg(c.failed,'f'),seg(c.unknown,'u'),seg(c.pending,'p')]);
  // widths are set through the CSSOM (allowed by the CSP), never through a style attribute
  Array.prototype.forEach.call(bar.children,function(x){x.style.width=(100*Number(x.getAttribute('data-w')))+'%'});return bar}
function distList(list,compact){
  if(!list.length)return h('div',{cls:'empty'},[h('h3',{text:'עדיין אין הפצות'}),h('p',{text:demo?'כתבו הודעה בסימולציה, והיא תופיע כאן עם הסטטוס בכל קבוצה.':'כל הודעה שתכתבו בקבוצת השליטה תופיע כאן, עם הסטטוס בכל קבוצה.'}),
    demo?h('button',{cls:'btn btn-primary',type:'button',text:'לסימולציה',onclick:function(){go('sim')}}):null]);
  return h('div',{cls:'dists'},list.map(function(d){return distRow(d,compact)}));
}
function distRow(d,compact){
  var k=keyOf(d),c=d.copies,total=c.total-c.cancelled-c.skipped;
  var tags=[];
  if(d.deleted)tags.push(h('span',{cls:'pill mute',text:'נמחקה'}));
  if(d.version>1)tags.push(h('span',{cls:'pill info',text:'נערכה · גרסה '+d.version}));
  if(c.failed)tags.push(h('span',{cls:'pill bad',text:c.failed+' נכשלו'}));
  if(c.unknown)tags.push(h('span',{cls:'pill warn',text:c.unknown+' ממתינים לאימות'}));
  if(c.pending)tags.push(h('span',{cls:'pill info',text:c.pending+' בתור'}));
  var box=h('div',{cls:'detail'});box.hidden=!open[k];
  var btn=h('button',{'aria-expanded':String(!!open[k]),onclick:function(){if(compact){go('dists');open={};open[k]=true;draw(true);return}
    if(open[k]){delete open[k];box.hidden=true;btn.setAttribute('aria-expanded','false')}else{open[k]=true;box.hidden=false;btn.setAttribute('aria-expanded','true');loadDetail(k,box)}}},[
    h('span',{cls:'txt',text:d.preview||'(מדיה)'}),h('span',{cls:'when',text:whenOf(d.createdAt)}),
    h('span',{cls:'meta'},[dbar(c),h('span',{text:c.sent+' מתוך '+total+' קבוצות'}),c.sent?h('span',{cls:'reads'},[icon('eye'),d.reads?'נקראה ע״י '+fmt(d.reads):'עוד לא נקראה']):null].concat(tags))]);
  if(open[k]&&!compact)loadDetail(k,box);
  return h('div',{cls:'dist'},[btn,box]);
}
async function loadDetail(key,box){
  var r;try{r=await api('GET','/v1/distributions/'+key)}catch(e){box.replaceChildren(h('p',{cls:'err',text:e.message}));return}
  var vers=r.versions.length>1?h('ul',{cls:'versions'},r.versions.map(function(v){return h('li',null,[h('b',{text:'גרסה '+v.version}),' · '+timeOf(v.at)+(v.text?' · '+v.text.slice(0,140):'')])})):null;
  var rows=r.copies.map(function(c){
    var act=null;
    if(!r.deleted&&c.status==='failed')act=h('button',{cls:'btn btn-sm btn-primary',type:'button',text:'נסו שוב',onclick:function(){retry(c.jobId,false,key,box)}});
    else if(!r.deleted&&c.status==='unknown')act=h('button',{cls:'btn btn-sm btn-ghost',type:'button',text:'לא בקבוצה? שלחו שוב',title:'רק אחרי שבדקתם שההודעה לא הגיעה לקבוצה',onclick:function(){retry(c.jobId,true,key,box)}});
    var chg=function(x,label){return x?h('span',null,[pill(x.status),x.error?h('span',{cls:'why',text:REASON[x.error]||x.error}):null]):h('span',{cls:'why',text:'—'})};
    return h('tr',null,[
      h('td',{text:c.target.title||c.target.chatId}),
      h('td',{cls:'c-plat'},[h('span',{cls:'plat'+(c.target.platform==='tg'?' tg':'')},[h('i',{'aria-hidden':'true'}),c.target.platform==='tg'?'Telegram':'WhatsApp'])]),
      h('td',null,[pill(c.status),c.error?h('span',{cls:'why',text:REASON[c.error]||c.error}):null]),
      h('td',{cls:'num',text:c.status==='sent'?fmt(c.reads||0):'—'}),
      h('td',null,[chg(c.edit)]),h('td',null,[chg(c.delete)]),h('td',null,[act])]);
  });
  box.replaceChildren.apply(box,[vers,h('div',{cls:'tablewrap'},[h('table',{cls:'copies'},[h('thead',null,[h('tr',null,['קבוצה','פלטפורמה','שליחה','קראו','עריכה','מחיקה',''].map(function(t,i){return h('th',{cls:i===1?'c-plat':null,text:t})}))]),h('tbody',null,rows)])])].filter(Boolean));
}
async function retry(id,confirmNotDelivered,key,box){try{await api('POST','/v1/jobs/'+id+'/retry',confirmNotDelivered?{confirmNotDelivered:true}:{});await loadDetail(key,box)}catch(e){box.insertBefore(h('p',{cls:'err',text:e.message}),box.firstChild)}}
function distsPage(){return h('div',null,[h('div',{cls:'page-h'},[h('div',null,[h('h1',{text:'הפצות'}),h('p',{text:'כל הודעה מקבוצת השליטה, ומה קרה איתה בכל קבוצה. לחצו על הודעה לפרטים.'})])]),h('section',{cls:'panel'},[distList(dists,false)])])}

// ---------------- simulation (demo servers)
var simEl=null,simState=null,editing=null,simMsg=null,composer=null,chatBox=null,groupsBox=null;
async function simFetch(){if(editing)return;try{simState=await api('GET','/v1/demo/state')}catch(e){}}
function say(t,bad){if(simMsg){simMsg.textContent=t;simMsg.className='status'+(bad?' bad':'')}}
async function act(path,body,ok){try{await api('POST',path,body);say(ok||'');await refresh()}catch(e){say(e.message,true)}}
function simPage(){
  var ta=h('textarea',{cls:'i',placeholder:'כתבו הודעה, כמו בקבוצת השליטה ב‑WhatsApp…','aria-label':'הודעה לקבוצת השליטה'});
  var sendBtn=h('button',{cls:'btn btn-primary',type:'button',text:'שליחה',onclick:async function(){
    if(!ta.value.trim())return say('כתבו טקסט לפני השליחה',true);
    await act('/v1/demo/post',{text:ta.value},'נשלח לקבוצת השליטה. PUSH מפיצה עכשיו…');ta.value=''}});
  ta.addEventListener('keydown',function(e){if(e.key==='Enter'&&(e.ctrlKey||e.metaKey))sendBtn.click()});
  composer=h('div',{cls:'compose'},[ta,h('div',{cls:'row'},[h('span',{cls:'kbd-hint',text:'Ctrl+Enter לשליחה'}),sendBtn])]);
  simMsg=h('div',{cls:'status',role:'status'});
  chatBox=h('div',{cls:'chat','aria-live':'polite'});groupsBox=h('div',{cls:'tgrid'});
  simEl=h('div',null,[
    h('div',{cls:'page-h'},[h('div',null,[h('h1',{text:'סימולציה'}),h('p',{text:'נסו את PUSH בלי מספר אמיתי: כתבו, ערכו ומחקו בקבוצת השליטה, וראו מה קורה בכל קבוצה.'})])]),
    h('div',{cls:'banner',text:'זו סימולציה של WhatsApp. שום הודעה לא נשלחת ל‑WhatsApp אמיתי. הקריאות מדומות לפי מספר החברים בכל קבוצה ומגיעות בדקה הראשונה.'}),
    h('div',{cls:'sim'},[
      h('div',{cls:'phone'},[h('div',{cls:'bar'},[h('span',{cls:'av',text:'P'}),h('div',null,[h('b',{text:'קבוצת שליטה'}),h('small',{text:'אתם ו‑PUSH'})])]),chatBox,simMsg,composer]),
      h('div',null,[groupsBox])])]);
  simDraw();return simEl;
}
function bubble(m,own){
  if(m.deleted)return h('div',{cls:'b del'+(m.fromPush?' push':own?' me':' copy'),text:'🚫 ההודעה נמחקה'});
  var cls='b '+(m.fromPush&&own?'push':own?'me':'copy');
  var kids=[];
  if(m.fromPush&&own)kids.push(h('div',{cls:'who',text:'PUSH'}));
  if(own&&!m.fromPush&&editing&&editing.id===m.id){
    var inp=h('textarea',{cls:'i','aria-label':'עריכת ההודעה'});inp.value=editing.text;inp.addEventListener('input',function(){editing.text=inp.value});
    kids.push(inp,h('div',{cls:'acts'},[h('button',{type:'button',text:'שמירה',onclick:function(){var t=inp.value,id=m.id;editing=null;act('/v1/demo/edit',{id:id,text:t},'נערך. PUSH מעדכנת את כל העותקים…')}}),
      h('button',{type:'button',text:'ביטול',onclick:function(){editing=null;simDraw()}})]));
    setTimeout(function(){inp.focus()},0);
    return h('div',{cls:cls},kids);
  }
  // The bubble header already says PUSH, so the report's own tag is dropped here.
  var shown=m.fromPush&&own?m.text.replace(/^(\S+)\s*PUSH ·\s*/,'$1 '):m.text;
  kids.push(h('div',{text:shown}),h('div',{cls:'t',text:timeOf(m.at)+(m.edited?' · נערכה':'')}));
  if(own&&!m.fromPush)kids.push(h('div',{cls:'acts'},[h('button',{type:'button',text:'עריכה',onclick:function(){editing={id:m.id,text:m.text};simDraw()}}),
    h('button',{type:'button',text:'מחיקה לכולם',onclick:function(){act('/v1/demo/delete',{id:m.id},'נמחק. PUSH מוחקת מכל הקבוצות…')}})]));
  return h('div',{cls:cls},kids);
}
function simDraw(){
  if(!simEl||!simState)return;
  var atBottom=chatBox.scrollHeight-chatBox.scrollTop-chatBox.clientHeight<40;
  var msgs=simState.control.messages;
  chatBox.replaceChildren.apply(chatBox,msgs.length?msgs.map(function(m){return bubble(m,true)}):[h('p',{cls:'empty',text:'קבוצת השליטה ריקה. כתבו הודעה למטה.'})]);
  if(atBottom||!editing)chatBox.scrollTop=chatBox.scrollHeight;
  groupsBox.replaceChildren.apply(groupsBox,simState.groups.map(function(g){
    var c=h('div',{cls:'chat'},g.messages.length?g.messages.map(function(m){return bubble(m,false)}):[h('div',{cls:'none',text:'עוד אין הודעות'})]);
    setTimeout(function(){c.scrollTop=c.scrollHeight},0);
    return h('div',{cls:'tg'},[h('h3',null,[h('i',{'aria-hidden':'true'}),g.title]),c])}));
}

window.addEventListener('hashchange',function(){var r=location.hash.slice(1);if(r&&r!==route&&mainEl&&ROUTES.some(function(x){return x.id===r}))go(r)});
if(tok('at'))start();else showAuth(location.hash==='#signup'?'signup':'login');
})();
</script>
</body>
</html>`;
}
