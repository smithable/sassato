import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store, SCHEMA_VERSION } from '../dist/storage.js';
import { initWorkspace, search, showRecord } from '../dist/admin.js';
import { setRole, inbox, context, renderContext } from '../dist/coordination.js';
import * as tasks from '../dist/tasks.js';
import { previewImport, applyImport, exportMarkdown } from '../dist/migration.js';

const cli = resolve('bin/sassato.js');
function fixture(t, humans=['alice']) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-humans-'));
  const db=join(dir,'state.db'),s=new Store(db,undefined,{create:true});
  initWorkspace(s,'team',undefined,humans);s.actor='builder';
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  return {s,dir,db};
}
function as(s,actor,fn) {const before=s.actor;s.actor=actor;try{return fn();}finally{s.actor=before;}}
function raw(db,args,workspace='team') {
  return spawnSync(process.execPath,[cli,'--db',db,'--workspace',workspace,'--json',...args],{
    encoding:'utf8',timeout:5000,env:{...process.env,SASSATO_ROLE:'',SASSATO_WORKSPACE:'',SASSATO_DB:''}
  });
}
function run(db,args,workspace) {const r=raw(db,args,workspace);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}

test('a workspace with a custom human name routes questions, mail, human work and answers to its human',t=>{
  const {s}=fixture(t),task=tasks.addTask(s,{title:'Choose host'});
  assert.equal(s.get('PRAGMA user_version').user_version,SCHEMA_VERSION);
  assert.equal(s.get("SELECT name FROM roles WHERE name='human'"),undefined);
  assert.equal(s.get("SELECT actor FROM events WHERE action='created' AND entity='workspace'").actor,'alice');
  const q=tasks.askHuman(s,task.id,{question:'Which host?',options:['local','hosted']});
  assert.equal(q.for_role,'alice');assert.equal(showRecord(s,q.id).for_role,'alice');
  assert.equal(tasks.showTask(s,task.id).blockers[0].waiting_on,'alice');
  assert.equal(context(s).sections.questions[0].for_role,'alice');
  assert.equal(search(s,'Which host',{type:'question',role:'alice'})[0].id,q.id);
  assert.throws(()=>tasks.answerQuestion(s,q.id,'1'),e=>e.code===3);
  as(s,'alice',()=>{
    assert.equal(inbox(s,{peek:true})[0].task_id,task.id);
    assert.equal(tasks.humanQueue(s)[0].id,q.id);
    assert.equal(tasks.answerQuestion(s,q.id,'2').answered_by,'alice');
  });
  assert.equal(tasks.showTask(s,task.id).status,'open');
  assert.equal(search(s,'Which host',{type:'question',role:'alice',status:'answered'})[0].id,q.id);
  assert.match(inbox(s,{peek:true})[0].body,/answered by alice/);
  const human=tasks.addTask(s,{title:'Publish',humanOnly:true});assert.equal(human.for_role,'alice');
  assert.throws(()=>tasks.takeTask(s,human.id),e=>e.code===3);
  as(s,'alice',()=>{tasks.takeTask(s,human.id);assert.equal(tasks.doneTask(s,human.id).status,'done');});
  const plain=tasks.addTask(s,{title:'Human step'});
  assert.equal(tasks.updateTask(s,plain.id,{version:plain.version,humanOnly:true}).for_role,'alice');
});

