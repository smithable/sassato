import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SCHEMA_VERSION } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { addTask } from '../dist/tasks.js';
import { send, inbox, acknowledge } from '../dist/coordination.js';
import { requestStop, acknowledgeStop, resumeWork } from '../dist/control.js';
import { waitForWork } from '../dist/mail-wait.js';
import { getNotificationProgress, saveNotificationProgress } from '../dist/notification-progress.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-progress-')),path=join(dir,'state.db');
  const s=new Store(path,'builder',{create:true});initWorkspace(s,'demo');
  const readers=[];
  const reader=()=>{const r=new Store(path,'builder',{readonly:true});r.use('demo');readers.push(r);return r;};
  t.after(()=>{for (const r of readers) r.close();s.close();rmSync(dir,{recursive:true,force:true});});
  return {s,path,reader,stopFile:join(dir,'STOP'),cursor:()=>Number(s.get('SELECT coalesce(max(id),0) n FROM events WHERE workspace_id=?',s.ws).n)};
}
function as(s,role,fn) {const old=s.actor;s.actor=role;try{return fn();}finally{s.actor=old;}}
function task(s,title) {return as(s,'human',()=>addTask(s,{title,forRole:'builder'}));}
const wait=(f,options={})=>waitForWork(f.reader(),{timeout:1,stopFile:f.stopFile,...options});

test('progress uses role-owned versioned audit state and idempotent compare-and-set writes',t=>{
  const f=fixture(t),s=f.s;
  assert.equal(getNotificationProgress(s),null);
  const first=saveNotificationProgress(s,{cursor:f.cursor(),expected_version:0});
  assert.deepEqual(getNotificationProgress(s),first);assert.equal(first.version,1);assert.equal(first.role,'builder');
  assert.match(first.id,/^E\d+$/);assert.ok(Number.isFinite(Date.parse(first.saved_at)));
  const events=f.cursor();
  assert.deepEqual(saveNotificationProgress(s,{cursor:first.cursor,expected_version:0}),first,'lost-response retry returns prior result');
  assert.deepEqual(saveNotificationProgress(s,{cursor:first.cursor,expected_version:1}),first,'saving current progress is a no-op');
  assert.equal(f.cursor(),events);
  task(s,'Next notification');
  const next=saveNotificationProgress(s,{cursor:f.cursor(),expected_version:1});
  assert.equal(next.version,2);assert.notEqual(next.id,first.id);
  assert.throws(()=>saveNotificationProgress(s,{cursor:next.cursor,expected_version:0}),/progress changed/);
  assert.throws(()=>saveNotificationProgress(s,{cursor:first.cursor,expected_version:2}),/cannot move backwards/);
  assert.throws(()=>saveNotificationProgress(s,{cursor:f.cursor()+1,expected_version:2}),/ahead of this workspace/);
  assert.equal(getNotificationProgress(s).version,2);
  assert.equal(s.get("SELECT count(*) n FROM events WHERE entity='notification-progress'").n,2);
  assert.equal(s.get('PRAGMA user_version').user_version,SCHEMA_VERSION);
});

test('progress rejects invalid cursors and versions without writes',t=>{
  const f=fixture(t),before=f.cursor();
  for (const input of [{cursor:-1,expected_version:0},{cursor:1.5,expected_version:0},{cursor:0,expected_version:-1},{cursor:0},{cursor:0,expected_version:1}]) {
    assert.throws(()=>saveNotificationProgress(f.s,input));
  }
  assert.equal(f.cursor(),before);assert.equal(getNotificationProgress(f.s),null);
});

test('progress is shared-readable but writes are scoped to current role and workspace',t=>{
  const f=fixture(t),s=f.s,first=saveNotificationProgress(s,{cursor:0,expected_version:0});
  as(s,'reviewer',()=>{
    assert.equal(getNotificationProgress(s),null);assert.deepEqual(getNotificationProgress(s,'builder'),first);
    saveNotificationProgress(s,{cursor:0,expected_version:0});
  });
  assert.deepEqual(getNotificationProgress(s),first);
  initWorkspace(s,'second');assert.equal(getNotificationProgress(s),null);
  saveNotificationProgress(s,{cursor:0,expected_version:0});
  s.use('demo');assert.deepEqual(getNotificationProgress(s),first);
  assert.throws(()=>getNotificationProgress(s,'missing'),/Unknown role/);
  as(s,null,()=>assert.throws(()=>saveNotificationProgress(s,{cursor:0,expected_version:0}),/Specify --as/));
});

test('two writers cannot advance from the same progress version to different cursors',t=>{
  const f=fixture(t),first=saveNotificationProgress(f.s,{cursor:0,expected_version:0});
  const another=new Store(f.path,'builder');another.use('demo');
  try {
    const old=getNotificationProgress(another);assert.equal(old.version,first.version);
    task(f.s,'Concurrent update');
    saveNotificationProgress(f.s,{cursor:f.cursor(),expected_version:first.version});
    assert.throws(()=>saveNotificationProgress(another,{cursor:first.cursor,expected_version:old.version}),/progress changed/);
  } finally {another.close();}
});

