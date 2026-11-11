import os, re, secrets, hashlib, hmac, json, time
from datetime import datetime, timedelta, timezone
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Depends, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError

DATABASE_URL=os.environ.get('DATABASE_URL','')
PEPPER=os.environ.get('APP_PEPPER','')
ORIGIN=os.environ.get('ALLOWED_ORIGIN','')
if not DATABASE_URL or len(PEPPER)<32 or not ORIGIN: raise RuntimeError('DATABASE_URL, APP_PEPPER (32+ chars) and ALLOWED_ORIGIN are required')
if DATABASE_URL.startswith('postgres://'): DATABASE_URL='postgresql+psycopg://'+DATABASE_URL[len('postgres://'):]
elif DATABASE_URL.startswith('postgresql://'): DATABASE_URL='postgresql+psycopg://'+DATABASE_URL[len('postgresql://'):]
engine=create_engine(DATABASE_URL,pool_pre_ping=True)

def now(): return int(time.time())
def name_key(n): return ' '.join(n.split()).casefold()
def hash_password(password, salt=None):
    salt=salt or secrets.token_hex(16)
    value=hashlib.scrypt((password+PEPPER).encode(),salt=bytes.fromhex(salt),n=16384,r=8,p=1,dklen=32).hex()
    return salt+'$'+value
def verify_password(password, stored): return hmac.compare_digest(hash_password(password,stored.split('$')[0]),stored)
def init_db():
    with engine.begin() as c:
        c.execute(text('CREATE TABLE IF NOT EXISTS users (id VARCHAR(64) PRIMARY KEY, name VARCHAR(200) NOT NULL, name_key VARCHAR(200) NOT NULL UNIQUE, password_hash VARCHAR(200) NOT NULL, role VARCHAR(10) NOT NULL, active INTEGER NOT NULL DEFAULT 1, failures INTEGER NOT NULL DEFAULT 0, locked_until BIGINT NOT NULL DEFAULT 0)'))
        c.execute(text('CREATE TABLE IF NOT EXISTS sessions (token_hash VARCHAR(64) PRIMARY KEY, user_id VARCHAR(64) NOT NULL REFERENCES users(id), expires BIGINT NOT NULL)'))
        c.execute(text('CREATE TABLE IF NOT EXISTS visits (id VARCHAR(64) PRIMARY KEY, user_id VARCHAR(64) NOT NULL REFERENCES users(id), data TEXT NOT NULL, created_at BIGINT NOT NULL)'))
        c.execute(text('CREATE TABLE IF NOT EXISTS information (id VARCHAR(64) PRIMARY KEY, user_id VARCHAR(64) NOT NULL REFERENCES users(id), data TEXT NOT NULL, created_at BIGINT NOT NULL)'))
        if not c.execute(text("SELECT id FROM users WHERE role='admin' LIMIT 1")).first():
            name=os.environ.get('ADMIN_NAME','').strip(); password=os.environ.get('ADMIN_PASSWORD','')
            if len(name.split())<3 or len(password)<16: raise RuntimeError('Set ADMIN_NAME to a full name and ADMIN_PASSWORD to a strong password of at least 16 characters for initial setup')
            c.execute(text("INSERT INTO users (id,name,name_key,password_hash,role) VALUES (:id,:n,:k,:p,'admin')"),dict(id=secrets.token_hex(16),n=name,k=name_key(name),p=hash_password(password)))
@asynccontextmanager
async def lifespan(app): init_db(); yield
app=FastAPI(lifespan=lifespan,docs_url=None,redoc_url=None,openapi_url=None)
app.add_middleware(CORSMiddleware,allow_origins=[ORIGIN],allow_methods=['GET','POST','PATCH','DELETE'],allow_headers=['Authorization','Content-Type'])
class Login(BaseModel): name:str=Field(min_length=1,max_length=200); password:str=Field(min_length=1,max_length=256)
class UserCreate(BaseModel): name:str=Field(min_length=3,max_length=200); pin:str=Field(min_length=4,max_length=4)
class UserUpdate(BaseModel): pin:str|None=None; active:bool|None=None
class Visit(BaseModel):
    shop:str=Field(min_length=1,max_length=200); date:str=Field(min_length=1,max_length=30); visit:str=Field(max_length=100); status:str=Field(max_length=100)
    type:str=Field(default='',max_length=200); owner:str=Field(default='',max_length=200); address:str=Field(default='',max_length=500); notes:str=Field(default='',max_length=5000)