test('multiple humans require an explicit recipient for agents, with independent queues and no partial writes',t=>{
  const {s}=fixture(t,['alice','bob']),task=tasks.addTask(s,{title:'Decisions'});
  const before=s.get('SELECT count(*) AS n FROM events').n;
  assert.throws(()=>tasks.askHuman(s,task.id,{question:'Who?'}),/--for NAME/);
  assert.throws(()=>tasks.addTask(s,{title:'Ambiguous',humanOnly:true}),/--for NAME/);
  assert.throws(()=>tasks.askHuman(s,task.id,{question:'Agent?',forRole:'reviewer'}),/human role/);
  assert.equal(s.get('SELECT count(*) AS n FROM events').n,before);
  assert.equal(tasks.showTask(s,task.id).status,'open');
  const qa=tasks.askHuman(s,task.id,{question:'First?',forRole:'alice'});
  const qb=tasks.askHuman(s,task.id,{question:'Second?',forRole:'bob'});
  assert.deepEqual(tasks.humanQueue(s,{forRole:'alice'}).map(x=>x.id),[qa.id]);
  assert.deepEqual(tasks.humanQueue(s,{forRole:'bob'}).map(x=>x.id),[qb.id]);
  assert.equal(as(s,'alice',()=>inbox(s,{peek:true})).length,1);
  assert.equal(as(s,'bob',()=>inbox(s,{peek:true})).length,1);
  // Routing is not a new authorization boundary: any human may answer, as before.
  as(s,'bob',()=>tasks.answerQuestion(s,qa.id,'Yes'));
  assert.equal(tasks.showTask(s,task.id).status,'blocked');
  as(s,'alice',()=>tasks.answerQuestion(s,qb.id,'Yes'));
  assert.equal(tasks.showTask(s,task.id).status,'open');
  const owned=tasks.addTask(s,{title:'Bob handles this',humanOnly:true,owner:'bob'});
  assert.equal(owned.for_role,'bob');
  const directed=tasks.addTask(s,{title:'Alice handles this',forRole:'alice'});
  const promoted=tasks.updateTask(s,directed.id,{version:directed.version,humanOnly:true});
  assert.equal(promoted.for_role,'alice');
  assert.deepEqual(tasks.humanQueue(s,{forRole:'bob'}).map(x=>x.id),[owned.id]);
  assert.deepEqual(tasks.humanQueue(s,{forRole:'alice'}).map(x=>x.id),[directed.id]);
  as(s,'alice',()=>assert.equal(tasks.addTask(s,{title:'My human step',humanOnly:true}).for_role,'alice'));
});

test('humans can be added as roles while agents cannot promote themselves or remove human safeguards',t=>{
  const {s}=fixture(t);
  assert.throws(()=>setRole(s,'builder',{kind:'human'}),e=>e.code===3);
  assert.throws(()=>setRole(s,'bob',{kind:'human'}),e=>e.code===3);
  as(s,'alice',()=>{
    assert.throws(()=>setRole(s,'alice',{kind:'agent'}),/last human/);
    assert.equal(setRole(s,'bob',{kind:'human'}).kind,'human');
  });
  const task=tasks.addTask(s,{title:'Pending question'});
  const question=tasks.askHuman(s,task.id,{question:'Ready?',forRole:'bob'});
  as(s,'alice',()=>{
    assert.throws(()=>setRole(s,'bob',{kind:'agent'}),/pending human work/);
    tasks.answerQuestion(s,question.id,'Yes');
    assert.equal(setRole(s,'bob',{kind:'agent'}).kind,'agent');
    setRole(s,'bob',{kind:'human'});
  });
  const human=tasks.addTask(s,{title:'Pending task',humanOnly:true,forRole:'bob'});
  as(s,'alice',()=>{
    assert.throws(()=>setRole(s,'bob',{kind:'agent'}),/pending human work/);
    tasks.updateTask(s,human.id,{version:human.version,forRole:'alice'});
    assert.equal(setRole(s,'bob',{kind:'agent'}).kind,'agent');
  });
});

test('existing workspaces retain roles when init is repeated',t=>{
  const {s,db}=fixture(t,['human']);
  as(s,'human',()=>setRole(s,'alice',{kind:'human'}));
  const task=tasks.addTask(s,{title:'Legacy decision'});
  assert.equal(tasks.askHuman(s,task.id,{question:'Continue?',forRole:'human'}).for_role,'human');
  assert.throws(()=>tasks.askHuman(s,task.id,{question:'Default?'}),/--for/);
  assert.equal(tasks.addTask(s,{title:'Legacy human task',humanOnly:true,forRole:'human'}).for_role,'human');
  assert.equal(run(db,['init','--humans','carol']).created,false);
  assert.deepEqual(run(db,['roles']).filter(r=>r.kind==='human').map(r=>r.name),['alice','human']);
  assert.equal(run(db,['init'],'legacy').created,true);
  assert.ok(run(db,['roles'],'legacy').some(r=>r.name==='human'&&r.kind==='human'));
});

