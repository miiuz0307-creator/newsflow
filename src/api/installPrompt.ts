/**
 * "Install the app" offer, shown on the home page and inside the customer app whenever the
 * visitor is in a browser (not already in the installed app). "Not now" hides it for this
 * visit only: the next visit offers it again.
 *
 *  - Chrome / Edge / Samsung (Android, computer): one tap opens the browser's own install dialog.
 *  - iPhone / iPad (Safari): the two steps, with the share icon, right in the card.
 *  - Inside WhatsApp / Instagram / Facebook: install is not possible there, so the card offers
 *    to open the page in the real browser (Chrome on Android).
 *  - Anything else: the full guide at /app/install.
 *
 * Plain DOM, no inline styles or handlers (the pages run under a nonce-only CSP).
 */

export function installPromptCss(): string {
  return `
.ip{position:fixed;inset-inline:12px;bottom:max(12px,env(safe-area-inset-bottom));z-index:80;max-width:440px;margin-inline:auto;
  background:linear-gradient(160deg,#13325D,#0A1B33 70%);color:#fff;border:1px solid rgba(25,198,180,.35);border-radius:22px;padding:16px 16px 14px;
  box-shadow:0 24px 60px -12px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.04) inset;font-family:"IBM Plex Sans Hebrew",system-ui,sans-serif;
  transform:translateY(140%);opacity:0;transition:transform .55s cubic-bezier(.2,.9,.25,1.2),opacity .3s}
.ip.on{transform:none;opacity:1}
.ip-h{display:flex;gap:12px;align-items:center}
.ip-ic{width:52px;height:52px;border-radius:14px;flex:none;box-shadow:0 8px 20px rgba(0,0,0,.35);animation:ipbob 2.6s ease-in-out infinite}
@keyframes ipbob{50%{transform:translateY(-4px) rotate(-3deg)}}
.ip-t{font-family:"Secular One","IBM Plex Sans Hebrew",sans-serif;font-size:19px;line-height:1.2;margin:0}
.ip-s{margin:3px 0 0;font-size:14px;color:#A9B8CE;line-height:1.4}
.ip-x{margin-inline-start:auto;align-self:flex-start;background:none;border:0;color:#A9B8CE;font-size:22px;line-height:1;cursor:pointer;padding:2px 6px}
.ip-row{display:flex;gap:8px;margin-top:14px}
.ip-go{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:8px;background:#19C6B4;color:#0A1B33;border:0;border-radius:14px;padding:13px 16px;
  font:600 16px "IBM Plex Sans Hebrew",system-ui,sans-serif;cursor:pointer;text-decoration:none;position:relative;overflow:hidden}
.ip-go::after{content:"";position:absolute;top:0;bottom:0;left:0;width:35%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.6),transparent);transform:translateX(-150%) skewX(-20deg);animation:ipsweep 3s ease-in-out 1s infinite}
@keyframes ipsweep{60%,100%{transform:translateX(420%) skewX(-20deg)}}
.ip-go svg{width:18px;height:18px}
.ip-later{background:transparent;color:#fff;border:1px solid rgba(169,184,206,.3);border-radius:14px;padding:13px 14px;font:500 15px "IBM Plex Sans Hebrew",system-ui,sans-serif;cursor:pointer}
.ip-steps{margin:12px 0 0;padding:12px 14px;background:rgba(255,255,255,.06);border-radius:14px;font-size:15px;line-height:1.5;list-style:none;display:grid;gap:8px;counter-reset:ip}
.ip-steps li{display:flex;gap:10px;align-items:center;counter-increment:ip}
.ip-steps li::before{content:counter(ip);width:22px;height:22px;border-radius:50%;background:#19C6B4;color:#0A1B33;font-weight:700;font-size:13px;display:grid;place-items:center;flex:none}
.ip-k{display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,.12);border-radius:7px;padding:0 7px;font-weight:600;white-space:nowrap}
.ip-k svg{width:16px;height:16px}
.ip [hidden]{display:none!important}
@media (prefers-reduced-motion:reduce){.ip,.ip-ic,.ip-go::after{animation:none!important;transition:none!important}}
`;
}

const SHARE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';

