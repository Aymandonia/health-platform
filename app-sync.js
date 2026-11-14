'use strict';
const API_BASE=(window.HEALTH_API_URL||'').replace(/\/$/,'');
let sessionToken=localStorage.getItem('healthSession')||sessionStorage.getItem('healthSession')||'';
if(sessionToken){localStorage.setItem('healthSession',sessionToken);sessionStorage.removeItem('healthSession')}
let refreshSequence=0;
const loginScreen=document.getElementById('loginScreen');
const loginError=document.getElementById('loginError');
function setLoggedOut(message=''){
  sessionToken='';localStorage.removeItem('healthSession');sessionStorage.removeItem('healthSession');currentUser=null;custom=[];visitRecords=[];applyCatalog([]);catalogReady=false;render();
  document.querySelectorAll('.admin-only').forEach(el=>el.hidden=true);
  document.getElementById('logoutBtn').hidden=true;
  loginScreen.hidden=false;loginError.textContent=message;document.getElementById('loginPassword').value='';
}
async function api(path,options={}){
  if(!API_BASE||API_BASE.includes('YOUR-RENDER-SERVICE'))throw Error('اضبط رابط خادم Render في ملف config.js أولاً.');
  let response;
  try{response=await fetch(API_BASE+path,{...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(sessionToken?{'Authorization':'Bearer '+sessionToken}:{}),...(options.headers||{})}})}
  catch(e){throw Error('تعذر الاتصال بالخادم. تحقق من الإنترنت ورابط الخادم وحاول مجدداً.')}
  if(response.status===401 && path!=='/api/login'){setLoggedOut('انتهت الجلسة، يرجى تسجيل الدخول مجدداً.');throw Error('انتهت الجلسة')}
  if(!response.ok){let data;try{data=await response.json()}catch(e){};throw Error(typeof data?.detail==='string'?data.detail:'تعذر إتمام العملية. تحقق من البيانات وحاول مجدداً.')}
  return response.status===204?null:response.json();
}
function showAccount(){
  const isAdmin=currentUser.role==='admin';
  document.querySelectorAll('.admin-only').forEach(el=>el.hidden=!isAdmin);
  document.getElementById('logoutBtn').hidden=false;
  loginScreen.hidden=true;loginError.textContent='';restoreCurrentSection();
}
async function refreshData(){
  if(!currentUser)return;
  const sequence=++refreshSequence;
  try{const [visits,info,catalog]=await Promise.all([api('/api/visits'),api('/api/information'),api('/api/catalog')]);if(sequence!==refreshSequence||!currentUser)return;visitRecords=visits;custom=info;applyCatalog(catalog);renderRecords();render();document.getElementById('syncStatus').textContent='تمت المزامنة';document.getElementById('syncStatus').classList.remove('sync-error')}
  catch(e){document.getElementById('syncStatus').textContent='تعذرت المزامنة؛ تحقق من الاتصال.';document.getElementById('syncStatus').classList.add('sync-error');throw e}
}
async function loadUsers(){
  if(!currentUser||currentUser.role!=='admin')return;
  const users=await api('/api/admin/users');
  document.getElementById('usersList').innerHTML=users.map(u=>`<div class="admin-user"><div><b>${esc(u.name)}</b><div class="sync-status">${u.role==='admin'?'أدمن':u.active?'مفعّل':'موقوف'}${u.locked_until>Date.now()/1000?' · مقفل مؤقتاً':''}</div></div>${u.role==='user'?`<div class="admin-user-actions"><button data-reset="${esc(u.id)}">تغيير الرمز</button><button data-active="${esc(u.id)}" data-next="${u.active?'0':'1'}">${u.active?'إيقاف':'تفعيل'}</button></div>`:''}</div>`).join('');
}
document.getElementById('loginForm').addEventListener('submit',async e=>{
  e.preventDefault();loginError.textContent='';const button=e.currentTarget.querySelector('button');button.disabled=true;
  try{const data=await api('/api/login',{method:'POST',body:JSON.stringify({name:document.getElementById('loginName').value,password:document.getElementById('loginPassword').value})});sessionToken=data.token;localStorage.setItem('healthSession',sessionToken);sessionStorage.removeItem('healthSession');currentUser=data.user;document.getElementById('loginPassword').value='';showAccount();await refreshData()}
  catch(err){loginError.textContent=err.message;if(currentUser)alert(err.message)}finally{button.disabled=false}
});
document.getElementById('logoutBtn').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST'});setLoggedOut();displaySection('dashboard')}catch(e){if(sessionToken)alert('تعذر تسجيل الخروج من الخادم. تحقق من الاتصال وحاول مجدداً.')}});
document.getElementById('userForm').addEventListener('submit',async e=>{e.preventDefault();const msg=document.getElementById('userMessage');try{await api('/api/admin/users',{method:'POST',body:JSON.stringify({name:userName.value,pin:userPin.value})});e.target.reset();msg.textContent='تمت إضافة المستخدم.';await loadUsers()}catch(err){msg.textContent=err.message}});
document.getElementById('usersList').addEventListener('click',async e=>{const target=e.target;try{if(target.dataset.reset){const pin=prompt('أدخل الرمز الجديد من أربعة أرقام');if(pin===null)return;if(!/^[0-9]{4}$/.test(pin))throw Error('أدخل أربعة أرقام.');await api('/api/admin/users/'+encodeURIComponent(target.dataset.reset),{method:'PATCH',body:JSON.stringify({pin})})}else if(target.dataset.active){await api('/api/admin/users/'+encodeURIComponent(target.dataset.active),{method:'PATCH',body:JSON.stringify({active:target.dataset.next==='1'})})}else return;await loadUsers()}catch(err){alert(err.message)}});
document.querySelector('#tabs [data-tab=records]').addEventListener('click',()=>{if(currentUser)refreshData().catch(()=>{})});
document.querySelector('#tabs [data-tab=backup]').addEventListener('click',()=>{if(currentUser?.role==='admin')loadUsers().catch(e=>alert(e.message))});
document.getElementById('exportBtn').addEventListener('click',async()=>{try{const [visitRecords,customInformation,catalogEdits]=await Promise.all([api('/api/visits'),api('/api/information'),api('/api/catalog')]);const blob=new Blob([JSON.stringify({app:'نظام الرقابة الصحية',exportedAt:new Date().toISOString(),visitRecords,customInformation,catalogEdits,version:5},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='نسخة-احتياطية-الرقابة-الصحية.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch(e){alert(e.message)}});
document.getElementById('importFile').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;try{if(file.size>5*1024*1024)throw Error('حجم الملف يتجاوز 5 ميغابايت.');const d=JSON.parse(await file.text());if(!Array.isArray(d.visitRecords)&&!Array.isArray(d.customInformation)&&!Array.isArray(d.catalogEdits))throw Error('صيغة النسخة غير صحيحة.');if(!confirm('سيتم دمج البيانات، وقد تتكرر الزيارات والمعلومات. تعديلات البطاقات الموجودة حالياً لن تُستبدل. متابعة؟'))return;const out=await api('/api/admin/import',{method:'POST',body:JSON.stringify({visitRecords:d.visitRecords||[],customInformation:d.customInformation||[],catalogEdits:d.catalogEdits||[]})});await refreshData();alert('اكتمل الاستيراد: '+out.visits+' زيارة و'+out.information+' معلومة و'+out.catalogImported+' تعديل بطاقة. تم تجاوز '+out.catalogSkipped+' بطاقة موجودة.')}catch(err){alert(err.message||'تعذر استيراد الملف.')}finally{e.target.value=''}});
const status=document.createElement('p');status.id='syncStatus';status.className='sync-status';document.querySelector('.visits-heading>div').append(status);
let restoreInFlight=false;
async function restoreSession(){
 if(!sessionToken||currentUser||restoreInFlight)return;
 restoreInFlight=true;const previousToken=sessionToken;
 try{const user=await api('/api/me');if(sessionToken!==previousToken)return;currentUser=user;showAccount();await refreshData()}
 catch(e){if(sessionToken===previousToken&&!currentUser)loginError.textContent='تعذر الاتصال للتحقق من الجلسة. ستُعاد المحاولة تلقائياً.'}
 finally{restoreInFlight=false}
}
if(sessionToken){loginError.textContent='جارٍ التحقق من تسجيل الدخول...';restoreSession()}else setLoggedOut();
setInterval(()=>{if(document.visibilityState==='visible'){if(currentUser)refreshData().catch(()=>{});else if(sessionToken)restoreSession()}},30000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){if(currentUser)refreshData().catch(()=>{});else if(sessionToken)restoreSession()}});


document.getElementById('adminProfileForm').addEventListener('submit',async e=>{
  e.preventDefault();const message=document.getElementById('adminProfileMessage');message.textContent='';
  const name=document.getElementById('adminNewName').value.trim();const password=document.getElementById('adminNewPassword').value;const confirmPassword=document.getElementById('adminConfirmPassword').value;
  if(!name&&!password){message.textContent='أدخل اسماً أو كلمة مرور جديدة.';return}
  if(name&&name.split(/\s+/).length<3){message.textContent='أدخل الاسم الثلاثي.';return}
  if(password&&password.length<16){message.textContent='كلمة المرور الجديدة لا تقل عن 16 حرفاً.';return}
  if(password!==confirmPassword){message.textContent='تأكيد كلمة المرور غير مطابق.';return}
  const payload={current_password:document.getElementById('adminCurrentPassword').value};if(name)payload.name=name;if(password)payload.password=password;
  const button=e.currentTarget.querySelector('button');button.disabled=true;
  try{await api('/api/admin/profile',{method:'PATCH',body:JSON.stringify(payload)});e.target.reset();if(name)document.getElementById('loginName').value=name;displaySection('dashboard');setLoggedOut('تم تغيير بيانات الأدمن. سجّل الدخول بالبيانات الجديدة.')}catch(err){message.textContent=err.message}finally{button.disabled=false}
});
