import { fixtureConfig } from './fixtures/team.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync,writeFileSync,unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Store,SCHEMA_VERSION } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { addTask,takeTask } from '../dist/tasks.js';
import { registerSession,endSession,context,renderContext,setFact,send,processIdentity } from '../dist/coordination.js';
import { requestStop,stopStatus,acknowledgeStop,resumeWork,assertWorkAllowed } from '../dist/control.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-control-')),path=join(dir,'state.db'),s=new Store(path,'human',{create:true});
  initWorkspace(s,'team',fixtureConfig);s.use('team');
  t.after(()=>{if(s.db.isOpen)s.close();rmSync(dir,{recursive:true,force:true});});
  return {s,dir,path};
}
function as(s,actor,fn){const old=s.actor;s.actor=actor;try{return fn();}finally{s.actor=old;}}
async function fakeProvider(t,dir) {
  const path=join(dir,'claude.mjs');writeFileSync(path,"process.send('ready');setInterval(()=>{},1000);\n");
  const child=spawn(process.execPath,[path],{stdio:['ignore','ignore','ignore','ipc']});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}});
  await once(child,'message');return child;
}

test('human stop requests are durable, idempotent and scoped to agent roles',t=>{
  const {s,path}=fixture(t);
  assert.throws(()=>as(s,'a',()=>requestStop(s,['b'])),/human role/);
  assert.throws(()=>requestStop(s,['human']),/agent roles/);
  assert.throws(()=>requestStop(s,['a','missing']),/Unknown role/);
  assert.equal(stopStatus(s).length,0,'invalid selection never partially requests stop');
  const requests=requestStop(s);assert.deepEqual(requests.map(r=>r.role),['a','b','c','coordinator','lead']);
  assert.ok(requests.every(r=>r.state==='inactive'));
  const events=s.get('SELECT count(*) n FROM events').n;
  assert.deepEqual(requestStop(s,[],{all:true}).map(r=>r.id),requests.map(r=>r.id));
  assert.equal(s.get('SELECT count(*) n FROM events').n,events);
  assert.throws(()=>requestStop(s,['a'],{all:true}),/named roles or --all/);
  assert.throws(()=>assertWorkAllowed(s,'a'),/Stop requested/);
  s.close();const reopened=new Store(path,'a');reopened.use('team');
  assert.equal(stopStatus(reopened,['a'])[0].id,requests[0].id);
  assert.throws(()=>assertWorkAllowed(reopened,'a'),/Stop requested/);reopened.close();
});

test('acknowledgement binds the exact active generation and human resume permits future work',t=>{
  const {s}=fixture(t);const first=requestStop(s,['a'])[0];
  assert.throws(()=>acknowledgeStop(s,first.id),/Only the requested role/);
  assert.throws(()=>as(s,'b',()=>acknowledgeStop(s,first.id)),/Only the requested role/);
  as(s,'a',()=>assert.equal(acknowledgeStop(s,first.id).state,'acknowledged'));
  const count=s.get('SELECT count(*) n FROM events').n;
  as(s,'a',()=>acknowledgeStop(s,first.id));assert.equal(s.get('SELECT count(*) n FROM events').n,count);
  assert.throws(()=>assertWorkAllowed(s,'a'),/Stop requested/,'acknowledgement never clears stop');
  assert.throws(()=>as(s,'a',()=>resumeWork(s,['a'])),/human role/);
  const resumed=resumeWork(s,['a']);assert.ok(resumed[0].cleared_at);assert.equal(stopStatus(s,['a']).length,0);
  assert.doesNotThrow(()=>assertWorkAllowed(s,'a'));
  const second=requestStop(s,['a'])[0];assert.notEqual(second.id,first.id);
  assert.throws(()=>as(s,'a',()=>acknowledgeStop(s,first.id)),/cleared/);
  assert.equal(stopStatus(s,['a'])[0].acknowledged_at,null);
  assert.equal(s.get('SELECT count(*) n FROM stop_requests WHERE workspace_id=?',s.ws).n,2);
  assert.deepEqual(s.all("SELECT action FROM events WHERE workspace_id=? AND entity='stop' AND entity_id=? ORDER BY id",s.ws,first.id).map(r=>r.action),['requested','acknowledged','cleared']);
});