class Info(BaseModel): title:str=Field(min_length=1,max_length=200); category:str=Field(min_length=1,max_length=100); text:str=Field(min_length=1,max_length=5000)
# A process-level limit supplements the persistent per-account lock. No forwarded headers are trusted.
attempts={}
@app.post('/api/login')
def login(body:Login,request:Request):
    ip=request.client.host if request.client else 'unknown'; stamp=now(); recent=[t for t in attempts.get(ip,[]) if t>stamp-600]
    if len(recent)>=100: raise HTTPException(429,'محاولات كثيرة، حاول لاحقاً')
    recent.append(stamp); attempts[ip]=recent
    with engine.begin() as c:
        lock=' FOR UPDATE' if engine.dialect.name=='postgresql' else ''
        row=c.execute(text('SELECT * FROM users WHERE name_key=:k'+lock),{'k':name_key(body.name)}).mappings().first()
        if row and row['locked_until']>stamp: raise HTTPException(429,'الحساب مقفل مؤقتاً؛ تواصل مع المسؤول')
        valid=bool(row and row['active'] and verify_password(body.password,row['password_hash']))
        if not valid:
            if row:
                failures=row['failures']+1
                c.execute(text('UPDATE users SET failures=:f,locked_until=:l WHERE id=:id'),{'f':failures,'l':stamp+900 if failures>=5 else 0,'id':row['id']})
            # Commit before returning the error so failed attempts persist.
        else:
            c.execute(text('UPDATE users SET failures=0,locked_until=0 WHERE id=:id'),{'id':row['id']})
            token=secrets.token_urlsafe(32)
            c.execute(text('INSERT INTO sessions (token_hash,user_id,expires) VALUES (:h,:id,:exp)'),{'h':hashlib.sha256(token.encode()).hexdigest(),'id':row['id'],'exp':stamp+7*86400})
    if not valid: raise HTTPException(401,'الاسم أو الرمز غير صحيح')
    return {'token':token,'user':{'id':row['id'],'name':row['name'],'role':row['role']}}
def current(authorization:str|None=Header(default=None)):
    if not authorization or not authorization.startswith('Bearer '): raise HTTPException(401,'يرجى تسجيل الدخول')
    token=authorization[7:]
    with engine.connect() as c: row=c.execute(text('SELECT u.id,u.name,u.role,u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=:h AND s.expires>:t'),{'h':hashlib.sha256(token.encode()).hexdigest(),'t':now()}).mappings().first()
    if not row or not row['active']: raise HTTPException(401,'انتهت الجلسة')
    return dict(row)
def admin(user=Depends(current)):
    if user['role']!='admin': raise HTTPException(403,'للأدمن فقط')
    return user
@app.get('/api/me')
def me(u=Depends(current)): return u
@app.post('/api/logout',status_code=204)
def logout(authorization:str=Header(),u=Depends(current)):
    with engine.begin() as c: c.execute(text('DELETE FROM sessions WHERE token_hash=:h'),{'h':hashlib.sha256(authorization[7:].encode()).hexdigest()})
@app.get('/api/admin/users')
def users(u=Depends(admin)):
    with engine.connect() as c: return [dict(x) for x in c.execute(text("SELECT id,name,role,active,locked_until FROM users ORDER BY name")).mappings()]
@app.post('/api/admin/users',status_code=201)
def create_user(body:UserCreate,u=Depends(admin)):
    name=' '.join(body.name.split())
    if len(name.split())<3 or not re.fullmatch(r'[0-9]{4}',body.pin): raise HTTPException(422,'أدخل الاسم الثلاثي ورمزاً من أربعة أرقام')
    try:
        with engine.begin() as c: c.execute(text("INSERT INTO users (id,name,name_key,password_hash,role) VALUES (:id,:n,:k,:p,'user')"),dict(id=secrets.token_hex(16),n=name,k=name_key(name),p=hash_password(body.pin)))
    except IntegrityError: raise HTTPException(409,'الاسم مستخدم بالفعل')
    return {'ok':True}