test('CLI setup accepts named humans and custom configurations without prompting or adding a default human',t=>{
  const {dir,db}=fixture(t);
  const preview=run(db,['init','--humans','alice,bob','--dry-run'],'preview');
  assert.equal(preview.would_create,true);assert.equal(preview.roles.some(r=>r.name==='human'),false);
  assert.equal(raw(db,['roles'],'preview').status,3);
  run(db,['init','--humans','alice,bob'],'cli');
  run(db,['role','set','carol','--kind','human','--as','alice'],'cli');
  const task=run(db,['add','CLI question','--as','builder'],'cli');
  const q=run(db,['ask-human',task.id,'Ready?','--for','carol','--as','builder'],'cli');
  assert.equal(run(db,['humans','--for','carol'],'cli')[0].id,q.id);
  assert.deepEqual(run(db,['humans','--for','bob'],'cli'),[]);
  assert.equal(run(db,['answer',q.id,'Yes','--as','carol'],'cli').answered_by,'carol');
  const config=join(dir,'config.json');
  writeFileSync(config,JSON.stringify({roles:[{name:'worker',provider:'codex'},{name:'dana',kind:'human'}]}));
  assert.equal(run(db,['init','--config',config],'custom').created,true);
  assert.equal(raw(db,['init','--config',config,'--humans','alice'],'invalid').status,2);
  for(const names of ['', 'Alice', 'alice,alice', 'alice,', 'builder'])assert.equal(raw(db,['init','--humans',names],'invalid').status,2);
  assert.equal(raw(db,['init','--interactive'],'invalid').status,2);
  assert.equal(run(db,['init','--no-interactive','--humans','erin'],'explicit').created,true);
});

test('imports and exports route decisions to a custom human name',t=>{
  const {s,dir}=fixture(t),actions=join(dir,'actions');mkdirSync(actions);
  writeFileSync(join(actions,'pending.md'),'# Publish package\n\nChoose a release date.\n');
  writeFileSync(join(actions,'answered.md'),'# Choose a host\n\nAnswer: local\n');
  const options={actions};
  as(s,'alice',()=>{
    const preview=previewImport(s,options);assert.ok(preview.items.every(i=>i.owner==='alice'));
    const result=applyImport(s,options,preview.digest);assert.equal(result.created.length,2);
    assert.ok(tasks.humanQueue(s).every(i=>i.for_role==='alice'));
    assert.equal(previewImport(s,{...options,repair:true}).summary.repair,0);
    const out=join(dir,'export');exportMarkdown(s,out);
    assert.match(readFileSync(join(out,'humans.md'),'utf8'),/For: alice/);
    assert.equal(existsSync(join(out,'human.md')),false);
    setRole(s,'human',{kind:'human'});
    const legacy=join(dir,'legacy-export');exportMarkdown(s,legacy);
    assert.equal(existsSync(join(legacy,'humans.md')),true);
  });
});

test('import confirmation binds the human recipient even for ownerless reconciliation work',t=>{
  const {s,dir}=fixture(t,['alice','bob']),backlog=join(dir,'backlog.md');
  writeFileSync(backlog,'## Anyone\n1. Investigate the callback\n');
  const options={backlog};
  assert.throws(()=>previewImport(s,options),/--as HUMAN/);
  const preview=as(s,'alice',()=>previewImport(s,options));
  as(s,'bob',()=>assert.throws(()=>applyImport(s,options,preview.digest),/preview changed/));
  assert.equal(s.get('SELECT count(*) AS n FROM tasks').n,0);
  as(s,'alice',()=>{
    const result=applyImport(s,options,preview.digest);
    assert.equal(tasks.showTask(s,result.created[0]).blockers[0].waiting_on,'alice');
  });
});


