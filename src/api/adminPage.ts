/**
 * The management panel (/admin) for the PUSH owner: first-time setup, sign-in
 * with password + authenticator code, customers (list, details, plan,
 * suspend, remove, add). Talks only to /admin/v1/*. Same CSP rules as the app:
 * no inline styles or handlers, no innerHTML.
 */
import { fontFaceCss } from './fonts.js';

export function adminHtml(nonce: string): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>PUSH — ניהול</title>
<style nonce="${nonce}">
${fontFaceCss()}
:root{--ink:#0A1B33;--navy:#12305C;--teal:#19C6B4;--teal-deep:#0B8A7E;--teal-mist:#E3F8F5;--bg:#F3F6FA;--card:#fff;--text:#0A1B33;--muted:#5E6E86;--line:#E1E8F0;--soft:#F7F9FC;
  --ok:#0F9F6E;--ok-soft:#E3F7EF;--bad:#D63B3B;--bad-soft:#FCE9E9;--warn:#B7791F;--warn-soft:#FDF3E1;
  --display:"Secular One","IBM Plex Sans Hebrew",system-ui,sans-serif;--body:"IBM Plex Sans Hebrew",system-ui,sans-serif}
*{box-sizing:border-box}
body{margin:0;font-family:var(--body);background:var(--bg);color:var(--text);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:var(--display);font-weight:400;margin:0;line-height:1.2}
button,input,select{font:inherit}
:focus-visible{outline:3px solid var(--teal);outline-offset:2px;border-radius:6px}
.top{background:var(--ink);color:#fff;padding:14px 28px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:5}
.logo{font-family:var(--display);font-size:24px;display:flex;align-items:center;gap:10px}
.logo i{width:10px;height:10px;border-radius:50%;background:var(--teal);box-shadow:0 0 0 5px rgba(25,198,180,.22)}
.logo small{font-family:var(--body);font-size:13px;color:rgba(255,255,255,.65);margin-inline-start:6px}
.top button{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:9px;padding:6px 12px;cursor:pointer}
main{max-width:1200px;margin:0 auto;padding:28px 24px 80px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px}
.auth{max-width:420px;margin:60px auto}.auth h1{font-size:30px}.auth .sub{color:var(--muted);margin:6px 0 22px}
label.f{display:block;margin-bottom:14px}label.f span{display:block;font-size:13px;font-weight:600;margin-bottom:6px}
.i{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:11px;background:var(--soft);color:var(--text)}
.i:focus{outline:none;border-color:var(--teal);box-shadow:0 0 0 3px rgba(25,198,180,.2)}
.btn{border:0;border-radius:11px;padding:11px 18px;font-weight:600;cursor:pointer}
.btn-primary{background:var(--teal);color:var(--ink)}.btn-dark{background:var(--ink);color:#fff}.btn-ghost{background:transparent;border:1px solid var(--line);color:var(--text)}
.btn-danger{background:var(--bad-soft);color:var(--bad)}.btn-sm{padding:7px 12px;font-size:13px}.btn-block{width:100%}
.btn:disabled{opacity:.55;cursor:default}
.err{color:var(--bad);font-size:14px;min-height:1.4em;margin-top:8px}.ok{color:var(--ok);font-weight:600}
.hint{font-size:13px;color:var(--muted)}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px}
.kpi .v{font-family:var(--display);font-size:32px;line-height:1.1}.kpi .k{color:var(--muted);font-size:13px}
@media (max-width:760px){.kpis{grid-template-columns:1fr 1fr}}
.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}.bar .i{max-width:320px}.bar h2{font-size:24px;margin-inline-end:auto}
.tablewrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:right;font-size:12px;color:var(--muted);font-weight:600;padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:11px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
tbody tr{cursor:pointer}tbody tr:hover{background:var(--soft)}
.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:600}
.pill.ok{background:var(--ok-soft);color:var(--ok)}.pill.bad{background:var(--bad-soft);color:var(--bad)}.pill.mute{background:var(--soft);color:var(--muted);border:1px solid var(--line)}
.ltr{direction:ltr;unicode-bidi:isolate}
.drawer{position:fixed;inset:0;background:rgba(10,27,51,.45);display:flex;justify-content:flex-start;z-index:10}
.drawer>div{background:var(--bg);width:min(560px,100%);height:100%;overflow-y:auto;padding:24px;box-shadow:0 0 40px rgba(0,0,0,.25)}
.drawer h2{font-size:26px}.drawer .close{float:left}
.sec{margin-top:18px}.sec h3{font-size:17px;margin-bottom:8px}
.rows{display:flex;flex-direction:column;gap:6px;font-size:14px}.rows div{display:flex;justify-content:space-between;gap:10px;border-bottom:1px dashed var(--line);padding-bottom:6px}
.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.danger{border:1px solid rgba(214,59,59,.3);background:var(--bad-soft);border-radius:14px;padding:14px;margin-top:20px}
.danger h3{color:var(--bad)}
.qr{width:220px;height:220px;display:block;margin:10px auto}
.secret{font-family:ui-monospace,monospace;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:6px 10px;display:inline-block;direction:ltr;word-break:break-all}
.steps{padding-inline-start:20px;margin:6px 0 14px}.steps li{margin-bottom:6px}
.temp{background:var(--ok-soft);border-radius:12px;padding:14px;margin-top:12px}.temp b{font-family:ui-monospace,monospace;direction:ltr;display:inline-block}
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
(function(){
'use strict';
var root=document.getElementById('root');
function h(tag,attrs,kids){var e=document.createElement(tag);if(attrs)for(var k in attrs){var v=attrs[k];if(v==null||v===false)continue;if(k==='text')e.textContent=v;else if(k==='cls')e.className=v;else if(k.slice(0,2)==='on')e.addEventListener(k.slice(2),v);else e.setAttribute(k,v===true?'':v)}
  (kids||[]).forEach(function(c){if(c!=null&&c!==false)e.appendChild(typeof c==='string'?document.createTextNode(c):c)});return e}
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
function fmtDate(d){if(!d)return '—';try{return new Date(d).toLocaleString('he-IL',{day:'numeric',month:'numeric',year:'2-digit',hour:'2-digit',minute:'2-digit'})}catch(e){return '—'}}
function qrSvg(rows){var n=rows.length,q=3,d='';rows.forEach(function(r,y){for(var x=0;x<n;x++)if(r.charCodeAt(x)===49){var run=1;while(x+run<n&&r.charCodeAt(x+run)===49)run++;d+='M'+(x+q)+' '+(y+q)+'h'+run+'v1h-'+run+'z';x+=run-1}});
  return s('svg',{'class':'qr',viewBox:'0 0 '+(n+2*q)+' '+(n+2*q),role:'img','aria-label':'קוד לסריקה באפליקציית אימות','shape-rendering':'crispEdges'},[s('rect',{width:n+2*q,height:n+2*q,fill:'#fff'}),s('path',{d:d,fill:'#0A1B33'})])}
function shell(content,withLogout){
  root.replaceChildren(h('div',null,[h('div',{cls:'top'},[h('div',{cls:'logo'},[h('i'),'PUSH',h('small',{text:'ניהול'})]),
    withLogout?h('button',{type:'button',text:'יציאה',onclick:function(){setTok(null);showLogin()}}):null]),h('main',null,[content])]));
}

// ---------------- first-time setup
function showSetup(){
  var code=h('input',{cls:'i',type:'password',autocomplete:'off',dir:'ltr'}),email=h('input',{cls:'i',type:'email',dir:'ltr',autocomplete:'username'});
  var pw=h('input',{cls:'i',type:'password',dir:'ltr',autocomplete:'new-password'}),totp=h('input',{cls:'i',inputmode:'numeric',maxlength:'6',dir:'ltr',autocomplete:'one-time-code'});
  var err=h('p',{cls:'err',role:'alert'}),step2=h('div',{hidden:true}),secret=null;
  var next=h('button',{cls:'btn btn-primary btn-block',type:'button',text:'המשך',onclick:async function(){
    err.textContent='';next.disabled=true;
    try{var r=await api('POST','/admin/v1/setup/secret',{code:code.value,email:email.value});secret=r.secret;
      step2.replaceChildren(h('ol',{cls:'steps'},[h('li',{text:'התקינו בטלפון אפליקציית אימות (Google Authenticator או Microsoft Authenticator).'}),h('li',{text:'באפליקציה: הוספת חשבון ← סריקת קוד QR, וסרקו את הקוד:'})]),
        qrSvg(r.qrRows),h('p',{cls:'hint'},['אם אי אפשר לסרוק, הקלידו את המפתח: ',h('span',{cls:'secret',text:r.secret})]),
        h('label',{cls:'f'},[h('span',{text:'6 הספרות שמופיעות עכשיו באפליקציה'}),totp]),
        h('button',{cls:'btn btn-primary btn-block',type:'button',text:'יצירת המנהל',onclick:async function(){err.textContent='';this.disabled=true;var b=this;
          try{await api('POST','/admin/v1/setup',{code:code.value,email:email.value,password:pw.value,secret:secret,totp:totp.value});showLogin('המנהל נוצר. התחברו עם הסיסמה והקוד מהאפליקציה.')}catch(e){err.textContent=e.message;b.disabled=false}}}),err);
      step2.hidden=false;next.hidden=true;}
    catch(e){err.textContent=e.message;next.disabled=false}}});
  shell(h('div',{cls:'panel auth'},[h('h1',{text:'הגדרה ראשונה'}),h('p',{cls:'sub',text:'יוצרים את חשבון המנהל הראשי. זה קורה פעם אחת בלבד.'}),
    h('label',{cls:'f'},[h('span',{text:'קוד הגדרה (קיבלתם אותו בנפרד)'}),code]),h('label',{cls:'f'},[h('span',{text:'אימייל המנהל'}),email]),
    h('label',{cls:'f'},[h('span',{text:'סיסמה (לפחות 12 תווים)'}),pw]),next,step2,err]));
}

// ---------------- sign in
function showLogin(msg){
  var email=h('input',{cls:'i',type:'email',dir:'ltr',autocomplete:'username'}),pw=h('input',{cls:'i',type:'password',dir:'ltr',autocomplete:'current-password'});
  var code=h('input',{cls:'i',inputmode:'numeric',maxlength:'6',dir:'ltr',autocomplete:'one-time-code'});
  var err=h('p',{cls:'err',role:'alert',text:msg||''});
  var go=h('button',{cls:'btn btn-primary btn-block',type:'submit',text:'כניסה'});
  shell(h('form',{cls:'panel auth',novalidate:true,onsubmit:async function(e){e.preventDefault();err.textContent='';go.disabled=true;
      try{var r=await api('POST','/admin/v1/login',{email:email.value,password:pw.value,code:code.value});setTok(r.token);showHome()}catch(x){err.textContent=x.message==='bad credentials'?'האימייל, הסיסמה או הקוד שגויים':x.message;go.disabled=false}}},
    [h('h1',{text:'כניסת מנהל'}),h('p',{cls:'sub',text:'אימייל, סיסמה וקוד מאפליקציית האימות.'}),h('label',{cls:'f'},[h('span',{text:'אימייל'}),email]),
     h('label',{cls:'f'},[h('span',{text:'סיסמה'}),pw]),h('label',{cls:'f'},[h('span',{text:'קוד מהאפליקציה (6 ספרות)'}),code]),go,err]));
}

// ---------------- home: numbers + customers
var PLANS=[];
async function showHome(){
  var list=h('tbody'),kpis=h('div',{cls:'kpis'}),q=h('input',{cls:'i',type:'search',placeholder:'חיפוש לפי שם או אימייל…','aria-label':'חיפוש לקוח'});
  var addBtn=h('button',{cls:'btn btn-primary',type:'button',text:'הוספת לקוח',onclick:addCustomer});
  shell(h('div',null,[kpis,h('section',{cls:'panel'},[h('div',{cls:'bar'},[h('h2',{text:'לקוחות'}),q,addBtn]),
    h('div',{cls:'tablewrap'},[h('table',null,[h('thead',null,[h('tr',null,['עסק','אימייל','מסלול','מצב','מספרים','נשלחו ב‑24 שעות','כניסה אחרונה','הצטרף'].map(function(t){return h('th',{text:t})}))]),list])])])]),true);
  try{var d=await api('GET','/admin/v1/dashboard');PLANS=await api('GET','/admin/v1/plans');
    var sum=function(o){return Object.keys(o||{}).reduce(function(a,k){return a+o[k]},0)};
    var kpi=function(v,k){return h('div',{cls:'kpi'},[h('div',{cls:'v',text:String(v)}),h('div',{cls:'k',text:k})])};
    kpis.replaceChildren(kpi((d.tenants&&d.tenants.active)||0,'לקוחות פעילים'),kpi((d.whatsappNumbers&&d.whatsappNumbers.connected)||0,'מספרים מחוברים'),
      kpi((d.jobsLast24h&&d.jobsLast24h.sent)||0,'הודעות נשלחו ב‑24 שעות'),kpi((d.tenants&&d.tenants.suspended)||0,'מושעים'));
  }catch(e){kpis.replaceChildren(h('p',{cls:'err',text:e.message}))}
  var load=async function(){
    try{var rows=await api('GET','/admin/v1/tenants?q='+encodeURIComponent(q.value.trim()));
      list.replaceChildren.apply(list,rows.length?rows.map(function(t){
        var plan=(PLANS.find(function(p){return p.code===t.plan_code})||{name:t.plan_code}).name;
        return h('tr',{tabindex:'0',onclick:function(){openCustomer(t.id,load)},onkeydown:function(e){if(e.key==='Enter')openCustomer(t.id,load)}},[
          h('td',null,[h('b',{text:t.name})]),h('td',{cls:'ltr',text:t.owner_email||'—'}),h('td',{text:plan}),
          h('td',null,[h('span',{cls:'pill '+(t.status==='active'?'ok':'bad'),text:t.status==='active'?'פעיל':'מושעה'})]),
          h('td',{text:(t.connected||0)+' / '+(t.numbers||0)}),h('td',{text:String(t.sent_24h||0)}),h('td',{text:fmtDate(t.last_login_at)}),h('td',{text:fmtDate(t.created_at)})])
      }):[h('tr',null,[h('td',{colspan:'8',cls:'hint',text:'אין לקוחות'})])]);
    }catch(e){list.replaceChildren(h('tr',null,[h('td',{colspan:'8',cls:'err',text:e.message})]))}
  };
  var timer;q.addEventListener('input',function(){clearTimeout(timer);timer=setTimeout(load,250)});
  load();
}

// ---------------- one customer
async function openCustomer(id,reload){
  var box=h('div'),wrap=h('div',{cls:'drawer',onclick:function(e){if(e.target===wrap)close()}},[box]);
  var close=function(){wrap.remove();document.removeEventListener('keydown',esc)};
  var esc=function(e){if(e.key==='Escape')close()};document.addEventListener('keydown',esc);
  document.body.appendChild(wrap);box.replaceChildren(h('p',{cls:'hint',text:'טוען…'}));
  var d;try{d=await api('GET','/admin/v1/tenants/'+id)}catch(e){box.replaceChildren(h('p',{cls:'err',text:e.message}));return}
  var t=d.tenant,msg=h('p',{cls:'err',role:'status'});
  var sent=0,failed=0;(d.jobs7d||[]).forEach(function(j){if(j.status==='sent')sent+=j.n;if(j.status==='failed')failed+=j.n});
  var plan=h('select',{cls:'i'},PLANS.map(function(p){return h('option',{value:p.code,text:p.name+(p.price_agorot?' · '+(p.price_agorot/100)+' ₪':'')})}));plan.value=t.plan_code;
  var savePlan=h('button',{cls:'btn btn-dark',type:'button',text:'שמירת מסלול',onclick:async function(){savePlan.disabled=true;try{await api('POST','/admin/v1/tenants/'+id,{plan:plan.value});msg.className='ok';msg.textContent='המסלול עודכן';reload()}catch(e){msg.className='err';msg.textContent=e.message}savePlan.disabled=false}});
  var active=t.status==='active';
  var toggle=h('button',{cls:'btn '+(active?'btn-ghost':'btn-primary'),type:'button',text:active?'השעיית הלקוח':'החזרה לפעילות',onclick:async function(){toggle.disabled=true;
    try{await api('POST','/admin/v1/tenants/'+id,{status:active?'suspended':'active'});close();reload();openCustomer(id,reload)}catch(e){msg.className='err';msg.textContent=e.message;toggle.disabled=false}}});
  var confirmIn=h('input',{cls:'i',placeholder:t.name,'aria-label':'הקלידו את שם העסק לאישור'});
  var del=h('button',{cls:'btn btn-danger',type:'button',text:'הסרה מהמערכת',onclick:async function(){
    if(confirmIn.value.trim()!==t.name){msg.className='err';msg.textContent='כדי להסיר, הקלידו את שם העסק בדיוק';return}
    del.disabled=true;try{await api('DELETE','/admin/v1/tenants/'+id);close();reload()}catch(e){msg.className='err';msg.textContent=e.message;del.disabled=false}}});
  var row=function(k,v){return h('div',null,[h('span',{cls:'hint',text:k}),h('span',null,[v])])};
  box.replaceChildren(
    h('button',{cls:'btn btn-ghost btn-sm close',type:'button',text:'סגירה',onclick:close}),
    h('h2',{text:t.name}),h('p',{cls:'hint',text:'הצטרף '+fmtDate(t.created_at)}),
    h('div',{cls:'sec'},[h('h3',{text:'מצב'}),h('div',{cls:'rows'},[
      row('מצב',h('span',{cls:'pill '+(active?'ok':'bad'),text:active?'פעיל':'מושעה'})),
      row('אישר את הסבר הסיכונים',t.risk_accepted_at?fmtDate(t.risk_accepted_at):'לא'),
      row('נשלחו ב‑7 ימים',String(sent)+(failed?' · '+failed+' נכשלו':'')),
      row('קבוצות שליטה',String((d.routes||[]).length))])]),
    h('div',{cls:'sec'},[h('h3',{text:'משתמשים'}),h('div',{cls:'rows'},(d.users||[]).map(function(u){return row(u.role==='owner'?'בעלים':u.role,h('span',{cls:'ltr',text:u.email+' · '+fmtDate(u.last_login_at)}))}))]),
    h('div',{cls:'sec'},[h('h3',{text:'מספרי WhatsApp'}),h('div',{cls:'rows'},(d.whatsapp||[]).length?(d.whatsapp||[]).map(function(w){return row(w.phone_number?'+'+w.phone_number:'(לא חובר)',h('span',{cls:'pill '+(w.status==='connected'?'ok':'mute'),text:w.status==='connected'?'מחובר':w.status}))}):[h('p',{cls:'hint',text:'אין מספרים'})])]),
    (d.activeStops||[]).length?h('div',{cls:'sec'},[h('h3',{text:'עצירות פעילות'}),h('div',{cls:'rows'},d.activeStops.map(function(x){return row(x.scope,x.reason)}))]):'',
    h('div',{cls:'sec'},[h('h3',{text:'פעולות'}),h('div',{cls:'actions'},[h('label',{cls:'f'},[h('span',{text:'מסלול'}),plan]),savePlan,toggle]),msg]),
    h('div',{cls:'danger'},[h('h3',{text:'הסרה מהמערכת'}),h('p',{cls:'hint',text:'המספרים מתנתקים, הקבוצות וההיסטוריה נמחקות, והמשתמשים לא יוכלו להיכנס. אי אפשר לבטל.'}),
      h('label',{cls:'f'},[h('span',{text:'לאישור, הקלידו את שם העסק'}),confirmIn]),del]));
}

// ---------------- add a customer
function addCustomer(){
  var box=h('div'),wrap=h('div',{cls:'drawer',onclick:function(e){if(e.target===wrap)wrap.remove()}},[box]);document.body.appendChild(wrap);
  var name=h('input',{cls:'i'}),email=h('input',{cls:'i',type:'email',dir:'ltr'}),plan=h('select',{cls:'i'},PLANS.map(function(p){return h('option',{value:p.code,text:p.name})}));plan.value='trial';
  var err=h('p',{cls:'err',role:'alert'}),out=h('div');
  var go=h('button',{cls:'btn btn-primary',type:'button',text:'יצירת הלקוח',onclick:async function(){err.textContent='';go.disabled=true;
    try{var r=await api('POST','/admin/v1/tenants',{businessName:name.value,email:email.value,plan:plan.value});
      out.replaceChildren(h('div',{cls:'temp'},[h('p',{cls:'ok',text:'הלקוח נוצר.'}),h('p',null,['שלחו ללקוח: כתובת ',h('b',{text:location.origin+'/app'}),', אימייל ',h('b',{text:r.email}),' וסיסמה זמנית ',h('b',{text:r.temporaryPassword})]),
        h('p',{cls:'hint',text:'הסיסמה מוצגת עכשיו בלבד. כדאי שהלקוח יחליף אותה אחרי הכניסה הראשונה.'})]));go.hidden=true;showHome();}
    catch(e){err.textContent=e.message;go.disabled=false}}});
  box.replaceChildren(h('button',{cls:'btn btn-ghost btn-sm close',type:'button',text:'סגירה',onclick:function(){wrap.remove()}}),h('h2',{text:'הוספת לקוח'}),
    h('p',{cls:'hint',text:'לקוחות יכולים גם להירשם לבד באתר. כאן פותחים חשבון בשבילם.'}),h('div',{cls:'sec'},[
    h('label',{cls:'f'},[h('span',{text:'שם העסק'}),name]),h('label',{cls:'f'},[h('span',{text:'אימייל של הלקוח'}),email]),h('label',{cls:'f'},[h('span',{text:'מסלול'}),plan]),go,err,out]));
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
