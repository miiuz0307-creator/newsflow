/**
 * The management panel (/admin) for the PUSH owner: first-time setup, sign-in
 * with email + password, a live view of the last 24 hours, and customers (list,
 * details, plan, suspend, remove, add). Talks only to /admin/v1/*. Same CSP
 * rules as the app: no inline styles or handlers, no innerHTML.
 */
import { fontFaceCss } from './fonts.js';

/** The panel's service worker: shows notifications and opens the right customer when one is tapped. */
export function adminServiceWorker(): string {
  return `'use strict';
self.addEventListener('install',function(){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});
self.addEventListener('push',function(e){
  var d={};try{d=e.data?e.data.json():{}}catch(x){d={body:e.data?e.data.text():''}}
  e.waitUntil(self.registration.showNotification(d.title||'PUSH',{body:d.body||'',icon:'/admin/icon-192.png',badge:'/admin/icon-192.png',lang:'he',dir:'rtl',tag:d.tag||undefined,data:{url:d.url||'/admin'}}));
});
self.addEventListener('notificationclick',function(e){
  e.notification.close();
  var url=(e.notification.data&&e.notification.data.url)||'/admin';
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(list){
    for(var i=0;i<list.length;i++){var c=list[i];if(c.url.indexOf('/admin')>=0&&'focus' in c){c.postMessage({open:url});return c.focus()}}
    return self.clients.openWindow(url);
  }));
});
`;
}

export function adminHtml(nonce: string): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0A1B33">
<link rel="manifest" href="/admin/manifest.webmanifest">
<link rel="apple-touch-icon" href="/admin/icon-180.png">
<link rel="icon" type="image/png" href="/admin/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="PUSH ניהול">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>PUSH — ניהול</title>
<style nonce="${nonce}">
${fontFaceCss()}
:root{
  --ink:#0A1B33;--deep:#102C52;--deep2:#163763;--teal:#19C6B4;--teal-ink:#0B7F74;--teal-mist:#E2F7F4;
  --amber:#F2B33D;--amber-ink:#8F6100;--amber-mist:#FDF2DC;--coral:#E5534B;--coral-mist:#FCE8E6;
  --paper:#F2F5F9;--card:#fff;--line:#DFE6EF;--soft:#F7F9FC;--text:#0A1B33;--muted:#5B6B83;--ok:#0F9F6E;--ok-mist:#E2F6EE;
  --on-ink:#E8EEF7;--on-ink-muted:#93A5C0;
  --display:"Secular One","IBM Plex Sans Hebrew",system-ui,sans-serif;--body:"IBM Plex Sans Hebrew",system-ui,sans-serif}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0}
