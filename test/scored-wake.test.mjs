import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../dist/storage.js';
import { initWorkspace, showRecord } from '../dist/admin.js';
import { acknowledge, inbox, registerSession, send, wakeAudit } from '../dist/coordination.js';
import { addTask, blockTask, handoffTask, takeTask, noteTask, updateTask } from '../dist/tasks.js';
import { waitForWork } from '../dist/mail-wait.js';
import { wake } from '../dist/wake.js';
import { enrollPendingWake, readPendingWake, stagePendingWake } from '../dist/pending-wake.js';
import { getNotificationProgress, saveNotificationProgress } from '../dist/notification-progress.js';
import { requestSupervisorPing, acknowledgeSupervisorPing } from '../dist/supervisor-monitor.js';
import { setWorkspaceSettings, workspaceSettings } from '../dist/workspace-settings.js';
import { effectiveWakePolicy } from '../dist/wake-policy.js';
import { saveCheckpoint } from '../dist/recovery-write.js';
import { fixtureConfig } from './fixtures/team.mjs';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-scored-')),db=join(dir,'state.db');
  const operator=new Store(db,'human',{create:true});
  initWorkspace(operator,'team',fixtureConfig);operator.use('team');
  const a=new Store(db,'a'),b=new Store(db,'b');a.use('team');b.use('team');
  t.after(()=>{b.close();a.close();operator.close();rmSync(dir,{recursive:true,force:true});});
  const latest=()=>operator.get('SELECT max(id) AS id FROM events WHERE workspace_id=?',operator.ws).id;
  saveNotificationProgress(b,{cursor:latest(),expected_version:0});
  const base=Date.now()+100, stopFile=join(dir,'STOP');
  const mail=(options={},targets=['b'])=>send(a,targets,'Fixture message',options);
  const timestamp=id=>Date.parse(operator.get("SELECT created_at FROM events WHERE entity='message' AND entity_id=? AND action='sent'",id).created_at);
  const opt=(patch={})=>setWorkspaceSettings(operator,{wake_mode:'scored',...patch});
  return {operator,a,b,base,stopFile,latest,mail,opt,timestamp};
}

function controlled(base,{jump=0,onSleep}={}) {
  let elapsed=0,sleeps=0;
  return {
    now:()=>base+elapsed,
    monotonic:()=>elapsed,
    sleep:async ms=>{elapsed+=Math.max(ms,jump);onSleep?.(++sleeps);},
  };
}

test('legacy settings, strict parsed scores and send-transaction audit preserve flags and broadcast',t=>{
  const f=fixture(t);
  assert.equal(workspaceSettings(f.b).wake_mode,'legacy');
  assert.equal(workspaceSettings(f.b).speed,'normal');
  assert.throws(()=>setWorkspaceSettings(f.a,{wake_mode:'scored'}),/human role/);
  assert.throws(()=>f.opt({speed:'turbo'}),/Workspace speed/);
  assert.throws(()=>f.opt({wake_roles:{b:{threshold:1.5}}}),/integer/);
  assert.equal(workspaceSettings(f.b).wake_mode,'legacy');
  const before=f.latest();
  for(const urgency of [-1,11,'2.5','1e1','0x2'])assert.throws(()=>f.mail({urgency}),/urgency/);
  assert.throws(()=>f.mail({urgency:8}),/--reason/);
  assert.throws(()=>f.mail({urgency:8,reason:' \n '}),/nonempty/);
  assert.throws(()=>f.mail({urgency:8,reason:'this\nthat'}),/one line/);
  assert.throws(()=>f.mail({urgent:true,urgency:4}),/conflicts/);
  assert.equal(f.latest(),before);
  const zero=f.mail({urgency:'0',needsReply:true});
  const high=f.mail({urgency:8,reason:'A deployment decision waits'},'all');
  const alias=f.mail({urgent:true,needsReply:true});
  f.mail({now:true});f.mail({now:true});
  assert.equal(zero.urgency,0);assert.equal(zero.reply,true);
  assert.equal(alias.urgency,5);assert.ok(high.recipients.includes('b'));assert.ok(!high.recipients.includes('a'));
  assert.equal(showRecord(f.operator,high.id).urgency_reason,'A deployment decision waits');
  assert.equal(wakeAudit(f.operator).high_scores[0].message,high.id);
  assert.deepEqual(wakeAudit(f.operator).repeated_now.map(row=>({...row})),[{sender:'a',uses:2}]);
  assert.throws(()=>wakeAudit(f.a),/human role/);
  const event=f.operator.get("SELECT actor,detail FROM events WHERE entity_id=? AND action='sent'",high.id);
  assert.equal(event.actor,'a');assert.equal(JSON.parse(event.detail).urgency,8);
  // A row already in place before migration derives both urgency and immediacy from its old flags/audit.
  const old=f.mail({now:true,needsReply:true});
  f.operator.run('UPDATE messages SET urgency=NULL,immediate=NULL WHERE id=?',Number(old.id.slice(1)));
  assert.equal(showRecord(f.operator,old.id).urgency,5);
  assert.equal(showRecord(f.operator,old.id).now,true);
});