test('context hides legacy pending questions and blockers on closed tasks without erasing history',t=>{
  const {s}=fixture(t);
  for(const status of ['done','dropped']) {
    const task=tasks.addTask(s,{title:`Legacy ${status}`,owner:'builder'});
    const question=tasks.askHuman(s,task.id,{question:`Obsolete ${status} decision?`});
    const blocker=tasks.blockTask(s,task.id,{kind:'agent',waitingOn:'reviewer',body:'Old explicit blocker'});
    // Simulate a legacy closed row that retained its pending question and open blockers.
    s.run('UPDATE tasks SET status=? WHERE workspace_id=? AND id=?',status,s.ws,Number(task.id.slice(1)));
    for(const role of ['builder','alice','reviewer'])as(s,role,()=>{
      const data=context(s);
      assert.ok(!data.sections.questions.some(row=>row.id===question.id),`${role}: obsolete ${status} question`);
      assert.ok(!data.sections.blockers.some(row=>row.task===task.id),`${role}: obsolete ${status} blockers`);
    });
    const detail=tasks.showTask(s,task.id);assert.equal(detail.questions[0].id,question.id);assert.equal(detail.questions[0].status,'pending');
    assert.ok(detail.blockers.some(row=>row.id===blocker.id));assert.equal(showRecord(s,question.id).status,'pending');
  }
  const active=tasks.addTask(s,{title:'Current decision',owner:'builder'}),question=tasks.askHuman(s,active.id,{question:'Still needed?'});
  assert.ok(context(s).sections.questions.some(row=>row.id===question.id));
  assert.ok(as(s,'alice',()=>context(s)).sections.blockers.some(row=>row.task===active.id));
});

test('dropping and reopening work keeps cancelled questions out of actionable context',t=>{
  const {s}=fixture(t),task=tasks.addTask(s,{title:'Deferred decision',owner:'builder'}),old=tasks.askHuman(s,task.id,{question:'Proceed now?'});
  tasks.dropTask(s,task.id,'No longer needed');
  for(const role of ['builder','alice'])as(s,role,()=>{
    const data=context(s);assert.ok(!data.sections.questions.some(row=>row.id===old.id));assert.ok(!data.sections.blockers.some(row=>row.task===task.id));
  });
  assert.equal(showRecord(s,old.id).status,'cancelled');
  tasks.reopenTask(s,task.id,'A new requirement');
  assert.ok(!context(s).sections.questions.some(row=>row.id===old.id));
  const fresh=tasks.askHuman(s,task.id,{question:'Proceed under the new requirement?'});
  assert.notEqual(fresh.id,old.id);assert.deepEqual(context(s).sections.questions.map(row=>row.id),[fresh.id]);
  assert.deepEqual(as(s,'alice',()=>tasks.humanQueue(s)).map(row=>row.id),[fresh.id]);
  const history=tasks.showTask(s,task.id).questions;assert.equal(history.find(q=>q.id===old.id).status,'cancelled');assert.equal(history.find(q=>q.id===fresh.id).status,'pending');
});


test('actionable reviews exclude approved work and permit human self-review',t=>{
  const {s}=fixture(t),own=tasks.addTask(s,{title:'Builder implementation',owner:'builder'});
  tasks.takeTask(s,own.id);tasks.submitTask(s,own.id,'Ready for another reviewer');
  assert.ok(!context(s).sections.reviews.some(row=>row.id===own.id),'agent cannot review its own work');
  assert.ok(as(s,'reviewer',()=>context(s)).sections.reviews.some(row=>row.id===own.id));
  as(s,'reviewer',()=>tasks.reviewTask(s,own.id,{approve:true,note:'Approved reviewed version',expected_version:s.task(own.id).version}));
  assert.equal(s.task(own.id).status,'review');
  for(const role of ['builder','reviewer','alice'])assert.ok(!as(s,role,()=>context(s)).sections.reviews.some(row=>row.id===own.id),'approval is no longer an actionable review');
  as(s,'alice',()=>{
    const human=tasks.addTask(s,{title:'Human-owned change',owner:'alice',humanOnly:true});
    tasks.takeTask(s,human.id);tasks.submitTask(s,human.id,'Ready for my review');
    assert.ok(context(s).sections.reviews.some(row=>row.id===human.id),'human may review own work');
    tasks.reviewTask(s,human.id,{approve:true,note:'Human self-review complete',expected_version:s.task(human.id).version});
    assert.ok(!context(s).sections.reviews.some(row=>row.id===human.id));
  });
});

