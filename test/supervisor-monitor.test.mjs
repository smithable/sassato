import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawnSync,spawn } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { workerTokenHash } from '../dist/managed-generation.js';
import { requestSupervisorPing,acknowledgeSupervisorPing,supervisorStatus,armManagedWaiter,disarmManagedWaiter } from '../dist/supervisor-monitor.js';
import { waitForWork } from '../dist/mail-wait.js';
import { saveNotificationProgress } from '../dist/notification-progress.js';
import { requestStop } from '../dist/control.js';

const token='fixture-monitor-worker-'.repeat(3);
function fixture(t,managed=false) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-monitor-')),db=join(dir,'state.db');
  const controller=new Store(db,'reviewer',{create:true});initWorkspace(controller,'demo');
  if(managed) {
    const at=new Date().toISOString();
    controller.run('INSERT INTO managed_controllers VALUES(?,?,?,?,?,?,?)','controller',controller.ws,'reviewer',join(dir,'controller.lock'),null,null,at);
    controller.run('INSERT INTO managed_workers(id,workspace_id,role,controller_id,binding_id,generation,token_hash,state,provider,external_id,pid,process_start,configuration_digest,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)','worker',controller.ws,'builder','controller',null,1,workerTokenHash(token),'running','claude',null,null,null,'0'.repeat(64),at);
  }
  const worker=new Store(db,'builder',{managedCredentials:{generation:managed?'1':undefined,token:managed?token:undefined}});worker.use('demo');
  t.after(()=>{worker.close();controller.close();rmSync(dir,{recursive:true,force:true});});return {dir,db,controller,worker};
}
test('generation-bound nonce wakes the right waiter without consuming notification progress',async t=>{
  const {controller,worker}=fixture(t,true),cursor=controller.get('SELECT max(id) n FROM events').n;
  const progress=saveNotificationProgress(worker,{cursor,expected_version:0});
  const ping=requestSupervisorPing(controller,'builder');
  assert.equal(requestSupervisorPing(controller,'builder').id,ping.id,'60 second interval prevents ping floods');
  const result=await waitForWork(worker,{since:cursor,timeout:1});
  assert.equal(result.reason,'supervisor-ping');assert.equal(result.nonce,ping.nonce);assert.equal(result.generation,1);
  assert.equal(worker.get("SELECT detail FROM events WHERE entity='notification-progress' AND id=?",Number(progress.id.slice(1))).detail.includes('"cursor":'+cursor),true);
  assert.throws(()=>acknowledgeSupervisorPing(controller,ping.nonce,1),/does not belong/);
  assert.throws(()=>acknowledgeSupervisorPing(worker,ping.nonce,0),/superseded/);
  assert.ok(acknowledgeSupervisorPing(worker,ping.nonce,1).acknowledged_at);
  assert.equal(supervisorStatus(controller).workers.find(w=>w.role==='builder').responsiveness.state,'acknowledged');
});
test('overdue and late responses are observations and never enable management',t=>{
  const {controller,worker}=fixture(t),clock=Date.now(),ping=requestSupervisorPing(controller,'builder',clock);
  let status=supervisorStatus(controller,clock+120001);assert.equal(status.workers.find(w=>w.role==='builder').responsiveness.state,'overdue');
  assert.equal(status.management_enabled,false);
  acknowledgeSupervisorPing(worker,ping.nonce,0,clock+120002);status=supervisorStatus(controller,clock+120003);
  assert.equal(status.workers.find(w=>w.role==='builder').responsiveness.state,'late');assert.equal(status.management_enabled,false);
  assert.equal(controller.get('SELECT count(*) n FROM managed_transitions').n,0);
});
test('managed waiter observations reserve one live PID and are distinct from checkpoints',t=>{
  const {controller,worker}=fixture(t,true),lease=armManagedWaiter(worker,0);
  assert.ok(lease);assert.throws(()=>armManagedWaiter(worker,0),/already exists/);
  let state=supervisorStatus(controller).workers.find(w=>w.role==='builder');assert.equal(state.waiter.armed,true);assert.equal(state.checkpoint,null);
  disarmManagedWaiter(worker,lease,1);state=supervisorStatus(controller).workers.find(w=>w.role==='builder');assert.equal(state.waiter.armed,false);
  assert.equal(worker.get('SELECT cursor FROM supervisor_waiters WHERE id=?',lease.id).cursor,1);
});
test('CLI managed wait tracks timeout cursor without advancing progress; STOP remains prominent',t=>{
  const {controller,worker,db}=fixture(t,true),cli=resolve('bin/sassato.js');saveNotificationProgress(worker,{cursor:0,expected_version:0});
  const run=args=>spawnSync(process.execPath,[cli,'--db',db,'--workspace','demo','--as','builder','--json',...args],{encoding:'utf8',env:{...process.env,SASSATO_WORKER_GENERATION:'1',SASSATO_WORKER_TOKEN:token},timeout:5000});
  const timed=run(['wait','--since','0','--timeout','1']);assert.equal(timed.status,5,timed.stderr);
  assert.equal(worker.get('SELECT count(*) n FROM supervisor_waiters WHERE ended_at IS NOT NULL').n,1);
  assert.equal(JSON.parse(worker.get("SELECT detail FROM events WHERE entity='notification-progress' ORDER BY id DESC LIMIT 1").detail).cursor,0);
  controller.actor='human';requestStop(controller,['builder']);controller.actor='reviewer';
  controller.run("UPDATE managed_workers SET state='stopped' WHERE id='worker'");
  const stopped=run(['wait','--since','0','--timeout','1']);assert.equal(stopped.status,0,stopped.stderr);assert.equal(JSON.parse(stopped.stdout).reason,'stop');
});
test('a generation frozen during wait still returns its cursor and leaves a positively reclaimable observation',async t=>{
  const {controller,worker,db}=fixture(t,true);saveNotificationProgress(worker,{cursor:0,expected_version:0});
  const child=spawn(process.execPath,[resolve('bin/sassato.js'),'--db',db,'--workspace','demo','--as','builder','--json','wait','--since','0','--timeout','1'],{env:{...process.env,SASSATO_WORKER_GENERATION:'1',SASSATO_WORKER_TOKEN:token},stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',bytes=>{out+=bytes;});child.stderr.on('data',bytes=>{err+=bytes;});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}});
  const deadline=Date.now()+5000;
  while(!controller.get('SELECT id FROM supervisor_waiters WHERE ended_at IS NULL')&&Date.now()<deadline)await new Promise(done=>setTimeout(done,10));
  assert.ok(controller.get('SELECT id FROM supervisor_waiters WHERE ended_at IS NULL'));
  controller.run("UPDATE managed_workers SET state='blocked' WHERE id='worker'");
  if(child.exitCode===null)await once(child,'exit');assert.equal(child.exitCode,5,err);
  const result=JSON.parse(out);assert.equal(result.reason,'timeout');assert.match(result.managed_observation,/cleanup-fenced/);assert.ok(Number.isInteger(result.cursor));
  assert.equal(JSON.parse(worker.get("SELECT detail FROM events WHERE entity='notification-progress' ORDER BY id DESC LIMIT 1").detail).cursor,0);
  controller.run("UPDATE managed_workers SET state='running' WHERE id='worker'");
  const lease=armManagedWaiter(worker,result.cursor);assert.ok(lease);disarmManagedWaiter(worker,lease,result.cursor);
});