test('threshold is inclusive, marking read preserves score, and durable delivery does not need an ack',async t=>{
  const f=fixture(t);f.opt();
  for(let i=0;i<10;i++)f.mail();
  inbox(f.b);
  const clock=controlled(f.base);
  const preview=await waitForWork(f.b,{timeout:1,clock});
  assert.equal(preview.digest.score.reason,'threshold');
  assert.equal(preview.digest.score.total,10);
  assert.equal((await waitForWork(f.b,{timeout:1,clock})).digest.entries.length,10);
  const result=await wake(f.b,{timeout:1,clock});
  assert.equal(result.commit().saved,true);
  assert.equal(inbox(f.b,{peek:true}).length,10);
  const cursor=getNotificationProgress(f.b).cursor;
  const quiet=await wake(f.b,{timeout:1,clock});
  assert.equal(quiet.result.reason,'timeout');
  assert.equal(quiet.result.cursor,cursor);
  assert.equal(quiet.commit,undefined);
});

test('zero has no timer, early acknowledgement removes score, and a speed change keeps the old timestamp',async t=>{
  const f=fixture(t);f.opt({speed:'slow'});
  const removed=f.mail({urgency:6,reason:'Decision'});acknowledge(f.b,removed.id);
  const zero=f.mail({urgency:0,needsReply:true});
  const urgent=f.mail({urgent:true});
  const clock=controlled(f.timestamp(urgent.id)+110_000,{onSleep:sleep=>{if(sleep===1)f.opt({speed:'normal'});}});
  const out=await waitForWork(f.b,{timeout:12,clock});
  assert.equal(clock.monotonic(),10_000);
  assert.equal(out.digest.score.reason,'age');
  assert.equal(out.digest.score.trigger,urgent.id);
  assert.deepEqual(out.digest.entries.map(x=>x.id),[urgent.id,zero.id]);
  assert.equal(out.digest.score.total,5);
});

test('capacity orders the trigger first and preserves the remainder across competing commits',async t=>{
  const f=fixture(t);f.opt();
  const all=Array.from({length:104},()=>f.mail().id);
  const urgent=f.mail({urgent:true}).id;all.push(urgent);
  const clock=controlled(f.base);
  const first=await wake(f.b,{timeout:1,clock});
  const duplicate=await wake(f.b,{timeout:1,clock});
  assert.equal(first.result.digest.entries[0].id,urgent);
  assert.equal(first.result.digest.has_more,true);
  assert.equal(first.result.digest.total,100);
  assert.equal(first.commit().saved,true);assert.equal(duplicate.commit().saved,false);
  const next=await wake(f.b,{timeout:1,clock});
  assert.equal(next.result.digest.score.reason,'continuation');
  assert.deepEqual([...first.result.digest.entries,...next.result.digest.entries].map(e=>e.id).sort(),all.sort());
  assert.equal(next.commit().saved,true);
  assert.equal((await wake(f.b,{timeout:1,clock})).result.reason,'timeout');
});

test('a scripted wait can save the scored receipt and advance beyond a partly delivered page',t=>{
  const f=fixture(t);f.opt();
  const all=Array.from({length:104},()=>f.mail().id);
  const urgent=f.mail({urgent:true}).id;all.push(urgent);
  const before=getNotificationProgress(f.b);
  const run=(...args)=>spawnSync(process.execPath,['bin/sassato.js',...args,'--db',f.b.path,'--workspace','team','--as','b','--json'],{encoding:'utf8'});
  const first=run('wait','--timeout','1');
  assert.equal(first.status,0,first.stderr);
  const page=JSON.parse(first.stdout);
  assert.equal(page.digest.entries[0].id,urgent);
  assert.equal(page.digest.has_more,true);
  assert.deepEqual(getNotificationProgress(f.b),before);
  const args=['progress','save','--cursor',String(page.cursor),'--expect',String(before.version),'--scored-receipt',JSON.stringify(page.scored)];
  writeFileSync(f.stopFile,'stop');
  const stopped=run(...args,'--stop-file',f.stopFile);
  assert.equal(stopped.status,4,stopped.stderr);
  assert.deepEqual(getNotificationProgress(f.b),before);
  rmSync(f.stopFile);
  const saved=run(...args);
  assert.equal(saved.status,0,saved.stderr);
  assert.equal(run(...args).status,4);
  const next=run('wait','--timeout','1');
  assert.equal(next.status,0,next.stderr);
  const rest=JSON.parse(next.stdout);
  assert.equal(rest.digest.score.reason,'continuation');
  assert.ok(rest.cursor>page.cursor);
  assert.deepEqual([...page.digest.entries,...rest.digest.entries].map(entry=>entry.id).sort(),all.sort());
});

