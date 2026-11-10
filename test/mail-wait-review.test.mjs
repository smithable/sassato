import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { context,send,inbox,acknowledge } from '../dist/coordination.js';
import { requestStop,resumeWork } from '../dist/control.js';
import { addTask,takeTask,submitTask,reviewTask,updateTask,showTask,doneTask,dropTask,noteTask,reopenTask,blockTask,resolveBlocker,askHuman,answerQuestion } from '../dist/tasks.js';
import { waitForWork } from '../dist/mail-wait.js';
import { fixtureConfig } from './fixtures/team.mjs';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-reviewwait-')),path=join(dir,'state.db'),s=new Store(path,'human',{create:true});
  initWorkspace(s,'team',fixtureConfig);s.use('team');
  const reader=new Store(path,'b',{readonly:true});reader.use('team');
  t.after(()=>{reader.close();s.close();rmSync(dir,{recursive:true,force:true});});
  return {s,reader,stopFile:join(dir,'stop'),cursor:()=>Number(s.get('SELECT coalesce(max(id),0) n FROM events WHERE workspace_id=?',s.ws).n)};
}
function as(s,role,fn){const original=s.actor;s.actor=role;try{return fn();}finally{s.actor=original;}}
function work(f,owner='a',humanOnly=false) {
  const task=addTask(f.s,{title:'Review this implementation',owner,forRole:owner,reviewRequired:true,humanOnly});
  as(f.s,owner,()=>takeTask(f.s,task.id));return task;
}
function submit(f,task){return as(f.s,f.s.task(task.id).owner,()=>submitTask(f.s,task.id,'Implementation and tests ready'));}
function review(f,task,approve,reviewer='b') {
  return as(f.s,reviewer,()=>reviewTask(f.s,task.id,{approve,note:approve?'Reviewed current version':'Revise the edge case',expected_version:showTask(f.s,task.id).version}));
}
function wait(f,role,since,extra={}) {f.reader.actor=role;return waitForWork(f.reader,{since,timeout:1,stopFile:f.stopFile,...extra});}

test('dropping and reopening supersedes a prior rejection held by a late waiter',async t=>{
  const f=fixture(t),task=work(f);submit(f,task);const since=f.cursor();review(f,task,false);
  dropTask(f.s,task.id,'Close old attempt');reopenTask(f.s,task.id,'New attempt');
  as(f.s,'a',()=>takeTask(f.s,task.id));
  assert.equal((await wait(f,'a',since)).reason,'timeout');
  submit(f,task);review(f,task,false);
  assert.equal((await wait(f,'a',since)).reason,'review-rejected','a new rejection still wakes its owner');
});

test('untargeted submission wakes independent reviewers from a retained context cursor without mutations',async t=>{
  const f=fixture(t),task=work(f),since=context(f.reader).snapshot_cursor;
  const submitted=submit(f,task),before=JSON.stringify(f.s.task(task.id)),events=f.cursor();
  const notified=await wait(f,'b',since);
  assert.equal(notified.reason,'review-submitted');assert.equal(notified.task,task.id);assert.equal(notified.version,submitted.version);
  assert.equal(notified.cursor,events);assert.equal(JSON.stringify(f.s.task(task.id)),before);assert.equal(f.cursor(),events);
  const another=await wait(f,'c',since);assert.equal(another.reason,'review-submitted');assert.equal(another.task,task.id);
  assert.equal((await wait(f,'a',since)).reason,'timeout','agent owners cannot be their own reviewer');
  assert.equal((await wait(f,'b',notified.cursor)).reason,'timeout','rearming does not repeat a submission');
});

test('submit reject revise resubmit approve complete delivers distinct owner and reviewer events',async t=>{
  const f=fixture(t),task=work(f),beforeSubmit=f.cursor();submit(f,task);
  const first=await wait(f,'b',beforeSubmit);assert.equal(first.reason,'review-submitted');
  const ownerCursor=f.cursor(),rejected=review(f,task,false);
  const rejection=await wait(f,'a',ownerCursor);assert.equal(rejection.reason,'review-rejected');assert.equal(rejection.version,rejected.version);assert.equal(rejection.task,task.id);
  const mail=as(f.s,'a',()=>inbox(f.s,{peek:true}));assert.equal(mail.length,1);assert.equal(mail[0].state,'unread');assert.equal(mail[0].urgent,false);
  as(f.s,'a',()=>updateTask(f.s,task.id,{version:showTask(f.s,task.id).version,body:'Corrected edge case and checked tests'}));
  const resubmitted=submit(f,task);
  const second=await wait(f,'b',first.cursor);assert.equal(second.reason,'review-submitted');assert.equal(second.version,resubmitted.version);assert(second.cursor>first.cursor);
  const approved=review(f,task,true);
  const approval=await wait(f,'a',rejection.cursor);assert.equal(approval.reason,'review-approved');assert.equal(approval.version,approved.version);assert.equal(approval.task,task.id);
  const completed=as(f.s,'a',()=>doneTask(f.s,task.id));assert.equal(completed.status,'done');
  assert.equal((await wait(f,'a',approval.cursor)).reason,'timeout');
  assert.equal(as(f.s,'a',()=>inbox(f.s,{peek:true}))[0].state,'unread','workflow notifications do not consume ordinary rejection mail');
});

