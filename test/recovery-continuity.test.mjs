import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { addTask, takeTask, submitTask } from '../dist/tasks.js';
import { inbox, send } from '../dist/coordination.js';
import { saveCheckpoint } from '../dist/recovery-write.js';
import { getCheckpoint } from '../dist/checkpoints.js';
import { saveNotificationProgress, getNotificationProgress } from '../dist/notification-progress.js';
import { waitForWork } from '../dist/mail-wait.js';

// Database continuity only: this test makes no claims about provider recovery.
test('reopening durable state preserves unfinished work, checkpoint, bytes and notification replay',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'sassato-continuity-')),db=join(dir,'state.db'),file=join(dir,'unfinished.txt');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  writeFileSync(file,'unfinished bytes\n\n');
  let s=new Store(db,'builder',{create:true});
  let task,progress,checkpoint;
  try {
    initWorkspace(s,'demo',{roles:[{name:'builder',provider:'codex',model:'fixture-model'},{name:'reviewer'},{name:'human',kind:'human'}]});
    task=takeTask(s,addTask(s,{title:'Unfinished parser',forRole:'builder'}).id);
    progress=saveNotificationProgress(s,{cursor:s.get('SELECT max(id) n FROM events').n,expected_version:0});
    checkpoint=saveCheckpoint(s,{current:`Continue ${task.id}`,next:'Read inbox and preserve unfinished bytes',notes:'Job state is reported fixture data, not provider proof.',evidence:{version:1,jobs:[{id:'fixture-job',description:'Reported fixture job',state:'completed',disposition:'finish'}],validation:[],artifacts:[]}});
    s.actor='reviewer';const review=takeTask(s,addTask(s,{title:'Ready for review'}).id);submitTask(s,review.id,'Review work');send(s,['builder'],'Message after checkpoint');
  } finally {s.close();}
  s=new Store(db,'builder',{readonly:true});
  try {
    s.use('demo');
    assert.equal(s.task(task.id).owner,'builder');assert.equal(s.task(task.id).status,'doing');assert.equal(s.task(task.id).version,task.version);
    assert.equal(s.role('builder').model,'fixture-model');assert.equal(readFileSync(file,'utf8'),'unfinished bytes\n\n');
    const restored=getCheckpoint(s);assert.equal(restored.id,checkpoint.id);assert.equal(restored.state,'stale');assert.equal(restored.evidence.reported.jobs[0].state,'completed');
    assert.deepEqual(getNotificationProgress(s),progress);assert.equal(inbox(s,{peek:true})[0].body,'Message after checkpoint');
    const event=await waitForWork(s,{timeout:1});assert.equal(event.reason,'review-submitted');assert.deepEqual(await waitForWork(s,{timeout:1}),event);
    assert.deepEqual(getNotificationProgress(s),progress);assert.equal(inbox(s,{peek:true})[0].state,'unread');
  } finally {s.close();}
});
