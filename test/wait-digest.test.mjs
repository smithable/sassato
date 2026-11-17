import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../dist/storage.js';
import { initWorkspace,showRecord } from '../dist/admin.js';
import { send,inbox,acknowledge,acknowledgeMany } from '../dist/coordination.js';
import { addTask,takeTask,doneTask,submitTask,askHuman,answerQuestion } from '../dist/tasks.js';
import { requestSupervisorPing,acknowledgeSupervisorPing } from '../dist/supervisor-monitor.js';
import { requestStop } from '../dist/control.js';
import { waitForWork } from '../dist/mail-wait.js';
import { DIGEST_LIMIT,formatDigest } from '../dist/wait-digest.js';
import { fixtureConfig } from './fixtures/team.mjs';
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-digest-')),path=join(dir,'state.db'),s=new Store(path,'human',{create:true});initWorkspace(s,'team',fixtureConfig);s.use('team');
  const reader=new Store(path,'b',{readonly:true});reader.use('team');t.after(()=>{reader.close();s.close();rmSync(dir,{recursive:true,force:true});});
  return {s,reader,path,stopFile:join(dir,'stop'),cursor:()=>Number(s.get('SELECT coalesce(max(id),0) n FROM events WHERE workspace_id=?',s.ws).n)};
}
function as(s,actor,fn){const old=s.actor;s.actor=actor;try{return fn();}finally{s.actor=old;}}
const mail=(f,body,options={})=>as(f.s,'a',()=>send(f.s,['b'],body,options));
const wait=(f,since,options={})=>waitForWork(f.reader,{since,stopFile:f.stopFile,timeout:3,settle:1,settleMax:2,...options});
function later(t,ms,fn){const timer=setTimeout(fn,ms);t.after(()=>clearTimeout(timer));}
test('message aliases are rejected before atomic acknowledgement and canonical now lookup is exact',t=>{
  const f=fixture(t),one=mail(f,'Immediate',{now:true}),before=f.cursor();
  for(const alias of [one.id.toLowerCase(),'M0'+one.id.slice(1),' '+one.id]) {
    as(f.s,'b',()=>assert.throws(()=>acknowledgeMany(f.s,[one.id,alias]),/Expected M/));
    assert.equal(f.cursor(),before);
    assert.throws(()=>showRecord(f.s,alias));
  }
  assert.equal(showRecord(f.s,one.id).now,true);
  as(f.s,'b',()=>assert.equal(acknowledgeMany(f.s,[one.id,one.id]).length,1));
  assert.equal(f.s.get("SELECT count(*) n FROM events WHERE entity='message' AND entity_id=? AND action='done'",one.id).n,1);
});
test('one bounded digest groups a burst without consuming receipts or saving progress',async t=>{
  const f=fixture(t),since=f.cursor();mail(f,'Please choose\n'+ 'word '.repeat(50),{urgent:true,needsReply:true});
  const task=as(f.s,'human',()=>addTask(f.s,{title:'Assigned work',owner:'b'}));
  const review=as(f.s,'human',()=>addTask(f.s,{title:'Review implementation',owner:'a'}));as(f.s,'a',()=>{takeTask(f.s,review.id);submitTask(f.s,review.id,'Ready',['b']);});
  const finished=as(f.s,'b',()=>addTask(f.s,{title:'Completed prerequisite',owner:'a'}));as(f.s,'a',()=>{takeTask(f.s,finished.id);doneTask(f.s,finished.id);});
  const ordinary=mail(f,'Progress update');const before=f.cursor(),receipts=JSON.stringify(f.s.all('SELECT * FROM receipts'));
  const result=await wait(f,since);assert.equal(result.reason,'digest');assert.equal(result.digest.flush,'quiet');
  assert.ok(result.digest.entries.some(e=>e.group==='needs-a-decision'));assert.ok(result.digest.entries.some(e=>e.group==='review-requested'));
  assert.ok(result.digest.entries.some(e=>e.group==='finished'&&e.task===finished.id));assert.ok(result.digest.entries.some(e=>e.id===ordinary.id));
  assert.ok(result.digest.entries.some(e=>e.task===task.id));assert.ok(result.digest.entries.every(e=>Array.from(e.summary).length<=160&&!/[\r\n\x1b]/.test(e.summary)));
  assert.equal(JSON.stringify(f.s.all('SELECT * FROM receipts')),receipts);assert.equal(f.cursor(),before);
  const output=formatDigest(result.digest,result.cursor);assert.match(output,/needs-a-decision:/);assert.match(output,/review-requested:/);assert.match(output,/finished:/);assert.match(output,/cursor \d+/);
});
test('new relevant arrivals extend quiet time; repeated pending urgent mail does not',async t=>{
  const f=fixture(t),since=f.cursor(),first=mail(f,'Urgent',{urgent:true});later(t,650,()=>mail(f,'A later relevant update'));
  const started=performance.now(),result=await wait(f,since,{settleMax:3});
  assert.equal(result.digest.flush,'quiet');assert.equal(result.digest.entries.filter(e=>e.id===first.id).length,1);assert.equal(result.digest.total,2);assert.ok(performance.now()-started>=1500);
});
test('maximum window bounds continuously arriving relevant traffic',async t=>{
  const f=fixture(t),since=f.cursor();mail(f,'First',{urgent:true});let n=0;const interval=setInterval(()=>mail(f,'Update '+n++),120);t.after(()=>clearInterval(interval));
  const result=await wait(f,since,{settle:2,settleMax:1});assert.equal(result.digest.flush,'max');assert.ok(result.digest.total>1);
});
test('unrelated traffic never extends the role quiet window',async t=>{
  const f=fixture(t),since=f.cursor();mail(f,'First',{urgent:true});const interval=setInterval(()=>as(f.s,'a',()=>send(f.s,['c'],'Unrelated',{urgent:true})),120);t.after(()=>clearInterval(interval));
  const result=await wait(f,since);assert.equal(result.digest.flush,'quiet');assert.equal(result.digest.total,1);
});
test('now is durable, implies urgent, and preempts older urgent mail without skipping it',async t=>{
  const f=fixture(t),since=f.cursor(),older=mail(f,'Ordinary urgency',{urgent:true}),immediate=mail(f,'Broken main',{now:true});
  assert.equal(immediate.urgent,true);assert.equal(immediate.now,true);assert.equal(showRecord(f.s,immediate.id).now,true);
  assert.equal(as(f.s,'b',()=>inbox(f.s,{peek:true})).find(m=>m.id===immediate.id).now,true);
  const result=await wait(f,since,{settle:120,settleMax:600});assert.equal(result.reason,'urgent');assert.equal(result.message.id,immediate.id);assert.equal(result.digest.flush,'immediate');assert.equal(result.cursor,since);
  as(f.s,'b',()=>acknowledge(f.s,immediate.id));const next=await wait(f,result.cursor,{timeout:1});assert.ok(next.digest.entries.some(e=>e.id===older.id));
});
test('STOP during collection returns buffered work and wins before other notifications',async t=>{
  const f=fixture(t),since=f.cursor(),message=mail(f,'Pending',{urgent:true});later(t,80,()=>as(f.s,'human',()=>requestStop(f.s,['b'])));
  const result=await wait(f,since,{settle:120,settleMax:600});assert.equal(result.reason,'stop');assert.equal(result.digest.flush,'immediate');assert.ok(result.digest.entries.some(e=>e.id===message.id));
  assert.equal(as(f.s,'b',()=>inbox(f.s,{peek:true}))[0].state,'unread');assert.equal((await wait(f,result.cursor)).reason,'stop');
});
test('legacy stop file preempts a collecting digest',async t=>{
  const f=fixture(t),since=f.cursor();mail(f,'Pending',{urgent:true});later(t,80,()=>writeFileSync(f.stopFile,''));
  assert.equal((await wait(f,since,{settle:120,settleMax:600})).reason,'stop');
});
test('a human answer preempts the quiet window and is returned with pending notifications',async t=>{
  const f=fixture(t),task=as(f.s,'b',()=>addTask(f.s,{title:'Decision'})),q=as(f.s,'b',()=>askHuman(f.s,task.id,{question:'Proceed?'})),since=f.cursor();mail(f,'Pending',{urgent:true});
  later(t,80,()=>as(f.s,'human',()=>answerQuestion(f.s,q.id,'Yes')));
  const result=await wait(f,since,{settle:120,settleMax:600});assert.equal(result.reason,'answer');assert.equal(result.question,q.id);assert.equal(result.digest.flush,'immediate');assert.ok(result.digest.entries.some(e=>e.id===q.id));
});
test('capacity never advances the cursor past an omitted notification',async t=>{
  const f=fixture(t),since=f.cursor(),messages=Array.from({length:DIGEST_LIMIT+5},(_,i)=>mail(f,'Request '+i,{needsReply:true}));
  const first=await wait(f,since);assert.equal(first.digest.flush,'capacity');assert.equal(first.digest.total,DIGEST_LIMIT);
  const next=await wait(f,first.cursor,{timeout:1});assert.equal(next.digest.total,5);assert.deepEqual([...first.digest.entries,...next.digest.entries].map(e=>e.id),messages.map(m=>m.id));
  assert.ok(next.cursor>first.cursor);assert.ok(f.s.all('SELECT state FROM receipts').every(r=>r.state==='unread'));
});
test('unacknowledged urgent digest survives interruption and can continue after batch acknowledgement',async t=>{
  const f=fixture(t),since=f.cursor(),messages=Array.from({length:DIGEST_LIMIT+1},(_,i)=>mail(f,'Urgent '+i,{urgent:true}));
  const first=await wait(f,since);assert.equal(first.digest.total,DIGEST_LIMIT);assert.equal(first.cursor,since);
  const replay=await wait(f,since);assert.deepEqual(replay.digest.entries.map(e=>e.id),first.digest.entries.map(e=>e.id));
  as(f.s,'b',()=>acknowledgeMany(f.s,first.digest.entries.map(e=>e.id)));
  const next=await wait(f,first.cursor,{timeout:1});assert.equal(next.digest.total,1);assert.equal(next.digest.entries[0].id,messages.at(-1).id);
});
test('agent default is 120/600, overall timeout flushes work, and human/explicit-zero retain immediate mode',async t=>{
  const f=fixture(t),since=f.cursor();mail(f,'Default',{urgent:true});
  const result=await waitForWork(f.reader,{since,timeout:1,stopFile:f.stopFile});assert.equal(result.reason,'digest');assert.equal(result.digest.settle,120);assert.equal(result.digest.settle_max,600);assert.equal(result.digest.flush,'deadline');
  assert.equal((await wait(f,since,{settle:0})).reason,'urgent');
  as(f.s,'a',()=>send(f.s,['human'],'For operator',{urgent:true}));f.reader.actor='human';
  assert.equal((await waitForWork(f.reader,{since,timeout:1,stopFile:f.stopFile})).reason,'urgent');
});
test('multi-ack is atomic, deduplicated and idempotent; single-ack return stays compatible',t=>{
  const f=fixture(t),one=mail(f,'One'),two=mail(f,'Two'),foreign=as(f.s,'a',()=>send(f.s,['c'],'Foreign'));
  as(f.s,'b',()=>{
    assert.throws(()=>acknowledgeMany(f.s,[one.id,foreign.id]),/not addressed/);assert.equal(inbox(f.s,{peek:true})[0].state,'unread');
    assert.throws(()=>acknowledgeMany(f.s,[one.id,'bad']),/Expected M/);assert.equal(inbox(f.s,{peek:true})[0].state,'unread');
    const rows=acknowledgeMany(f.s,[one.id,two.id,one.id]);assert.equal(rows.length,2);assert.ok(rows.every(r=>r.state==='done'));const cursor=f.cursor();
    acknowledgeMany(f.s,[one.id,two.id]);assert.equal(f.cursor(),cursor);assert.equal(acknowledge(f.s,one.id).message_id,one.id);
  });
});
test('CLI validates settle flags and supports now plus atomic multi-id ack',t=>{
  const f=fixture(t),run=(...args)=>spawnSync(process.execPath,[resolve('bin/sassato.js'),'--db',f.path,'--workspace','team','--json',...args],{encoding:'utf8',timeout:5000});
  const first=run('send','b','Immediate','--now','--as','a');assert.equal(first.status,0,first.stderr);const one=JSON.parse(first.stdout);assert.equal(one.now,true);
  const two=mail(f,'Also acknowledge');assert.equal(run('ack',one.id,two.id,'--as','b').status,0);
  for(const args of [['--settle','-1'],['--settle-max','0']])assert.equal(run('wait','--since',String(f.cursor()),'--timeout','1','--as','b',...args).status,2);
});