test('approval and rejection do not notify another reviewer, another owner or another workspace',async t=>{
  const f=fixture(t),task=work(f);submit(f,task);let since=f.cursor();review(f,task,false);
  assert.equal((await wait(f,'b',since)).reason,'timeout');
  assert.equal((await wait(f,'c',since)).reason,'timeout');
  submit(f,task);since=f.cursor();review(f,task,true);
  assert.equal((await wait(f,'b',since)).reason,'timeout');
  assert.equal((await wait(f,'c',since)).reason,'timeout');
  const baseline=f.cursor();initWorkspace(f.s,'other',fixtureConfig);
  const foreign=work(f);submit(f,foreign);review(f,foreign,false);submit(f,foreign);review(f,foreign,true);f.s.use('team');
  assert.equal((await wait(f,'b',baseline)).reason,'timeout');
  assert.equal((await wait(f,'a',baseline)).reason,'timeout');
});

test('STOP and urgent mail preserve a queued review event for cursor rearm',async t=>{
  const f=fixture(t),task=work(f),since=f.cursor();const submitted=submit(f,task);
  send(f.s,['b'],'An urgent decision',{urgent:true});requestStop(f.s,['b']);
  const stopped=await wait(f,'b',since);assert.equal(stopped.reason,'stop');assert.equal(stopped.cursor,since);resumeWork(f.s,['b']);
  const urgent=await wait(f,'b',stopped.cursor);assert.equal(urgent.reason,'urgent');assert.equal(urgent.cursor,since);
  as(f.s,'b',()=>{inbox(f.s);acknowledge(f.s,urgent.message.id);});
  const notification=await wait(f,'b',urgent.cursor);assert.equal(notification.reason,'review-submitted');assert.equal(notification.version,submitted.version);
  assert.equal((await wait(f,'b',notification.cursor)).reason,'timeout');
});

test('reviewer discovery follows existing human override and human-only review policy',async t=>{
  const f=fixture(t),task=work(f,'human',true),since=f.cursor();submit(f,task);
  assert.equal((await wait(f,'human',since)).reason,'timeout','human self-review is allowed, but own submission must not wake own waiter');
  assert.equal((await wait(f,'b',since)).reason,'review-submitted','human-only execution does not prohibit independent review');
  const approved=review(f,task,true,'human');assert.equal(approved.reviewed_by,'human');
});

test('settled or withdrawn submissions do not wake reviewers for obsolete work',async t=>{
  const f=fixture(t),approved=work(f),beforeApproval=f.cursor();submit(f,approved);review(f,approved,true,'c');
  assert.equal((await wait(f,'b',beforeApproval)).reason,'timeout');
  const dropped=work(f),beforeDrop=f.cursor();submit(f,dropped);dropTask(f.s,dropped.id,'No longer needed');
  assert.equal((await wait(f,'b',beforeDrop)).reason,'timeout');
});


test('late reviewer receives only the latest resubmission and cursor rearm does not repeat it',async t=>{
  const f=fixture(t),task=work(f),since=f.cursor();
  const obsolete=submit(f,task);review(f,task,false,'c');
  as(f.s,'a',()=>updateTask(f.s,task.id,{version:showTask(f.s,task.id).version,body:'Revised implementation'}));
  const current=submit(f,task);
  const notification=await wait(f,'b',since);
  assert.equal(notification.reason,'review-submitted');assert.equal(notification.task,task.id);
  assert.equal(notification.version,current.version);assert.notEqual(notification.version,obsolete.version);
  assert.equal((await wait(f,'b',notification.cursor)).reason,'timeout');
  assert.equal((await wait(f,'a',since)).reason,'timeout','superseded rejection does not wake owner');
});

test('metadata notes preserve pending submission and approval notifications despite newer versions',async t=>{
  const f=fixture(t),task=work(f),since=f.cursor(),submitted=submit(f,task);
  const note=as(f.s,'a',()=>noteTask(f.s,task.id,'Reviewer can use the existing test report'));
  assert(note.version>submitted.version);
  const submission=await wait(f,'b',since);assert.equal(submission.reason,'review-submitted');assert.equal(submission.version,submitted.version);
  const beforeApproval=f.cursor(),approved=review(f,task,true);
  as(f.s,'a',()=>noteTask(f.s,task.id,'Completion reference will follow'));
  const approval=await wait(f,'a',beforeApproval);assert.equal(approval.reason,'review-approved');assert.equal(approval.version,approved.version);
});

