import { fixtureConfig } from './fixtures/team.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/storage.js';
import {initWorkspace} from '../dist/admin.js';
import {context} from '../dist/coordination.js';
import {waitForUrgent} from '../dist/mail-wait.js';
import {addTask,takeTask,listTaskPage,updateTask,showTask,handoffTask,addDependency,doneTask} from '../dist/tasks.js';
import {setWorkspaceSettings,workspaceSettings} from '../dist/workspace-settings.js';
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'sassato-spare-')),path=join(dir,'state.db'),s=new Store(path,'a',{create:true});
  initWorkspace(s,'team',fixtureConfig);s.use('team');
  t.after(()=>{if(s.db.isOpen)s.close();rmSync(dir,{recursive:true,force:true});});
  const real=performance.now.bind(performance);let shift=0;performance.now=()=>real()+shift;t.after(()=>{performance.now=real;});
  // One idle period: the clock jumps a minute past the idle limit while the waiter runs.
  const idle=async(timeout=300)=>{const timer=setTimeout(()=>{shift+=61_000;},50);t.after(()=>clearTimeout(timer));
    return waitForUrgent(s,{settle:0,timeout,stopFile:join(dir,'stop'),since:context(s).snapshot_cursor,idleMinutes:1});};
  return {s,idle};
}
test('spare tasks stay out of ready work and are offered only to an idle role with nothing else to do (T1102)',async t=>{
  const {s,idle}=fixture(t);
  s.actor='a';const spare=addTask(s,{title:'Tidy the docs',spare:true});
  assert.equal(spare.spare,true);
  s.actor='b';
  assert.deepEqual(context(s).sections.available.map(r=>r.id),[],'context does not offer it as ready work');
  assert.deepEqual(listTaskPage(s,{available:true}),{items:[],has_more:false,next_after:null},'no spare section either');
  assert.throws(()=>listTaskPage(s,{available:true,spare:true}),e=>e.code===2);
  const page=listTaskPage(s,{});
  assert.deepEqual(page.items.map(r=>r.id),[]);assert.deepEqual(page.spare.map(r=>r.id),[spare.id],'listed apart');
  assert.deepEqual(listTaskPage(s,{spare:true}).items.map(r=>r.id),[spare.id]);
  let event=await idle();
  assert.equal(event.reason,'spare-work');assert.deepEqual(event.tasks,[spare.id]);
  s.actor='a';const real=addTask(s,{title:'Real work'});s.actor='b';
  event=await idle();
  assert.equal(event.reason,'open-work');assert.deepEqual(event.tasks,[real.id],'ordinary open work comes first, alone');
  takeTask(s,real.id);
  event=await idle();
  assert.equal(event.reason,'own-work','own work comes before spare work');
});
test('only a human switches spare work and names its providers; the offer follows both (T1102)',async t=>{
  const {s,idle}=fixture(t);
  s.actor='a';const spare=addTask(s,{title:'Tidy the docs',spare:true});
  assert.throws(()=>setWorkspaceSettings(s,{spare_work:false}),e=>e.code===3);
  s.actor='human';setWorkspaceSettings(s,{spare_providers:['codex']});
  assert.throws(()=>setWorkspaceSettings(s,{spare_providers:['Not a name']}),/spare_providers/);
  s.actor='b';assert.equal((await idle(3)).reason,'timeout','b runs on claude, which is not listed');
  s.actor='human';setWorkspaceSettings(s,{spare_providers:['codex','claude']});
  s.actor='b';assert.deepEqual((await idle()).tasks,[spare.id]);
  s.actor='human';setWorkspaceSettings(s,{spare_work:false});assert.equal(workspaceSettings(s).spare_work,false);
  s.actor='b';assert.equal((await idle(3)).reason,'timeout','spare work switched off');
});
test('a spare task never wakes as ready work: not on a hand-over, not when a dependency of a doing one finishes (T1102)',async t=>{
  const {s}=fixture(t);
  s.actor='a';const spare=addTask(s,{title:'Tidy the docs',spare:true}),first=addTask(s,{title:'First'}),held=addTask(s,{title:'Also tidy',spare:true});
  s.actor='b';takeTask(s,held.id);addDependency(s,held.id,first.id);
  const since=context(s).snapshot_cursor;
  s.actor='a';takeTask(s,spare.id);handoffTask(s,spare.id,'b','yours if you have room');takeTask(s,first.id);doneTask(s,first.id);
  s.actor='b';
  const event=await waitForUrgent(s,{settle:0,timeout:1,stopFile:'/nonexistent/stop',since});
  assert.equal(event.reason,'timeout',JSON.stringify(event));
});
test('clearing the spare flag to jump the queue shows in the task history (T1102)',async t=>{
  const {s}=fixture(t);
  s.actor='a';const spare=addTask(s,{title:'Tidy the docs',spare:true});
  assert.throws(()=>{s.actor='b';updateTask(s,spare.id,{version:spare.version,spare:false});},e=>e.code===3,'a bystander cannot clear it');
  s.actor='b';const since=context(s).snapshot_cursor;
  s.actor='a';const changed=updateTask(s,spare.id,{version:spare.version,spare:false});
  assert.equal(changed.spare,false);
  s.actor='b';assert.deepEqual(listTaskPage(s,{available:true}).items.map(r=>r.id),[spare.id],'now ordinary ready work');
  const event=await waitForUrgent(s,{settle:0,timeout:3,stopFile:'/nonexistent/stop',since});
  assert.equal(event.reason,'task-ready');assert.equal(event.task,spare.id);
  const entry=showTask(s,spare.id).history.find(e=>e.action==='updated'&&e.actor==='a');
  assert.ok(entry,'the change is in the history with its actor');
  const detail=typeof entry.detail==="string"?JSON.parse(entry.detail):entry.detail;assert.equal(detail.before.spare,1);assert.equal(detail.after.spare,0);
});