test('unfinished work does not imply a running session; explicitly ended no-PID registrations are inactive',t=>{
  const {s}=fixture(t);
  as(s,'a',()=>{const task=addTask(s,{title:'Unregistered active work'});takeTask(s,task.id);});
  as(s,'b',()=>{registerSession(s,{provider:'claude',external_id:'unverified'});endSession(s,'unverified');});
  requestStop(s,['a','b','c']);
  const states=Object.fromEntries(stopStatus(s).map(r=>[r.role,r]));
  assert.equal(states.a.state,'inactive');assert.equal(states.a.pending_work,1);
  assert.equal(states.b.session_state,'ended');assert.equal(states.b.state,'inactive','explicitly ended no-PID registration is inactive, not verified exited');
  assert.equal(states.c.state,'inactive');
});

test('verified live provider cannot look exited from stale heartbeat or declared end',async t=>{
  const {s,dir}=fixture(t),child=await fakeProvider(t,dir);
  as(s,'a',()=>registerSession(s,{provider:'claude',external_id:'verified',pid:child.pid}));
  requestStop(s,['a']);assert.equal(stopStatus(s,['a'])[0].state,'waiting');
  s.run("UPDATE sessions SET last_seen_at='2000-01-01T00:00:00.000Z' WHERE workspace_id=?",s.ws);
  as(s,'a',()=>endSession(s,'verified'));
  let status=stopStatus(s,['a'])[0];assert.equal(status.session_state,'running');assert.equal(status.state,'waiting');
  const exited=once(child,'exit');child.kill();await exited;
  status=stopStatus(s,['a'])[0];assert.equal(status.state,'exited');assert.ok(status.process_start);assert.ok(status.pid);
  assert.throws(()=>assertWorkAllowed(s,'a'),/Stop requested/,'process exit does not clear durable stop intent');
});

test('older verified live sessions cannot be hidden by a newer exit record',async t=>{
  const {s,dir}=fixture(t),child=await fakeProvider(t,dir);
  const old=as(s,'a',()=>registerSession(s,{provider:'claude',external_id:'older',pid:child.pid}));
  as(s,'a',()=>endSession(s,'older'));
  const at=new Date().toISOString();
  // A repaired/imported registry may contain out-of-order historical entries.
  s.run('INSERT INTO sessions(workspace_id,role,provider,external_id,pid,process_start,started_at,last_seen_at,ended_at) VALUES(?,?,?,?,?,?,?,?,?)',s.ws,'a','claude','newer-dead',2147483647,'old-boot:1',at,at,at);
  requestStop(s,['a']);
  const state=stopStatus(s,['a'])[0];assert.equal(state.state,'waiting');assert.equal(state.session_id,old.id);
});

test('workspace boundaries protect stop generations, visibility and resume',t=>{
  const {s}=fixture(t);const request=requestStop(s,['a'])[0];
  initWorkspace(s,'other',fixtureConfig);s.use('other');
  assert.equal(stopStatus(s).length,0);assert.doesNotThrow(()=>assertWorkAllowed(s,'a'));
  assert.throws(()=>as(s,'a',()=>acknowledgeStop(s,request.id)),/another workspace/);
  assert.deepEqual(resumeWork(s,['a']),[]);
  const other=requestStop(s,['a'])[0];assert.notEqual(other.id,request.id);
  resumeWork(s);s.use('team');assert.equal(stopStatus(s,['a'])[0].id,request.id);
});