@app.patch('/api/admin/users/{user_id}')
def update_user(user_id:str,body:UserUpdate,u=Depends(admin)):
    if body.pin is not None and not re.fullmatch(r'[0-9]{4}',body.pin): raise HTTPException(422,'الرمز يتكون من أربعة أرقام')
    if body.pin is None and body.active is None: raise HTTPException(422,'لم يتم تحديد تعديل')
    with engine.begin() as c:
        row=c.execute(text('SELECT role FROM users WHERE id=:id'),{'id':user_id}).first()
        if not row: raise HTTPException(404,'الحساب غير موجود')
        if row.role!='user': raise HTTPException(403,'لا يمكن تعديل الأدمن من هنا')
        if body.pin is not None: c.execute(text('UPDATE users SET password_hash=:p,failures=0,locked_until=0 WHERE id=:id'),{'p':hash_password(body.pin),'id':user_id})
        if body.active is not None: c.execute(text('UPDATE users SET active=:a,failures=0,locked_until=0 WHERE id=:id'),{'a':int(body.active),'id':user_id})
        c.execute(text('DELETE FROM sessions WHERE user_id=:id'),{'id':user_id})
    return {'ok':True}
def all_items(table):
    with engine.connect() as c: rows=c.execute(text(f'SELECT t.id,t.user_id,t.data,u.name FROM {table} t JOIN users u ON u.id=t.user_id ORDER BY t.created_at,t.id')).mappings().all()
    return [{**json.loads(x['data']),'id':x['id'],'userId':x['user_id'],'createdBy':x['name']} for x in rows]
@app.get('/api/visits')
def visits(u=Depends(current)): return all_items('visits')
@app.post('/api/visits',status_code=201)
def add_visit(body:Visit,u=Depends(current)):
    id=secrets.token_hex(16)
    with engine.begin() as c: c.execute(text('INSERT INTO visits (id,user_id,data,created_at) VALUES (:id,:u,:d,:t)'),{'id':id,'u':u['id'],'d':body.model_dump_json() if hasattr(body,'model_dump_json') else body.json(),'t':now()})
    return {'id':id}
@app.delete('/api/visits/{item_id}',status_code=204)
def delete_visit(item_id:str,u=Depends(current)):
    with engine.begin() as c:
        item=c.execute(text('SELECT user_id FROM visits WHERE id=:id'),{'id':item_id}).first()
        if not item: raise HTTPException(404,'الزيارة غير موجودة')
        if item.user_id!=u['id'] and u['role']!='admin': raise HTTPException(403,'يمكن حذف زيارتك فقط')
        c.execute(text('DELETE FROM visits WHERE id=:id'),{'id':item_id})
@app.get('/api/information')
def information(u=Depends(current)): return all_items('information')
@app.post('/api/information',status_code=201)
def add_info(body:Info,u=Depends(admin)):
    id=secrets.token_hex(16)
    with engine.begin() as c: c.execute(text('INSERT INTO information (id,user_id,data,created_at) VALUES (:id,:u,:d,:t)'),{'id':id,'u':u['id'],'d':body.model_dump_json() if hasattr(body,'model_dump_json') else body.json(),'t':now()})
    return {'id':id}
@app.get('/api/health')
def health(): return {'ok':True}
class ImportData(BaseModel):
    visitRecords:list[Visit]=Field(default_factory=list,max_length=1000)
    customInformation:list[Info]=Field(default_factory=list,max_length=1000)
@app.post('/api/admin/import')
def import_data(body:ImportData,u=Depends(admin)):
    with engine.begin() as c:
        for table,items in [('visits',body.visitRecords),('information',body.customInformation)]:
            for item in items:
                data=item.model_dump_json() if hasattr(item,'model_dump_json') else item.json()
                c.execute(text(f'INSERT INTO {table} (id,user_id,data,created_at) VALUES (:id,:u,:d,:t)'),{'id':secrets.token_hex(16),'u':u['id'],'d':data,'t':now()})
    return {'visits':len(body.visitRecords),'information':len(body.customInformation)}
