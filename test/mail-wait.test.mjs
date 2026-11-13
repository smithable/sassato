import { fixtureConfig } from './fixtures/team.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store,SCHEMA_VERSION} from '../dist/storage.js';
import {initWorkspace} from '../dist/admin.js';
import {send,inbox,context,acknowledge} from '../dist/coordination.js';
import {requestStop,acknowledgeStop} from '../dist/control.js';
import {waitForUrgent} from '../dist/mail-wait.js';
import {addTask,takeTask,noteTask,askHuman,addDependency} from '../dist/tasks.js';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'sassato-mailwait-')),path=join(dir,'state.db'),s=new Store(path,'a',{create:true});initWorkspace(s,'team',fixtureConfig);s.use('team');t.after(()=>{if(s.db.isOpen)s.close();rmSync(dir,{recursive:true,force:true});});return {s,path,stopFile:join(dir,'legacy-stop')};}
test('urgent waiter sees later writes through a read-only connection without consuming receipts',async t=>{
  const {s,path,stopFile}=fixture(t);send(s,['b'],'ordinary mail');send(s,['c'],'urgent elsewhere',{urgent:true});
  initWorkspace(s,'other',fixtureConfig);send(s,['b'],'foreign urgent',{urgent:true});s.use('team');
  const reader=new Store(path,'b',{readonly:true});reader.use('team');t.after(()=>reader.close());
  let urgent;const timer=setTimeout(()=>{urgent=send(s,['b'],'Wake up\nreview \u001b[2Jneeded',{urgent:true});},30);t.after(()=>clearTimeout(timer));
  const since=context(reader).snapshot_cursor,event=await waitForUrgent(reader,{timeout:2,stopFile,since});
  assert.equal(event.reason,'urgent');assert.equal(event.message.id,urgent.id);assert.equal(event.message.summary,'Wake up review [2Jneeded');
  assert.equal(s.get('SELECT state FROM receipts WHERE workspace_id=? AND message_id=? AND recipient=?',s.ws,Number(urgent.id.slice(1)),'b').state,'unread');
  assert.equal(context(reader).sections.inbox[0].urgent,true);
  s.actor='b';const messages=inbox(s,{limit:1});assert.equal(messages[0].id,urgent.id);assert.equal(messages[0].urgent,true);
  assert.equal((await waitForUrgent(reader,{timeout:1,stopFile,since})).reason,'urgent','read but unhandled urgent mail must survive interruption');
  acknowledge(s,urgent.id);
  assert.equal((await waitForUrgent(reader,{timeout:1,stopFile,since})).reason,'timeout','acknowledged mail must stop waking the watcher');
});
test('stop wins over urgent mail and acknowledged stop does not restart a watcher loop',async t=>{
  const {s,stopFile}=fixture(t);send(s,['a'],'urgent',{urgent:true});s.actor='human';const req=requestStop(s,['a'])[0];s.actor='a';
  const event=await waitForUrgent(s,{timeout:1,stopFile});assert.equal(event.reason,'stop');assert.equal(event.stop.id,req.id);
  acknowledgeStop(s,req.id);assert.equal((await waitForUrgent(s,{stopFile})).stop.acknowledged,true);
  assert.equal(inbox(s,{peek:true})[0].state,'unread');
});
test('mail waiter requires role identity and rejects malformed timeout',async t=>{
  const {s}=fixture(t);s.actor=null;await assert.rejects(()=>waitForUrgent(s),/identity|--as|role/i);
  s.actor='a';await assert.rejects(()=>waitForUrgent(s,{timeout:-1}),/timeout/);
});
test('v3 upgrade preserves messages and receipts and defaults urgency to false',t=>{
  const {s,path}=fixture(t);const msg=send(s,['b'],'old mail');s.actor='b';inbox(s);const receipts=JSON.stringify(s.all('SELECT * FROM receipts'));s.close();
  const db=new DatabaseSync(path);db.exec('DROP TABLE jobs; ALTER TABLE messages DROP COLUMN reply; DROP INDEX urgent_messages; ALTER TABLE messages DROP COLUMN urgent; DELETE FROM schema_migrations WHERE version>=4; PRAGMA user_version=3');db.close();
  const newer=new Store(path,'b');newer.use('team');t.after(()=>newer.close());
  assert.equal(newer.get('PRAGMA user_version').user_version,SCHEMA_VERSION);assert.equal(inbox(newer,{peek:true})[0].urgent,false);
  assert.equal(newer.get('SELECT urgent FROM messages WHERE id=?',Number(msg.id.slice(1))).urgent,0);assert.equal(JSON.stringify(newer.all('SELECT * FROM receipts')),receipts);
});