test('context keeps stop instructions prominent, bounded and present after acknowledgement',t=>{
  const {s}=fixture(t);
  for(let i=0;i<15;i++)as(s,'a',()=>{setFact(s,`fact-${i}`,{body:'long context '.repeat(100),source:'source.md'});send(s,['a'],'unread body '.repeat(100));});
  const request=requestStop(s,['a'])[0];
  const view=as(s,'a',()=>context(s,{limit:5})),terminal=renderContext(view);
  assert.equal(view.sections.stop[0].id,request.id);
  assert.ok(terminal.split('\n')[1].startsWith(`STOP ${request.id}:`));
  assert.ok(terminal.includes('tools/background jobs to stop'));assert.ok(terminal.includes(`sas stopped ${request.id} --as a`));
  assert.ok(JSON.stringify(view).length<=5800);assert.ok(terminal.length<=6000);assert.ok(terminal.split('\n').length<=40);
  as(s,'a',()=>acknowledgeStop(s,request.id));
  const acknowledged=as(s,'a',()=>context(s,{since:view.cursor}));
  assert.ok(acknowledged.sections.stop[0].acknowledged);assert.match(renderContext(acknowledged),/Stay stopped/);
  resumeWork(s,['a']);assert.equal(as(s,'a',()=>context(s)).sections.stop,undefined);
});

test('v2 migration creates stop registry without changing existing role settings or history',t=>{
  const {s,path}=fixture(t);s.run("UPDATE roles SET reasoning_effort='high',permission_mode='plan' WHERE name='a' AND workspace_id=?",s.ws);
  const events=JSON.stringify(s.all('SELECT * FROM events ORDER BY id'));s.close();
  const db=new DatabaseSync(path);db.exec('DROP INDEX urgent_messages; ALTER TABLE messages DROP COLUMN urgent; DROP TABLE stop_requests; DELETE FROM schema_migrations WHERE version>=3; PRAGMA user_version=2');db.close();
  assert.throws(()=>new Store(path,undefined,{readonly:true}),/writable migration/);
  const migrated=new Store(path,'human');migrated.use('team');
  assert.equal(migrated.get('PRAGMA user_version').user_version,SCHEMA_VERSION);
  assert.equal(migrated.role('a').reasoning_effort,'high');assert.equal(migrated.role('a').permission_mode,'plan');
  assert.equal(JSON.stringify(migrated.all('SELECT * FROM events ORDER BY id')),events);
  assert.equal(requestStop(migrated,['a']).length,1);
  assert.deepEqual(migrated.all('SELECT version FROM schema_migrations ORDER BY version').map(r=>r.version),Array.from({length:SCHEMA_VERSION},(_,i)=>i+1));migrated.close();
});


test('live launcher lock closes the spawn-to-session-registration gap for inactive and exited roles',t=>{
  const {s,path}=fixture(t),locks=join(`${path}.launch`,s.workspace);mkdirSync(locks,{recursive:true});
  const at=new Date().toISOString();
  s.run('INSERT INTO sessions(workspace_id,role,provider,pid,process_start,started_at,last_seen_at,ended_at) VALUES(?,?,?,?,?,?,?,?)',s.ws,'b','claude',2147483647,'old-boot:1',at,at,at);
  const lock={pid:process.pid,identity:processIdentity(process.pid),created_at:at};assert.ok(lock.identity);
  for(const role of ['a','b'])writeFileSync(join(locks,`${role}.lock`),JSON.stringify(lock));
  const requests=requestStop(s,['a','b']);
  assert.ok(requests.every(r=>r.state==='waiting'&&r.launcher_pending));
  assert.equal(requests.find(r=>r.role==='a').session_id,null,'no session is registered yet');
  assert.equal(requests.find(r=>r.role==='b').session_state,'ended','previous dead session is not new child proof');
  for(const role of ['a','b'])unlinkSync(join(locks,`${role}.lock`));
  const after=Object.fromEntries(stopStatus(s).map(r=>[r.role,r]));
  assert.equal(after.a.state,'inactive');assert.equal(after.b.state,'exited');assert.equal(after.a.launcher_pending,false);
});

