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
  if(!res.ok)throw Object.assign(new Error((data.error&&data.error.message)||('שגיאה '+res.status)),{code:data.error&&data.error.code,status:res.status});
  return data;
}
var root=document.getElementById('root');
var STATUS={sent:['נשלח','ok'],failed:['נכשל','bad'],unknown:['ממתין לאימות','warn'],queued:['בתור','info'],sending:['נשלח עכשיו','info'],pending_approval:['ממתין לאישור','info'],skipped:['דולג','mute'],cancelled:['בוטל','mute']};
var REASON={forbidden:'אין הרשאה לשלוח בקבוצה',not_found:'הקבוצה או ההודעה לא נמצאו',window_closed:'עבר חלון הזמן של הפלטפורמה',rate_limited:'הפלטפורמה ביקשה להאט',transient:'תקלה זמנית',disconnected:'החיבור מנותק',account_blocked:'המספר חסום',invalid:'תוכן לא תקין',stale:'עבר יותר מדי זמן',source_deleted:'נמחקה בקבוצת השליטה',superseded:'הוחלפה בעריכה חדשה',merged_into_send:'עודכנה לפני השליחה',copy_not_sent:'העותק לא נשלח',copy_unknown:'מצב העותק לא ידוע',not_supported:'הפלטפורמה לא תומכת',unknown:'אין תשובה מהפלטפורמה',cancelled_before_send:'בוטלה לפני השליחה'};
function pill(st){var x=STATUS[st]||[st,'mute'];return h('span',{cls:'pill '+x[1],text:x[0]})}
function timeOf(d){try{return new Date(d).toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'})}catch(e){return ''}}
function whenOf(d){try{var x=new Date(d),now=new Date();var same=x.toDateString()===now.toDateString();return same?'היום, '+timeOf(d):x.toLocaleDateString('he-IL',{day:'numeric',month:'numeric'})+', '+timeOf(d)}catch(e){return ''}}

// ---------------- auth screens
function showAuth(mode,msg){
  clearInterval(timer);
  var err=h('div',{cls:'err',role:'alert',text:msg||''});
  var email=h('input',{cls:'i',type:'email',autocomplete:'username',required:true,dir:'ltr'});
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
    }catch(x){err.textContent=x.message;submit.disabled=false}
  }},[
    h('h2',{text:mode==='login'?'ברוכים השבים':'פתיחת חשבון'}),
    h('p',{cls:'sub',text:mode==='login'?'התחברו כדי לראות את ההפצות שלכם.':'כמה פרטים, ואתם בפנים. אפשר להתחיל בחינם.'}),
    h('div',{cls:'seg',role:'group','aria-label':'כניסה או הרשמה'},[
      h('button',{type:'button','aria-pressed':String(mode==='login'),text:'כניסה',onclick:function(){showAuth('login')}}),
      h('button',{type:'button','aria-pressed':String(mode==='signup'),text:'הרשמה',onclick:function(){showAuth('signup')}})]),
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
var me=null,demo=false,timer=null,route='overview',dists=[],caps=null;
var ROUTES=[{id:'overview',label:'סקירה',icon:'home'},{id:'dists',label:'הפצות',icon:'send'},{id:'sim',label:'סימולציה',icon:'lab',demo:true},{id:'settings',label:'חתימה',icon:'pen'},{id:'caps',label:'יכולות',icon:'info'}];
async function start(){
  try{me=await api('GET','/v1/me')}catch(e){return showAuth('login')}
  try{await api('GET','/v1/demo/state');demo=true}catch(e){demo=false}
  var r=(location.hash||'').slice(1);route=ROUTES.some(function(x){return x.id===r&&(!x.demo||demo)})?r:(demo?'sim':'overview');
  buildShell();await refresh();
  clearInterval(timer);timer=setInterval(refresh,demo?3000:10000);
}
var mainEl,navLinks=[];
function navItems(cls){return ROUTES.filter(function(x){return !x.demo||demo}).map(function(x){
  var a=h('a',{href:'#'+x.id,'data-r':x.id,onclick:function(e){e.preventDefault();go(x.id)}},[icon(x.icon),h('span',{text:x.label})]);navLinks.push(a);return a})}
function buildShell(){
  navLinks=[];
  mainEl=h('main',{id:'main'});
  var logout=h('button',{type:'button',text:'יציאה',onclick:async function(){try{await api('POST','/v1/auth/logout',{refreshToken:tok('rt')})}catch(e){}clearTok();showAuth('login')}});
  root.replaceChildren(h('div',{cls:'shell'},[
    h('aside',{cls:'side'},[h('a',{cls:'logo',href:'/'},[h('i',{'aria-hidden':'true'}),'PUSH']),h('nav',{cls:'nav','aria-label':'ניווט'},navItems()),
      h('div',{cls:'who'},[h('b',{text:me.tenant.name}),h('span',{text:'מסלול '+me.tenant.plan.name}),h('br'),logout])]),
    h('div',null,[h('div',{cls:'mob'},[h('a',{cls:'logo',href:'/'},[h('i',{'aria-hidden':'true'}),'PUSH']),
      h('button',{cls:'btn btn-sm btn-ghost',type:'button',text:'יציאה',style:null,onclick:function(){logout.click()}})]),mainEl]),
    h('nav',{cls:'tabbar','aria-label':'ניווט'},navItems())]));
  markNav();
}
function markNav(){navLinks.forEach(function(a){if(a.getAttribute('data-r')===route)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current')})}
function go(r){route=r;try{history.replaceState(null,'','#'+r)}catch(e){}markNav();draw(true);window.scrollTo(0,0)}
async function refresh(){
  try{dists=await api('GET','/v1/distributions?limit=100');if(!caps)caps=await api('GET','/v1/capabilities')}catch(e){return}
  if(route==='sim')await simFetch();
  draw(false);
}
function draw(full){
  if(route==='sim'){if(full||!simEl)mainEl.replaceChildren(simPage());else simDraw();return}
  simEl=null;
  if(route==='settings'){if(full)mainEl.replaceChildren(settingsPage());return} // a form: never redrawn under the user
  mainEl.replaceChildren(route==='dists'?distsPage():route==='caps'?capsPage():overviewPage());
}

// ---------------- overview
function isToday(d){var x=new Date(d),n=new Date();return x.toDateString()===n.toDateString()}
function fmt(n){return Number(n||0).toLocaleString('he-IL')}
function overviewPage(){
  var today=dists.filter(function(d){return isToday(d.createdAt)});
  var sentToday=0,readsToday=0;today.forEach(function(d){sentToday+=d.copies.sent;readsToday+=d.reads||0});
  var top=today.slice().sort(function(a,b){return (b.reads||0)-(a.reads||0)})[0];
  var dateLine=new Date().toLocaleDateString('he-IL',{weekday:'long',day:'numeric',month:'long'});
  var stat=function(v,k,sub){return h('div',{cls:'hstat'},[h('div',{cls:'hv',text:fmt(v)}),h('div',{cls:'hk',text:k}),sub?h('div',{cls:'hs',text:sub}):null])};
  var topCard=top&&top.reads?h('div',{cls:'top'},[
      h('div',{cls:'top-k',text:'הנקראת ביותר היום'}),h('p',{cls:'top-t',text:top.preview}),
      h('div',{cls:'top-n'},[h('b',{text:fmt(top.reads)}),h('span',{text:'קריאות · '+top.copies.sent+' קבוצות · '+timeOf(top.createdAt)})])])
    :h('div',{cls:'top empty-top'},[h('div',{cls:'top-k',text:'הנקראת ביותר היום'}),h('p',{cls:'top-t',text:today.length?'הקריאות מתעדכנות תוך דקה מהשליחה.':'עוד לא נשלחו הודעות היום.'})]);
  var hero=h('section',{cls:'hero-band'},[
    h('div',{cls:'hb-head'},[h('div',null,[h('h1',{text:'היום'}),h('p',{text:dateLine+' · '+me.tenant.name})]),
      demo?h('button',{cls:'btn btn-primary',type:'button',text:'שליחת הודעה',onclick:function(){go('sim')}}):null]),
    h('div',{cls:'hb-body'},[h('div',{cls:'hstats'},[stat(today.length,'הודעות הופצו'),stat(sentToday,'עותקים נשלחו'),stat(readsToday,'קריאות','לפחות; רק מי שלא כיבה אישורי קריאה')]),topCard])]);
  var bad=0,unk=0;dists.forEach(function(d){bad+=d.copies.failed;unk+=d.copies.unknown});
  var alert=bad||unk?h('button',{cls:'alert',type:'button',onclick:function(){go('dists')}},[h('b',{text:(bad?bad+' עותקים לא הגיעו':'')+(bad&&unk?' · ':'')+(unk?unk+' ממתינים לאימות':'')}),h('span',{text:'לפרטים ולשליחה חוזרת'})]):null;
  var most=dists.filter(function(d){return d.reads}).sort(function(a,b){return b.reads-a.reads}).slice(0,5);
  var maxR=most.length?most[0].reads:1;
  var board=h('section',{cls:'panel'},[h('div',{cls:'ph'},[h('h2',{text:'הנקראות ביותר'}),h('span',{cls:'hint',text:'30 הימים האחרונים'})]),
    most.length?h('ol',{cls:'board'},most.map(function(d){var bar=h('span',{cls:'bfill'});bar.style.width=(100*d.reads/maxR)+'%';
      return h('li',null,[h('div',{cls:'bt'},[h('span',{cls:'btx',text:d.preview}),h('b',{text:fmt(d.reads)})]),h('span',{cls:'btrack','aria-hidden':'true'},[bar]),h('span',{cls:'bm',text:whenOf(d.createdAt)+' · '+d.copies.sent+' קבוצות'})])}))
    :h('p',{cls:'hint',text:'כשההודעות ייקראו, הן יופיעו כאן לפי מספר הקריאות.'})]);
  var chartPanel=h('section',{cls:'panel'},[h('div',{cls:'ph'},[h('h2',{text:'14 הימים האחרונים'})]),chart(dists),
    h('div',{cls:'legend'},[h('span',null,[h('i',{cls:'lg-read'}),'קריאות ביום']),h('span',null,[h('b',{cls:'lg-num',text:'3'}),'מספר ההודעות שהופצו'])])]);
  var recent=h('section',{cls:'panel'},[h('div',{cls:'ph'},[h('h2',{text:'הפצות אחרונות'}),h('a',{href:'#dists',text:'לכל ההפצות',onclick:function(e){e.preventDefault();go('dists')}})]),distList(dists.slice(0,5),true)]);
  var notice=!demo&&!dists.length?h('div',{cls:'notice'},[h('h3',{text:'השלב הבא: חיבור מספר WhatsApp'}),
    h('p',{text:'בקרוב תוכלו לסרוק כאן קוד QR, לבחור קבוצת שליטה וקבוצות יעד, ולהתחיל להפיץ. החיבור למספרים אמיתיים נפתח אחרי שלב הבדיקות.'})]):null;
  return h('div',null,[hero,notice,alert,h('div',{cls:'grid-2'},[chartPanel,board]),h('div',{cls:'grid-2 one'},[recent])]);
}
function chart(list){
  var days=[],now=new Date();now.setHours(0,0,0,0);
  for(var i=13;i>=0;i--){var d=new Date(now.getTime()-i*864e5);days.push({d:d,sent:0,reads:0,msgs:0})}
  list.forEach(function(x){var d=new Date(x.createdAt);d.setHours(0,0,0,0);var day=days.find(function(y){return y.d.getTime()===d.getTime()});if(day){day.msgs++;day.sent+=x.copies.sent;day.reads+=x.reads||0}});
  var W=640,H=210,pad=30,top=22,max=Math.max(10,Math.max.apply(null,days.map(function(x){return x.reads})));
  var step=(W-pad)/days.length,bw=Math.min(24,step*.56),kids=[],y=function(v){return H-pad-(H-pad-top)*(v/max)};
  [0,.5,1].forEach(function(f){var yy=y(max*f);kids.push(s('line',{x1:0,x2:W-pad,y1:yy,y2:yy,'class':'grid'}));kids.push(s('text',{x:W-2,y:yy+4,'class':'axis','text-anchor':'end'},[fmt(Math.round(max*f))]))});
  days.forEach(function(x,i){var cx=(W-pad)-(i+.5)*step,label=x.d.toLocaleDateString('he-IL')+': '+x.msgs+' הודעות, '+x.sent+' עותקים, '+fmt(x.reads)+' קריאות';
    if(x.msgs){var hgt=Math.max(3,H-pad-y(x.reads));kids.push(s('rect',{x:cx-bw/2,y:H-pad-hgt,width:bw,height:hgt,rx:4,'class':'bread'},[s('title',{},[label])]));
      kids.push(s('text',{x:cx,y:H-pad-hgt-6,'class':'axis val','text-anchor':'middle'},[String(x.msgs)]))}
    if(i%2===1||i===13)kids.push(s('text',{x:cx,y:H-9,'class':'axis','text-anchor':'middle'},[i===13?'היום':x.d.getDate()+'.'+(x.d.getMonth()+1)]))});
  return s('svg',{'class':'chart',direction:'ltr',viewBox:'0 0 '+W+' '+H,role:'img','aria-label':'קריאות והודעות בכל יום ב‑14 הימים האחרונים'},kids);
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
    h('span',{cls:'meta'},[dbar(c),h('span',{text:c.sent+' מתוך '+total+' קבוצות'}),d.reads?h('span',{cls:'reads'},[icon('eye'),fmt(d.reads)+' קריאות']):null].concat(tags))]);
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
  box.replaceChildren.apply(box,[vers,h('div',{cls:'tablewrap'},[h('table',{cls:'copies'},[h('thead',null,[h('tr',null,['קבוצה','פלטפורמה','שליחה','קריאות','עריכה','מחיקה',''].map(function(t,i){return h('th',{cls:i===1?'c-plat':null,text:t})}))]),h('tbody',null,rows)])])].filter(Boolean));
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

// ---------------- capabilities
var CAPN={send:'שליחה',edit:'עריכה',editCaption:'עריכת כיתוב של מדיה',delete:'מחיקה לכולם',receive:'קבלת הודעות',receiveEdits:'זיהוי עריכות',receiveDeletes:'זיהוי מחיקות',media:'מדיה',groupDiscovery:'רשימת קבוצות',deliveryStatus:'אישורי מסירה'};
var LV={verified:['נבדק','ok'],documented:['מתועד','info'],untested:['דורש בדיקה','warn'],false:['לא נתמך','bad']};
function capsPage(){
  var rows=caps?Object.keys(CAPN).map(function(k){return h('tr',null,[h('td',{text:CAPN[k]})].concat(['wa','tg'].map(function(p){var l=LV[String(caps[p][k])]||[String(caps[p][k]),'mute'];return h('td',null,[h('span',{cls:'pill '+l[1],text:l[0]})])})))}):[];
  return h('div',null,[h('div',{cls:'page-h'},[h('div',null,[h('h1',{text:'מה כל פלטפורמה תומכת'}),h('p',{text:'"מתועד" אומר שהפלטפורמה מתעדת את היכולת, אבל עוד לא בדקנו אותה על מספר אמיתי.'})])]),
    h('section',{cls:'panel'},[h('div',{cls:'tablewrap'},[h('table',{cls:'caps'},[h('thead',null,[h('tr',null,[h('th',{text:'יכולת'}),h('th',{text:'WhatsApp'}),h('th',{text:'Telegram'})])]),h('tbody',null,rows)])]),
      h('p',{cls:'hint',text:'WhatsApp: עריכה עד 15 דקות מהשליחה, מחיקה לכולם עד כיומיים וחצי. Telegram: מחיקה עד 48 שעות. בוטים בטלגרם לא מקבלים הודעה על מחיקה, ולכן בקבוצת שליטה בטלגרם עונים "מחק" על ההודעה.'})])]);
}

window.addEventListener('hashchange',function(){var r=location.hash.slice(1);if(r&&r!==route&&mainEl&&ROUTES.some(function(x){return x.id===r}))go(r)});
if(tok('at'))start();else showAuth(location.hash==='#signup'?'signup':'login');
})();
</script>
</body>
</html>`;
}