test('malformed and future-format progress cannot silently skip notifications',t=>{
  const f=fixture(t),s=f.s;
  for (const detail of [{format:2,cursor:0,version:1},{format:1,cursor:-1,version:1},{format:1,cursor:0,version:0},{format:1,cursor:0,version:'1'},{format:1,cursor:0,version:1.1},{format:1,cursor:99999,version:1},[]]) {
    s.event('notification-progress','builder','saved',detail);
    assert.throws(()=>getNotificationProgress(s),/malformed or unsupported/);
  }
});

test('a returned but unhandled event replays from durable progress after restart',async t=>{
  const f=fixture(t),s=f.s,progress=saveNotificationProgress(s,{cursor:f.cursor(),expected_version:0});
  const pending=task(s,'Handle after restart'),before=f.cursor();
  const first=await wait(f);assert.equal(first.reason,'task-assigned');assert.equal(first.task,pending.id);
  assert.equal(f.cursor(),before,'read-only waiter adds no audit event');
  assert.deepEqual(getNotificationProgress(s),progress,'returning a notification does not mark it handled');
  const replay=await wait(f);assert.equal(replay.cursor,first.cursor);assert.equal(replay.task,pending.id);
});

test('saving a handled cursor preserves later events through restart and ignores stale checkpoint cursors',async t=>{
  const f=fixture(t),s=f.s;saveNotificationProgress(s,{cursor:f.cursor(),expected_version:0});
  const firstTask=task(s,'First'),first=await wait(f);assert.equal(first.task,firstTask.id);
  const secondTask=task(s,'Arrived while handling first');
  saveNotificationProgress(s,{cursor:first.cursor,expected_version:1});
  // Historical recovery content must never replace newer independent notification progress.
  s.event('checkpoint','builder','saved',{format:2,notification_progress:{cursor:0,version:1}});
  const second=await wait(f);assert.equal(second.task,secondTask.id);assert.ok(second.cursor>first.cursor);
  saveNotificationProgress(s,{cursor:second.cursor,expected_version:2});
  assert.equal((await wait(f)).reason,'timeout');
});

test('explicit --since overrides saved progress and missing progress requires a cursor',async t=>{
  const f=fixture(t),s=f.s,before=f.cursor(),pending=task(s,'Existing notification');
  await assert.rejects(wait(f),/No saved notification progress.*snapshot_cursor/);
  assert.equal((await wait(f,{since:before})).task,pending.id,'the explicit context cursor preserves an event arriving before wait');
  saveNotificationProgress(s,{cursor:before,expected_version:0});
  assert.equal((await wait(f,{since:f.cursor()})).reason,'timeout','explicit newer cursor overrides progress');
  assert.equal((await wait(f)).task,pending.id);
  saveNotificationProgress(s,{cursor:f.cursor(),expected_version:1});
  assert.equal((await wait(f,{since:before})).task,pending.id,'explicit older cursor permits replay without rewinding durable progress');
});

test('STOP and urgent receipts retain precedence and progress never consumes mail',async t=>{
  const f=fixture(t),s=f.s;saveNotificationProgress(s,{cursor:0,expected_version:0});
  task(s,'Assigned work');
  const mail=as(s,'reviewer',()=>send(s,['builder'],'Urgent update',{urgent:true}));
  const request=as(s,'human',()=>requestStop(s,['builder']))[0];
  assert.equal((await wait(f)).reason,'stop');
  acknowledgeStop(s,request.id);assert.equal((await wait(f)).reason,'stop');
  as(s,'human',()=>resumeWork(s,['builder']));
  assert.equal((await wait(f)).reason,'urgent');
  saveNotificationProgress(s,{cursor:f.cursor(),expected_version:1});
  assert.equal(inbox(s,{peek:true})[0].state,'unread','saving progress is not a mail receipt acknowledgment');
  assert.equal((await wait(f)).reason,'urgent','urgent mail remains visible independently of the event cursor');
  acknowledge(s,mail.id);assert.equal((await wait(f)).reason,'timeout');
});

test('malformed progress cannot hide durable or external STOP and never silently resumes work',async t=>{
  const f=fixture(t),s=f.s;
  s.event('notification-progress','builder','saved',{format:999,cursor:0,version:1});
  await assert.rejects(wait(f),/malformed or unsupported/);
  const request=as(s,'human',()=>requestStop(s,['builder']))[0],before=f.cursor();
  const stopped=await wait(f);assert.equal(stopped.reason,'stop');assert.equal(stopped.stop.id,request.id);assert.equal(stopped.cursor,0);
  assert.equal(f.cursor(),before,'STOP fallback must not change saved progress');
  acknowledgeStop(s,request.id);assert.equal((await wait(f)).stop.acknowledged,true);
  as(s,'human',()=>resumeWork(s,['builder']));
  await assert.rejects(wait(f),/malformed or unsupported/);
  writeFileSync(f.stopFile,'stop');
  const external=await wait(f);assert.equal(external.reason,'stop');assert.equal(external.stop.file,f.stopFile);assert.equal(external.cursor,0);
  rmSync(f.stopFile);await assert.rejects(wait(f),/malformed or unsupported/);
  // An intentional replay remains available without repairing or advancing the invalid record.
  assert.equal((await wait(f,{since:0})).reason,'timeout');
  assert.throws(()=>getNotificationProgress(s),/malformed or unsupported/);
});