test('malformed launcher locks wait, proven stale locks do not block, and acknowledgement remains explicit',t=>{
  const {s,path}=fixture(t),locks=join(`${path}.launch`,s.workspace);mkdirSync(locks,{recursive:true});
  const file=join(locks,'a.lock'),request=requestStop(s,['a'])[0];
  for(const malformed of ['{unfinished','null',JSON.stringify({pid:process.pid}),JSON.stringify({pid:process.pid,identity:'unverifiable'})]) {
    writeFileSync(file,malformed);assert.equal(stopStatus(s,['a'])[0].state,'waiting');
  }
  writeFileSync(file,JSON.stringify({pid:process.pid,identity:'00000000-0000-0000-0000-000000000000:1'}));
  assert.equal(stopStatus(s,['a'])[0].state,'inactive','different boot/start fingerprint proves stale lock');
  writeFileSync(file,JSON.stringify({pid:2147483647,identity:processIdentity(process.pid)}));
  assert.equal(stopStatus(s,['a'])[0].state,'inactive','nonexistent PID proves launcher gone');
  writeFileSync(file,JSON.stringify({pid:process.pid,identity:processIdentity(process.pid)}));
  as(s,'a',()=>acknowledgeStop(s,request.id));assert.equal(stopStatus(s,['a'])[0].state,'acknowledged');
});


test('unresolved no-PID registration explains the human-verified session-end escape',t=>{
  const {s}=fixture(t);
  as(s,'a',()=>registerSession(s,{provider:'claude',external_id:'unverified'}));
  const requested=requestStop(s,['a'])[0];assert.equal(requested.state,'waiting');
  assert.match(requested.waiting_reason,/no PID/);
  assert.match(requested.human_action,/independently verifying.*session end --for a --as human --workspace team/);
  as(s,'a',()=>endSession(s,'unverified'));
  const ended=stopStatus(s,['a'])[0];assert.equal(ended.state,'inactive');assert.equal(ended.acknowledged_at,null);
  assert.equal(ended.waiting_reason,undefined);assert.equal(ended.human_action,undefined);
  assert.throws(()=>assertWorkAllowed(s,'a'),/Stop requested/,'clearing the registration does not clear STOP intent');
});


test('remote queue uncertainty outlives terminal exit until explicit end or stop acknowledgement',t=>{
  const {s}=fixture(t);
  const registered=as(s,'a',()=>registerSession(s,{provider:'codex',external_id:'remote-thread'}));
  const at=new Date().toISOString();
  s.run('UPDATE sessions SET pid=?,process_start=?,ended_at=? WHERE role=?',2147483647,'old-boot:1',at,'a');
  as(s,'a',()=>s.event('watch','a','queue-attempt',{session_id:registered.id,reason:'urgent',outcome:'queued'}));
  s.event('session',registered.id,'launcher-exited',{role:'a',exit_code:0});
  const stopped=requestStop(s,['a'])[0];
  assert.equal(stopped.state,'waiting');assert.match(stopped.waiting_reason,/outlive its terminal/);assert.match(stopped.human_action,/session end --for a --as human/);
  as(s,'a',()=>acknowledgeStop(s,stopped.id));assert.equal(stopStatus(s,['a'])[0].state,'acknowledged');
  resumeWork(s,['a']);
  s.run('UPDATE sessions SET pid=NULL,process_start=NULL,ended_at=NULL WHERE role=?','a');
  assert.equal(requestStop(s,['a'])[0].state,'waiting');
  as(s,'a',()=>endSession(s));assert.equal(stopStatus(s,['a'])[0].state,'inactive');
});


test('human end of an already-ended registration settles remote uncertainty without pretending a live PID exited',async t=>{
  const {s,dir}=fixture(t),child=await fakeProvider(t,dir);
  as(s,'a',()=>registerSession(s,{provider:'claude',external_id:'verified-worker',pid:child.pid}));
  as(s,'a',()=>endSession(s));
  s.event('watch','a','queue-attempt',{role:'a',reason:'urgent',queue_exit_code:0});
  requestStop(s,['a']);assert.equal(stopStatus(s,['a'])[0].state,'waiting');
  endSession(s,'verified-worker','a');
  const stillLive=stopStatus(s,['a'])[0];assert.equal(stillLive.state,'waiting');assert.equal(stillLive.session_state,'running');
  assert.equal(stillLive.waiting_reason,undefined,'human end cleared remote uncertainty, but the live process still blocks STOP');
  const exited=once(child,'exit');child.kill();await exited;
  assert.equal(stopStatus(s,['a'])[0].state,'exited');
});
