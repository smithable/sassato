import { fixtureConfig } from './fixtures/team.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/storage.js';
import {initWorkspace} from '../dist/admin.js';
import {send,inbox,acknowledge} from '../dist/coordination.js';
import {requestStop,resumeWork,acknowledgeStop} from '../dist/control.js';
import {addTask,askHuman,answerQuestion,blockTask,resolveBlocker,addDependency,removeDependency,takeTask,doneTask,dropTask,reopenTask,releaseTask,handoffTask,updateTask} from '../dist/tasks.js';
import {waitForWork} from '../dist/mail-wait.js';
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'sassato-workwait-')),path=join(dir,'state.db'),s=new Store(path,'human',{create:true});
  initWorkspace(s,'team',fixtureConfig);s.use('team');const reader=new Store(path,'a',{readonly:true});reader.use('team');
  t.after(()=>{reader.close();s.close();rmSync(dir,{recursive:true,force:true});});
  return {s,reader,stopFile:join(dir,'stop'),cursor:()=>s.get('SELECT coalesce(max(id),0) n FROM events WHERE workspace_id=?',s.ws).n};
}
function as(s,role,fn){const old=s.actor;s.actor=role;try{return fn();}finally{s.actor=old;}}
const task=(s,title,owner='a')=>addTask(s,{title,owner});
const wait=(f,since,extra={})=>waitForWork(f.reader,{timeout:1,stopFile:f.stopFile,...(since===undefined?{}:{since}),...extra});
const finish=(s,id)=>as(s,s.task(id).owner??'human',()=>{takeTask(s,id);doneTask(s,id);});

test('human answer wakes once with its canonical event, without consuming ordinary mail',async t=>{
  const f=fixture(t),work=task(f.s,'Need decision'),question=as(f.s,'a',()=>askHuman(f.s,work.id,{question:'Use option one?'})),since=f.cursor();
  answerQuestion(f.s,question.id,'Yes');
  const first=await wait(f,since);assert.equal(first.reason,'answer');assert.equal(first.question,question.id);assert.equal(first.task,work.id);
  assert.equal(f.s.get('SELECT entity FROM events WHERE id=?',first.cursor).entity,'question');
  assert.equal((await wait(f,first.cursor)).reason,'timeout');
  assert.ok(as(f.s,'a',()=>inbox(f.s,{peek:true})).some(m=>m.state==='unread'));
});

test('answers reach original asker after handoff and after explicit human task closure',async t=>{
  const f=fixture(t),work=task(f.s,'Ask then handoff'),question=as(f.s,'a',()=>askHuman(f.s,work.id,{question:'Proceed?'}));
  handoffTask(f.s,work.id,'b','B handles implementation');const since=f.cursor();answerQuestion(f.s,question.id,'Yes');
  assert.equal((await wait(f,since)).reason,'answer');
  const human=addTask(f.s,{title:'Human decision',humanOnly:true}),q=askHuman(f.s,human.id,{question:'Approve and close?'}),cursor=f.cursor();answerQuestion(f.s,q.id,'Approved',{close:true});
  f.reader.actor='human';const closed=await wait(f,cursor);assert.equal(closed.reason,'timeout','own answer must not wake the answering human');assert.equal(f.s.task(human.id).status,'done');
});

test('resolved blocker wakes its owner even when another blocker still holds the task',async t=>{
  const f=fixture(t),work=task(f.s,'Two blockers'),one=blockTask(f.s,work.id,{kind:'agent',waitingOn:'b',body:'First'});
  blockTask(f.s,work.id,{kind:'external',waitingOn:'release',body:'Second'});const since=f.cursor();resolveBlocker(f.s,one.id,'First cleared');
  const result=await wait(f,since);assert.equal(result.reason,'blocker-resolved');assert.equal(result.blocker,one.id);assert.equal(result.task,work.id);assert.equal(f.s.task(work.id).status,'blocked');
});

test('one completion returns every eligible dependent and rearm does not lose a later event',async t=>{
  const f=fixture(t),dep=task(f.s,'Prerequisite','b'),one=task(f.s,'Ready one'),two=task(f.s,'Ready two'),foreign=task(f.s,'Other owner','c'),blocked=task(f.s,'Still blocked');
  for(const work of [one,two,foreign,blocked])addDependency(f.s,work.id,dep.id);
  blockTask(f.s,blocked.id,{kind:'external',waitingOn:'outside',body:'Independent blocker'});
  const since=f.cursor();finish(f.s,dep.id);const later=task(f.s,'Arrives between waits');
  const first=await wait(f,since);assert.equal(first.reason,'task-ready');assert.deepEqual(first.tasks,[one.id,two.id]);
  const next=await wait(f,first.cursor);assert.equal(next.reason,'task-assigned');assert.equal(next.task,later.id);assert.ok(next.cursor>first.cursor);
  assert.equal((await wait(f,next.cursor)).reason,'timeout');
});

