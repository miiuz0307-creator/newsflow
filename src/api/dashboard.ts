/**
 * The basic PUSH dashboard: one static page (Hebrew, RTL) served by the API.
 * It signs in with the customer's email and password, then shows recent
 * distributions, the status of every copy, edits and deletes, lets the
 * customer retry a failed copy, and shows what each platform supports.
 *
 * All text from the server is inserted with textContent (never innerHTML),
 * and the page runs under a strict Content-Security-Policy with a nonce.
 */
export function dashboardHtml(nonce: string): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PUSH — לוח בקרה</title>
<style nonce="${nonce}">
:root{--navy:#0b1f3a;--navy2:#13305a;--teal:#14b8a6;--teal-soft:#ccfbf1;--bg:#f4f7fb;--card:#fff;--ink:#0f172a;--muted:#5b6b82;--line:#e2e8f0;
--ok:#0f9d58;--ok-soft:#dcfce7;--bad:#c62828;--bad-soft:#fee2e2;--warn:#b45309;--warn-soft:#fef3c7;--info:#1d4ed8;--info-soft:#dbeafe;}
@media (prefers-color-scheme:dark){:root{--bg:#07111f;--card:#0e1d33;--ink:#e6edf7;--muted:#93a4bd;--line:#1e3354;--teal-soft:#0f3d3a;
--ok-soft:#0f3320;--bad-soft:#3b1414;--warn-soft:#3a2a0b;--info-soft:#13254a;}}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI","Noto Sans Hebrew",Arial,sans-serif;background:var(--bg);color:var(--ink);line-height:1.5}
header{background:linear-gradient(90deg,var(--navy),var(--navy2));color:#fff;padding:14px 20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.logo{font-weight:800;font-size:22px;letter-spacing:.06em}.logo span{color:var(--teal)}
.slogan{opacity:.8;font-size:14px}.spacer{flex:1}
header button{background:transparent;border:1px solid rgba(255,255,255,.35);color:#fff;border-radius:8px;padding:6px 12px;cursor:pointer}
main{max-width:1100px;margin:0 auto;padding:20px 16px 60px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card .k{color:var(--muted);font-size:13px}.card .v{font-size:26px;font-weight:700;margin-top:2px}
h2{font-size:18px;margin:26px 0 10px}
.dist{background:var(--card);border:1px solid var(--line);border-radius:12px;margin-bottom:10px;overflow:hidden}
.dist>button{all:unset;box-sizing:border-box;display:block;width:100%;padding:12px 16px;cursor:pointer}
.dist>button:focus-visible{outline:2px solid var(--teal)}
.row1{display:flex;gap:10px;align-items:center;flex-wrap:wrap;color:var(--muted);font-size:13px}
.preview{margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:4.5em;overflow:hidden}
@media (max-width:600px){.detail th:nth-child(2),.detail td:nth-child(2){display:none}}
.chip{display:inline-block;border-radius:999px;padding:1px 9px;font-size:12px;font-weight:600}
.ok{background:var(--ok-soft);color:var(--ok)}.bad{background:var(--bad-soft);color:var(--bad)}.warn{background:var(--warn-soft);color:var(--warn)}
.info{background:var(--info-soft);color:var(--info)}.mute{background:var(--line);color:var(--muted)}
.detail{border-top:1px solid var(--line);padding:12px 16px;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:right;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px}
.retry{background:var(--teal);color:#fff;border:0;border-radius:7px;padding:4px 10px;cursor:pointer;font-size:13px}
.retry.warnbtn{background:var(--warn)}
.login{max-width:380px;margin:60px auto;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:26px}
.login h1{margin:0 0 4px;font-size:22px}.login p{color:var(--muted);margin:0 0 18px}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font-size:15px}
.primary{width:100%;margin-top:18px;background:var(--teal);color:#fff;border:0;border-radius:9px;padding:11px;font-size:16px;font-weight:700;cursor:pointer}
.err{color:var(--bad);margin-top:10px;min-height:1.2em}
.empty{color:var(--muted);text-align:center;padding:30px;background:var(--card);border:1px dashed var(--line);border-radius:12px}
.small{font-size:12px;color:var(--muted)}
.versions{margin:8px 0 12px;padding:0;list-style:none}.versions li{margin:2px 0}
</style>
</head>
<body>
<header><div class="logo">PU<span>SH</span></div><div class="slogan">הודעה אחת. כל הקבוצות.</div><div class="spacer"></div>
<div id="who" class="slogan"></div><button id="logout" hidden>יציאה</button></header>
<main id="main"></main>
<script nonce="${nonce}">
(function(){
'use strict';
var store={get:function(k){try{return sessionStorage.getItem(k)}catch(e){return null}},set:function(k,v){try{sessionStorage.setItem(k,v)}catch(e){}},del:function(k){try{sessionStorage.removeItem(k)}catch(e){}}};
var mem={};
function tok(k){return mem[k]||store.get(k)}
function setTok(a,r){mem.at=a;mem.rt=r;store.set('at',a);store.set('rt',r)}
function clearTok(){mem={};store.del('at');store.del('rt')}
function h(tag,attrs,kids){var e=document.createElement(tag);if(attrs)for(var k in attrs){if(k==='text')e.textContent=attrs[k];else if(k==='cls')e.className=attrs[k];else if(k.slice(0,2)==='on')e.addEventListener(k.slice(2),attrs[k]);else e.setAttribute(k,attrs[k])}
(kids||[]).forEach(function(c){if(c!=null)e.appendChild(typeof c==='string'?document.createTextNode(c):c)});return e}
var main=document.getElementById('main');
async function api(method,path,body,retried){
  var res=await fetch(path,{method:method,headers:Object.assign({'content-type':'application/json'},tok('at')?{authorization:'Bearer '+tok('at')}:{}),body:body?JSON.stringify(body):undefined});
  if(res.status===401&&!retried&&tok('rt')){
    var r=await fetch('/v1/auth/refresh',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({refreshToken:tok('rt')})});
    if(r.ok){var j=await r.json();setTok(j.accessToken,j.refreshToken);return api(method,path,body,true)}
    clearTok();showLogin();throw new Error('יש להתחבר מחדש');
  }
  var data=await res.json().catch(function(){return {}});
  if(!res.ok)throw Object.assign(new Error((data.error&&data.error.message)||('שגיאה '+res.status)),{code:data.error&&data.error.code,status:res.status});
  return data;
}
var STATUS={sent:['נשלח','ok'],failed:['נכשל','bad'],unknown:['ממתין לאימות','warn'],queued:['בתור','info'],sending:['נשלח עכשיו','info'],
  pending_approval:['ממתין לאישור','info'],skipped:['דולג','mute'],cancelled:['בוטל','mute']};
var REASON={forbidden:'אין הרשאה לשלוח בקבוצה',not_found:'הקבוצה או ההודעה לא נמצאו',window_closed:'חלון הזמן של הפלטפורמה נסגר',
  rate_limited:'הפלטפורמה ביקשה להאט',transient:'תקלה זמנית',disconnected:'החיבור מנותק',account_blocked:'המספר חסום',invalid:'תוכן לא תקין',
  stale:'עבר יותר מדי זמן',source_deleted:'ההודעה נמחקה בקבוצת השליטה',superseded:'הוחלפה בעריכה חדשה',merged_into_send:'עודכן לפני השליחה',
  copy_not_sent:'העותק לא נשלח',copy_unknown:'מצב העותק לא ידוע',not_supported:'הפלטפורמה לא תומכת',unknown:'אין תשובה מהפלטפורמה',duplicate:'כפילות'};
function chip(st){var s=STATUS[st]||[st,'mute'];return h('span',{cls:'chip '+s[1],text:s[0]})}
function when(d){try{return new Date(d).toLocaleString('he-IL',{dateStyle:'short',timeStyle:'short'})}catch(e){return ''}}
var PL={wa:'WhatsApp',tg:'Telegram'};
function showLogin(msg){
  document.getElementById('logout').hidden=true;document.getElementById('who').textContent='';
  var err=h('div',{cls:'err',text:msg||''});var email=h('input',{type:'email',autocomplete:'username',required:''});var pw=h('input',{type:'password',autocomplete:'current-password',required:''});
  var form=h('form',{onsubmit:async function(e){e.preventDefault();err.textContent='';try{var r=await api('POST','/v1/auth/login',{email:email.value,password:pw.value});setTok(r.accessToken,r.refreshToken);start()}catch(x){err.textContent=x.message}}},
    [h('label',{text:'אימייל'}),email,h('label',{text:'סיסמה'}),pw,h('button',{cls:'primary',type:'submit',text:'כניסה'}),err]);
  main.replaceChildren(h('div',{cls:'login'},[h('h1',{text:'כניסה ל-PUSH'}),h('p',{text:'לוח הבקרה של ההפצות שלך'}),form]));
}
var open={};var timer;
async function start(){
  try{var me=await api('GET','/v1/me')}catch(e){return showLogin()}
  document.getElementById('who').textContent=me.tenant.name+' · '+me.tenant.plan.name;document.getElementById('logout').hidden=false;
  render();clearInterval(timer);timer=setInterval(render,10000);
}
async function render(){
  var dists,caps;
  try{dists=await api('GET','/v1/distributions?limit=50');caps=await api('GET','/v1/capabilities')}catch(e){return}
  var tot={d:dists.length,sent:0,all:0,unk:0,fail:0};
  dists.forEach(function(d){tot.sent+=d.copies.sent;tot.all+=d.copies.total-d.copies.cancelled;tot.unk+=d.copies.unknown;tot.fail+=d.copies.failed});
  var rate=tot.all?Math.round(100*tot.sent/tot.all)+'%':'—';
  var cards=h('div',{cls:'cards'},[card('הפצות (30 יום)',tot.d),card('עותקים שנשלחו',tot.sent),card('שיעור הצלחה',rate),card('נכשלו',tot.fail),card('ממתינים לאימות',tot.unk)]);
  var list=dists.length?h('div',null,dists.map(distView)):h('div',{cls:'empty',text:'עדיין אין הפצות. שלחו הודעה בקבוצת השליטה, והיא תופיע כאן.'});
  main.replaceChildren(cards,h('h2',{text:'הפצות אחרונות'}),list,h('h2',{text:'מה כל פלטפורמה תומכת'}),capsView(caps));
  for(var k in open){var el=document.getElementById('d-'+k);if(el)loadDetail(open[k],el)}
}
function card(k,v){return h('div',{cls:'card'},[h('div',{cls:'k',text:k}),h('div',{cls:'v',text:String(v)})])}
function keyOf(d){return encodeURIComponent(d.source.platform)+'/'+encodeURIComponent(d.source.accountId)+'/'+encodeURIComponent(d.source.chatId)+'/'+encodeURIComponent(d.messageId)}
function distView(d){
  var k=btoa(unescape(encodeURIComponent(keyOf(d)))).replace(/[^a-zA-Z0-9]/g,'');
  var chips=[h('span',{cls:'chip '+(d.copies.failed||d.copies.unknown?'warn':'ok'),text:'נשלח ל-'+d.copies.sent+' מתוך '+(d.copies.total-d.copies.cancelled)})];
  if(d.copies.pending)chips.push(h('span',{cls:'chip info',text:d.copies.pending+' בתור'}));
  if(d.copies.failed)chips.push(h('span',{cls:'chip bad',text:d.copies.failed+' נכשלו'}));
  if(d.copies.unknown)chips.push(h('span',{cls:'chip warn',text:d.copies.unknown+' ממתינים לאימות'}));
  if(d.version>1)chips.push(h('span',{cls:'chip info',text:'נערכה (גרסה '+d.version+')'}));
  if(d.deleted)chips.push(h('span',{cls:'chip mute',text:'נמחקה ('+d.deletes.sent+')'}));
  var box=h('div',{cls:'detail',id:'d-'+k});box.hidden=!open[k];
  var btn=h('button',{'aria-expanded':String(!!open[k]),onclick:function(){if(open[k]){delete open[k];box.hidden=true;btn.setAttribute('aria-expanded','false')}else{open[k]=keyOf(d);box.hidden=false;btn.setAttribute('aria-expanded','true');loadDetail(open[k],box)}}},
    [h('div',{cls:'row1'},[h('span',{text:when(d.createdAt)}),h('span',{text:'· '+(d.source.title||PL[d.source.platform]||'')}),h('span',null,chips)]),h('div',{cls:'preview',text:d.preview||'(מדיה)'})]);
  return h('div',{cls:'dist'},[btn,box]);
}
async function loadDetail(key,box){
  try{var r=await api('GET','/v1/distributions/'+key)}catch(e){box.replaceChildren(h('div',{cls:'err',text:e.message}));return}
  var vers=r.versions.length>1?h('ul',{cls:'versions'},r.versions.map(function(v){return h('li',{cls:'small',text:'גרסה '+v.version+' · '+when(v.at)+(v.text?' · '+v.text.slice(0,120):'')})})):null;
  var rows=r.copies.map(function(c){
    var act=null;
    if(r.deleted)act=null;
    else if(c.status==='failed')act=h('button',{cls:'retry',text:'נסו שוב',onclick:function(){retry(c.jobId,false,key,box)}});
    else if(c.status==='unknown')act=h('button',{cls:'retry warnbtn',text:'לא בקבוצה — שלחו שוב',title:'רק אחרי שבדקתם שההודעה לא הגיעה לקבוצה',onclick:function(){retry(c.jobId,true,key,box)}});
    var editCell=c.edit?h('span',null,[chip(c.edit.status),h('span',{cls:'small',text:' גרסה '+c.edit.version+(c.edit.error?' · '+(REASON[c.edit.error]||c.edit.error):'')})]):h('span',{cls:'small',text:'—'});
    var delCell=c.delete?h('span',null,[chip(c.delete.status),h('span',{cls:'small',text:c.delete.error?' '+(REASON[c.delete.error]||c.delete.error):''})]):h('span',{cls:'small',text:'—'});
    return h('tr',null,[h('td',{text:(c.target.title||c.target.chatId)}),h('td',{text:PL[c.target.platform]||c.target.platform}),
      h('td',null,[chip(c.status),c.error?h('div',{cls:'small',text:REASON[c.error]||c.error}):null]),h('td',null,[editCell]),h('td',null,[delCell]),h('td',null,[act])]);
  });
  box.replaceChildren.apply(box,[vers,h('table',null,[h('thead',null,[h('tr',null,['קבוצה','פלטפורמה','שליחה','עריכה','מחיקה',''].map(function(t){return h('th',{text:t})}))]),h('tbody',null,rows)])].filter(Boolean));
}
async function retry(id,confirmNotDelivered,key,box){
  try{await api('POST','/v1/jobs/'+id+'/retry',confirmNotDelivered?{confirmNotDelivered:true}:{});await loadDetail(key,box)}catch(e){alert(e.message)}
}
var CAPN={send:'שליחה',edit:'עריכה',editCaption:'עריכת כיתוב למדיה',delete:'מחיקה לכולם',receive:'קבלת הודעות',receiveEdits:'זיהוי עריכות',receiveDeletes:'זיהוי מחיקות',media:'מדיה',groupDiscovery:'רשימת קבוצות',deliveryStatus:'אישורי מסירה'};
var LV={verified:['נבדק','ok'],documented:['מתועד, טרם נבדק כאן','info'],untested:['דורש בדיקה','warn'],false:['לא נתמך','bad']};
function capsView(caps){
  var rows=Object.keys(CAPN).map(function(k){return h('tr',null,[h('td',{text:CAPN[k]})].concat(['wa','tg'].map(function(p){var l=LV[String(caps[p][k])]||[String(caps[p][k]),'mute'];return h('td',null,[h('span',{cls:'chip '+l[1],text:l[0]})])})))});
  var win=h('p',{cls:'small',text:'WhatsApp: עריכה עד 15 דקות מהשליחה, מחיקה לכולם עד כיומיים וחצי. Telegram: מחיקה עד 48 שעות; בוטים לא מקבלים הודעה על מחיקה, לכן בקבוצת שליטה בטלגרם עונים "מחק" על ההודעה.'});
  return h('div',{cls:'card'},[h('table',null,[h('thead',null,[h('tr',null,[h('th',{text:'יכולת'}),h('th',{text:'WhatsApp'}),h('th',{text:'Telegram'})])]),h('tbody',null,rows)]),win]);
}
document.getElementById('logout').addEventListener('click',async function(){try{await api('POST','/v1/auth/logout',{refreshToken:tok('rt')})}catch(e){}clearTok();clearInterval(timer);showLogin()});
if(tok('at'))start();else showLogin();
})();
</script>
</body>
</html>`;
}