test('a scored wait with only quiet mail polls for an immediate message within 500ms',async t=>{
  const f=fixture(t);f.opt();f.mail();
  let immediate;
  const clock=controlled(f.base,{onSleep:()=>{immediate=f.mail({now:true});}});
  const result=await waitForWork(f.b,{idleMinutes:0,clock});
  assert.equal(clock.monotonic(),500);
  assert.equal(result.digest.score.trigger,immediate.id);
});

test('STOP before a direct receipt leaves scoring and cursor intact',async t=>{
  const f=fixture(t);f.opt();
  const immediate=f.mail({now:true,urgency:0});
  const cursor=getNotificationProgress(f.b).cursor;
  const out=await wake(f.b,{timeout:1,clock:controlled(f.base),stopFile:f.stopFile});
  assert.equal(out.result.digest.score.trigger,immediate.id);
  writeFileSync(f.stopFile,'stop');
  assert.equal(out.commit().saved,false);
  assert.equal(getNotificationProgress(f.b).cursor,cursor);
  const stopped=await waitForWork(f.b,{clock:controlled(f.base),stopFile:f.stopFile});
  assert.equal(stopped.reason,'stop');assert.equal(stopped.digest,undefined);
  rmSync(f.stopFile);
  assert.equal((await wake(f.b,{timeout:1,clock:controlled(f.base)})).result.digest.score.trigger,immediate.id);
});

test('only eligible work enables idle delivery, and explicit settle still selects legacy',async t=>{
  const f=fixture(t);f.opt({speed:'fast'});
  f.mail();
  const sole=await waitForWork(f.b,{timeout:1500,clock:controlled(f.base,{jump:1_500_000})});
  assert.equal(sole.reason,'timeout');
  addTask(f.b,{title:'My open work',forRole:'b'});
  const clock=controlled(f.base,{jump:1_500_000});
  const woke=await waitForWork(f.b,{timeout:1501,clock});
  assert.equal(clock.monotonic(),1_500_000);
  assert.equal(woke.reason,'open-work');assert.equal(woke.digest.score.reason,'idle');
  const disabled=await waitForWork(f.b,{timeout:1500,idleMinutes:0,clock:controlled(f.base,{jump:1_500_000})});
  assert.equal(disabled.reason,'timeout');
  f.mail({urgent:true});
  const legacy=await waitForWork(f.b,{timeout:1,settle:0});
  assert.equal(legacy.reason,'urgent');assert.equal(legacy.scored,undefined);
});

