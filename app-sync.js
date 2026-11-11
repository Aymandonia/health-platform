'use strict';
const API_BASE=(window.HEALTH_API_URL||'').replace(/\/$/,'');
let sessionToken=sessionStorage.getItem('healthSession')||'';
let refreshSequence=0;
const loginScreen=document.getElementById('loginScreen');
const loginError=document.getElementById('loginError');
function setLoggedOut(message=''){
  sessionToken='';sessionStorage.removeItem('healthSession');currentUser=null;custom=[];visitRecords=[];
  document.querySelectorAll('.admin-only').forEach(el=>el.hidden=true);
  document.getElementById('addBtn').hidden=true;document.getElementById('logoutBtn').hidden=true;
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
  document.getElementById('addBtn').hidden=!isAdmin;
  document.getElementById('logoutBtn').hidden=false;
  loginScreen.hidden=true;loginError.textContent='';
}
async function refreshData(){
  if(!currentUser)return;
  const sequence=++refreshSequence;
  try{const [visits,info]=await Promise.all([api('/api/visits'),api('/api/information')]);if(sequence!==refreshSequence||!currentUser)return;visitRecords=visits;custom=info;renderRecords();render();document.getElementById('syncStatus').textContent='تمت المزامنة';document.getElementById('syncStatus').classList.remove('sync-error')}
  catch(e){document.getElementById('syncStatus').textContent='تعذرت المزامنة؛ تحقق من الاتصال.';document.getElementById('syncStatus').classList.add('sync-error');throw e}
}
async function loadUsers(){
  if(!currentUser||currentUser.role!=='admin')return;
  const users=await api('/api/admin/users');
  document.getElementById('usersList').innerHTML=users.map(u=>`<div class="admin-user"><div><b>${esc(u.name)}</b><div class="sync-status">${u.role==='admin'?'أدمن':u.active?'مفعّل':'موقوف'}${u.locked_until>Date.now()/1000?' · مقفل مؤقتاً':''}</div></div>${u.role==='user'?`<div class="admin-user-actions"><button data-reset="${esc(u.id)}">تغيير الرمز</button><button data-active="${esc(u.id)}" data-next="${u.active?'0':'1'}">${u.active?'إيقاف':'تفعيل'}</button></div>`:''}</div>`).join('');
}
document.getElementById('loginForm').addEventListener('submit',async e=>{
  e.preventDefault();loginError.textContent='';const button=e.currentTarget.querySelector('button');button.disabled=true;
  try{const data=await api('/api/login',{method:'POST',body:JSON.stringify({name:document.getElementById('loginName').value,password:document.getElementById('loginPassword').value})});sessionToken=data.token;sessionStorage.setItem('healthSession',sessionToken);currentUser=data.user;document.getElementById('loginPassword').value='';showAccount();await refreshData()}
  catch(err){loginError.textContent=err.message;if(currentUser)alert(err.message)}finally{button.disabled=false}
});
document.getElementById('logoutBtn').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST'})}catch(e){}setLoggedOut();displaySection('dashboard')});
document.getElementById('userForm').addEventListener('submit',async e=>{e.preventDefault();const msg=document.getElementById('userMessage');try{await api('/api/admin/users',{method:'POST',body:JSON.stringify({name:userName.value,pin:userPin.value})});e.target.reset();msg.textContent='تمت إضافة المستخدم.';await loadUsers()}catch(err){msg.textContent=err.message}});
document.getElementById('usersList').addEventListener('click',async e=>{const target=e.target;try{if(target.dataset.reset){const pin=prompt('أدخل الرمز الجديد من أربعة أرقام');if(pin===null)return;if(!/^[0-9]{4}$/.test(pin))throw Error('أدخل أربعة أرقام.');await api('/api/admin/users/'+encodeURIComponent(target.dataset.reset),{method:'PATCH',body:JSON.stringify({pin})})}else if(target.dataset.active){await api('/api/admin/users/'+encodeURIComponent(target.dataset.active),{method:'PATCH',body:JSON.stringify({active:target.dataset.next==='1'})})}else return;await loadUsers()}catch(err){alert(err.message)}});
document.querySelector('#tabs [data-tab=records]').addEventListener('click',()=>{if(currentUser)refreshData().catch(()=>{})});
document.querySelector('#tabs [data-tab=backup]').addEventListener('click',()=>{if(currentUser?.role==='admin')loadUsers().catch(e=>alert(e.message))});
document.getElementById('exportBtn').addEventListener('click',async()=>{try{const [visitRecords,customInformation]=await Promise.all([api('/api/visits'),api('/api/information')]);const blob=new Blob([JSON.stringify({app:'نظام الرقابة الصحية',exportedAt:new Date().toISOString(),visitRecords,customInformation,version:4},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='نسخة-احتياطية-الرقابة-الصحية.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch(e){alert(e.message)}});
document.getElementById('importFile').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;try{if(file.size>5*1024*1024)throw Error('حجم الملف يتجاوز 5 ميغابايت.');const d=JSON.parse(await file.text());if(!Array.isArray(d.visitRecords)&&!Array.isArray(d.customInformation))throw Error('صيغة النسخة غير صحيحة.');if(!confirm('سيتم دمج البيانات مع البيانات الحالية وقد تتكرر إذا استوردت الملف سابقاً. متابعة؟'))return;const out=await api('/api/admin/import',{method:'POST',body:JSON.stringify({visitRecords:d.visitRecords||[],customInformation:d.customInformation||[]})});await refreshData();alert('اكتمل الاستيراد: '+out.visits+' زيارة و'+out.information+' معلومة.')}catch(err){alert(err.message||'تعذر استيراد الملف.')}finally{e.target.value=''}});
const status=document.createElement('p');status.id='syncStatus';status.className='sync-status';document.querySelector('.visits-heading>div').append(status);
(async()=>{if(!sessionToken){setLoggedOut();return}try{currentUser=await api('/api/me');showAccount();await refreshData()}catch(e){if(!currentUser)setLoggedOut(e.message)}})();
setInterval(()=>{if(currentUser&&document.visibilityState==='visible')refreshData().catch(()=>{})},30000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&currentUser)refreshData().catch(()=>{})});