test('legacy stop file ends the waiter without consuming mail or creating a durable request',async t=>{
  const {s,stopFile}=fixture(t);const timer=setTimeout(()=>writeFileSync(stopFile,''),20);t.after(()=>clearTimeout(timer));
  const result=await waitForUrgent(s,{timeout:2,stopFile,since:context(s).snapshot_cursor});assert.equal(result.reason,'stop');assert.equal(result.stop.file,stopFile);
  assert.equal(s.get('SELECT count(*) n FROM stop_requests').n,0);
});

test('urgent wake text includes up to 2000 characters and an identity-specific inbox command when truncated',async t=>{
  const {s,stopFile}=fixture(t),since=context(s).snapshot_cursor;
  const short='Review detail '.repeat(30),long='X'.repeat(2100);
  s.actor='b';const first=send(s,['a'],short,{urgent:true});s.actor='a';
  const complete=await waitForUrgent(s,{since,stopFile,timeout:1});
  assert.equal(complete.message.summary,short.trim());assert.equal(complete.message.truncated,false);assert.equal(complete.message.inbox_command,undefined);
  acknowledge(s,first.id);s.actor='b';send(s,['a'],long,{urgent:true});s.actor='a';
  const clipped=await waitForUrgent(s,{since,stopFile,timeout:1});
  assert.equal(clipped.message.summary.length,2000);assert.equal(clipped.message.truncated,true);
  assert.equal(clipped.message.inbox_command,'sassato inbox --peek --as a --workspace team');
});

