import { fixtureConfig } from './fixtures/team.mjs';
import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store,SCHEMA_VERSION} from '../dist/storage.js';
import {initWorkspace} from '../dist/admin.js';
import {context,setFact} from '../dist/coordination.js';
import {contextDelta} from '../dist/context-brief.js';
import {waitForUrgent} from '../dist/mail-wait.js';
import {prune} from '../dist/prune.js';
import {addTask,listTaskPage,takeTask,doneTask,blockTask,addDependency,noteTask,askHuman,answerQuestion,humanBrief,showTask,dropTask,reopenTask} from '../dist/tasks.js';
import {addTopic,topicFrom,linkTopic,unlinkTopic,closeTopic,listTopics,showTopic,renderTopics} from '../dist/topics.js';
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'sassato-topics-')),path=join(dir,'state.db'),s=new Store(path,'a',{create:true});
  initWorkspace(s,'team',fixtureConfig);s.use('team');
  t.after(()=>{if(s.db.isOpen)s.close();rmSync(dir,{recursive:true,force:true});});
  return {s,dir,path};
}
const code=n=>error=>error.code===n&&/is a topic|topic/.test(error.message);

test('schema 17 gives every existing task kind work and keeps its rows',t=>{
  const {s,path}=fixture(t);
  addTask(s,{title:'Old work'});addTask(s,{title:'Older work'});s.close();
  const db=new DatabaseSync(path);
  db.exec("DROP INDEX refusals_time; DROP TABLE refusals; DROP TABLE schedule_ticks; DROP TABLE occurrences; DROP INDEX schedules_due; DROP TABLE schedules; DROP INDEX topic_links_topic; DROP TABLE topic_links; ALTER TABLE tasks DROP COLUMN kind; DELETE FROM schema_migrations WHERE version>=17; PRAGMA user_version=16;");db.close();
  const again=new Store(path,'a');again.use('team');
  assert.deepEqual(again.all('SELECT title,kind FROM tasks ORDER BY id').map(r=>[r.title,r.kind]),[['Old work','work'],['Older work','work']]);
  assert.equal(again.get('PRAGMA user_version').user_version,SCHEMA_VERSION);
  again.close();
});

test('a topic is never offered, taken, assigned or woken for as work',async t=>{
  const {s,dir}=fixture(t);
  s.actor='b';const since=context(s).snapshot_cursor;
  s.actor='a';const topic=addTopic(s,{title:'Should exports be signed?',keeper:'b'});
  assert.equal(topic.kind,'topic');assert.equal(topic.for_role,'b');assert.equal(topic.status,'open');
  assert.deepEqual(listTaskPage(s,{available:true}).items.map(r=>r.id),[]);
  assert.deepEqual(listTaskPage(s,{}).items.map(r=>r.id),[]);
  assert.deepEqual(listTaskPage(s,{kind:'topic'}).items.map(r=>r.id),[topic.id]);
  assert.deepEqual(listTaskPage(s,{kind:'all'}).items.map(r=>r.id),[topic.id]);
  s.actor='b';
  const event=await waitForUrgent(s,{settle:0,timeout:1,stopFile:join(dir,'stop'),since});
  assert.equal(event.reason,'timeout',JSON.stringify(event));
  for(const step of [()=>takeTask(s,topic.id),()=>doneTask(s,topic.id),()=>dropTask(s,topic.id,'no'),()=>blockTask(s,topic.id,{kind:'agent',waitsOn:'a',body:'x'})])assert.throws(step,code(4));
  s.actor='a';const work=addTask(s,{title:'Sign the export'});
  assert.throws(()=>addDependency(s,work.id,topic.id),code(4));
  assert.throws(()=>addDependency(s,topic.id,work.id),code(4));
});

test('any role notes a topic; a role that does not hold work still may not note it',t=>{
  const {s}=fixture(t);
  const topic=addTopic(s,{title:'Retention for logs'});
  s.actor='c';noteTask(s,topic.id,'Ninety days is what the law asks for here.');
  s.actor='human';noteTask(s,topic.id,'Agreed.');
  s.actor='a';const work=addTask(s,{title:'Held work',for:'b'});s.actor='b';takeTask(s,work.id);
  s.actor='c';assert.throws(()=>noteTask(s,work.id,'Not mine'),e=>e.code===3);
  const notes=showTask(s,topic.id).history.filter(e=>e.action==='note').map(e=>e.actor);
  assert.deepEqual(notes.sort(),['c','human']);
});