test('explicit snapshot baseline ignores historical workflow and a read-only waiter sees later commits',async t=>{
  const f=fixture(t);task(f.s,'Historical available work');send(f.s,['a'],'Ordinary mail');
  let fresh;const pending=wait(f,f.cursor(),{timeout:2});
  const timer=setTimeout(()=>{assert.equal(f.reader.db.isTransaction,false);fresh=task(f.s,'Created after wait starts');},30);t.after(()=>clearTimeout(timer));
  const result=await pending;assert.equal(result.reason,'task-assigned');assert.equal(result.task,fresh.id);
  const snapshot=f.s.get('SELECT count(*) n FROM events').n;assert.equal((await wait(f,result.cursor)).reason,'timeout');assert.equal(f.s.get('SELECT count(*) n FROM events').n,snapshot);
});

test('ordinary mail, other workspace, wrong target, human-only and already claimed work do not wake',async t=>{
  const f=fixture(t),since=f.cursor();send(f.s,['a'],'Ignore ordinary mail');task(f.s,'Other role','b');
  addTask(f.s,{title:'For another role',forRole:'b'});addTask(f.s,{title:'Human only',humanOnly:true});
  const claimed=addTask(f.s,{title:'Claimed before catchup'});as(f.s,'b',()=>takeTask(f.s,claimed.id));
  const closed=task(f.s,'Closed before catchup');finish(f.s,closed.id);
  const reassigned=task(f.s,'Reassigned before catchup');handoffTask(f.s,reassigned.id,'c','Other role owns this now');
  initWorkspace(f.s,'other',fixtureConfig);task(f.s,'Foreign workspace');send(f.s,['a'],'Foreign urgent',{urgent:true});f.s.use('team');
  const result=await wait(f,since);assert.equal(result.reason,'timeout');assert.equal(result.cursor,f.cursor());
});

test('release, reopen, target edits, permission edits and dependency removal produce readiness',async t=>{
  const f=fixture(t),released=task(f.s,'Release','b');as(f.s,'b',()=>takeTask(f.s,released.id));let cursor=f.cursor();releaseTask(f.s,released.id,'Available to others');
  let result=await wait(f,cursor);assert.equal(result.reason,'task-ready');assert.equal(result.task,released.id);
  const reopened=task(f.s,'Reopen');dropTask(f.s,reopened.id,'Pause');cursor=f.cursor();reopenTask(f.s,reopened.id,'Resume');
  result=await wait(f,cursor);assert.equal(result.task,reopened.id);
  const target=addTask(f.s,{title:'Change target',forRole:'b'});cursor=f.cursor();updateTask(f.s,target.id,{version:target.version,forRole:'a'});
  result=await wait(f,cursor);assert.equal(result.reason,'task-assigned');assert.equal(result.task,target.id);
  const human=addTask(f.s,{title:'Change classification',humanOnly:true});cursor=f.cursor();updateTask(f.s,human.id,{version:human.version,humanOnly:false,forRole:null});
  result=await wait(f,cursor);assert.equal(result.reason,'task-ready');assert.equal(result.task,human.id);
  const dep=task(f.s,'Dependency','b'),work=task(f.s,'Remove dependency');addDependency(f.s,work.id,dep.id);cursor=f.cursor();removeDependency(f.s,work.id,dep.id);
  result=await wait(f,cursor);assert.equal(result.reason,'task-ready');assert.equal(result.task,work.id);
  const handed=task(f.s,'Handoff','b');cursor=f.cursor();handoffTask(f.s,handed.id,'a','Take over');result=await wait(f,cursor);assert.equal(result.reason,'task-assigned');assert.equal(result.task,handed.id);
});

test('dropped dependency notifies dependents without making work available',async t=>{
  const f=fixture(t),dep=task(f.s,'Dependency','b'),work=task(f.s,'Dependent');addDependency(f.s,work.id,dep.id);
  const locked=addTask(f.s,{title:'Target retained',owner:'b',forRole:'b'});const since=f.cursor();dropTask(f.s,dep.id,'Cancelled');releaseTask(f.s,locked.id,'Still for B');
  const event=await wait(f,since);assert.equal(event.reason,'dependency-dropped');assert.equal(event.task,dep.id);assert.deepEqual(event.tasks,[work.id]);
  assert.throws(()=>as(f.s,'a',()=>takeTask(f.s,work.id)),/blockers|dependenc/i);
  assert.equal((await wait(f,event.cursor)).reason,'timeout');
});

