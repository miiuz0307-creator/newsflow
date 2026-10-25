/**
 * The customer app as an installable phone app: its manifest, a small service worker
 * (an offline notice when there is no connection), and the /app/install page that a
 * PUSH owner sends to customers. The page shows the right steps for the visitor's
 * device (iPhone, Android, computer), and on Chrome/Edge offers a one-tap install.
 */

export function appManifest(): string {
  return JSON.stringify({
    id: '/app', name: 'PUSH', short_name: 'PUSH', lang: 'he', dir: 'rtl',
    description: 'הודעה אחת בקבוצת השליטה, לכל הקבוצות. רואים מה יצא, לאן הגיע ומי קרא.',
    start_url: '/app', scope: '/app', display: 'standalone', orientation: 'portrait',
    background_color: '#0A1B33', theme_color: '#0A1B33',
    icons: [
      { src: '/app/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/app/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  });
}

/** Handles page loads only: online → the network as usual; offline → a short Hebrew notice. API calls are untouched. */
export function appServiceWorker(): string {
  return `'use strict';
self.addEventListener('install',function(){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});
self.addEventListener('fetch',function(e){
  if(e.request.mode!=='navigate')return;
  e.respondWith(fetch(e.request).catch(function(){
    return new Response('<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PUSH</title>'+
      '<body style="margin:0;font-family:system-ui,sans-serif;background:#0A1B33;color:#fff;display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px">'+
      '<div><div style="width:18px;height:18px;border-radius:50%;background:#19C6B4;margin:0 auto 18px"></div><h1 style="margin:0 0 8px;font-size:24px">אין חיבור לאינטרנט</h1>'+
      '<p style="margin:0;color:#93A5C0">ההפצות ממשיכות לעבוד בשרת. כשהחיבור יחזור, פתחו שוב את האפליקציה.</p></div></body></html>',
      {headers:{'content-type':'text/html; charset=utf-8'}});
  }));
});
`;
}

/** Head tags that make /app installable (and give it the PUSH icon on the home screen). */
export const APP_INSTALL_HEAD = `<link rel="manifest" href="/app/manifest.webmanifest">
<link rel="apple-touch-icon" href="/app/icon-180.png">
<link rel="icon" type="image/png" href="/app/icon-192.png">
<meta name="theme-color" content="#0A1B33">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="PUSH">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`;

export function installHtml(nonce: string, fontCss: string): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>התקנת PUSH</title>
<meta name="description" content="מתקינים את PUSH בטלפון ורואים מה יצא, לאן הגיע ומי קרא.">
${APP_INSTALL_HEAD}
<style nonce="${nonce}">
${fontCss}
:root{--ink:#0A1B33;--deep:#13325D;--teal:#19C6B4;--muted:#93A5C0;--line:rgba(147,165,192,.22)}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{font-family:"IBM Plex Sans Hebrew",system-ui,sans-serif;background:radial-gradient(120% 60% at 90% 0%,#17406F,var(--ink) 65%) var(--ink);color:#fff;line-height:1.55;-webkit-font-smoothing:antialiased;
  padding:max(28px,env(safe-area-inset-top)) max(18px,env(safe-area-inset-right)) max(40px,env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-left))}
main{max-width:520px;margin:0 auto}
h1,h2{font-family:"Secular One","IBM Plex Sans Hebrew",sans-serif;font-weight:400;margin:0;line-height:1.2}
.brand{display:flex;align-items:center;gap:12px;font-family:"Secular One",sans-serif;font-size:30px;letter-spacing:1px}
.brand i{width:14px;height:14px;border-radius:50%;background:var(--teal);box-shadow:0 0 0 7px rgba(25,198,180,.2)}
.icon{width:96px;height:96px;border-radius:24px;display:block;margin:30px 0 18px;box-shadow:0 14px 40px rgba(0,0,0,.35)}
h1{font-size:36px;text-wrap:balance}
.lead{color:var(--muted);font-size:18px;margin:10px 0 24px}
.gets{list-style:none;padding:0;margin:0 0 26px;display:grid;gap:10px}
.gets li{display:flex;gap:12px;align-items:flex-start;font-size:17px}
.gets li::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--teal);margin-top:10px;flex:none}
.btn{display:flex;width:100%;align-items:center;justify-content:center;gap:10px;border:0;border-radius:16px;padding:16px 20px;font:inherit;font-size:19px;font-weight:600;cursor:pointer;text-decoration:none}
.btn-primary{background:var(--teal);color:var(--ink)}.btn-ghost{background:transparent;color:#fff;border:1px solid var(--line)}
.btn+.btn{margin-top:10px}
.box{background:rgba(19,50,93,.8);border:1px solid var(--line);border-radius:20px;padding:20px;margin:18px 0}
.box h2{font-size:22px;margin-bottom:12px}
ol{margin:0;padding-inline-start:22px;display:grid;gap:12px;font-size:17px}
.k{display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.1);border-radius:8px;padding:1px 8px;font-weight:600;white-space:nowrap}
.k svg{width:18px;height:18px}
.note{font-size:15px;color:var(--muted);margin:12px 0 0}
.tabs{display:flex;gap:8px;margin:26px 0 0;flex-wrap:wrap}
.tab{border:1px solid var(--line);background:transparent;color:#fff;border-radius:99px;padding:8px 16px;font:inherit;font-size:15px;cursor:pointer}
.tab[aria-pressed=true]{background:#fff;color:var(--ink);border-color:#fff}
[hidden]{display:none!important}
:focus-visible{outline:3px solid var(--teal);outline-offset:2px}
</style>
</head>
<body>
<main>
  <div class="brand"><i></i>PUSH</div>
  <img class="icon" src="/app/icon-192.png" alt="" width="96" height="96">
  <h1>האפליקציה של PUSH בטלפון שלכם</h1>
  <p class="lead">מאחורי הקלעים של ההפצות: כל מה שקורה עם ההודעות שלכם, במקום אחד.</p>
  <ul class="gets">
    <li>כל הודעה שיצאה מקבוצת השליטה, ולאילו קבוצות הגיעה</li>
    <li>כמה אנשים קראו כל הודעה</li>
    <li>מצב החיבור של ה‑WhatsApp, וחיבור מחדש בלחיצה</li>
    <li>החתימה, הלוגו והקבוצות, לשינוי מתי שרוצים</li>
  </ul>

  <button class="btn btn-primary" id="install" type="button" hidden>התקנת האפליקציה</button>
  <p class="note" id="done" hidden>האפליקציה הותקנה. אפשר לפתוח אותה ממסך הבית.</p>

  <div class="tabs" role="group" aria-label="סוג המכשיר">
    <button class="tab" type="button" data-for="ios">אייפון</button>
    <button class="tab" type="button" data-for="android">אנדרואיד</button>
    <button class="tab" type="button" data-for="desktop">מחשב</button>
  </div>

  <section class="box" data-os="ios" hidden>
    <h2>התקנה באייפון</h2>
    <ol>
      <li>פותחים את הדף הזה ב<span class="k">Safari</span>.</li>
      <li>לוחצים על כפתור השיתוף <span class="k"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>שיתוף</span> בתחתית המסך.</li>
      <li>גוללים ובוחרים <span class="k">הוספה למסך הבית</span>, ואז <span class="k">הוספה</span>.</li>
      <li>פותחים את <span class="k">PUSH</span> ממסך הבית ונכנסים עם האימייל והסיסמה.</li>
    </ol>
    <p class="note">נפתח בתוך WhatsApp? לוחצים על סמל המצפן או על "פתיחה ב‑Safari", וממשיכים משם.</p>
  </section>

  <section class="box" data-os="android" hidden>
    <h2>התקנה באנדרואיד</h2>
    <ol>
      <li>פותחים את הדף הזה ב<span class="k">Chrome</span>.</li>
      <li>אם מופיע הכפתור "התקנת האפליקציה" למעלה, לוחצים עליו. אם לא: לוחצים על <span class="k">⋮</span> בפינה ובוחרים <span class="k">התקנת אפליקציה</span> או <span class="k">הוספה למסך הבית</span>.</li>
      <li>פותחים את <span class="k">PUSH</span> ממסך הבית ונכנסים עם האימייל והסיסמה.</li>
    </ol>
    <p class="note">נפתח בתוך WhatsApp? לוחצים על <span class="k">⋮</span> ובוחרים "פתיחה ב‑Chrome".</p>
  </section>

  <section class="box" data-os="desktop" hidden>
    <h2>התקנה במחשב</h2>
    <ol>
      <li>פותחים את הדף ב‑<span class="k">Chrome</span> או ב‑<span class="k">Edge</span>.</li>
      <li>לוחצים על "התקנת האפליקציה" למעלה, או על סמל ההתקנה בשורת הכתובת.</li>
      <li>PUSH נפתחת בחלון משלה, ואפשר להצמיד אותה לשורת המשימות.</li>
    </ol>
  </section>

  <a class="btn btn-ghost" href="/app">כניסה בלי להתקין</a>
</main>
<script nonce="${nonce}">
(function(){
  'use strict';
  var ua=navigator.userAgent||'';
  var standalone=(window.matchMedia&&matchMedia('(display-mode: standalone)').matches)||navigator.standalone===true;
  if(standalone){location.replace('/app');return}
  var os=/iPhone|iPad|iPod/.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1)?'ios':/Android/.test(ua)?'android':'desktop';
  var tabs=[].slice.call(document.querySelectorAll('.tab')),boxes=[].slice.call(document.querySelectorAll('[data-os]'));
  function pick(k){tabs.forEach(function(t){t.setAttribute('aria-pressed',String(t.getAttribute('data-for')===k))});boxes.forEach(function(b){b.hidden=b.getAttribute('data-os')!==k})}
  tabs.forEach(function(t){t.addEventListener('click',function(){pick(t.getAttribute('data-for'))})});
  pick(os);
  if('serviceWorker' in navigator)navigator.serviceWorker.register('/app/sw.js',{scope:'/app'}).catch(function(){});
  var btn=document.getElementById('install'),done=document.getElementById('done'),deferred=null;
  window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();deferred=e;btn.hidden=false});
  btn.addEventListener('click',function(){if(!deferred)return;deferred.prompt();deferred.userChoice.then(function(c){if(c&&c.outcome==='accepted'){btn.hidden=true;done.hidden=false}deferred=null})});
  window.addEventListener('appinstalled',function(){btn.hidden=true;done.hidden=false});
})();
</script>
</body>
</html>`;
}
