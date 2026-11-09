import { fixtureConfig } from './fixtures/team.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store,SCHEMA_VERSION } from '../dist/storage.js';
import { initWorkspace,attachWorkspace,restoreDatabase,search } from '../dist/admin.js';
import { addTask,takeTask } from '../dist/tasks.js';
import { send,setFact,setWip,registerSession } from '../dist/coordination.js';
import { normalizeOption,validateRoleOptions } from '../dist/role-options.js';
import { safe,integer } from '../dist/errors.js';
test('secret guard rejects quoted assignments and structured values without echoing them',()=>{
  const fakeValue='FAKE_TEST_VALUE_'.repeat(2); // Synthetic input, never a usable credential.
  const fakeHeaders=['','ENCRYPTED ','DSA '].map(kind=>'-'.repeat(5)+'BEGIN '+kind+'PRIVATE KEY'+'-'.repeat(5));
  for(const value of [JSON.stringify({password:fakeValue}),{password:fakeValue},'api_key='+fakeValue,...fakeHeaders,'ghp_'+'a'.repeat(32)])assert.throws(()=>safe(value),/Possible secret rejected/);
  safe('API key lives in .env; never copy its value');safe({source:'docs/credentials.md'});
});
test('schema migration is atomic and rejects unknown future versions',t=>{
  const dir=mkdtempSync(join(tmpdir(),'sassato-schema-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'state.db');const s=new Store(path,'human',{create:true});initWorkspace(s,'one',fixtureConfig);s.use('one');
  assert.equal(s.get('PRAGMA foreign_keys').foreign_keys,1);assert.equal(s.get('PRAGMA journal_mode').journal_mode,'wal');assert.equal(s.get('PRAGMA synchronous').synchronous,2);
  assert.equal(s.get('SELECT count(*) n FROM schema_migrations').n,SCHEMA_VERSION);
  assert.equal(s.get('PRAGMA user_version').user_version,SCHEMA_VERSION);
  const file=join(dir,'file');writeFileSync(file,'x');assert.throws(()=>attachWorkspace(s,file),/directory/);
  const config=join(dir,'config.json');writeFileSync(config,JSON.stringify({roles:[null]}));assert.throws(()=>initWorkspace(s,'bad',config),/object/);
  s.close();const native=new DatabaseSync(path);native.exec('PRAGMA user_version=999');native.close();
  assert.throws(()=>new Store(path),/newer Sassato/);
});

test('numeric validation refuses implicit JavaScript coercions',()=>{
  for(const input of [true,false,null,undefined,'',' ','0x10','1e3','1.5'])assert.throws(()=>integer(input,'number'));
  assert.equal(integer('42','number'),42);
});

function legacyFixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-v1-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'v1.db'),s=new Store(path,'a',{create:true});initWorkspace(s,'legacy',fixtureConfig);s.use('legacy');
  const task=addTask(s,{title:'Preserved quartz task',body:'Persist every committed change'});takeTask(s,task.id);
  send(s,['b'],'Legacy unread message',{task:task.id});setFact(s,'legacy-fact',{body:'Existing fact',source:'source.md'});
  setWip(s,{current:'Existing work'});registerSession(s,{provider:'claude',external_id:'old-runtime'});
  s.run("UPDATE roles SET provider='codex',model='legacy-model' WHERE workspace_id=? AND name='c'",s.ws);
  s.run('INSERT INTO imports(workspace_id,path,digest,raw,created_at) VALUES(?,?,?,?,?)',s.ws,'legacy.md','digest','raw preserved input',new Date().toISOString());
  const baseline=Object.fromEntries(['tasks','messages','receipts','facts','events','sessions','wip','imports','documents'].map(table=>[table,JSON.stringify(s.all(`SELECT * FROM ${table} ORDER BY rowid`))]));
  s.close();
  // Reconstruct the exact v1 roles schema, keeping real committed data from all core modules.
  const db=new DatabaseSync(path);db.exec('BEGIN IMMEDIATE');
  for(const column of ['reasoning_effort','permission_mode','sandbox_mode','approval_policy'])db.exec(`ALTER TABLE roles DROP COLUMN ${column}`);
  db.exec('DROP INDEX urgent_messages; ALTER TABLE messages DROP COLUMN urgent; DROP TABLE stop_requests; DELETE FROM schema_migrations WHERE version>=2; PRAGMA user_version=1; COMMIT;');db.close();
  return {path,dir,baseline,task};
}

test('v1 migrates transactionally to current schema without changing roles, claims, history or search',t=>{
  const {path,baseline,task}=legacyFixture(t);
  assert.throws(()=>new Store(path,undefined,{readonly:true}),/sassato migrate/);
  let s=new Store(path,'a');s.use('legacy');
  assert.equal(s.get('PRAGMA user_version').user_version,SCHEMA_VERSION);
  assert.deepEqual(s.all('SELECT version FROM schema_migrations ORDER BY version').map(r=>r.version),Array.from({length:SCHEMA_VERSION},(_,i)=>i+1));
  for(const [table,value] of Object.entries(baseline))assert.equal(JSON.stringify(s.all(`SELECT * FROM ${table} ORDER BY rowid`)),value,`${table} survives`);
  assert.equal(s.role('c').provider,'codex');assert.equal(s.role('c').model,'legacy-model');
  for(const field of ['reasoning_effort','permission_mode','sandbox_mode','approval_policy'])assert.equal(s.role('a')[field],null);
  assert.equal(search(s,'quartz',{type:'task'})[0].id,task.id);
  s.close();s=new Store(path,undefined,{readonly:true});assert.equal(s.get('PRAGMA user_version').user_version,SCHEMA_VERSION);s.close();
  s=new Store(path);assert.equal(s.get('SELECT count(*) n FROM schema_migrations').n,SCHEMA_VERSION);s.close();
});