test('the asker, the task creator or a human withdraws a pending question with a reason; others may not',t=>{
  const {s,db}=fixture(t),task=tasks.addTask(s,{title:'Pick a host'});
  const old=tasks.askHuman(s,task.id,{question:'Which host?',options:['local','hosted']});
  assert.equal(tasks.showTask(s,task.id).status,'blocked');
  assert.throws(()=>as(s,'reviewer',()=>tasks.withdrawQuestion(s,old.id,'not mine')),e=>e.code===3);
  assert.throws(()=>tasks.withdrawQuestion(s,old.id,''),/withdraw reason/);
  const out=tasks.withdrawQuestion(s,old.id,'reworded as a new question');
  assert.equal(out.status,'cancelled');assert.equal(out.cancelled_by,'builder');assert.equal(out.cancel_reason,'reworded as a new question');
  assert.equal(tasks.showTask(s,task.id).status,'open');
  as(s,'alice',()=>assert.equal(tasks.humanQueue(s).filter(r=>r.id===old.id).length,0));
  assert.throws(()=>tasks.withdrawQuestion(s,old.id,'again'),e=>e.code===4);
  assert.throws(()=>as(s,'alice',()=>tasks.answerQuestion(s,old.id,'1')),/cancelled/);
  // The new question is untouched; the human may withdraw it too, through the command.
  const next=tasks.askHuman(s,task.id,{question:'Which host, local or ours?',options:['local','hosted']});
  const cli=run(db,['withdraw',next.id,'settled','in','chat','--as','alice']);
  assert.equal(cli.status,'cancelled');assert.equal(cli.cancel_reason,'settled in chat');assert.equal(cli.cancelled_by,'alice');
  assert.equal(tasks.showTask(s,task.id).status,'open');
});

test('the human queue says who asked, how long ago, and marks what nobody touched for a week (T1085)',t=>{
  const {s,db}=fixture(t),old=new Date(Date.now()-9*86_400_000).toISOString();
  const asked=tasks.addTask(s,{title:'Choose host'}),q=tasks.askHuman(s,asked.id,{question:'Which host?'});
  const work=tasks.addTask(s,{title:'Sign the form',humanOnly:true}),fresh=tasks.addTask(s,{title:'Read the note',humanOnly:true});
  s.run('UPDATE questions SET created_at=? WHERE id=?',old,Number(q.id.slice(1)));
  s.run('UPDATE tasks SET created_at=?,updated_at=? WHERE id IN (?,?)',old,old,Number(asked.id.slice(1)),Number(work.id.slice(1)));
  const rows=run(db,['--as','alice','humans','--for','alice']),by=id=>rows.find(r=>r.id===id);
  assert.deepEqual([by(q.id).asked_by,by(q.id).age_days,by(q.id).untouched],['builder',9,true]);
  assert.deepEqual([by(work.id).asked_by,by(work.id).age_days,by(work.id).untouched],['builder',9,true]);
  assert.deepEqual([by(fresh.id).age_days,by(fresh.id).untouched],[0,false]);
  assert.deepEqual(run(db,['--as','alice','humans','--untouched']).map(r=>r.id).sort(),[q.id,work.id].sort());
  // A change to the question's task counts as touching it.
  s.run('UPDATE tasks SET updated_at=? WHERE id=?',new Date().toISOString(),Number(asked.id.slice(1)));
  assert.deepEqual(run(db,['--as','alice','humans','--untouched']).map(r=>r.id),[work.id]);
  const text=spawnSync(process.execPath,[cli,'--db',db,'--workspace','team','--as','alice','humans'],{encoding:'utf8'}).stdout;
  assert.match(text,/Sign the form.*\(asked by builder, 9 d, untouched\)/);
  assert.match(text,/Which host\? \(asked by builder, 9 d\)/);
});

test('context shows a role its own open questions with their age and the untouched mark (T1085)',t=>{
  const {s}=fixture(t),old=new Date(Date.now()-10*86_400_000).toISOString();
  const task=tasks.addTask(s,{title:'Choose host',owner:'builder'}),q=tasks.askHuman(s,task.id,{question:'Which host?'});
  let row=context(s).sections.questions.find(r=>r.id===q.id);
  assert.deepEqual([row.age_days,row.untouched],[0,false]);
  s.run('UPDATE questions SET created_at=? WHERE id=?',old,Number(q.id.slice(1)));
  s.run('UPDATE tasks SET updated_at=? WHERE id=?',old,Number(task.id.slice(1)));
  row=context(s).sections.questions.find(r=>r.id===q.id);
  assert.deepEqual([row.age_days,row.untouched],[10,true]);
  assert.match(renderContext(context(s)),new RegExp(`questions: ${q.id} · task=${task.id} · for_role=alice · age_days=10 · untouched=true · question=Which host\\?`));
});