export function installPromptHtml(): string {
  return `<div class="ip" id="ip" role="dialog" aria-labelledby="ip-t" aria-describedby="ip-s" hidden>
  <div class="ip-h">
    <img class="ip-ic" src="/app/icon-192.png" alt="" width="52" height="52">
    <div><p class="ip-t" id="ip-t">התקינו את Groupush בטלפון</p><p class="ip-s" id="ip-s">פותחים בלחיצה ממסך הבית, ומקבלים התראה מיד כשמשהו קורה.</p></div>
    <button class="ip-x" id="ip-x" type="button" aria-label="סגירה">×</button>
  </div>
  <ol class="ip-steps" id="ip-ios" hidden>
    <li><span>לוחצים על <span class="ip-k">${SHARE_ICON}שיתוף</span> בתחתית המסך</span></li>
    <li><span>בוחרים <span class="ip-k">הוספה למסך הבית</span> ואז <span class="ip-k">הוספה</span></span></li>
  </ol>
  <p class="ip-s" id="ip-inapp" hidden>כדי להתקין צריך לפתוח את הדף בדפדפן עצמו, לא מתוך WhatsApp.</p>
  <div class="ip-row">
    <button class="ip-go" id="ip-go" type="button">${DOWNLOAD_ICON}<span id="ip-go-t">התקנת האפליקציה</span></button>
    <button class="ip-later" id="ip-later" type="button">לא עכשיו</button>
  </div>
</div>`;
}

/**
 * @param delayMs how long after the page opens the card slides in.
 * Any element with data-install="1" on the page also starts the install when clicked.
 */
export function installPromptJs(delayMs: number): string {
  return `
(function(){
  'use strict';
  var ua=navigator.userAgent||'';
  var standalone=(window.matchMedia&&matchMedia('(display-mode: standalone)').matches)||navigator.standalone===true;
  var ios=/iPhone|iPad|iPod/.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  var android=/Android/.test(ua);
  var inApp=/FBAN|FBAV|Instagram|WhatsApp|Line\\/|; wv\\)/.test(ua)||(ios&&!/Safari\\//.test(ua));
  var KEY='push-install-later',deferred=null;
  var ip=document.getElementById('ip');if(!ip||window.PUSH_NO_INSTALL)return;
  var go=document.getElementById('ip-go'),goT=document.getElementById('ip-go-t'),steps=document.getElementById('ip-ios'),inappNote=document.getElementById('ip-inapp');
  function laterThisVisit(){try{return sessionStorage.getItem(KEY)==='1'}catch(e){return false}}
  function hide(){ip.classList.remove('on');setTimeout(function(){ip.hidden=true},400)}
  function show(){if(standalone)return;ip.hidden=false;requestAnimationFrame(function(){requestAnimationFrame(function(){ip.classList.add('on')})})}
  if(!ios&&!android&&!inApp){document.getElementById('ip-t').textContent='התקינו את Groupush במחשב';document.getElementById('ip-s').textContent='נפתחת בחלון משלה, בלי לחפש את הלשונית בדפדפן.'}
  if(inApp){inappNote.hidden=false;goT.textContent=android?'פתיחה ב‑Chrome':'איך פותחים בדפדפן'}
  else if(ios){steps.hidden=false;goT.textContent='הבנתי, מוסיפים'}
  window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();deferred=e;goT.textContent='התקנת האפליקציה'});
  window.addEventListener('appinstalled',function(){deferred=null;hide();standalone=true});
  function install(){
    if(deferred){var d=deferred;deferred=null;d.prompt();d.userChoice.then(function(c){if(c&&c.outcome==='accepted')hide()}).catch(function(){});return}
    if(inApp&&android){location.href='intent://'+location.host+location.pathname+'#Intent;scheme=https;package=com.android.chrome;end';return}
    if(ios&&!inApp){if(!ip.classList.contains('on'))show();else hide();return}
    location.href='/app/install';
  }
  go.addEventListener('click',install);
  document.getElementById('ip-later').addEventListener('click',function(){try{sessionStorage.setItem(KEY,'1')}catch(e){}hide()});
  document.getElementById('ip-x').addEventListener('click',function(){try{sessionStorage.setItem(KEY,'1')}catch(e){}hide()});
  [].forEach.call(document.querySelectorAll('[data-install]'),function(el){
    if(standalone){el.hidden=true;return}
    el.addEventListener('click',function(ev){ev.preventDefault();if(deferred||(inApp&&android))install();else show()});
  });
  if(!standalone&&!laterThisVisit())setTimeout(show,${Math.max(0, Math.round(delayMs))});
})();
`;
}