test('topics lists questions and linked tasks with their status; show lists the links',t=>{
  const {s}=fixture(t);
  setFact(s,'decisions.logs',{body:'Keep logs ninety days',source:'test'});
  const work=addTask(s,{title:'Write the retention job'});
  const topic=addTopic(s,{title:'Retention',links:[work.id,'fact:decisions.logs']});
  const link=linkTopic(s,topic.id,'smithable/sassato#91',{}.label??'the pull request');
  const asked=askHuman(s,topic.id,{question:'Ninety days or a year?',forRole:'human'});
  assert.equal(showTask(s,topic.id).status,'open','a question leaves a topic open');
  const [row]=listTopics(s);
  assert.equal(row.id,topic.id);assert.equal(row.keeper,'a');assert.deepEqual(row.pending_questions,[asked.question_id??asked.id]);
  assert.deepEqual(row.tasks,[{id:work.id,status:'open',follow_up:false}]);
  assert.match(renderTopics([row]),/Retention · keeper a · 0d quiet · asks H\d+ · T\d+ open/);
  assert.deepEqual(showTopic(s,topic.id).links.map(l=>l.type),['task','fact','pull-request']);
  unlinkTopic(s,topic.id,link.id);
  assert.equal(showTopic(s,topic.id).links.length,2);
  assert.equal(s.get("SELECT status FROM topic_links WHERE id=?",Number(link.id.slice(1))).status,'removed');
  assert.throws(()=>linkTopic(s,topic.id,'T999'),e=>e.code===3);
  assert.throws(()=>linkTopic(s,topic.id,'fact:no.such'),e=>e.code===3);
  const brief=humanBrief(s,{forRole:'human'});
  assert.deepEqual(brief.blocks_work,[]);assert.equal(brief.can_wait.length,1,'a question on a topic can wait');
});

test('close --into needs existing work or facts; --reason needs an answered question or a human',t=>{
  const {s}=fixture(t);
  setFact(s,'decisions.export',{body:'Exports are signed',source:'test'});
  const work=addTask(s,{title:'Sign exports'}),other=addTopic(s,{title:'Another'});
  const topic=addTopic(s,{title:'Signing',keeper:'b'});
  s.actor='c';assert.throws(()=>closeTopic(s,topic.id,{into:[work.id]}),e=>e.code===3,'only keeper, creator or a human');
  s.actor='b';
  assert.throws(()=>closeTopic(s,topic.id,{into:['T999']}),e=>e.code===3);
  assert.throws(()=>closeTopic(s,topic.id,{into:[other.id]}),code(4));
  const abandoned=addTask(s,{title:'Abandoned'});dropTask(s,abandoned.id,'not needed');
  assert.throws(()=>closeTopic(s,topic.id,{into:[work.id,abandoned.id]}),e=>e.code===4&&/was dropped/.test(e.message),'a dropped task is not a follow-up');
  assert.throws(()=>closeTopic(s,topic.id,{into:['smithable/sassato#91']}),e=>e.code===2,'a pull request alone is not a follow-up');
  assert.throws(()=>closeTopic(s,topic.id,{into:[work.id],reason:'x'}),e=>e.code===2);
  const pending=askHuman(s,topic.id,{question:'Sign them?',forRole:'human'});
  const closed=closeTopic(s,topic.id,{into:[work.id,'fact:decisions.export']});
  assert.equal(closed.status,'done');
  assert.deepEqual(closed.links.filter(l=>l.follow_up).map(l=>l.target),[work.id,'fact:decisions.export']);
  assert.deepEqual(closed.pending_questions,[],'closing cancels its questions');
  assert.equal(s.get("SELECT status FROM questions WHERE id=?",Number(String(pending.question_id??pending.id).slice(1))).status,'cancelled');
  assert.throws(()=>linkTopic(s,topic.id,work.id),e=>e.code===4,'a closed topic takes no links');
  s.actor='c';assert.throws(()=>noteTask(s,topic.id,'Late word'),e=>e.code===3,'a closed topic takes notes as work does');
  s.actor='a';assert.throws(()=>topicFrom(s,work.id),code(4),'a follow-up stays work');s.actor='b';

  s.actor='a';const dropped=addTopic(s,{title:'Dropped idea'});
  assert.throws(()=>closeTopic(s,dropped.id,{reason:'Nobody wants it'}),e=>e.code===3);
  const q=askHuman(s,dropped.id,{question:'Drop it?',forRole:'human'}),qid=String(q.question_id??q.id);
  assert.throws(()=>closeTopic(s,dropped.id,{reason:'Nobody wants it',acknowledged:qid}),e=>e.code===4,'not answered yet');
  s.actor='human';assert.throws(()=>answerQuestion(s,qid,'Yes, drop it',{close:true}),code(4),'answer --close does not close a topic');
  answerQuestion(s,qid,'Yes, drop it');
  s.actor='a';s.run("UPDATE questions SET answered_by='b' WHERE id=?",Number(qid.slice(1)));
  assert.throws(()=>closeTopic(s,dropped.id,{reason:'Nobody wants it',acknowledged:qid}),e=>e.code===3,'a human must have answered');
  s.run("UPDATE questions SET answered_by='human' WHERE id=?",Number(qid.slice(1)));
  assert.equal(closeTopic(s,dropped.id,{reason:'Nobody wants it',acknowledged:qid}).status,'dropped');
  assert.equal(reopenTask(s,dropped.id,'Back on the table').status,'open');assert.ok(listTopics(s).some(r=>r.id===dropped.id));
  assert.throws(()=>closeTopic(s,dropped.id,{reason:'Nobody wants it',acknowledged:qid}),e=>e.code===4&&/reopened/.test(e.message),'an answer from before the reopening does not count');
  s.actor='human';closeTopic(s,dropped.id,{reason:'Nobody wants it'});s.actor='a';
  const third=addTopic(s,{title:'Third'});
  s.actor='human';assert.equal(closeTopic(s,third.id,{reason:'Not now'}).status,'dropped');
  assert.deepEqual(listTopics(s).map(r=>r.id),[other.id]);
  assert.equal(listTopics(s,{all:true}).length,4);
});