test('mail that asks for a reply wakes each recipient once and stays in context until acknowledged',async t=>{
  const {s,stopFile}=fixture(t);s.actor='b';const since=context(s).snapshot_cursor;s.actor='a';
  send(s,['b'],'ordinary mail');const ask=send(s,['b','c'],'Please read PR 4',{task:undefined,needsReply:true});
  assert.equal(ask.reply,true);
  s.actor='b';const event=await waitForUrgent(s,{timeout:1,stopFile,since});
  assert.equal(event.reason,'reply-needed');assert.equal(event.message.id,ask.id);assert.equal(event.message.sender,'a');
  assert.equal((await waitForUrgent(s,{timeout:1,stopFile,since:event.cursor})).reason,'timeout','it wakes once, unlike urgent mail');
  inbox(s);let view=context(s);
  assert.deepEqual(view.sections.replies.map(r=>[r.id,r.state]),[[ask.id,'read']],'read mail that asks for a reply stays listed');
  assert.ok(!view.sections.inbox.some(r=>r.id===ask.id));
  assert.equal(view.sections.replies[0].urgent,false);
  acknowledge(s,ask.id);assert.equal(context(s).sections.replies.length,0);
  s.actor='c';acknowledge(s,ask.id);
  assert.equal((await waitForUrgent(s,{timeout:1,stopFile,since})).reason,'timeout','an acknowledged request no longer wakes a late waiter');
});
test('v6 upgrade keeps messages and defaults reply to false',t=>{
  const {s,path}=fixture(t);const msg=send(s,['b'],'old mail');s.close();
  const db=new DatabaseSync(path);db.exec('DROP TABLE jobs; ALTER TABLE messages DROP COLUMN reply; DELETE FROM schema_migrations WHERE version>=7; PRAGMA user_version=6');db.close();
  const newer=new Store(path,'b');newer.use('team');t.after(()=>newer.close());
  assert.equal(newer.get('PRAGMA user_version').user_version,SCHEMA_VERSION);
  assert.equal(inbox(newer,{peek:true})[0].reply,false);assert.equal(newer.get('SELECT reply FROM messages WHERE id=?',Number(msg.id.slice(1))).reply,0);
});
test('a role idle with its own doing tasks is woken with them; a write of its own or no task keeps it waiting',async t=>{
  const {s,stopFile}=fixture(t);const real=performance.now.bind(performance);let shift=0;performance.now=()=>real()+shift;t.after(()=>{performance.now=real;});
  const later=(ms,fn)=>{const timer=setTimeout(fn,ms);t.after(()=>clearTimeout(timer));};
  s.actor='b';const since=context(s).snapshot_cursor;
  later(50,()=>{shift+=61_000;});
  assert.equal((await waitForUrgent(s,{timeout:3,stopFile,since,idleMinutes:1})).reason,'timeout','no doing task: nothing to wake for');
  const task=takeTask(s,addTask(s,{title:'Held work'}).id);
  later(50,()=>{shift+=61_000;});
  const event=await waitForUrgent(s,{timeout:300,stopFile,since:context(s).snapshot_cursor,idleMinutes:1});
  assert.equal(event.reason,'own-work');assert.deepEqual(event.tasks,[task.id]);
  later(50,()=>{noteTask(s,task.id,'still at it');shift+=61_000;});later(1500,()=>{shift+=61_000;});
  const began=real();
  assert.equal((await waitForUrgent(s,{timeout:300,stopFile,since:context(s).snapshot_cursor,idleMinutes:1})).reason,'own-work','a later idle period wakes again');
  assert.ok(real()-began>=1400,'its own write started the idle period again');
});
test('a role idle with open tasks of its own but none doing is woken with them, highest priority first',async t=>{
  const {s,stopFile}=fixture(t);const real=performance.now.bind(performance);let shift=0;performance.now=()=>real()+shift;t.after(()=>{performance.now=real;});
  const later=(ms,fn)=>{const timer=setTimeout(fn,ms);t.after(()=>clearTimeout(timer));};
  s.actor='a';const low=addTask(s,{title:'Waiting for b',forRole:'b'});const high=addTask(s,{title:'Urgent for b',forRole:'b',priority:5});addTask(s,{title:'For c',forRole:'c'});
  s.actor='b';
  later(50,()=>{shift+=61_000;});
  const event=await waitForUrgent(s,{timeout:300,stopFile,since:context(s).snapshot_cursor,idleMinutes:1});
  assert.equal(event.reason,'open-work');assert.deepEqual(event.tasks,[high.id,low.id]);assert.equal(event.task,high.id);
  takeTask(s,low.id);
  later(50,()=>{shift+=61_000;});
  const doing=await waitForUrgent(s,{timeout:300,stopFile,since:context(s).snapshot_cursor,idleMinutes:1});
  assert.equal(doing.reason,'own-work','a doing task comes before open ones');assert.deepEqual(doing.tasks,[low.id]);
  s.actor='c';takeTask(s,s.get("SELECT id FROM tasks WHERE title='For c'").id.toString().replace(/^/,'T'));s.actor='a';
  later(50,()=>{shift+=61_000;});
  assert.equal((await waitForUrgent(s,{timeout:3,stopFile,since:context(s).snapshot_cursor,idleMinutes:1})).reason,'timeout','a role with no open task is not woken');
});
test('open tasks that cannot be taken now (a pending human question, an unfinished dependency) wake nobody',async t=>{
  const {s,stopFile}=fixture(t);const real=performance.now.bind(performance);let shift=0;performance.now=()=>real()+shift;t.after(()=>{performance.now=real;});
  const later=(ms,fn)=>{const timer=setTimeout(fn,ms);t.after(()=>clearTimeout(timer));};
  s.actor='b';const asked=addTask(s,{title:'Waits on a human',forRole:'b'});askHuman(s,asked.id,{question:'Which one?'});
  s.actor='a';const first=addTask(s,{title:'First'});const after=addTask(s,{title:'After the first',forRole:'b'});addDependency(s,after.id,first.id);
  s.actor='b';
  later(50,()=>{shift+=61_000;});
  assert.equal((await waitForUrgent(s,{timeout:3,stopFile,since:context(s).snapshot_cursor,idleMinutes:1})).reason,'timeout','nothing takeable: no wake');
  s.actor='a';const free=addTask(s,{title:'Free for b',forRole:'b'});s.actor='b';
  later(50,()=>{shift+=61_000;});
  const event=await waitForUrgent(s,{timeout:300,stopFile,since:context(s).snapshot_cursor,idleMinutes:1});
  assert.equal(event.reason,'open-work');assert.deepEqual(event.tasks,[free.id],'only the takeable task is named');
});