body{font-family:var(--body);background:var(--paper);color:var(--text);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
h1,h2,h3{font-family:var(--display);font-weight:400;margin:0;line-height:1.2}
button,input,select{font:inherit;color:inherit}
:focus-visible{outline:3px solid var(--teal);outline-offset:2px;border-radius:6px}
.ltr{direction:ltr;unicode-bidi:isolate}
.hint{font-size:13px;color:var(--muted);margin:0}
.err{color:var(--coral);font-size:14px;min-height:1.4em;margin:8px 0 0}.ok{color:var(--ok);font-weight:600}

/* top bar */
.top{background:var(--ink);color:#fff;display:flex;justify-content:space-between;align-items:center;padding:14px max(16px,calc((100% - 1200px)/2))}
.logo{font-family:var(--display);font-size:24px;display:flex;align-items:center;gap:10px;letter-spacing:.5px}
.logo i{width:10px;height:10px;border-radius:50%;background:var(--teal);box-shadow:0 0 0 5px rgba(25,198,180,.22)}
.logo small{font-family:var(--body);font-size:13px;color:var(--on-ink-muted);margin-inline-start:4px;letter-spacing:0}
.top .out{background:transparent;color:var(--on-ink);border:1px solid rgba(255,255,255,.22);border-radius:10px;padding:6px 14px;cursor:pointer}
.top .out:hover{background:rgba(255,255,255,.08)}
.top-actions{display:flex;gap:8px;align-items:center}
.bell{display:inline-flex;align-items:center;gap:7px}.bell svg{width:16px;height:16px}
.bell .on-dot{width:7px;height:7px;border-radius:50%;background:var(--teal)}
.strip{display:flex;gap:12px;align-items:center;flex-wrap:wrap;background:#fff;border:1px solid var(--line);border-inline-start:4px solid var(--teal);border-radius:14px;padding:12px 16px;margin-bottom:18px}
.strip p{margin:0;margin-inline-end:auto}
.steps{padding-inline-start:20px;margin:6px 0 14px}.steps li{margin-bottom:8px}
.state{display:flex;align-items:center;gap:10px;font-weight:600;margin-bottom:10px}

/* buttons and fields */
.btn{border:0;border-radius:12px;padding:11px 18px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:8px;justify-content:center;white-space:nowrap}
.btn-primary{background:var(--teal);color:var(--ink)}.btn-primary:hover{background:#2AD4C2}
.btn-dark{background:var(--ink);color:#fff}.btn-ghost{background:var(--card);border:1px solid var(--line)}.btn-ghost:hover{background:var(--soft)}
.btn-danger{background:var(--coral);color:#fff}.btn-sm{padding:7px 12px;font-size:13px;border-radius:10px}.btn-block{width:100%}
.btn:disabled{opacity:.55;cursor:default}
label.f{display:block;margin-bottom:14px}label.f>span{display:block;font-size:13px;font-weight:600;margin-bottom:6px}
.i{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:12px;background:var(--soft)}
.i:focus{outline:none;border-color:var(--teal);box-shadow:0 0 0 3px rgba(25,198,180,.2);background:#fff}

/* sign-in and setup: the product idea drawn on the side, one message going out to many groups */
.auth{min-height:calc(100vh - 62px);display:grid;grid-template-columns:1fr 1fr}
.auth-art{background:radial-gradient(120% 90% at 100% 0%,var(--deep2),var(--ink) 70%);color:var(--on-ink);padding:48px;display:flex;flex-direction:column;justify-content:center;gap:28px;overflow:hidden}
.auth-art svg{width:100%;max-width:520px;height:auto;align-self:center}
.auth-art h2{font-size:clamp(26px,3vw,38px);color:#fff;max-width:22ch}
.auth-art p{color:var(--on-ink-muted);max-width:40ch;margin:0}
.fan line{stroke:rgba(147,165,192,.35);stroke-width:1.5}
.fan .src{fill:var(--teal)}.fan .halo{fill:rgba(25,198,180,.18)}.fan .dst{fill:var(--deep2);stroke:var(--on-ink-muted);stroke-width:1.5}
.fan .pulse{fill:var(--teal)}
.auth-form{display:flex;align-items:center;justify-content:center;padding:40px 20px}
.auth-form form{width:100%;max-width:380px}
.auth-form h1{font-size:32px}.auth-form .sub{color:var(--muted);margin:6px 0 24px}
@media (max-width:860px){.auth{grid-template-columns:1fr}.auth-art{padding:28px 20px;gap:14px}.auth-art svg{max-width:340px}.auth-art p{display:none}}

/* home: live band */
.live{background:var(--ink);color:var(--on-ink);padding:26px max(16px,calc((100% - 1200px)/2)) 22px}
.greet{color:var(--on-ink-muted);margin:0 0 4px;font-size:14px}
.headline{font-family:var(--display);font-size:clamp(24px,3.2vw,40px);line-height:1.25;color:#fff;margin:0;max-width:30ch}
.headline .n-sent{color:var(--teal)}.headline .n-read{color:var(--amber)}
.chart{position:relative;margin-top:22px;direction:ltr}
.ch-svg{display:block;width:100%;height:150px}
.ch-svg .b{fill:var(--teal);transform-box:fill-box;transform-origin:50% 100%;animation:grow .7s cubic-bezier(.2,.8,.2,1) both}
.ch-svg .b0{fill:rgba(147,165,192,.22)}
.ch-svg .rl{stroke:var(--amber);stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round}
.ch-svg .base{stroke:rgba(147,165,192,.3);stroke-width:1}
@keyframes grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}
.ch-hit{position:absolute;inset:0;display:grid}
.ch-hit div{cursor:crosshair}.ch-hit div:hover,.ch-hit div.on{background:rgba(255,255,255,.06);border-radius:6px}
.ch-axis{display:grid;color:var(--on-ink-muted);font-size:12px;margin-top:6px;direction:ltr}
.ch-axis span{text-align:center;white-space:nowrap;overflow:visible}
.readout{display:flex;gap:18px;flex-wrap:wrap;align-items:center;min-height:24px;margin-top:10px;font-size:14px;color:var(--on-ink-muted)}
.key{display:inline-flex;align-items:center;gap:7px}
.key i{width:12px;height:12px;border-radius:3px;background:var(--teal)}.key.r i{height:3px;border-radius:2px;background:var(--amber)}
.readout b{color:#fff;font-weight:600}
.facts{display:flex;flex-wrap:wrap;margin-top:18px;border-top:1px solid rgba(147,165,192,.22);padding-top:16px;row-gap:12px}
.facts div{padding-inline-end:28px;margin-inline-end:28px;border-inline-end:1px solid rgba(147,165,192,.22)}
.facts div:last-child{border:0}
.facts b{font-family:var(--display);font-weight:400;font-size:26px;color:#fff;display:block;line-height:1.1}
.facts span{font-size:13px;color:var(--on-ink-muted)}
.facts .warn b{color:var(--amber)}
@media (prefers-reduced-motion:reduce){.ch-svg .b{animation:none}}

/* customers */
main{max-width:1200px;margin:0 auto;padding:26px 16px 80px}
.head{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.head h2{font-size:28px;margin-inline-end:auto}
.head .i{width:260px;background:#fff}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.chip{border:1px solid var(--line);background:#fff;border-radius:99px;padding:6px 14px;font-size:14px;cursor:pointer;display:inline-flex;gap:6px;align-items:center}
.chip em{font-style:normal;color:var(--muted);font-size:12px}
.chip[aria-pressed=true]{background:var(--ink);border-color:var(--ink);color:#fff}.chip[aria-pressed=true] em{color:var(--on-ink-muted)}
.list{background:#fff;border:1px solid var(--line);border-radius:18px;overflow:hidden}
.tablewrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:right;font-size:12px;color:var(--muted);font-weight:600;padding:12px 14px;background:var(--soft);border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:middle;white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
tbody tr.rowlink{cursor:pointer}tbody tr.rowlink:hover{background:#F8FBFD}
tr.susp td{color:var(--muted)}tr.susp .av{filter:grayscale(1);opacity:.6}
.who{display:flex;align-items:center;gap:12px}
.who b{display:block;font-weight:600;color:var(--text)}.who small{display:block;color:var(--muted);font-size:13px}
.av{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;font-family:var(--display);font-size:16px;flex:none}
.av.lg{width:58px;height:58px;border-radius:18px;font-size:24px}
.c0{background:#E2F7F4;color:#0B7F74}.c1{background:#FDF2DC;color:#8F6100}.c2{background:#E4EDFB;color:#2251A8}.c3{background:#EFE7FB;color:#6B3FB0}.c4{background:#FBE7EE;color:#A8325C}.c5{background:#E6F4E6;color:#2F7A32}
.plan{display:inline-block;border:1px solid var(--line);border-radius:8px;padding:2px 9px;font-size:13px;background:var(--soft)}
.plan.p-premium{border-color:#BFEDE7;background:var(--teal-mist);color:var(--teal-ink)}
.wa{display:inline-flex;align-items:center;gap:8px}
.dot{width:9px;height:9px;border-radius:50%;background:#B8C3D3;flex:none}
.dot.on{background:var(--ok);box-shadow:0 0 0 4px rgba(15,159,110,.15)}.dot.off{background:var(--coral)}
.spark{width:96px;height:28px;display:block}
.spark polyline{fill:none;stroke:var(--teal-ink);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.spark .area{fill:rgba(25,198,180,.14);stroke:none}
.spark .flat{stroke:#C7D1DF}
.nums b{font-weight:600;display:block}.nums small{color:var(--amber-ink);display:block;font-size:12px}
.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:600;margin-inline-start:6px;vertical-align:middle}
.pill.bad{background:var(--coral-mist);color:#B0302A}.pill.ok{background:var(--ok-mist);color:var(--ok)}.pill.mute{background:var(--soft);color:var(--muted);border:1px solid var(--line)}
.empty{padding:44px 20px;text-align:center}
.empty h3{font-size:22px;margin-bottom:6px}.empty p{color:var(--muted);margin:0 0 16px}
@media (max-width:760px){.head .i{width:100%}.col-hide{display:none}.facts{display:grid;grid-template-columns:1fr 1fr;gap:14px 16px}.facts div{border:0;padding:0;margin:0}td,th{padding:12px 10px}}

/* side window */
.drawer{position:fixed;inset:0;background:rgba(10,27,51,.5);display:flex;justify-content:flex-start;z-index:10}
.drawer>div{background:var(--paper);width:min(560px,100%);height:100%;overflow-y:auto;box-shadow:0 0 50px rgba(0,0,0,.3);animation:slide .22s ease-out both}
@keyframes slide{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){.drawer>div{animation:none}}
.d-head{background:var(--ink);color:var(--on-ink);padding:22px 24px 20px;position:relative}
.d-head .close{position:absolute;top:16px;left:16px;background:transparent;border:1px solid rgba(255,255,255,.25);color:var(--on-ink);border-radius:10px;padding:5px 12px;cursor:pointer}
.d-id{display:flex;gap:14px;align-items:center}
.d-id h2{font-size:26px;color:#fff}.d-id p{margin:2px 0 0;color:var(--on-ink-muted);font-size:14px}
.d-head .chart{margin-top:18px}.d-head .ch-svg{height:96px}
.d-body{padding:20px 24px 40px}
.box{background:#fff;border:1px solid var(--line);border-radius:16px;padding:16px 18px;margin-bottom:14px}
.box h3{font-size:17px;margin-bottom:10px}
.dl{display:grid;grid-template-columns:auto 1fr;gap:8px 18px;font-size:14px;margin:0}
.dl dt{color:var(--muted)}.dl dd{margin:0}
.lines{display:flex;flex-direction:column;gap:8px;font-size:14px}
.lines>div{display:flex;justify-content:space-between;gap:10px;align-items:center}
.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}.actions label.f{margin:0;flex:1;min-width:160px}
.danger{border-color:#F3C9C5}.danger h3{color:#B0302A}
.temp{background:var(--ok-mist);border:1px solid #BCE8D6;border-radius:14px;padding:16px;margin-top:14px}
.temp dl{margin:10px 0 14px}.temp .hint{margin-top:10px}.temp dd{font-weight:600}
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
(function(){
'use strict';
var root=document.getElementById('root');
var REDUCED=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
function h(tag,attrs,kids){var e=document.createElement(tag);if(attrs)for(var k in attrs){var v=attrs[k];if(v==null||v===false)continue;if(k==='text')e.textContent=v;else if(k==='cls')e.className=v;else if(k.slice(0,2)==='on')e.addEventListener(k.slice(2),v);else e.setAttribute(k,v===true?'':v)}
  (kids||[]).forEach(function(c){if(c!=null&&c!==false&&c!=='')e.appendChild(typeof c==='string'?document.createTextNode(c):c)});return e}
var SVGNS='http://www.w3.org/2000/svg';
function s(tag,attrs,kids){var e=document.createElementNS(SVGNS,tag);for(var k in attrs)e.setAttribute(k,attrs[k]);(kids||[]).forEach(function(c){e.appendChild(c)});return e}
function tok(){try{return sessionStorage.getItem('push-admin')}catch(e){return null}}
function setTok(t){try{if(t)sessionStorage.setItem('push-admin',t);else sessionStorage.removeItem('push-admin')}catch(e){}}
async function api(method,path,body){
  var res=await fetch(path,{method:method,headers:Object.assign({'content-type':'application/json'},tok()?{authorization:'Bearer '+tok()}:{}),body:body?JSON.stringify(body):undefined});
  var data=await res.json().catch(function(){return {}});
  if(res.status===401&&path.indexOf('/admin/v1/login')<0&&path.indexOf('/admin/v1/setup')<0){setTok(null);showLogin('יש להתחבר מחדש');throw new Error('יש להתחבר מחדש')}
  if(!res.ok)throw new Error((data.error&&data.error.message)||('שגיאה '+res.status));
  return data;
}
var nf=new Intl.NumberFormat('he-IL');
function num(n){return nf.format(n||0)}
function fmtDate(d){if(!d)return '—';try{return new Date(d).toLocaleDateString('he-IL',{day:'numeric',month:'numeric',year:'2-digit'})}catch(e){return '—'}}
function ago(d){
  if(!d)return 'עוד לא נכנס';var ms=Date.now()-new Date(d).getTime();if(!(ms>=0))return fmtDate(d);
  var m=Math.round(ms/60000);if(m<2)return 'עכשיו';if(m<60)return 'לפני '+m+' דקות';
  var hr=Math.round(m/60);if(hr===1)return 'לפני שעה';if(hr<24)return 'לפני '+hr+' שעות';
  var dd=Math.round(hr/24);if(dd===1)return 'אתמול';if(dd<30)return 'לפני '+dd+' ימים';return fmtDate(d);
}
function initials(name){var w=String(name||'?').trim().split(' ').filter(Boolean);return ((w[0]||'?').charAt(0)+(w[1]?w[1].charAt(0):'')).toUpperCase()}
function hue(id){var x=0;id=String(id||'');for(var i=0;i<id.length;i++)x=(x*31+id.charCodeAt(i))>>>0;return 'c'+(x%6)}
function avatar(t,big){return h('div',{cls:'av '+hue(t.id)+(big?' lg':''),'aria-hidden':'true',text:initials(t.name)})}
function bellIcon(){return s('svg',{viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'},[s('path',{d:'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0'})])}
var bellBtn=null;
function shell(content,withLogout){
  bellBtn=withLogout?h('button',{cls:'out bell',type:'button','aria-label':'התראות',onclick:notifySettings},[bellIcon(),h('span',{text:'התראות'})]):null;
  root.replaceChildren(h('div',{cls:'top'},[h('div',{cls:'logo'},[h('i'),'PUSH',h('small',{text:'ניהול'})]),
    withLogout?h('div',{cls:'top-actions'},[bellBtn,h('button',{cls:'out',type:'button',text:'יציאה',onclick:function(){setTok(null);showLogin()}})]):null]),content);
  if(withLogout)refreshBell();
}

// ---------------- notifications to this device (new signups)
function pushSupported(){return 'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window}
function isIOS(){return /iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1)}
function standalone(){return (window.matchMedia&&matchMedia('(display-mode: standalone)').matches)||navigator.standalone===true}
function keyBytes(b64u){var b=atob(b64u.split('-').join('+').split('_').join('/')+'==='.slice((b64u.length+3)%4));var a=new Uint8Array(b.length);for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a}
async function currentSub(){if(!pushSupported())return null;try{var r=await navigator.serviceWorker.getRegistration('/admin');return r?await r.pushManager.getSubscription():null}catch(e){return null}}
async function enablePush(){
  var info=await api('GET','/admin/v1/push');if(!info.available)throw new Error('התראות לא זמינות בשרת הזה');
  var perm=await Notification.requestPermission();
  if(perm!=='granted')throw new Error(perm==='denied'?'ההתראות חסומות בדפדפן הזה. אפשר לאשר אותן בהגדרות האתר ואז לנסות שוב.':'ההתראות לא אושרו');
  var reg=await navigator.serviceWorker.register('/admin/sw.js',{scope:'/admin'});await navigator.serviceWorker.ready;
  var sub=await reg.pushManager.getSubscription();
  if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyBytes(info.publicKey)});
  return api('POST','/admin/v1/push/subscribe',{subscription:sub.toJSON()});
}
async function disablePush(){var sub=await currentSub();if(!sub)return;try{await api('POST','/admin/v1/push/unsubscribe',{endpoint:sub.endpoint})}catch(e){}await sub.unsubscribe()}
async function refreshBell(){if(!bellBtn)return;var sub=await currentSub();var dot=bellBtn.querySelector('.on-dot');if(sub&&!dot)bellBtn.appendChild(h('i',{cls:'on-dot','aria-hidden':'true'}));if(!sub&&dot)dot.remove()}
async function notifySettings(){
  var w=sideWindow(),box=w.box,close=w.close,body=h('div',{cls:'box'}),msg=h('p',{cls:'err',role:'status'});
  box.replaceChildren(h('div',{cls:'d-head'},[h('button',{cls:'close',type:'button',text:'סגירה',onclick:close}),h('div',{cls:'d-id'},[h('div',null,[h('h2',{text:'התראות'}),h('p',{text:'הודעה לטלפון או למחשב ברגע שלקוח חדש נרשם.'})])])]),h('div',{cls:'d-body'},[body,msg]));
  var draw=async function(){
    msg.textContent='';msg.className='err';
    if(!pushSupported()){
      if(isIOS()&&!standalone())return body.replaceChildren(h('h3',{text:'באייפון: מוסיפים את הניהול למסך הבית'}),h('ol',{cls:'steps'},[
        h('li',{text:'פותחים את הדף הזה בספארי.'}),h('li',{text:'לוחצים על כפתור השיתוף (ריבוע עם חץ למעלה).'}),h('li',{text:'בוחרים "הוספה למסך הבית" ולוחצים "הוספה".'}),
        h('li',{text:'פותחים את "PUSH ניהול" ממסך הבית, נכנסים, ולוחצים כאן "הפעלת התראות".'})]),h('p',{cls:'hint',text:'אפל מאפשרת התראות מאתרים רק אחרי הוספה למסך הבית (iOS 16.4 ומעלה).'}));
      return body.replaceChildren(h('p',{text:'הדפדפן הזה לא תומך בהתראות. אפשר להשתמש ב‑Chrome, Edge, Firefox או Safari מעודכן.'}));
    }
    var info;try{info=await api('GET','/admin/v1/push')}catch(e){return body.replaceChildren(h('p',{cls:'err',text:e.message}))}
    if(!info.available)return body.replaceChildren(h('p',{text:'התראות לא זמינות בשרת הזה.'}));
    var sub=await currentSub();
    if(Notification.permission==='denied'&&!sub)return body.replaceChildren(h('div',{cls:'state'},[h('span',{cls:'dot off'}),'ההתראות חסומות בדפדפן הזה']),
      h('p',{cls:'hint',text:'כדי לאשר: לוחצים על סמל המנעול ליד כתובת האתר, משנים את "התראות" ל"אפשר", ומרעננים את הדף.'}));
    if(sub){
      var test=h('button',{cls:'btn btn-primary',type:'button',text:'שליחת התראת בדיקה',onclick:async function(){test.disabled=true;try{await api('POST','/admin/v1/push/test');msg.className='ok';msg.textContent='נשלחה התראת בדיקה. היא אמורה להופיע תוך כמה שניות.'}catch(e){msg.className='err';msg.textContent=e.message}test.disabled=false}});
      var off=h('button',{cls:'btn btn-ghost',type:'button',text:'כיבוי במכשיר הזה',onclick:async function(){off.disabled=true;await disablePush();refreshBell();draw()}});
      return body.replaceChildren(h('div',{cls:'state'},[h('span',{cls:'dot on'}),'ההתראות פעילות במכשיר הזה']),
        h('p',{cls:'hint',text:'מכשירים שמקבלים התראות: '+info.devices+'. כל טלפון או מחשב מפעילים בנפרד.'}),h('div',{cls:'actions'},[test,off]));
    }
    var on=h('button',{cls:'btn btn-primary btn-block',type:'button',text:'הפעלת התראות במכשיר הזה',onclick:async function(){on.disabled=true;
      try{await enablePush();refreshBell();await draw();msg.className='ok';msg.textContent='ההתראות הופעלו.'}catch(e){msg.className='err';msg.textContent=e.message;on.disabled=false}}});
    body.replaceChildren(h('p',{text:'הדפדפן ישאל אם לאשר התראות. אחרי האישור, כל לקוח חדש שנרשם יגיע אליכם כהתראה, ולחיצה עליה תפתח את פרטי הלקוח.'}),on);
  };
  draw();
}
async function notifyStrip(el){
  try{if(localStorage.getItem('push-admin-notify-later'))return}catch(e){}
  if(!pushSupported()&&!isIOS())return;
  if(await currentSub())return;
  try{var info=await api('GET','/admin/v1/push');if(!info.available)return}catch(e){return}
  el.replaceChildren(h('div',{cls:'strip'},[h('p',{text:'רוצים לדעת מיד כשלקוח חדש נרשם? הפעילו התראות לטלפון או למחשב.'}),
    h('button',{cls:'btn btn-primary btn-sm',type:'button',text:'הפעלת התראות',onclick:function(){el.replaceChildren();notifySettings()}}),
    h('button',{cls:'btn btn-ghost btn-sm',type:'button',text:'לא עכשיו',onclick:function(){try{localStorage.setItem('push-admin-notify-later','1')}catch(e){}el.replaceChildren()}})]));
}
function openFromHash(reload){
  var m=String(location.hash||'').match(/^#customer=([0-9a-f-]{36})$/);if(!m)return;
  try{history.replaceState(null,'',location.pathname)}catch(e){}
  openCustomer(m[1],reload);
}
if('serviceWorker' in navigator)navigator.serviceWorker.addEventListener('message',function(e){if(e.data&&e.data.open&&tok()){location.hash=String(e.data.open).split('#')[1]||''}});
var HOME_RELOAD=null;
window.addEventListener('hashchange',function(){if(tok()&&HOME_RELOAD)openFromHash(HOME_RELOAD)});

/* A bar per period (copies delivered) with the reads drawn as a line over it. */
function chart(rows,labelOf,tickEvery,readoutOf){
  var n=rows.length,W=n*10,H=100,max=1;
  rows.forEach(function(r){max=Math.max(max,r.sent,r.reads)});
  var svg=s('svg',{viewBox:'0 0 '+W+' '+H,preserveAspectRatio:'none','class':'ch-svg','aria-hidden':'true'});
  svg.appendChild(s('line',{x1:0,x2:W,y1:H-.5,y2:H-.5,'class':'base','vector-effect':'non-scaling-stroke'}));
  rows.forEach(function(r,i){
    var bh=r.sent?Math.max(2,r.sent/max*(H-8)):2;
    var b=s('rect',{x:i*10+1.6,y:H-bh,width:6.8,height:bh,rx:1,'class':r.sent?'b':'b b0'});
    if(r.sent&&!REDUCED)b.style.animationDelay=(i*22)+'ms';
    svg.appendChild(b);
  });
  if(rows.some(function(r){return r.reads>0}))
    svg.appendChild(s('polyline',{points:rows.map(function(r,i){return (i*10+5)+','+(H-1-r.reads/max*(H-8))}).join(' '),'class':'rl',fill:'none','vector-effect':'non-scaling-stroke'}));
  var hit=h('div',{cls:'ch-hit'}),axis=h('div',{cls:'ch-axis'});
  hit.style.gridTemplateColumns='repeat('+n+',1fr)';axis.style.gridTemplateColumns='repeat('+n+',1fr)';
  var cells=rows.map(function(r,i){
    var c=h('div',{onmouseenter:function(){cells.forEach(function(x){x.classList.remove('on')});c.classList.add('on');readoutOf(r,i)}});
    axis.appendChild(h('span',{text:(n-1-i)%tickEvery===0?labelOf(r,i):''}));return c});
  cells.forEach(function(c){hit.appendChild(c)});
  hit.addEventListener('mouseleave',function(){cells.forEach(function(x){x.classList.remove('on')});readoutOf(null)});
  return h('div',null,[h('div',{cls:'chart'},[svg,hit]),axis]);
}
function legend(sentText,readText){return [h('span',{cls:'key'},[h('i'),sentText]),h('span',{cls:'key r'},[h('i'),readText])]}

/* One message going out to many groups: the picture beside the sign-in form. */
function fanArt(){
  var svg=s('svg',{viewBox:'0 0 520 300','class':'fan',role:'img','aria-label':'הודעה אחת יוצאת לקבוצות רבות'});
  var sx=440,sy=150,dst=[[70,28],[40,92],[70,150],[40,208],[70,272],[170,60],[170,240]];
  dst.forEach(function(p){svg.appendChild(s('line',{x1:sx,y1:sy,x2:p[0],y2:p[1]}))});
  svg.appendChild(s('circle',{cx:sx,cy:sy,r:34,'class':'halo'}));svg.appendChild(s('circle',{cx:sx,cy:sy,r:16,'class':'src'}));
  dst.forEach(function(p,i){
    svg.appendChild(s('circle',{cx:p[0],cy:p[1],r:11,'class':'dst'}));
    if(REDUCED)return;
    var dot=s('circle',{cx:sx,cy:sy,r:4.5,'class':'pulse',opacity:0});
    var begin=(i*0.18).toFixed(2)+'s';
    dot.appendChild(s('animate',{attributeName:'cx',values:sx+';'+p[0],dur:'2.6s',begin:begin,repeatCount:'indefinite'}));
    dot.appendChild(s('animate',{attributeName:'cy',values:sy+';'+p[1],dur:'2.6s',begin:begin,repeatCount:'indefinite'}));
    dot.appendChild(s('animate',{attributeName:'opacity',values:'0;1;1;0',keyTimes:'0;0.1;0.85;1',dur:'2.6s',begin:begin,repeatCount:'indefinite'}));
    svg.appendChild(dot);
  });
  return h('div',{cls:'auth-art'},[svg,h('h2',{text:'הודעה אחת. כל הקבוצות. בזמן אמת.'}),h('p',{text:'מכאן מנהלים את הלקוחות של PUSH: מי מחובר, כמה נשלח, ומי קרא.'})]);
}
function authScreen(form){shell(h('div',{cls:'auth'},[h('div',{cls:'auth-form'},[form]),fanArt()]),false)}

// ---------------- first-time setup
function showSetup(){
  var code=h('input',{cls:'i',type:'password',autocomplete:'off',dir:'ltr'}),email=h('input',{cls:'i',type:'email',dir:'ltr',autocomplete:'username'});
  var pw=h('input',{cls:'i',type:'password',dir:'ltr',autocomplete:'new-password'});
  var err=h('p',{cls:'err',role:'alert'});
  var go=h('button',{cls:'btn btn-primary btn-block',type:'submit',text:'יצירת המנהל'});
  authScreen(h('form',{novalidate:true,onsubmit:async function(e){e.preventDefault();err.textContent='';go.disabled=true;
      try{await api('POST','/admin/v1/setup',{code:code.value,email:email.value,password:pw.value});showLogin('המנהל נוצר. התחברו עם האימייל והסיסמה.',true)}catch(x){err.textContent=x.message;go.disabled=false}}},
    [h('h1',{text:'הגדרה ראשונה'}),h('p',{cls:'sub',text:'יוצרים את חשבון המנהל הראשי. עושים את זה פעם אחת בלבד.'}),
    h('label',{cls:'f'},[h('span',{text:'קוד הגדרה'}),code]),h('label',{cls:'f'},[h('span',{text:'אימייל המנהל'}),email]),
    h('label',{cls:'f'},[h('span',{text:'סיסמה (לפחות 12 תווים)'}),pw]),go,err]));
}

// ---------------- sign in
function showLogin(msg,good){
  var email=h('input',{cls:'i',type:'email',dir:'ltr',autocomplete:'username'}),pw=h('input',{cls:'i',type:'password',dir:'ltr',autocomplete:'current-password'});
  var err=h('p',{cls:good?'err ok':'err',role:'alert',text:msg||''});
  var go=h('button',{cls:'btn btn-primary btn-block',type:'submit',text:'כניסה'});
  authScreen(h('form',{novalidate:true,onsubmit:async function(e){e.preventDefault();err.textContent='';err.className='err';go.disabled=true;
      try{var r=await api('POST','/admin/v1/login',{email:email.value,password:pw.value});setTok(r.token);showHome()}catch(x){err.textContent=x.message==='bad credentials'?'האימייל או הסיסמה שגויים':x.message;go.disabled=false}}},
    [h('h1',{text:'כניסת מנהל'}),h('p',{cls:'sub',text:'ניהול הלקוחות של PUSH.'}),h('label',{cls:'f'},[h('span',{text:'אימייל'}),email]),
     h('label',{cls:'f'},[h('span',{text:'סיסמה'}),pw]),go,err]));
}

// ---------------- home: the last 24 hours, then customers
var PLANS=[];
function planName(code){return (PLANS.find(function(p){return p.code===code})||{name:code}).name}
function greeting(){var hr=new Date().getHours();return hr>=5&&hr<12?'בוקר טוב':hr<17&&hr>=12?'צהריים טובים':hr>=17&&hr<21?'ערב טוב':'לילה טוב'}
var FILTERS=[['all','הכל'],['active','פעילים'],['online','מחוברים ל‑WhatsApp'],['nowa','בלי מספר מחובר'],['susp','מושעים']];
function matches(f,t){return f==='all'||(f==='active'&&t.status==='active')||(f==='online'&&t.connected>0)||(f==='nowa'&&!t.connected)||(f==='susp'&&t.status!=='active')}

async function showHome(){
  var live=h('section',{cls:'live','aria-label':'24 השעות האחרונות'},[h('p',{cls:'greet',text:greeting()}),h('p',{cls:'headline',text:'טוען…'})]);
  var tbody=h('tbody'),chips=h('div',{cls:'chips',role:'group','aria-label':'סינון לקוחות'}),count=h('span');
  var q=h('input',{cls:'i',type:'search',placeholder:'חיפוש לפי שם או אימייל','aria-label':'חיפוש לקוח'});
  var addBtn=h('button',{cls:'btn btn-primary',type:'button',text:'+ הוספת לקוח',onclick:addCustomer});
  var listBox=h('div',{cls:'list'},[h('div',{cls:'tablewrap'},[h('table',null,[h('thead',null,[h('tr',null,[
    h('th',{text:'לקוח'}),h('th',{cls:'col-hide',text:'מסלול'}),h('th',{text:'WhatsApp'}),h('th',{cls:'col-hide',text:'7 ימים'}),h('th',{text:'24 שעות'}),h('th',{cls:'col-hide',text:'כניסה אחרונה'}),h('th',{cls:'col-hide',text:'הצטרף'})])]),tbody])])]);
  var stripBox=h('div');
  shell(h('div',null,[live,h('main',null,[stripBox,h('div',{cls:'head'},[h('h2',null,['לקוחות ',count]),q,addBtn]),chips,listBox])]),true);
  notifyStrip(stripBox);

  try{
    var res=await Promise.all([api('GET','/admin/v1/dashboard'),api('GET','/admin/v1/plans')]);var d=res[0];PLANS=res[1];
    var sent=d.sentLast24h||0,reads=d.readsLast24h||0;
    var head=sent?h('p',{cls:'headline'},['ב‑24 השעות האחרונות יצאו ',h('span',{cls:'n-sent',text:num(sent)}),' העתקים',reads?', ונקראו ':'',reads?h('span',{cls:'n-read',text:num(reads)}):'',reads?' פעמים':'','.'])
                 :h('p',{cls:'headline',text:'ב‑24 השעות האחרונות לא יצאו הודעות.'});
    var readout=h('div',{cls:'readout',role:'status'});
    var rest=function(){readout.replaceChildren.apply(readout,legend('העתקים שנשלחו','קריאות'))};rest();
    var rows=(d.hourly||[]).map(function(r){return {sent:r.sent,reads:r.reads,at:new Date(r.h)}});
    var hh=function(dt){return String(dt.getHours()).padStart(2,'0')+':00'};
    var ch=rows.length?chart(rows,function(r){return hh(r.at)},4,function(r){if(!r)return rest();
      readout.replaceChildren(h('b',{cls:'ltr',text:hh(r.at)+'–'+String((r.at.getHours()+1)%24).padStart(2,'0')+':00'}),h('span',{cls:'key'},[h('i'),num(r.sent)+' נשלחו']),h('span',{cls:'key r'},[h('i'),num(r.reads)+' קריאות']))}):'';
    var T=d.tenants||{},WA=d.whatsappNumbers||{},waAll=Object.keys(WA).reduce(function(a,k){return a+WA[k]},0);
    var fact=function(v,k,cls){return h('div',{cls:cls||''},[h('b',{text:v}),h('span',{text:k})])};
    live.replaceChildren(h('p',{cls:'greet',text:greeting()}),head,ch,readout,h('div',{cls:'facts'},[
      fact(num(T.active||0),'לקוחות פעילים'),fact(num(WA.connected||0)+' מתוך '+num(waAll),'מספרי WhatsApp מחוברים'),
      fact(num(T.suspended||0),'מושעים',(T.suspended||0)?'warn':''),fact('₪'+num(d.monthlyRevenueEstimateIls||0),'בחודש לפי המסלולים')]));
  }catch(e){live.replaceChildren(h('p',{cls:'headline',text:'לא הצלחנו לטעון את הנתונים'}),h('p',{cls:'greet',text:e.message}))}

  var all=[],filter='all';
  var drawChips=function(){chips.replaceChildren.apply(chips,FILTERS.map(function(f){var n=all.filter(function(t){return matches(f[0],t)}).length;
    return h('button',{cls:'chip',type:'button','aria-pressed':String(filter===f[0]),onclick:function(){filter=f[0];drawChips();drawRows()}},[f[1],h('em',{text:String(n)})])}))};
  var drawRows=function(){
    var rows=all.filter(function(t){return matches(filter,t)});count.textContent='('+all.length+')';
    if(!all.length&&!q.value.trim()){tbody.replaceChildren(h('tr',null,[h('td',{colspan:'7'},[h('div',{cls:'empty'},[h('h3',{text:'עוד אין לקוחות'}),h('p',{text:'לקוחות שנרשמים באתר יופיעו כאן. אפשר גם לפתוח חשבון ללקוח בעצמכם.'}),h('button',{cls:'btn btn-primary',type:'button',text:'+ הוספת לקוח',onclick:addCustomer})])])]));return}
    if(!rows.length){tbody.replaceChildren(h('tr',null,[h('td',{colspan:'7'},[h('div',{cls:'empty'},[h('p',{text:q.value.trim()?'אין לקוח שמתאים לחיפוש.':'אין לקוחות בסינון הזה.'})])])]));return}
    tbody.replaceChildren.apply(tbody,rows.map(function(t){
      var on=t.connected>0,susp=t.status!=='active';
      var open=function(){openCustomer(t.id,load)};
      return h('tr',{cls:'rowlink'+(susp?' susp':''),tabindex:'0',onclick:open,onkeydown:function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}}},[
        h('td',null,[h('div',{cls:'who'},[avatar(t),h('div',null,[h('b',null,[t.name,susp?h('span',{cls:'pill bad',text:'מושעה'}):'']),h('small',{cls:'ltr',text:t.owner_email||'—'})])])]),
        h('td',{cls:'col-hide'},[h('span',{cls:'plan p-'+t.plan_code,text:planName(t.plan_code)})]),
        h('td',null,[h('span',{cls:'wa'},[h('span',{cls:'dot'+(on?' on':t.numbers?' off':'')}),on?(t.connected>1?t.connected+' מחוברים':'מחובר'):t.numbers?'מנותק':'לא חובר'])]),
        h('td',{cls:'col-hide'},[spark(t.spark_7d)]),
        h('td',{cls:'nums'},[h('b',{text:num(t.sent_24h)}),t.reads_24h?h('small',{text:num(t.reads_24h)+' קריאות'}):'']),
        h('td',{cls:'col-hide',text:ago(t.last_login_at)}),h('td',{cls:'col-hide',text:fmtDate(t.created_at)})])
    }));
  };
  var load=async function(){
    try{all=await api('GET','/admin/v1/tenants?q='+encodeURIComponent(q.value.trim()));drawChips();drawRows()}
    catch(e){tbody.replaceChildren(h('tr',null,[h('td',{colspan:'7',cls:'err',text:e.message})]))}
  };
  var timer;q.addEventListener('input',function(){clearTimeout(timer);timer=setTimeout(load,250)});
  HOME_RELOAD=load;
  load().then(function(){openFromHash(load)});
}
function spark(csv){
  var v=String(csv||'').split(',').map(Number).filter(function(x){return !isNaN(x)});if(!v.length)v=[0,0,0,0,0,0,0];
  var max=Math.max.apply(null,v),W=96,H=28,step=W/(v.length-1||1);
  var svg=s('svg',{viewBox:'0 0 '+W+' '+H,'class':'spark',role:'img','aria-label':'נשלחו ב‑7 ימים: '+v.join(', ')});
  if(!max){svg.appendChild(s('polyline',{points:'0,'+(H-2)+' '+W+','+(H-2),'class':'flat'}));return svg}
  var pts=v.map(function(x,i){return (i*step).toFixed(1)+','+(H-2-x/max*(H-6)).toFixed(1)});
  svg.appendChild(s('polygon',{points:'0,'+H+' '+pts.join(' ')+' '+W+','+H,'class':'area'}));
  svg.appendChild(s('polyline',{points:pts.join(' ')}));
  return svg;
}

// ---------------- one customer
function sideWindow(){
  var box=h('div',{role:'dialog','aria-modal':'true'}),wrap=h('div',{cls:'drawer',onclick:function(e){if(e.target===wrap)close()}},[box]);
  var close=function(){wrap.remove();document.removeEventListener('keydown',esc)};
  var esc=function(e){if(e.key==='Escape')close()};document.addEventListener('keydown',esc);
  document.body.appendChild(wrap);return {box:box,close:close};
}
async function openCustomer(id,reload){
  var w=sideWindow(),box=w.box,close=w.close;box.replaceChildren(h('div',{cls:'d-body'},[h('p',{cls:'hint',text:'טוען…'})]));
  var d;try{d=await api('GET','/admin/v1/tenants/'+id)}catch(e){box.replaceChildren(h('div',{cls:'d-body'},[h('p',{cls:'err',text:e.message})]));return}
  var t=d.tenant,msg=h('p',{cls:'err',role:'status'}),active=t.status==='active';
  var sent=0,failed=0;(d.jobs7d||[]).forEach(function(j){if(j.status==='sent')sent+=j.n;if(j.status==='failed')failed+=j.n});
  var plan=h('select',{cls:'i'},PLANS.map(function(p){return h('option',{value:p.code,text:p.name+(p.price_agorot?' ('+(p.price_agorot/100)+' ₪)':'')})}));plan.value=t.plan_code;
  var savePlan=h('button',{cls:'btn btn-dark',type:'button',text:'שמירת מסלול',onclick:async function(){savePlan.disabled=true;try{await api('POST','/admin/v1/tenants/'+id,{plan:plan.value});msg.className='ok';msg.textContent='המסלול עודכן';reload()}catch(e){msg.className='err';msg.textContent=e.message}savePlan.disabled=false}});
  var toggle=h('button',{cls:'btn '+(active?'btn-ghost':'btn-primary'),type:'button',text:active?'השעיית הלקוח':'החזרה לפעילות',onclick:async function(){toggle.disabled=true;
    try{await api('POST','/admin/v1/tenants/'+id,{status:active?'suspended':'active'});close();reload();openCustomer(id,reload)}catch(e){msg.className='err';msg.textContent=e.message;toggle.disabled=false}}});
  var confirmIn=h('input',{cls:'i',placeholder:t.name,'aria-label':'הקלידו את שם העסק לאישור'}),delMsg=h('p',{cls:'err',role:'alert'});
  var del=h('button',{cls:'btn btn-danger',type:'button',text:'הסרה מהמערכת',onclick:async function(){
    if(confirmIn.value.trim()!==t.name){delMsg.textContent='כדי להסיר, הקלידו את שם העסק בדיוק';return}
    del.disabled=true;try{await api('DELETE','/admin/v1/tenants/'+id);close();reload()}catch(e){delMsg.textContent=e.message;del.disabled=false}}});
  var rows=(d.daily||[]).map(function(r){return {sent:r.sent,reads:r.reads,at:new Date(r.d)}});
  var readout=h('div',{cls:'readout',role:'status'}),rest=function(){readout.replaceChildren.apply(readout,legend('נשלחו','קריאות'))};rest();
  var day=function(dt){return dt.getDate()+'.'+(dt.getMonth()+1)};
  var waLines=(d.whatsapp||[]).filter(function(x){return x.status!=='deleted'});
  box.replaceChildren(
    h('div',{cls:'d-head'},[h('button',{cls:'close',type:'button',text:'סגירה',onclick:close}),
      h('div',{cls:'d-id'},[avatar(t,true),h('div',null,[h('h2',{text:t.name}),h('p',null,[planName(t.plan_code),', הצטרף ב‑'+fmtDate(t.created_at),active?'':h('span',{cls:'pill bad',text:'מושעה'})])])]),
      rows.length?chart(rows,function(r){return day(r.at)},4,function(r){if(!r)return rest();readout.replaceChildren(h('b',{text:day(r.at)}),h('span',{cls:'key'},[h('i'),num(r.sent)+' נשלחו']),h('span',{cls:'key r'},[h('i'),num(r.reads)+' קריאות']))}):'',readout]),
    h('div',{cls:'d-body'},[
      h('div',{cls:'box'},[h('h3',{text:'פעילות'}),h('dl',{cls:'dl'},[
        h('dt',{text:'נשלחו ב‑7 ימים'}),h('dd',{text:num(sent)+(failed?' ('+num(failed)+' נכשלו)':'')}),
        h('dt',{text:'קבוצות שליטה'}),h('dd',{text:num((d.routes||[]).length)}),
        h('dt',{text:'אישר את הסבר הסיכונים'}),h('dd',{text:t.risk_accepted_at?fmtDate(t.risk_accepted_at):'עדיין לא'})])]),
      h('div',{cls:'box'},[h('h3',{text:'מספרי WhatsApp'}),waLines.length?h('div',{cls:'lines'},waLines.map(function(x){var on=x.status==='connected';
        return h('div',null,[h('span',{cls:'wa ltr'},[h('span',{cls:'dot'+(on?' on':' off')}),x.phone_number?'+'+x.phone_number:'(לא חובר)']),h('span',{cls:'hint',text:on?'מחובר':'מנותק'+(x.last_connected_at?', חובר לאחרונה '+ago(x.last_connected_at):'')})])})):h('p',{cls:'hint',text:'הלקוח עוד לא חיבר מספר.'})]),
      (d.activeStops||[]).length?h('div',{cls:'box'},[h('h3',{text:'עצירות פעילות'}),h('div',{cls:'lines'},d.activeStops.map(function(x){return h('div',null,[h('span',{text:x.reason}),h('span',{cls:'hint',text:ago(x.set_at)})])}))]):'',
      h('div',{cls:'box'},[h('h3',{text:'משתמשים'}),h('div',{cls:'lines'},(d.users||[]).map(function(u){return h('div',null,[h('span',{cls:'ltr',text:u.email}),h('span',{cls:'hint',text:(u.role==='owner'?'בעלים, ':'')+(u.last_login_at?'נכנס '+ago(u.last_login_at):'עוד לא נכנס')})])}))]),
      h('div',{cls:'box'},[h('h3',{text:'מסלול ומצב'}),h('div',{cls:'actions'},[h('label',{cls:'f'},[h('span',{text:'מסלול'}),plan]),savePlan,toggle]),msg]),
      h('div',{cls:'box danger'},[h('h3',{text:'הסרה מהמערכת'}),h('p',{cls:'hint',text:'המספרים מתנתקים, הקבוצות וההיסטוריה נמחקות, והמשתמשים לא יוכלו להיכנס. אי אפשר לבטל את זה.'}),
        h('label',{cls:'f'},[h('span',{text:'לאישור, הקלידו את שם העסק'}),confirmIn]),del,delMsg])]));
}

// ---------------- add a customer
function addCustomer(){
  var w=sideWindow(),box=w.box,close=w.close;
  var name=h('input',{cls:'i'}),email=h('input',{cls:'i',type:'email',dir:'ltr'}),plan=h('select',{cls:'i'},PLANS.map(function(p){return h('option',{value:p.code,text:p.name})}));plan.value='trial';
  var err=h('p',{cls:'err',role:'alert'}),out=h('div');
  var go=h('button',{cls:'btn btn-primary btn-block',type:'button',text:'יצירת הלקוח',onclick:async function(){err.textContent='';go.disabled=true;
    try{var r=await api('POST','/admin/v1/tenants',{businessName:name.value,email:email.value,plan:plan.value});
      var link=location.origin+'/app',text='כניסה ל‑PUSH\\n'+link+'\\nאימייל: '+r.email+'\\nסיסמה זמנית: '+r.temporaryPassword;
      var copy=h('button',{cls:'btn btn-dark btn-sm',type:'button',text:'העתקת הפרטים',onclick:async function(){try{await navigator.clipboard.writeText(text);copy.textContent='הועתק'}catch(e){copy.textContent='לא הצלחנו להעתיק, סמנו והעתיקו ידנית'}}});
      out.replaceChildren(h('div',{cls:'temp'},[h('p',{cls:'ok',text:'הלקוח נוצר. שלחו לו את הפרטים:'}),h('dl',{cls:'dl'},[
        h('dt',{text:'כתובת'}),h('dd',{cls:'ltr',text:link}),h('dt',{text:'אימייל'}),h('dd',{cls:'ltr',text:r.email}),h('dt',{text:'סיסמה זמנית'}),h('dd',{cls:'ltr',text:r.temporaryPassword})]),
        copy,h('p',{cls:'hint',text:'הסיסמה מוצגת עכשיו בלבד. כדאי שהלקוח יחליף אותה אחרי הכניסה הראשונה.'})]));go.hidden=true;showHome();}
    catch(e){err.textContent=e.message;go.disabled=false}}});
  box.replaceChildren(h('div',{cls:'d-head'},[h('button',{cls:'close',type:'button',text:'סגירה',onclick:close}),h('div',{cls:'d-id'},[h('div',null,[h('h2',{text:'הוספת לקוח'}),h('p',{text:'פותחים חשבון בשביל הלקוח ומקבלים סיסמה זמנית לשלוח לו.'})])])]),
    h('div',{cls:'d-body'},[h('div',{cls:'box'},[
    h('label',{cls:'f'},[h('span',{text:'שם העסק'}),name]),h('label',{cls:'f'},[h('span',{text:'אימייל של הלקוח'}),email]),h('label',{cls:'f'},[h('span',{text:'מסלול'}),plan]),go,err,out])]));
  name.focus();
}

(async function(){
  if(tok()){try{await api('GET','/admin/v1/plans');return showHome()}catch(e){setTok(null)}}
  try{var st=await api('GET','/admin/v1/setup');if(st.needed)return showSetup()}catch(e){}
  showLogin();
})();
})();
</script>
</body>
</html>`;
}