test('topic from keeps the id, notes and questions; only open unheld work converts',t=>{
  const {s}=fixture(t);
  const work=addTask(s,{title:'Research signing'});noteTask(s,work.id,'First finding');
  askHuman(s,work.id,{question:'Which key?',forRole:'human'});
  assert.equal(showTask(s,work.id).status,'blocked');
  const topic=topicFrom(s,work.id);
  assert.equal(topic.id,work.id);assert.equal(topic.kind,'topic');assert.equal(topic.status,'open');assert.equal(topic.owner,null);assert.equal(topic.for_role,'a');
  assert.equal(topic.pending_questions.length,1);
  s.actor='human';answerQuestion(s,`H${s.get('SELECT id FROM questions WHERE task_id=?',Number(work.id.slice(1))).id}`,'The new one');
  assert.equal(showTask(s,work.id).status,'open','an answer leaves a converted topic open');s.actor='a';
  const reviewed=addTask(s,{title:'Needs a review',reviewRequired:true});
  assert.throws(()=>topicFrom(s,reviewed.id),e=>e.code===4&&/review/.test(e.message));
  assert.ok(showTask(s,work.id).history.some(e=>e.action==='note'));
  const held=addTask(s,{title:'Held',for:'b'});s.actor='b';takeTask(s,held.id);
  s.actor='a';assert.throws(()=>topicFrom(s,held.id),e=>e.code===3);
  const human=addTask(s,{title:'Only a human',humanOnly:true});
  s.actor='human';assert.throws(()=>topicFrom(s,human.id),e=>e.code===3);
  s.actor='a';const finished=addTask(s,{title:'Finished'});takeTask(s,finished.id);doneTask(s,finished.id);
  assert.throws(()=>topicFrom(s,finished.id),e=>e.code===4);
  const waiting=addTask(s,{title:'Waits on a vendor'});blockTask(s,waiting.id,{kind:'external',waitingOn:'vendor',body:'Quote due'});
  assert.throws(()=>topicFrom(s,waiting.id),e=>e.code===4&&/blockers/.test(e.message),'other blockers are resolved first');
  const passing=addTask(s,{title:'Being handed over'});takeTask(s,passing.id);s.event('task-handoff',passing.id,'pending',{brief_id:'fixture'});
  assert.throws(()=>topicFrom(s,passing.id),e=>e.code===4&&/hand-over/.test(e.message),'a pending hand-over is settled first');
});

test('the keeper gets a quiet entry and a brief row; topics are counted in context',async t=>{
  const {s,dir}=fixture(t);
  const topic=addTopic(s,{title:'Retention',keeper:'b'});
  s.actor='b';const since=context(s).snapshot_cursor;
  s.actor='c';noteTask(s,topic.id,'A finding');
  s.actor='b';
  const delta=contextDelta(s,{since});
  assert.deepEqual(delta.sections.topics,[{id:topic.id,title:'Retention',change:'new note by c'}]);
  assert.equal(delta.sections.tasks,undefined,'a topic is not work in the brief');
  assert.equal(delta.counts.topics_open,1);
  assert.equal(context(s,{brief:true}).counts.topics_open,1);
  s.actor='a';const asOther=contextDelta(s,{since});
  assert.equal(asOther.sections.topics,undefined,'not kept, not noted: no row');
  s.actor='b';
  const event=await waitForUrgent(s,{settle:0,timeout:1,stopFile:join(dir,'stop'),since});
  assert.equal(event.reason,'timeout','a note on a topic does not wake its keeper alone');
});

test('prune lists a 30-day quiet topic under quiet-topics and not under quiet-review',t=>{
  mock.timers.enable({apis:['Date'],now:Date.now()-31*86_400_000});t.after(()=>mock.timers.reset());
  const {s}=fixture(t);
  const topic=addTopic(s,{title:'Slow topic'});
  mock.timers.tick(31*86_400_000);
  const fresh=addTopic(s,{title:'Fresh topic'});
  const data=prune(s);
  assert.deepEqual(data.sections['quiet-topics'].map(r=>r.id),[topic.id]);
  assert.ok(!data.sections['quiet-review'].some(r=>r.id===topic.id||r.id===fresh.id));
});
