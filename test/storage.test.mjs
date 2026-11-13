import { fixtureConfig } from './fixtures/team.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store,SCHEMA_VERSION } from '../dist/storage.js';
import { initWorkspace,attachWorkspace,restoreDatabase,search } from '../dist/admin.js';
import { addTask,takeTask,askHuman,answerQuestion,blockTask,showTask,reopenTask,humanQueue } from '../dist/tasks.js';
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
  db.exec('DROP TABLE jobs; ALTER TABLE messages DROP COLUMN reply; DROP INDEX urgent_messages; ALTER TABLE messages DROP COLUMN urgent; DROP TABLE stop_requests; DELETE FROM schema_migrations WHERE version>=2; PRAGMA user_version=1; COMMIT;');db.close();
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

function questionV4Fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-v4-questions-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'state.db'),s=new Store(path,'a',{create:true});initWorkspace(s,'legacy',fixtureConfig);
  const dropped=addTask(s,{title:'Dropped decision task',owner:'a'}), pending=askHuman(s,dropped.id,{question:'Retired quartz question?',options:['Yes','No']});
  const external=blockTask(s,dropped.id,{kind:'external',waitingOn:'supplier',body:'Unrelated blocker'});
  const completed=addTask(s,{title:'Completed legacy task',owner:'a'}), obsolete=askHuman(s,completed.id,{question:'Completed task question?'});
  const active=addTask(s,{title:'Active decision',owner:'a'}), live=askHuman(s,active.id,{question:'Still relevant?'});
  const answeredTask=addTask(s,{title:'Answered question',owner:'a'}), answered=askHuman(s,answeredTask.id,{question:'Earlier decision?'});
  s.actor='human';answerQuestion(s,answered.id,'Recorded answer');s.actor='a';
  s.run("UPDATE tasks SET status='dropped',lease_until=NULL WHERE id=?",Number(dropped.id.slice(1)));
  s.run("UPDATE tasks SET status='done',lease_until=NULL WHERE id=?",Number(completed.id.slice(1)));
  const before={events:s.all('SELECT * FROM events ORDER BY id'),answered:showTask(s,answeredTask.id).questions[0],active:showTask(s,active.id),droppedVersion:showTask(s,dropped.id).version};
  s.close();
  const db=new DatabaseSync(path);
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE questions_v4(id INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id INTEGER NOT NULL,task_id INTEGER NOT NULL,blocker_id INTEGER NOT NULL,asked_by TEXT NOT NULL,question TEXT NOT NULL,options TEXT NOT NULL DEFAULT '[]',recommendation TEXT,command TEXT,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered')),answer TEXT,answered_by TEXT,created_at TEXT NOT NULL,answered_at TEXT,UNIQUE(workspace_id,id),FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id),FOREIGN KEY(workspace_id,blocker_id) REFERENCES blockers(workspace_id,id));
    INSERT INTO questions_v4(id,workspace_id,task_id,blocker_id,asked_by,question,options,recommendation,command,status,answer,answered_by,created_at,answered_at) SELECT id,workspace_id,task_id,blocker_id,asked_by,question,options,recommendation,command,status,answer,answered_by,created_at,answered_at FROM questions;
    DROP TABLE questions;ALTER TABLE questions_v4 RENAME TO questions;CREATE INDEX questions_status ON questions(workspace_id,status,id);
    UPDATE sqlite_sequence SET seq=100 WHERE name='questions';
    DROP TABLE jobs; ALTER TABLE messages DROP COLUMN reply;
    DELETE FROM schema_migrations WHERE version>=5;PRAGMA user_version=4;COMMIT;`);
  db.close();return {path,dropped,pending,completed,obsolete,active,live,answeredTask,answered,external,before};
}

test('v5 preserves decisions and audit history, cancelling obsolete requests without reviving them on reopen',t=>{
  const f=questionV4Fixture(t);assert.throws(()=>new Store(f.path,undefined,{readonly:true}),/writable migration/);
  const s=new Store(f.path,'a');t.after(()=>s.close());s.use('legacy');
  assert.equal(s.get('PRAGMA user_version').user_version,SCHEMA_VERSION);assert.deepEqual(s.all('PRAGMA foreign_key_check'),[]);
  assert.deepEqual(s.all('SELECT * FROM events WHERE id<=? ORDER BY id',f.before.events.at(-1).id),f.before.events);
  assert.deepEqual(showTask(s,f.answeredTask.id).questions[0],f.before.answered);assert.deepEqual(showTask(s,f.active.id),f.before.active);
  for(const [task,q] of [[f.dropped,f.pending],[f.completed,f.obsolete]]) {
    const question=showTask(s,task.id).questions.find(row=>row.id===q.id);
    assert.equal(question.status,'cancelled');assert.equal(question.cancelled_by,'schema-migration');assert.match(question.cancel_reason,/already closed/);assert.equal(question.answer,null);
    assert.equal(s.get("SELECT status FROM documents WHERE type='question' AND entity_id=?",q.id).status,'cancelled');
    const event=s.get("SELECT * FROM events WHERE entity='question' AND entity_id=? AND action='cancelled'",q.id);assert.equal(JSON.parse(event.detail).migration,5);
    assert.ok(s.get("SELECT 1 FROM documents WHERE type='event' AND entity_id=?",`E${event.id}`));
  }
  assert.equal(showTask(s,f.dropped.id).version,f.before.droppedVersion+1);
  assert.deepEqual(showTask(s,f.dropped.id).blockers.map(b=>b.id),[f.external.id]);
  assert.deepEqual(humanQueue(s).filter(q=>q.kind==='question').map(q=>q.id),[f.live.id]);
  assert.ok(search(s,'quartz',{type:'question'}).some(q=>q.id===f.pending.id));
  reopenTask(s,f.dropped.id,'New request needed');assert.ok(!humanQueue(s).some(q=>q.id===f.pending.id));
  const next=askHuman(s,f.dropped.id,{question:'New question after migration?'});assert.equal(next.id,'H101','the existing AUTOINCREMENT high-water mark is preserved');
});

test('failed v5 cancellation rolls back table rebuild, metadata, audit and search',t=>{
  const f=questionV4Fixture(t),db=new DatabaseSync(f.path);
  db.exec("CREATE TRIGGER reject_cancel BEFORE UPDATE ON blockers BEGIN SELECT RAISE(ABORT,'migration blocker failure'); END");
  const documents=db.prepare('SELECT * FROM documents ORDER BY id').all();db.close();
  assert.throws(()=>new Store(f.path),/migration blocker failure/);
  const old=new DatabaseSync(f.path,{readOnly:true});t.after(()=>old.close());
  assert.equal(old.prepare('PRAGMA user_version').get().user_version,4);
  assert.equal(old.prepare('PRAGMA table_info(questions)').all().some(c=>c.name==='cancelled_at'),false);
  assert.equal(old.prepare('SELECT status FROM questions WHERE id=?').get(Number(f.pending.id.slice(1))).status,'pending');
  assert.deepEqual(old.prepare('SELECT * FROM events ORDER BY id').all(),f.before.events);
  assert.deepEqual(old.prepare('SELECT * FROM documents ORDER BY id').all(),documents);
  assert.deepEqual(old.prepare('PRAGMA foreign_key_check').all(),[]);
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
