import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Store} from '../dist/storage.js';
import {initWorkspace,status,renderStatus} from '../dist/admin.js';
import {context,renderContext,send,setFact,processIdentity} from '../dist/coordination.js';
import {addTask,takeTask,doneTask,askHuman,answerQuestion,handoffTask,blockTask,noteTask} from '../dist/tasks.js';
import {saveNotificationProgress} from '../dist/notification-progress.js';
import {requestStop} from '../dist/control.js';
import {fixtureConfig} from './fixtures/team.mjs';
function setup(t){const dir=mkdtempSync(join(tmpdir(),'sassato-brief-')),path=join(dir,'state.db'),s=new Store(path,'human',{create:true});initWorkspace(s,'team',fixtureConfig);s.use('team');s.actor='a';t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return {s,path,cursor:()=>Number(s.get('SELECT coalesce(max(id),0) n FROM events WHERE workspace_id=?',s.ws).n)};}
function as(s,role,fn){const old=s.actor;s.actor=role;try{return fn();}finally{s.actor=old;}}
const delta=(s,since,limit)=>context(s,{brief:true,since,limit});
test('brief delta returns only directed new mail, state changes, changed facts and own answers',t=>{
 const {s,cursor}=setup(t),old=addTask(s,{title:'Old task'}),fact=setFact(s,'stable',{body:'Do not repeat me',source:'fixture'});takeTask(s,old.id);
 const since=cursor(),mail=as(s,'b',()=>send(s,['a'],'New mail')),next=addTask(s,{title:'New task'});
 as(s,'b',()=>send(s,['c'],'Private unrelated mail'));as(s,'b',()=>addTask(s,{title:'Unrelated b',owner:'b'}));
 noteTask(s,old.id,'Note is not a state change');const changed=setFact(s,'new-key',{body:'New decision',source:'fixture'});
 const question=askHuman(s,next.id,{question:'Proceed?'});as(s,'human',()=>answerQuestion(s,question.id,'Yes'));
 const before=cursor(),receipts=JSON.stringify(s.all('SELECT * FROM receipts')),view=delta(s,since),output=renderContext(view);
 assert.equal(view.sections.mail[0].id,mail.id);assert.equal(view.sections.mail.length,2,'includes the automatic human-answer notification');assert.equal(view.sections.mail[1].from,'human');assert.ok(view.sections.tasks.some(r=>r.id===next.id));assert.ok(!view.sections.tasks.some(r=>r.id===old.id));
 assert.deepEqual(view.sections.facts.map(r=>r.id),[changed.id]);assert.equal(view.counts.facts_unchanged,1);assert.ok(!output.includes(fact.key));assert.match(output,/1 unchanged facts; sas facts/);assert.ok(output.includes(question.id));
 assert.equal(cursor(),before);assert.equal(JSON.stringify(s.all('SELECT * FROM receipts')),receipts);assert.ok(!output.includes('Private unrelated'));assert.equal(view.cursor,view.snapshot_cursor);
 assert.equal(Object.keys(delta(s,view.cursor).sections).length,0);
});
test('delta paging never skips omitted mixed changes, including repeated fact corrections',t=>{
 const {s,cursor}=setup(t),since=cursor(),expected=new Set();let fact;
 for(let n=0;n<12;n++){const task=addTask(s,{title:'Task '+n});expected.add(task.id);expected.add(as(s,'b',()=>send(s,['a'],'Mail '+n)).id);fact=setFact(s,'fact-'+n,{body:'First '+n,source:'fixture'});expected.add(fact.id);}
 setFact(s,fact.key,{body:'Corrected',source:'fixture',expected_version:1});
 let from=since;const seen=new Set();
 for(let n=0;n<40;n++){const view=delta(s,from,2),output=renderContext(view);for(const rows of Object.values(view.sections))for(const row of rows){seen.add(row.id);assert.ok(output.includes(row.id));}assert.ok(view.cursor>from);from=view.cursor;if(!view.truncated)break;}
 assert.deepEqual([...seen].sort(),[...expected].sort());assert.equal(from,cursor());
 assert.throws(()=>delta(s,from+100),/ahead of this workspace/);
});
test('state changes remain visible after handoff away and unchanged snapshots do not repeat',t=>{
 const {s,cursor}=setup(t),task=addTask(s,{title:'Handoff'});takeTask(s,task.id);const since=cursor();handoffTask(s,task.id,'b','Own it');
 const view=delta(s,since);assert.equal(view.sections.tasks[0].owner,'b');assert.equal(view.sections.tasks[0].id,task.id);assert.equal(delta(s,view.cursor).sections.tasks,undefined);
});
test('all brief lines are bounded Unicode lines with public IDs; STOP always appears',t=>{
 const {s,cursor}=setup(t);const since=cursor(),mail=as(s,'b',()=>send(s,['a'],'😀'.repeat(1000)+'\nInjected line'));
 as(s,'human',()=>requestStop(s,['a']));
 for(const view of [context(s,{brief:true}),context(s,{brief:true,since,lineLength:120})]){
  const text=renderContext(view);assert.ok(text.split('\n').every(line=>Array.from(line).length<=(view.line_length??200)));assert.match(text,/STOP R\d+/);assert.ok(text.includes(mail.id));assert.ok(!text.includes('\ufffd'));
 }
 assert.throws(()=>context(s,{brief:true,lineLength:1}),/line length/);
});
test('role status shows own tasks, waits, replies, saved cursor and verified waiter without mutations',t=>{
 const {s,cursor}=setup(t),mine=addTask(s,{title:'Mine'});takeTask(s,mine.id);const theirs=as(s,'b',()=>addTask(s,{title:'Blocked b',owner:'b'}));
 const blocker=as(s,'b',()=>blockTask(s,theirs.id,{kind:'agent',waitingOn:'a',body:'Need your answer'}));const mail=as(s,'b',()=>send(s,['a'],'Review this',{needsReply:true}));
 saveNotificationProgress(s,{cursor:cursor(),expected_version:0});
 s.run('INSERT INTO supervisor_waiters VALUES(?,?,?,?,?,?,?,?,NULL)','fixture-waiter',s.ws,'a',process.pid,processIdentity(process.pid),0,cursor(),new Date().toISOString());
 const before=cursor(),view=status(s),text=renderStatus(view);assert.equal(view.waiter.armed,true);assert.ok(text.includes(mine.id));assert.ok(text.includes(blocker.id));assert.ok(text.includes(mail.id));assert.ok(!view.own_tasks.some(r=>r.id===theirs.id));assert.equal(cursor(),before);
 s.run("UPDATE supervisor_waiters SET process_start='wrong' WHERE id='fixture-waiter'");assert.equal(status(s).waiter.armed,false);assert.match(renderStatus(status(s)),/stale\/unconfirmed/);
 assert.ok(text.split('\n').length<=24);assert.ok(text.split('\n').every(line=>Array.from(line).length<=200));
});
test('status remains one screen with overflowing queues and IDs for detailed lookups',t=>{
 const {s}=setup(t);for(let n=0;n<10;n++){addTask(s,{title:'😀'.repeat(150),owner:'a'});as(s,'b',()=>send(s,['a'],'Reply '+n,{needsReply:true}));const task=as(s,'b',()=>addTask(s,{title:'Other '+n,owner:'b'}));as(s,'b',()=>blockTask(s,task.id,{kind:'agent',waitingOn:'a',body:'Need '+n}));}
 const view=status(s),text=renderStatus(view);assert.deepEqual(view.more,{tasks:true,waits:true,replies:true});assert.ok(text.split('\n').length<=24);assert.match(text,/More items exist/);assert.equal(view.notification_progress.state,'absent');
});
test('CLI brief delta and status accept line limits while JSON remains structured',t=>{
 const {s,path,cursor}=setup(t),since=cursor();as(s,'b',()=>send(s,['a'],'CLI mail'));
 const run=(...args)=>spawnSync(process.execPath,[resolve('bin/sassato.js'),...args,'--db',path,'--workspace','team','--as','a'],{encoding:'utf8'});
 const brief=run('context','--brief','--since',String(since),'--line-length','100');assert.equal(brief.status,0,brief.stderr);assert.match(brief.stdout,/changes since/);assert.ok(brief.stdout.trim().split('\n').every(line=>Array.from(line).length<=100));
 const status=run('status');assert.equal(status.status,0,status.stderr);assert.match(status.stdout,/waiter unregistered/);assert.equal(JSON.parse(run('status','--json').stdout).role,'a');assert.equal(run('context','--brief','--line-length','20').status,2);
});
