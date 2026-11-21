import { fixtureConfig } from './fixtures/team.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/storage.js';
import {initWorkspace,search,showRecord} from '../dist/admin.js';
import {context,setFact} from '../dist/coordination.js';
import {contextDelta} from '../dist/context-brief.js';
import {waitForUrgent} from '../dist/mail-wait.js';
import {addTask,listTaskPage} from '../dist/tasks.js';
import {exportMarkdown} from '../dist/migration.js';
import {setWorkspaceSettings} from '../dist/workspace-settings.js';
import {addFeedback,listFeedback,closeFeedback} from '../dist/feedback.js';
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'sassato-feedback-')),path=join(dir,'state.db'),s=new Store(path,'a',{create:true});
  initWorkspace(s,'team',fixtureConfig);s.use('team');
  t.after(()=>{if(s.db.isOpen)s.close();rmSync(dir,{recursive:true,force:true});});
  return {s,dir};
}
const code=n=>error=>error.code===n;

test('feedback is one line with a kind, numbered K, linked to a task, and wakes nobody (T1113)',async t=>{
  const {s,dir}=fixture(t);
  s.actor='a';const task=addTask(s,{title:'Gate'});
  s.actor='b';const since=context(s).snapshot_cursor;
  s.actor='a';
  const k=addFeedback(s,'tokens','Read the whole log twice to find one exit line',{re:task.id});
  assert.equal(k.id,'K1');assert.equal(k.task_id,task.id);assert.equal(k.author,'a');assert.equal(k.open,true);
  assert.throws(()=>addFeedback(s,'mood','x'),/kind must be one of/);
  assert.throws(()=>addFeedback(s,'workflow','two\nlines'),/one line/);
  assert.throws(()=>addFeedback(s,'workflow','x'.repeat(501)),/at most 500/);
  assert.throws(()=>addFeedback(s,'workflow','x',{re:'T99'}),/not found/);
  s.actor='b';
  const event=await waitForUrgent(s,{settle:0,timeout:1,stopFile:join(dir,'stop'),since});
  assert.equal(event.reason,'timeout',JSON.stringify(event));
  assert.deepEqual(listTaskPage(s,{available:true}).items.map(r=>r.id),[task.id],'feedback is never work');
  assert.deepEqual(listFeedback(s).items.map(r=>r.id),['K1']);
  assert.equal(showRecord(s,'K1').body,'Read the whole log twice to find one exit line');
  assert.deepEqual(search(s,'exit line').map(r=>r.id),['K1']);
});

test('only a human or a role named in feedback_closers closes feedback, as a task, a fact or a stated no (T1113)',t=>{
  const {s,dir}=fixture(t);
  s.actor='a';
  const [k1,k2,k3]=['First','Second','Third'].map(line=>addFeedback(s,'workflow',line));
  const task=addTask(s,{title:'Fix it'});
  s.actor='b';
  assert.throws(()=>closeFeedback(s,k1.id,{dropped:'no'}),code(3));
  assert.throws(()=>setWorkspaceSettings(s,{feedback_closers:['b']}),/human/);
  s.actor='human';setWorkspaceSettings(s,{feedback_closers:['b']});
  assert.throws(()=>setWorkspaceSettings(s,{feedback_closers:['nobody']}),/not found|Unknown role/i);
  s.actor='b';
  assert.throws(()=>closeFeedback(s,k1.id,{}),/exactly one/);
  assert.throws(()=>closeFeedback(s,k1.id,{task:task.id,dropped:'x'}),/exactly one/);
  assert.throws(()=>closeFeedback(s,k2.id,{fact:'rules.logs'}),/set it first/);
  assert.equal(closeFeedback(s,k1.id,{task:task.id}).outcome_ref,task.id);
  setFact(s,'rules.logs',{body:'Grep the exit line',source:'here'});
  const fact=closeFeedback(s,k2.id,{fact:'rules.logs'});
  assert.equal(fact.outcome,'fact');assert.equal(fact.closed_by,'b');assert.equal(fact.open,false);
  assert.throws(()=>closeFeedback(s,k1.id,{dropped:'again'}),code(4));
  s.actor='human';assert.equal(closeFeedback(s,k3.id,{dropped:'Already a rule'}).outcome,'dropped');
  s.actor='a';
  assert.deepEqual(listFeedback(s).items,[]);
  assert.deepEqual(listFeedback(s,{all:true}).items.map(r=>r.outcome),['task','fact','dropped']);
  assert.deepEqual(listFeedback(s,{all:true,kind:'tokens'}).items,[]);
  assert.deepEqual(listFeedback(s,{all:true,limit:2}).next_after,'K2');
  const out=join(dir,'export');exportMarkdown(s,out);
  assert.match(readFileSync(join(out,'feedback.md'),'utf8'),/K3 · .* · a · workflow: Third \(closed .* by human: dropped Already a rule\)/);
});

test('the open count is in the context of the roles that close feedback, and nobody else (T1113)',t=>{
  const {s}=fixture(t);
  s.actor='b';const since=context(s).snapshot_cursor;
  s.actor='a';addFeedback(s,'untested','The restore path has no test');
  assert.equal(context(s).sections.feedback,undefined);
  assert.equal(contextDelta(s,{since}).sections.feedback,undefined);
  s.actor='human';
  assert.deepEqual(context(s).sections.feedback,[{id:'feedback',open:1,oldest_days:0,read:'sassato feedback list'}]);
  setWorkspaceSettings(s,{feedback_closers:['b']});
  s.actor='b';
  assert.equal(context(s).sections.feedback[0].open,1);
  assert.equal(contextDelta(s,{since}).sections.feedback[0].open,1);
  s.actor='human';closeFeedback(s,'K1',{dropped:'Has one now'});
  s.actor='b';assert.equal(context(s).sections.feedback,undefined);
});