test('ask-human --new makes the task and asks the question in one step (T1085)',t=>{
  const {s,db}=fixture(t);
  const q=run(db,['--as','builder','ask-human','--new','Pick a host','Which host for the beta?','--options','local|hosted']);
  assert.match(q.id,/^H\d+$/);assert.equal(q.for_role,'alice');assert.equal(q.task_title,'Pick a host');
  const task=tasks.showTask(s,q.task_id);
  assert.deepEqual([task.title,task.body,task.owner,task.for_role,task.creator],['Pick a host','Which host for the beta?','builder','builder','builder']);
  assert.equal(task.blockers[0].waiting_on,'alice');
  assert.ok(run(db,['--as','alice','humans']).some(r=>r.id===q.id));
  const both=raw(db,['--as','builder','ask-human','--new','Again',task.id,'Which host?']);
  assert.equal(both.status,2);assert.match(both.stderr,/either --new TITLE or a task id/);
  // Options given as two words, not 'a|b', would leave the second in the question text (T1275).
  for(const argv of [['ask-human',task.id,'Which host?','--options','local','hosted'],['ask-human','--new','Split','Which host?','--options','local','hosted']]) {
    const extra=raw(db,['--as','builder',...argv]);
    assert.equal(extra.status,2);assert.match(extra.stderr,/one question text: quote it, and separate options with \|/);
  }
  // A refused question leaves no task behind: the two writes share one transaction.
  const before=s.get('SELECT count(*) AS n FROM tasks').n;
  const bad=raw(db,['--as','builder','ask-human','--new','Orphan','Which?','--for','nobody']);
  assert.notEqual(bad.status,0);assert.equal(s.get('SELECT count(*) AS n FROM tasks').n,before);
});

test('answer --asked records a question nobody recorded and its answer together (T1085)',t=>{
  const {s,db}=fixture(t),task=tasks.addTask(s,{title:'Choose host',owner:'builder'});
  const on=run(db,['--as','alice','answer','--asked','Which host?','--on',task.id,'--relayed-by','builder','Hosted']);
  assert.deepEqual([on.status,on.answer,on.answered_by,on.asked_by,on.relayed_by,on.task_id],['answered','Hosted','alice','builder','builder',task.id]);
  assert.equal(tasks.showTask(s,task.id).blockers.length,0);
  assert.equal(s.get("SELECT count(*) AS n FROM events WHERE entity='question' AND entity_id=? AND action='recorded'",on.id).n,1);
  const made=run(db,['--as','alice','answer','--asked','Ship on Monday?','--new','Ship date','--relayed-by','builder','--close','Yes']);
  const t2=tasks.showTask(s,made.task_id);
  assert.deepEqual([t2.title,t2.owner,t2.for_role,t2.status],['Ship date','builder','builder','done']);
  // Only a human records an answer, and always says who heard it.
  assert.equal(raw(db,['--as','builder','answer','--asked','Q?','--on',task.id,'--relayed-by','builder','A']).status,3);
  assert.match(raw(db,['--as','alice','answer','--asked','Q?','--on',task.id,'A']).stderr,/--relayed-by ROLE/);
  assert.match(raw(db,['--as','alice','answer','--asked','Q?','--relayed-by','builder','A']).stderr,/--on T1.*--new TITLE/);
  assert.match(raw(db,['--as','alice','answer',on.id,'A','--on',task.id]).stderr,/go with --asked/);
  assert.equal(s.get("SELECT detail FROM events WHERE entity='task' AND entity_id=? AND action='human-question'",task.id).detail.includes('"asked_by":"builder"'),true);
  // A failure after the new task is made rolls the task back with the question.
  s.run("CREATE TRIGGER boom BEFORE INSERT ON questions WHEN NEW.question='Boom?' BEGIN SELECT RAISE(ABORT,'boom'); END");
  const before=s.get('SELECT count(*) AS n FROM tasks').n;
  assert.notEqual(raw(db,['--as','alice','answer','--asked','Boom?','--new','Orphan','--relayed-by','builder','A']).status,0);
  assert.equal(s.get('SELECT count(*) AS n FROM tasks').n,before);
});