test('urgent and stop have priority but never skip queued workflow on rearm',async t=>{
  const f=fixture(t),since=f.cursor(),work=task(f.s,'Queued workflow');send(f.s,['a'],'Urgent action',{urgent:true});requestStop(f.s,['a']);
  const stopped=await wait(f,since);assert.equal(stopped.reason,'stop');assert.equal(stopped.cursor,since);resumeWork(f.s,['a']);
  const urgent=await wait(f,stopped.cursor);assert.equal(urgent.reason,'urgent');assert.equal(urgent.cursor,since);as(f.s,'a',()=>{inbox(f.s);acknowledge(f.s,urgent.message.id);});
  const event=await wait(f,urgent.cursor);assert.equal(event.reason,'task-assigned');assert.equal(event.task,work.id);
});

test('event batches preserve catchup and reject invalid cursors',async t=>{
  const f=fixture(t),since=f.cursor();for(let i=0;i<205;i++)f.s.event('workspace','team','irrelevant',{i});const work=task(f.s,'After a batch');
  const result=await wait(f,since);assert.equal(result.task,work.id);assert.equal(result.cursor,f.cursor());
  await assert.rejects(()=>wait(f,-1),/cursor/);await assert.rejects(()=>wait(f,1.5),/cursor/);
});


test('blocked handoffs and assignments wake their recipient without claiming readiness',async t=>{
  const f=fixture(t),dep=task(f.s,'Unfinished prerequisite','b'),work=task(f.s,'Hand off blocked work','b');
  blockTask(f.s,work.id,{kind:'external',waitingOn:'outside',body:'Still blocked'});addDependency(f.s,work.id,dep.id);
  const since=f.cursor();handoffTask(f.s,work.id,'a','New responsibility');
  const result=await wait(f,since);assert.equal(result.reason,'task-assigned');assert.equal(result.task,work.id);assert.equal(f.s.task(work.id).status,'blocked');
  assert.equal((await wait(f,result.cursor)).reason,'timeout');
  const next=f.cursor(),assigned=task(f.s,'New assignment with dependency');addDependency(f.s,assigned.id,dep.id);
  const event=await wait(f,next);assert.equal(event.reason,'task-assigned');assert.equal(event.task,assigned.id);
});


test('future workspace cursors fail clearly instead of suppressing future work',async t=>{
  const f=fixture(t);await assert.rejects(()=>wait(f,f.cursor()+1),/cursor.*ahead.*workspace/i);
});

test('import repair opening a task wakes an eligible role',async t=>{
  const f=fixture(t),work=task(f.s,'Legacy reconciliation'),blocker=blockTask(f.s,work.id,{kind:'human',waitingOn:'human',body:'Legacy blocker'}),since=f.cursor();
  // Fixture the import repair transaction: its one event owns both metadata changes.
  f.s.tx(()=>{
    f.s.run("UPDATE blockers SET status='resolved' WHERE workspace_id=? AND id=?",f.s.ws,Number(blocker.id.slice(1)));
    f.s.run("UPDATE tasks SET status='open',version=version+1 WHERE workspace_id=? AND id=?",f.s.ws,Number(work.id.slice(1)));
    f.s.event('task',work.id,'import-repaired',{before:{task:{status:'blocked'}},after:{task:{status:'open'}}});
  });
  const result=await wait(f,since);assert.equal(result.reason,'task-ready');assert.equal(result.task,work.id);
});

test('dependency completion and removal wake owned doing work but respect other gates',async t=>{
  const f=fixture(t),dep=task(f.s,'Prerequisite','b'),own=task(f.s,'Already working'),other=task(f.s,'Other role working','c'),blocked=task(f.s,'Working but otherwise blocked');
  for(const work of [own,other,blocked]){as(f.s,work.owner,()=>takeTask(f.s,work.id));addDependency(f.s,work.id,dep.id);}
  blockTask(f.s,blocked.id,{kind:'external',waitingOn:'outside',body:'Still blocked'});
  const since=f.cursor();finish(f.s,dep.id);const result=await wait(f,since);
  assert.equal(result.reason,'task-ready');assert.deepEqual(result.tasks,[own.id]);assert.equal(f.s.task(own.id).status,'doing');
  const missing=task(f.s,'Unfinished prerequisite','b');addDependency(f.s,own.id,missing.id);const cursor=f.cursor();removeDependency(f.s,own.id,missing.id);
  const removed=await wait(f,cursor);assert.equal(removed.reason,'task-ready');assert.deepEqual(removed.tasks,[own.id]);
});