test('profile cadence respects the original ping deadline and asks active stale work to checkpoint',async t=>{
  const f=fixture(t);f.opt();
  assert.deepEqual(['slow','normal','fast'].map(speed=>{
    const p=effectiveWakePolicy(speed);
    return [p.threshold,p.urgent_seconds,p.reply_seconds,p.idle_minutes,p.checkpoint_minutes,p.ping_minutes];
  }),[[20,360,900,100,120,5],[10,120,300,50,60,2],[5,36,90,25,30,1]]);
  const task=addTask(f.b,{title:'Working role',forRole:'b'});takeTask(f.b,task.id);
  saveCheckpoint(f.b,{current:'Working',next:'Continue',notes:'Fixture'});
  noteTask(f.b,task.id,'This activity follows the checkpoint');
  f.mail();
  const first=requestSupervisorPing(f.operator,'b',f.base);
  assert.equal(Date.parse(first.deadline),f.base+120_000);
  assert.equal(requestSupervisorPing(f.operator,'b',f.base+119_999).nonce,first.nonce);
  const woke=await waitForWork(f.b,{timeout:1,clock:controlled(f.base+119_999)});
  assert.equal(woke.reason,'supervisor-ping');assert.equal(woke.digest.entries[0].kind,'supervisor-ping');
  acknowledgeSupervisorPing(f.b,first.nonce,0,f.base+120_000);
  const near=requestSupervisorPing(f.operator,'b',f.base+120_000);
  assert.notEqual(near.nonce,first.nonce);
  acknowledgeSupervisorPing(f.b,near.nonce,0,f.base+120_000);
  initWorkspace(f.operator,'another',fixtureConfig);
  f.operator.use('another');
  f.operator.run("INSERT INTO jobs(workspace_id,role,kind,command,status,need_mb,cpu_need,margin,pid,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    f.operator.ws,'b','fixture','[]','waiting',1,1,1,2147483000,new Date(f.base).toISOString());
  f.operator.use('team');
  const old=requestSupervisorPing(f.operator,'b',f.base+3_601_000);
  assert.equal(old.checkpoint_requested,true);
});


test('CLI parses decimal scores and human settings against the fixture DB', t=>{
  const f=fixture(t);
  const run=(actor,...args)=>spawnSync(process.execPath,['bin/sassato.js',...args,'--db',f.b.path,'--workspace','team','--as',actor,'--json'],{encoding:'utf8'});
  assert.equal(run('a','send','b','Test','--urgency','9').status,2);
  assert.equal(run('a','send','b','Test','--urgency','1e1').status,2);
  const sent=run('a','send','b','Test','--urgency','9','--reason','Time-sensitive decision');
  assert.equal(sent.status,0,sent.stderr);assert.equal(JSON.parse(sent.stdout).urgency,9);
  assert.equal(run('a','workspace','set','--wake-mode','scored').status,3);
  const configured=run('human','workspace','set','--wake-mode','scored','--speed','fast','--wake-roles','{"b":{"threshold":14}}');
  assert.equal(configured.status,0,configured.stderr);
  assert.deepEqual(JSON.parse(configured.stdout).wake_roles,{b:{threshold:14}});
  const audit=run('human','workspace','wake-audit');
  assert.equal(audit.status,0,audit.stderr);assert.equal(JSON.parse(audit.stdout).high_scores[0].urgency,9);
});

test('unconsumed launcher pagination keeps progress and receipts intact until its bound consumer commits', async t=>{
  const f=fixture(t);f.opt();
  const thread='211a70d9-399a-4a54-8dd4-3a156d04a1bb';
  const session=registerSession(f.b,{provider:'codex',external_id:thread});
  const epoch=enrollPendingWake(f.b,{session:Number(session.id.slice(1)),thread});
  const progress=getNotificationProgress(f.b);
  const ids=Array.from({length:100},()=>f.mail().id);
  ids.push(f.mail({now:true}).id);
  const clock=controlled(f.base);
  const result=await waitForWork(f.b,{since:progress.cursor,clock});
  stagePendingWake(f.b,epoch,progress,result);
  assert.deepEqual(getNotificationProgress(f.b),progress);
  assert.equal(inbox(f.b,{peek:true,limit:100}).filter(row=>row.state==='unread').length,100);
  assert.throws(()=>readPendingWake(f.b,'another thread'),/different Codex thread/);
  const read=readPendingWake(f.b,thread);
  assert.equal(read.result.digest.entries[0].id,ids.at(-1));
  assert.equal(read.commit().saved,true);
  const next=await waitForWork(f.b,{clock,timeout:1});
  assert.equal(next.digest.score.reason,'continuation');
  assert.deepEqual([...read.result.digest.entries,...next.digest.entries].map(entry=>entry.id).sort(),ids.sort());
});


test('a blocked assignment wakes its recipient without an extra point for the generated mail',async t=>{
  const f=fixture(t);f.opt();
  const task=addTask(f.a,{title:'Already blocked',owner:'a'});
  blockTask(f.a,task.id,{kind:'external',waitingOn:'fixture',body:'Waiting on the fixture'});
  handoffTask(f.a,task.id,'b','Continue after the external blocker clears');
  const sent=f.operator.get("SELECT created_at FROM events WHERE entity='task' AND entity_id=? AND action='handed-off'",task.id);
  const clock=controlled(Date.parse(sent.created_at)+300_000);
  const woke=await waitForWork(f.b,{timeout:1,clock});
  assert.equal(woke.digest.score.total,3);
  assert.equal(woke.reason,'task-assigned');
  assert.equal(woke.task,task.id);
  assert.deepEqual(woke.digest.entries.map(entry=>entry.weight),[3,0]);
});

test('a replacement route and observed mail cannot contribute their old wake events',async t=>{
  const f=fixture(t);f.opt();
  const task=addTask(f.a,{title:'Rerouted work',forRole:'b'});
  const routed=updateTask(f.a,task.id,{version:task.version,forRole:'a'});
  updateTask(f.a,task.id,{version:routed.version,forRole:'b'});
  const replaced=f.operator.get("SELECT max(id) AS id FROM events WHERE entity='task' AND entity_id=?",task.id).id;
  const delivered=f.mail({now:true});
  const observer={inspect(){},deliveredMail:new Set([delivered.id])};
  const out=await waitForWork(f.b,{timeout:1,clock:controlled(Date.now()+300_001)},observer);
  assert.equal(out.reason,'task-assigned');
  assert.equal(out.digest.score.total,3);
  assert.deepEqual(out.digest.entries.map(entry=>entry.event_id),[`E${replaced}`]);
});