test('human answers bypass an overflowing urgent-mail page while the continuation stays safe',async t=>{
  const f=fixture(t),task=as(f.s,'b',()=>addTask(f.s,{title:'Backlogged decision'})),question=as(f.s,'b',()=>askHuman(f.s,task.id,{question:'Proceed?'})),since=f.cursor();
  const mailItems=Array.from({length:DIGEST_LIMIT+1},(_,i)=>mail(f,'Backlog '+i,{urgent:true}));as(f.s,'human',()=>answerQuestion(f.s,question.id,'Yes'));
  const first=await wait(f,since,{settle:120,settleMax:600});assert.equal(first.reason,'answer');assert.equal(first.question,question.id);assert.equal(first.cursor,since);assert.equal(first.digest.total,DIGEST_LIMIT);assert.equal(first.digest.has_more,true);
  assert.ok(first.digest.entries.some(e=>e.id===question.id));
  as(f.s,'b',()=>acknowledgeMany(f.s,first.digest.entries.filter(e=>e.id.startsWith('M')).map(e=>e.id)));
  const next=await wait(f,first.cursor,{settle:120,settleMax:600});assert.equal(next.reason,'answer');assert.ok(next.cursor>first.cursor);assert.equal(next.digest.has_more,false);
  assert.ok(next.digest.entries.some(e=>e.id===mailItems.at(-1).id));
});
test('supervisor pings bypass an overflowing urgent-mail page and still require explicit nonce acknowledgement',async t=>{
  const f=fixture(t),since=f.cursor();Array.from({length:DIGEST_LIMIT+1},(_,i)=>mail(f,'Backlog '+i,{urgent:true}));
  const ping=as(f.s,'human',()=>requestSupervisorPing(f.s,'b'));
  const result=await wait(f,since,{settle:120,settleMax:600});assert.equal(result.reason,'supervisor-ping');assert.equal(result.nonce,ping.nonce);assert.equal(result.cursor,since);assert.equal(result.digest.has_more,true);
  as(f.s,'b',()=>acknowledgeSupervisorPing(f.s,ping.nonce,0));
  const next=await wait(f,result.cursor);assert.equal(next.reason,'digest');assert.equal(next.digest.flush,'capacity');
});