test('queued self actions are skipped without losing other-role blocker notifications',async t=>{
  const f=fixture(t),work=task(f.s,'Reconcile blockers'),blockers=[];
  for(let i=0;i<4;i++)blockers.push(blockTask(f.s,work.id,{kind:'agent',waitingOn:'b',body:`Blocker ${i}`}));
  const since=f.cursor();as(f.s,'a',()=>{for(const blocker of blockers.slice(0,3))resolveBlocker(f.s,blocker.id,'Resolved during own reconciliation');});
  resolveBlocker(f.s,blockers[3].id,'Human cleared the remaining blocker');
  const external=await wait(f,since);assert.equal(external.reason,'blocker-resolved');assert.equal(external.blocker,blockers[3].id);
  const next=blockTask(f.s,work.id,{kind:'external',waitingOn:'service',body:'One more'});
  as(f.s,'a',()=>resolveBlocker(f.s,next.id,'I checked it'));as(f.s,'a',()=>addTask(f.s,{title:'Own assignment',owner:'a'}));
  const skipped=await wait(f,external.cursor);assert.equal(skipped.reason,'timeout');assert.equal(skipped.cursor,f.cursor());
  assert.equal((await wait(f,skipped.cursor)).reason,'timeout','rearm never loops on skipped self events');
});

test('self completion still wakes other dependent roles and own STOP takes priority',async t=>{
  const f=fixture(t),dep=task(f.s,'My prerequisite'),own=task(f.s,'My dependent'),other=task(f.s,'Other dependent','b');
  addDependency(f.s,own.id,dep.id);addDependency(f.s,other.id,dep.id);const since=f.cursor();finish(f.s,dep.id);
  const self=await wait(f,since);assert.equal(self.reason,'timeout');
  f.reader.actor='b';const notification=await wait(f,since);assert.equal(notification.reason,'task-ready');assert.deepEqual(notification.tasks,[other.id]);
  const stop=requestStop(f.s,['a'])[0];as(f.s,'a',()=>acknowledgeStop(f.s,stop.id));f.reader.actor='a';const stopped=await wait(f,since);assert.equal(stopped.reason,'stop');assert.equal(stopped.cursor,since);
});

test('self-sent urgent mail does not wake or consume mail, while other senders still wake',async t=>{
  const f=fixture(t),since=f.cursor();as(f.s,'a',()=>send(f.s,['a'],'Reminder to myself',{urgent:true}));
  const result=await wait(f,since);assert.equal(result.reason,'timeout');
  assert.equal(as(f.s,'a',()=>inbox(f.s,{peek:true}))[0].state,'unread');
  const external=send(f.s,['a'],'Human urgent update',{urgent:true});const next=await wait(f,result.cursor);
  assert.equal(next.reason,'urgent');assert.equal(next.message.id,external.id);
});

test('new blockers wake the role being waited on and ignore resolved or unrelated blockers',async t=>{
  const f=fixture(t),work=task(f.s,'Needs another role','b'),since=f.cursor();
  const blocker=as(f.s,'b',()=>blockTask(f.s,work.id,{kind:'agent',waitingOn:'a',body:'Please inspect the failure'}));
  const result=await wait(f,since);assert.equal(result.reason,'blocker-assigned');assert.equal(result.blocker,blocker.id);assert.equal(result.task,work.id);
  const unrelated=as(f.s,'b',()=>blockTask(f.s,work.id,{kind:'agent',waitingOn:'c',body:'Other role input'}));
  const obsolete=as(f.s,'b',()=>blockTask(f.s,work.id,{kind:'agent',waitingOn:'a',body:'Already settled'}));
  resolveBlocker(f.s,obsolete.id,'Resolved before the waiter returned');
  assert.equal((await wait(f,result.cursor)).reason,'timeout');
  resolveBlocker(f.s,blocker.id,'Settled original request');resolveBlocker(f.s,unrelated.id,'Settled other request');
  assert.equal((await wait(f,since)).reason,'timeout','resolved assignments should not resurface after restart');
});

test('dropped dependencies notify blocked or review owners but ignore unrelated and withdrawn work',async t=>{
  const f=fixture(t),dependency=task(f.s,'Shared prerequisite','b'),owned=task(f.s,'My blocked work'),foreign=task(f.s,'Other role work','c'),withdrawn=task(f.s,'Withdrawn work');
  for(const work of [owned,foreign,withdrawn])addDependency(f.s,work.id,dependency.id);
  blockTask(f.s,owned.id,{kind:'external',waitingOn:'service',body:'Also waiting externally'});dropTask(f.s,withdrawn.id,'Withdrawn');
  const since=f.cursor();dropTask(f.s,dependency.id,'Cancelled');
  const result=await wait(f,since);assert.equal(result.reason,'dependency-dropped');assert.deepEqual(result.tasks,[owned.id]);
  assert.equal(f.s.task(owned.id).status,'blocked');
  reopenTask(f.s,dependency.id,'Restored');assert.equal((await wait(f,since)).reason,'timeout','a reopened prerequisite supersedes its old drop notification');
});