test('completed or dropped work does not notify owners about obsolete review results',async t=>{
  const f=fixture(t),completed=work(f);submit(f,completed);const beforeApproval=f.cursor();
  review(f,completed,true);as(f.s,'a',()=>doneTask(f.s,completed.id));
  assert.equal((await wait(f,'a',beforeApproval)).reason,'timeout');
  const dropped=work(f);submit(f,dropped);const beforeRejection=f.cursor();review(f,dropped,false);
  dropTask(f.s,dropped.id,'Superseded by another project');
  assert.equal((await wait(f,'a',beforeRejection)).reason,'timeout');
});


test('approval invalidated by a body edit requests review once and suppresses the old approval',async t=>{
  const f=fixture(t),task=work(f),since=f.cursor();submit(f,task);review(f,task,true,'c');
  const changed=as(f.s,'a',()=>updateTask(f.s,task.id,{version:showTask(f.s,task.id).version,body:'Implementation changed after approval'}));
  assert.equal(changed.status,'review');assert.equal(changed.reviewed_by,null);
  const notification=await wait(f,'b',since);
  assert.equal(notification.reason,'review-submitted');assert.equal(notification.version,changed.version);assert.equal(notification.task,task.id);
  assert.equal((await wait(f,'b',notification.cursor)).reason,'timeout');
  assert.equal((await wait(f,'a',since)).reason,'timeout','invalidated approval does not notify owner as if still approved');
});

test('only latest pending review edit wakes a late reviewer, while a later note preserves it',async t=>{
  const f=fixture(t),task=work(f),since=f.cursor();submit(f,task);
  as(f.s,'a',()=>updateTask(f.s,task.id,{version:showTask(f.s,task.id).version,body:'First correction while awaiting review'}));
  const latest=as(f.s,'a',()=>updateTask(f.s,task.id,{version:showTask(f.s,task.id).version,body:'Second correction while awaiting review'}));
  as(f.s,'a',()=>noteTask(f.s,task.id,'Current validation report is linked in the body'));
  const notification=await wait(f,'b',since);
  assert.equal(notification.reason,'review-submitted');assert.equal(notification.version,latest.version);
  assert.equal((await wait(f,'b',notification.cursor)).reason,'timeout');
});


test('restoring blocked review wakes reviewers again and supersedes the original submission',async t=>{
  const f=fixture(t),task=work(f),since=f.cursor();submit(f,task);
  const original=await wait(f,'b',since);assert.equal(original.reason,'review-submitted');
  const blocker=as(f.s,'a',()=>blockTask(f.s,task.id,{kind:'external',waitingOn:'service',body:'Await integration result'}));
  resolveBlocker(f.s,blocker.id,'Integration passed');const restored=showTask(f.s,task.id);
  assert.equal(restored.status,'review');assert.equal(restored.reviewed_by,null);
  const next=await wait(f,'b',original.cursor);
  assert.equal(next.reason,'review-submitted');assert.equal(next.task,task.id);assert.equal(next.version,restored.version);
  assert.ok(next.cursor>original.cursor);
  const late=await wait(f,'c',since);assert.equal(late.reason,'review-submitted');assert.equal(late.cursor,next.cursor);assert.equal(late.version,restored.version);
  assert.equal((await wait(f,'b',next.cursor)).reason,'timeout');
  const owner=await wait(f,'a',original.cursor);assert.equal(owner.reason,'blocker-resolved');assert.equal(owner.blocker,blocker.id);
});


test('human owners of restored review get the blocker or answer notification instead of self-review',async t=>{
  const f=fixture(t),task=work(f,'human',true);submit(f,task);
  const blocker=blockTask(f.s,task.id,{kind:'agent',waitingOn:'a',body:'Await agent verification'}),since=f.cursor();
  as(f.s,'a',()=>resolveBlocker(f.s,blocker.id,'Verified'));
  const restored=await wait(f,'human',since);assert.equal(restored.reason,'blocker-resolved');assert.equal(restored.blocker,blocker.id);
  const review=await wait(f,'b',since);assert.equal(review.reason,'review-submitted');assert.equal(review.task,task.id);
  f.s.run("INSERT INTO roles(workspace_id,name,kind) VALUES(?,'operator','human')",f.s.ws);
  const question=askHuman(f.s,task.id,{question:'Approve the approach?',forRole:'operator'}),beforeAnswer=f.cursor();
  as(f.s,'operator',()=>answerQuestion(f.s,question.id,'Approved'));
  const answer=await wait(f,'human',beforeAnswer);assert.equal(answer.reason,'answer');assert.equal(answer.question,question.id);
  assert.equal((await wait(f,'human',answer.cursor)).reason,'timeout');
  assert.equal((await wait(f,'b',beforeAnswer)).reason,'review-submitted');
});