test('an earlier replayed answer cannot hide a later supervisor ping behind urgent mail',async t=>{
  const f=fixture(t),task=as(f.s,'b',()=>addTask(f.s,{title:'Earlier decision'})),q=as(f.s,'b',()=>askHuman(f.s,task.id,{question:'Proceed?'})),since=f.cursor();
  Array.from({length:DIGEST_LIMIT+1},(_,i)=>mail(f,'Unacknowledged '+i,{urgent:true}));as(f.s,'human',()=>answerQuestion(f.s,q.id,'Yes'));
  const ping=as(f.s,'human',()=>requestSupervisorPing(f.s,'b'));
  const first=await wait(f,since,{settle:120,settleMax:600});assert.equal(first.reason,'supervisor-ping');assert.equal(first.nonce,ping.nonce);assert.equal(first.cursor,since);
  assert.ok(first.digest.entries.some(e=>e.id===q.id));assert.ok(first.digest.entries.some(e=>e.summary.includes(ping.nonce)));
  as(f.s,'b',()=>acknowledgeSupervisorPing(f.s,ping.nonce,0));
  const next=await wait(f,first.cursor,{settle:120,settleMax:600});assert.equal(next.reason,'answer');assert.equal(next.question,q.id);
  const newer=as(f.s,'human',()=>requestSupervisorPing(f.s,'b',Date.now()+61_000));
  assert.equal((await wait(f,next.cursor,{settle:120,settleMax:600})).nonce,newer.nonce,'mail need not be ACKed to reach another ping');
});
test('a malformed older answer audit entry cannot mask the next valid answer',async t=>{
  const f=fixture(t),one=as(f.s,'b',()=>addTask(f.s,{title:'Old decision'})),two=as(f.s,'b',()=>addTask(f.s,{title:'New decision'}));
  const q1=as(f.s,'b',()=>askHuman(f.s,one.id,{question:'First?'})),q2=as(f.s,'b',()=>askHuman(f.s,two.id,{question:'Second?'})),since=f.cursor();
  f.s.run("INSERT INTO events(workspace_id,entity,entity_id,actor,action,detail,created_at) VALUES(?,'question',?,'human','answered','{invalid',?)",f.s.ws,q1.id,new Date().toISOString());
  as(f.s,'human',()=>{answerQuestion(f.s,q1.id,'Yes');answerQuestion(f.s,q2.id,'Yes');});
  const result=await wait(f,since,{settle:120,settleMax:600});assert.equal(result.reason,'answer');assert.equal(result.question,q1.id);
});