test('failed v2 migration rolls back earlier ALTER statements and leaves original data',t=>{
  const {path,baseline}=legacyFixture(t);
  let db=new DatabaseSync(path);db.exec('ALTER TABLE roles ADD COLUMN permission_mode TEXT');db.close();
  assert.throws(()=>new Store(path),/duplicate column/);
  db=new DatabaseSync(path,{readOnly:true});
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);
  assert.equal(db.prepare('SELECT count(*) n FROM schema_migrations').get().n,1);
  assert.equal(db.prepare('PRAGMA table_info(roles)').all().some(r=>r.name==='reasoning_effort'),false);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM events ORDER BY rowid').all()),baseline.events);db.close();
});

test('restoring a v1 backup migrates only its fresh destination and never overwrites',async t=>{
  const {path,dir,baseline}=legacyFixture(t),source=readFileSync(path),destination=join(dir,'restored.db');
  const restored=await restoreDatabase(path,destination);assert.equal(restored.schema,SCHEMA_VERSION);assert.equal(restored.source_schema,1);
  assert.deepEqual(readFileSync(path),source,'read-only source bytes unchanged');
  const sourceDb=new DatabaseSync(path,{readOnly:true});assert.equal(sourceDb.prepare('PRAGMA user_version').get().user_version,1);sourceDb.close();
  const s=new Store(destination);assert.equal(s.get('PRAGMA user_version').user_version,SCHEMA_VERSION);
  assert.equal(JSON.stringify(s.all('SELECT * FROM events ORDER BY rowid')),baseline.events);s.close();
  await assert.rejects(()=>restoreDatabase(path,destination),/already exists/);
  const broken=new DatabaseSync(path);broken.exec('ALTER TABLE roles ADD COLUMN permission_mode TEXT');broken.close();
  const failed=join(dir,'failed.db');await assert.rejects(()=>restoreDatabase(path,failed),/duplicate column/);assert.equal(existsSync(failed),false);
});

test('fresh role defaults use Claude for C and config round-trips explicit provider settings',t=>{
  const dir=mkdtempSync(join(tmpdir(),'sassato-config-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const s=new Store(join(dir,'state.db'),'human',{create:true});t.after(()=>s.close());
  initWorkspace(s,'defaults',fixtureConfig);s.use('defaults');
  assert.equal(s.role('c').provider,'claude');assert.equal(s.role('c').model,'fixture-model');
  assert.equal(s.role('lead').model,'fixture-model');assert.equal(s.role('coordinator').model,'fixture-model');
  const config=join(dir,'roles.json');writeFileSync(config,JSON.stringify({roles:[
    {name:'human',kind:'human'},
    {name:'a',provider:'claude',model:'claude-opus-5-5',reasoning_effort:'max',permission_mode:'acceptEdits'},
    {name:'b',provider:'codex',model:'example-model',reasoning_effort:'ultra',sandbox_mode:'workspace-write',approval_policy:'on-request'},
    {name:'c',provider:'claude',model:'inherit',reasoning_effort:'inherit',permission_mode:'inherit'}
  ]}));
  initWorkspace(s,'configured',config);s.use('configured');
  assert.equal(s.role('a').reasoning_effort,'max');assert.equal(s.role('a').permission_mode,'acceptEdits');
  assert.equal(s.role('b').sandbox_mode,'workspace-write');assert.equal(s.role('b').approval_policy,'on-request');
  assert.equal(s.role('c').model,null);assert.equal(s.role('c').reasoning_effort,null);assert.equal(s.role('c').permission_mode,null);
  writeFileSync(config,JSON.stringify({roles:[{name:'human',kind:'human'},{name:'a',provider:'claude',sandbox_mode:'workspace-write'}]}));
  assert.throws(()=>initWorkspace(s,'invalid',config),/not supported for provider claude/);
  assert.equal(s.get("SELECT count(*) n FROM workspaces WHERE name='invalid'").n,0);
});

test('provider options normalize inheritance and reject irrelevant or malformed values',()=>{
  assert.equal(normalizeOption(undefined),undefined);assert.equal(normalizeOption('inherit'),null);assert.equal(normalizeOption(''),null);assert.equal(normalizeOption(null),null);
  for(const value of [3,false,{},[]])assert.throws(()=>normalizeOption(value),/strings or null/);
  validateRoleOptions('claude',{reasoning_effort:'xhigh',permission_mode:'default'});
  validateRoleOptions('claude',{reasoning_effort:'inherit',permission_mode:null});
  validateRoleOptions('codex',{reasoning_effort:'minimal',sandbox_mode:'read-only',approval_policy:'never'});
  assert.throws(()=>validateRoleOptions('claude',{reasoning_effort:'ultra'}),/Invalid reasoning_effort/);
  assert.throws(()=>validateRoleOptions('codex',{permission_mode:'auto'}),/not supported/);
  assert.throws(()=>validateRoleOptions(null,{reasoning_effort:'high'}),/not supported/);
  assert.throws(()=>validateRoleOptions('future-provider',{sandbox_mode:'workspace-write'}),/not supported/);
});
