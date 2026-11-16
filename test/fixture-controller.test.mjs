import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { execFileSync,spawn,spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { addTask,takeTask,noteTask } from '../dist/tasks.js';
import { registerCheckout } from '../dist/checkouts.js';
import { saveNotificationProgress,getNotificationProgress } from '../dist/notification-progress.js';
import { setWorkspaceSettings } from '../dist/workspace-settings.js';
import { setSupervisorPolicy } from '../dist/supervisor-policy.js';
import { captureFixtureConfiguration,supervisorDigest } from '../dist/supervisor-snapshot.js';
import { acquireSupervisorLock } from '../dist/supervisor-locks.js';
import { FixtureController } from '../dist/fixture-controller.js';
import { requestStop } from '../dist/control.js';
import { processIdentity } from '../dist/coordination.js';

async function until(predicate,label='condition'){
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){const result=predicate();if(result)return result;await new Promise(r=>setTimeout(r,20));}
  throw new Error('Timed out: '+label);
}
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'sassato-controller-')),root=join(dir,'checkout'),db=join(dir,'state.db');mkdirSync(root);
  const git=(...args)=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
  git('init','-b','main');writeFileSync(join(root,'file.txt'),'initial');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','Initial');
  writeFileSync(join(root,'file.txt'),'preserved dirty file');
  const program=join(dir,'claude.mjs');copyFileSync(resolve('test/fixtures/managed-bootstrap.mjs'),program);
  const s=new Store(db,'builder',{create:true});initWorkspace(s,'demo');
  const task=addTask(s,{title:'Preserve worker objective'});takeTask(s,task.id);
  const checkout=registerCheckout(s,root),cursor=s.get('SELECT max(id) n FROM events').n;
  const progress=saveNotificationProgress(s,{cursor,expected_version:0}),configuration=captureFixtureConfiguration(s,'builder',program);
  s.actor='human';setWorkspaceSettings(s,{busy_checks:[{name:'fixture-protected-jobs',type:'command',argv:[process.execPath,'-e','process.exit(1)'],cwd:dir,timeout_ms:1000}]});
  const controllerPath=join(dir,'controller.lock'),maintenancePath=join(dir,'maintenance.lock');
  setSupervisorPolicy(s,{version:1,controller_id:randomUUID(),controller_role:'reviewer',worker_roles:['builder'],repository_ids:[checkout.repository_id],controller_lock:controllerPath,maintenance_lock:maintenancePath,maximum_workers:1});s.actor='reviewer';
  const lock=acquireSupervisorLock(controllerPath,'exclusive'),maintenance=acquireSupervisorLock(maintenancePath,'exclusive'),controller=new FixtureController(s,lock),children=[];
  t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}maintenance.close();lock.close();s.close();rmSync(dir,{recursive:true,force:true});});
  const launch=()=>controller.beginLaunch({role:'builder',task:task.id,checkout:checkout.checkout_id,directory:root,configuration,idempotency_key:'initial'},maintenance);
  function start(secret,overrides={}){
    assert.equal(secret.new_intent,true,'Replayed intents never carry credentials or authorize another spawn');
    const child=spawn(process.execPath,[program],{cwd:root,env:{...process.env,FIXTURE_DIST:resolve('dist'),FIXTURE_DB:db,FIXTURE_TRANSITION:secret.transition_id,FIXTURE_LAUNCH_TOKEN:secret.launch_token,SASSATO_WORKER_GENERATION:String(secret.generation),SASSATO_WORKER_TOKEN:secret.worker_token,...overrides},stdio:['ignore','ignore','pipe','ipc']});children.push(child);
    child.messages=[];child.on('message',message=>child.messages.push(message));let request=0;
    child.request=async message=>{const id=++request;child.send({...message,request:id});return until(()=>child.messages.find(row=>row.request===id),'fixture reply');};
    return child;
  }
  return {dir,root,db,s,task,progress,configuration,controller,maintenance,launch,start,lock,controllerPath,maintenancePath};
}
test('durable launch intent gates real fixture child; atomic readiness freezes the old worker',async t=>{
  const f=fixture(t),secret=await f.launch();
  assert.equal(f.s.get('SELECT state FROM managed_transitions WHERE id=?',secret.transition_id).state,'starting');
  await assert.rejects(()=>f.controller.releaseBootstrap(secret.transition_id,f.maintenance),/self-registration/);
  const child=f.start(secret);await until(()=>f.s.get('SELECT bootstrap_pid FROM managed_transitions WHERE id=?',secret.transition_id).bootstrap_pid);
  assert.equal((await child.request({type:'tool',path:join(f.root,'file.txt'),content:'too early'})).blocked,true);
  const replay=await f.launch();assert.equal(replay.new_intent,false);assert.equal(replay.transition_id,secret.transition_id);assert.equal(replay.worker_token,undefined);
  await f.controller.releaseBootstrap(secret.transition_id,f.maintenance);
  await until(()=>child.messages.find(row=>row.acting||row.fatal),'reconciliation');assert.equal(child.messages.find(row=>row.fatal),undefined,JSON.stringify(child.messages));
  assert.equal(f.s.task(f.task.id).owner,'builder');assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),'preserved dirty file');
  assert.equal(getNotificationProgress(f.s,'builder').cursor,f.progress.cursor);
  assert.throws(()=>f.controller.requestDrain(secret.worker_id,1,'initial'),/different operation/);
  const drain=f.controller.requestDrain(secret.worker_id,1,'handoff');assert.equal(f.controller.requestDrain(secret.worker_id,1,'handoff').id,drain.id);
  const report={version:1,objective:'Preserve worker objective',acceptance:['Dirty files and owner survive'],decisions:[{decision:'Same role',source:'Fixture test'}],open_issues:['Real providers remain unproven'],validation:[{command:'fixture bootstrap',result:'passed'}],artifacts:[],next_action:'Continue with the saved files',configuration:{digest:supervisorDigest(f.configuration),provenance:['Observed fixture executable and role settings']},jobs:[{id:'fixture-tool',state:'completed',evidence:'No active fixture jobs'}]};
  const ready=await child.request({type:'drain',transition:drain.id,nonce:JSON.parse(drain.payload).drain_nonce,report});
  assert.equal(ready.error,undefined,JSON.stringify(ready));assert.equal(ready.ready.state,'ready');
  assert.equal(f.s.get('SELECT state FROM managed_workers WHERE id=?',secret.worker_id).state,'ready');
  assert.equal(f.s.get('SELECT count(*) n FROM task_briefs').n,1);
  assert.equal((await child.request({type:'tool',path:join(f.root,'file.txt'),content:'after barrier'})).blocked,true);
  assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),'preserved dirty file');
  const stale=new Store(f.db,'builder',{managedCredentials:{generation:'1',token:secret.worker_token}});stale.use('demo');try{assert.throws(()=>stale.event('fixture','write','attempt',{}),/frozen/);}finally{stale.close();}
  await assert.rejects(()=>f.controller.startReplacement(drain.id,f.maintenance),/Verified fixture exit/);
  await f.controller.prepareFixtureRetirement(drain.id,f.maintenance);
  const old=f.s.get('SELECT * FROM managed_workers WHERE id=?',secret.worker_id),scope={kind:'fixture-only',worker_id:old.id,generation:old.generation,pid:old.pid,process_start:old.process_start,descendants:'empty'};
  await assert.rejects(()=>f.controller.recordFixtureExit(drain.id,scope,f.maintenance),/not conclusively exited/);
  const exit=once(child,'exit');child.send({type:'exit'});await exit;
  await assert.rejects(()=>f.controller.recordFixtureExit(drain.id,{...scope,descendants:'unknown'},f.maintenance),/unknown descendants/);
  await f.controller.recordFixtureExit(drain.id,scope,f.maintenance);
  f.s.actor='human';const policy=JSON.parse(f.s.get("SELECT detail FROM events WHERE entity='supervisor-policy' ORDER BY id DESC LIMIT 1").detail).policy;
  assert.throws(()=>setSupervisorPolicy(f.s,{...policy,controller_id:randomUUID()}),/do not orphan/);f.s.actor='reviewer';
  const replacement=await f.controller.startReplacement(drain.id,f.maintenance);assert.equal(replacement.generation,2);
  const replacementReplay=await f.controller.startReplacement(drain.id,f.maintenance);assert.equal(replacementReplay.new_intent,false);assert.equal(replacementReplay.launch_token,undefined);
  const newChild=f.start(replacement);await until(()=>f.s.get('SELECT bootstrap_pid FROM managed_transitions WHERE id=?',drain.id).bootstrap_pid);
  await f.controller.releaseBootstrap(drain.id,f.maintenance);
  await until(()=>newChild.messages.find(row=>row.acting||row.fatal),'successor acknowledgment');assert.equal(newChild.messages.find(row=>row.fatal),undefined,JSON.stringify(newChild.messages));
  assert.notEqual(newChild.messages.find(row=>row.acting).acting.external_id,child.messages.find(row=>row.acting).acting.external_id);
  assert.equal((await f.controller.startReplacement(drain.id,f.maintenance)).new_intent,false,'Lost acknowledgment must not create a new launch');
  assert.throws(()=>f.controller.requestDrain(secret.worker_id,2,'handoff'),/different operation or generation/);
  assert.equal(f.s.get('SELECT count(*) n FROM checkout_bindings WHERE released_at IS NULL').n,1);
  assert.equal(f.s.task(f.task.id).owner,'builder');assert.equal(getNotificationProgress(f.s,'builder').cursor,f.progress.cursor);
  assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),'preserved dirty file');
  const oldStore=new Store(f.db,'builder',{managedCredentials:{generation:'1',token:secret.worker_token}});oldStore.use('demo');try{assert.throws(()=>oldStore.event('fixture','write','old-generation',{}),/stale/);}finally{oldStore.close();}
});
test('STOP after self-registration cancels the child before it can act',async t=>{
  const f=fixture(t),secret=await f.launch(),child=f.start(secret);
  await until(()=>f.s.get('SELECT bootstrap_pid FROM managed_transitions WHERE id=?',secret.transition_id).bootstrap_pid);
  f.s.actor='human';requestStop(f.s,['builder']);f.s.actor='reviewer';
  await assert.rejects(()=>f.controller.releaseBootstrap(secret.transition_id,f.maintenance),/STOP/);
  await until(()=>child.exitCode!==null);assert.equal(child.exitCode,0);assert.equal(child.messages.some(row=>row.acting),false);
  assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),'preserved dirty file');
});
test('changed dirty files block bootstrap release without restoring or spawning another worker',async t=>{
  const f=fixture(t),secret=await f.launch();f.start(secret);
  await until(()=>f.s.get('SELECT bootstrap_pid FROM managed_transitions WHERE id=?',secret.transition_id).bootstrap_pid);
  writeFileSync(join(f.root,'file.txt'),'human change after intent');
  await assert.rejects(()=>f.controller.releaseBootstrap(secret.transition_id,f.maintenance),/changed/);
  assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),'human change after intent');
  assert.equal(f.s.get('SELECT count(*) n FROM managed_workers').n,1);
});
test('startup retry requires proven pre-release exit, rotates tokens and permits only one retry',async t=>{
  const f=fixture(t),secret=await f.launch();
  await assert.rejects(()=>f.controller.retryUnreleasedStartup(secret.transition_id,f.maintenance),/uncertain or post-release/);
  const child=f.start(secret);await until(()=>f.s.get('SELECT bootstrap_pid FROM managed_transitions WHERE id=?',secret.transition_id).bootstrap_pid);
  await assert.rejects(()=>f.controller.retryUnreleasedStartup(secret.transition_id,f.maintenance),/uncertain or post-release/);
  const exit=once(child,'exit');child.send({type:'exit'});await exit;
  const retry=await f.controller.retryUnreleasedStartup(secret.transition_id,f.maintenance);assert.equal(retry.generation,2);assert.notEqual(retry.worker_token,secret.worker_token);assert.notEqual(retry.launch_token,secret.launch_token);
  const next=f.start(retry);await until(()=>f.s.get('SELECT bootstrap_pid FROM managed_transitions WHERE id=?',secret.transition_id).bootstrap_pid);
  const secondExit=once(next,'exit');next.send({type:'exit'});await secondExit;
  await assert.rejects(()=>f.controller.retryUnreleasedStartup(secret.transition_id,f.maintenance),/Only one/);
});
test('duplicate bootstrap cannot act and an expired unreleased intent exits',async t=>{
  const f=fixture(t),secret=await f.launch(),first=f.start(secret);
  await until(()=>f.s.get('SELECT bootstrap_pid FROM managed_transitions WHERE id=?',secret.transition_id).bootstrap_pid);
  const duplicate=f.start(secret);await until(()=>duplicate.exitCode!==null);assert.equal(duplicate.exitCode,1);assert.match(duplicate.messages.find(row=>row.fatal).fatal,/Another bootstrap/);
  const row=f.s.get('SELECT payload FROM managed_transitions WHERE id=?',secret.transition_id),payload=JSON.parse(row.payload);
  f.s.run('UPDATE managed_transitions SET payload=? WHERE id=?',JSON.stringify({...payload,bootstrap_deadline:new Date(Date.now()-1).toISOString()}),secret.transition_id);
  // The running bootstrap retains its bounded monotonic deadline; release still
  // rejects the durable expired deadline. Cancel explicitly rather than waiting 120s.
  await assert.rejects(()=>f.controller.releaseBootstrap(secret.transition_id,f.maintenance),/deadline/);
  f.s.run("UPDATE managed_transitions SET state='blocked' WHERE id=?",secret.transition_id);
  await until(()=>first.exitCode!==null);assert.equal(first.messages.some(row=>row.acting),false);
});
test('job run holds shared maintenance exclusion and prevents policy changes until exit',async t=>{
  const f=fixture(t),marker=join(f.dir,'job-started'),release=join(f.dir,'job-release'),meminfo=join(f.dir,'meminfo');
  writeFileSync(meminfo,'MemTotal: 20480000 kB\nMemAvailable: 16384000 kB\n');f.maintenance.close();
  const child=spawn(process.execPath,[resolve('bin/sassato.js'),'--db',f.db,'--workspace','demo','--as','reviewer','job','run','--kind','other','--',process.execPath,'-e',"const fs=require('node:fs');fs.writeFileSync(process.argv[1],'ready');const t=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(t);process.exit(0)}},20)",marker,release],{env:{...process.env,SASSATO_JOB_MEMINFO:meminfo,SASSATO_JOB_CORES:'8',SASSATO_JOB_SCOPE:'0'},stdio:'ignore'});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}});
  await until(()=>f.s.get("SELECT id FROM jobs WHERE status='running'"),'protected job starts');
  assert.throws(()=>acquireSupervisorLock(join(f.dir,'maintenance.lock'),'exclusive'),/busy/);
  f.s.actor='human';const policy=JSON.parse(f.s.get("SELECT detail FROM events WHERE entity='supervisor-policy' ORDER BY id DESC LIMIT 1").detail).policy;
  assert.throws(()=>setSupervisorPolicy(f.s,policy),/Settle machine-wide jobs/);f.s.actor='reviewer';
  const exited=once(child,'exit');writeFileSync(release,'done');await exited;assert.equal(child.exitCode,0);
  const lease=acquireSupervisorLock(join(f.dir,'maintenance.lock'),'exclusive');lease.close();
});
test('blocked startup releases maintenance and every resume reacquires and rechecks it',async t=>{
  const f=fixture(t),secret=await f.launch(),child=f.start(secret);
  await until(()=>f.s.get('SELECT bootstrap_pid FROM managed_transitions WHERE id=?',secret.transition_id).bootstrap_pid);
  const blocked=f.controller.blockTransition(secret.transition_id,'Fixture guard needs reconciliation',f.maintenance);assert.equal(blocked.state,'blocked');
  assert.throws(()=>f.maintenance.assertHeld(),/no longer held/);
  await assert.rejects(()=>f.controller.resumeFixtureTransition(secret.transition_id,f.maintenance),/current supervisor lock lease/);
  await until(()=>child.exitCode!==null);
  const shared=acquireSupervisorLock(f.maintenancePath,'shared');assert.throws(()=>acquireSupervisorLock(f.maintenancePath,'exclusive'),/busy/);shared.close();
  const resumed=acquireSupervisorLock(f.maintenancePath,'exclusive');t.after(()=>resumed.close());
  assert.equal((await f.controller.resumeFixtureTransition(secret.transition_id,resumed)).state,'starting');
  const retry=await f.controller.retryUnreleasedStartup(secret.transition_id,resumed);assert.equal(retry.generation,2);
});
test('controller recovery reconciles the registered child and refuses uncertain spawn or released failure',async t=>{
  const f=fixture(t),secret=await f.launch();
  // Write an actual exited controller fingerprint into the disposable database to
  // represent a crash after intent. The worker bootstrap is a separate real child.
  const former=spawn(process.execPath,['-e',"process.send('ready');process.on('message',()=>process.exit(0));"],{stdio:['ignore','ignore','ignore','ipc']});
  await once(former,'message');const formerStart=processIdentity(former.pid),exited=once(former,'exit');former.send('exit');await exited;
  f.s.run('UPDATE managed_controllers SET pid=?,process_start=?',former.pid,formerStart);
  f.lock.close();const nextLock=acquireSupervisorLock(f.controllerPath,'exclusive');t.after(()=>nextLock.close());const recovered=new FixtureController(f.s,nextLock);
  await assert.rejects(()=>recovered.releaseBootstrap(secret.transition_id,f.maintenance),/reconcile existing/);
  await assert.rejects(()=>recovered.reconcileController(f.maintenance),/Uncertain spawn/);
  const child=f.start(secret);await until(()=>f.s.get('SELECT bootstrap_pid FROM managed_transitions WHERE id=?',secret.transition_id).bootstrap_pid);
  const observations=await recovered.reconcileController(f.maintenance);assert.equal(observations[0].live,true);
  await recovered.releaseBootstrap(secret.transition_id,f.maintenance);
  await until(()=>child.messages.find(row=>row.acting||row.fatal));assert.equal(child.messages.find(row=>row.fatal),undefined);
  await child.request({type:'tool',path:join(f.root,'file.txt'),content:'normal work after launch'});
  const connection=new Store(f.db,'builder',{managedCredentials:{generation:'1',token:secret.worker_token}});connection.use('demo');
  noteTask(connection,f.task.id,'Normal work changes task versions');saveNotificationProgress(connection,{cursor:connection.get('SELECT max(id) n FROM events').n,expected_version:f.progress.version});connection.close();
  assert.equal((await recovered.reconcileController(f.maintenance))[0].live,true,'Active work is refreshed instead of compared to its launch-time snapshot');
  const drain=recovered.requestDrain(secret.worker_id,1,'active-recovery');recovered.blockTransition(drain.id,'Reconcile active drain',f.maintenance);
  writeFileSync(join(f.root,'file.txt'),'human edit while drain blocked');
  const freshMaintenance=acquireSupervisorLock(f.maintenancePath,'exclusive');t.after(()=>freshMaintenance.close());
  assert.equal((await recovered.resumeFixtureTransition(drain.id,freshMaintenance)).state,'draining');
  const exit=once(child,'exit');child.send({type:'exit'});await exit;
  await assert.rejects(()=>recovered.retryUnreleasedStartup(drain.id,freshMaintenance),/Only one/);
  await assert.rejects(()=>recovered.reconcileController(freshMaintenance),/Post-release process failure/);
});
test('a live or uncertain prior controller cannot be superseded even if its lock was dropped',async t=>{
  const f=fixture(t),other=spawn(process.execPath,['-e',"process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
  await once(other,'message');t.after(async()=>{if(other.exitCode===null&&other.signalCode===null){const exited=once(other,'exit');other.kill();await exited;}});
  f.s.run('UPDATE managed_controllers SET pid=?,process_start=?',other.pid,processIdentity(other.pid));f.lock.close();
  const replacement=acquireSupervisorLock(f.controllerPath,'exclusive');t.after(()=>replacement.close());
  assert.throws(()=>new FixtureController(f.s,replacement),/live or uncertain/);
});
test('STOP before intent and after release prevent launch or reconciliation',async t=>{
  await t.test('before intent',async t=>{
    const f=fixture(t);f.s.actor='human';requestStop(f.s,['builder']);f.s.actor='reviewer';
    await assert.rejects(()=>f.launch(),/STOP/);assert.equal(f.s.get('SELECT count(*) n FROM managed_workers').n,0);
  });
  await t.test('after bootstrap release',async t=>{
    const f=fixture(t),secret=await f.launch(),child=f.start(secret,{FIXTURE_PAUSE_RECONCILE:'1'});
    await until(()=>f.s.get('SELECT bootstrap_pid FROM managed_transitions WHERE id=?',secret.transition_id).bootstrap_pid);
    await f.controller.releaseBootstrap(secret.transition_id,f.maintenance);await until(()=>child.messages.some(row=>row.released));
    f.s.actor='human';requestStop(f.s,['builder']);f.s.actor='reviewer';await child.request({type:'allow-reconcile'});
    await until(()=>child.exitCode!==null);assert.equal(child.exitCode,1);assert.equal(child.messages.some(row=>row.acting),false);
    assert.match(child.messages.find(row=>row.fatal).fatal,/STOP/);assert.equal(f.s.get('SELECT count(*) n FROM checkout_bindings').n,0);
    assert.equal(getNotificationProgress(f.s,'builder').cursor,f.progress.cursor);
  });
});
test('bootstrap rejects wrong generation, worker token and launch token without taking the intent',async t=>{
  const f=fixture(t),secret=await f.launch();
  for(const overrides of [{SASSATO_WORKER_GENERATION:'2'},{SASSATO_WORKER_TOKEN:'invalid-worker-token-'.repeat(4)},{FIXTURE_LAUNCH_TOKEN:'invalid-launch-token-'.repeat(4)}]){
    const child=f.start(secret,overrides);await until(()=>child.exitCode!==null);assert.equal(child.exitCode,1);assert.equal(child.messages.some(row=>row.acting),false);
    assert.equal(f.s.get('SELECT bootstrap_pid FROM managed_transitions WHERE id=?',secret.transition_id).bootstrap_pid,null);
  }
});
test('cancelled uncertain launch revokes both gates and remains human-blocked without deleting its reservation',async t=>{
  const f=fixture(t),secret=await f.launch(),row=f.controller.cancelUnreleasedIntent(secret.transition_id,'Uncertain spawn; human scope reconciliation required',f.maintenance);
  assert.equal(row.state,'blocked');assert.equal(row.launch_token_hash,null);
  const replayChild=f.start(secret);await until(()=>replayChild.exitCode!==null);assert.equal(replayChild.messages.some(row=>row.acting),false);
  const fresh=acquireSupervisorLock(f.maintenancePath,'exclusive');t.after(()=>fresh.close());
  await assert.rejects(()=>f.controller.resumeFixtureTransition(secret.transition_id,fresh),/human scope reconciliation/);
  assert.equal(f.s.get('SELECT count(*) n FROM managed_workers').n,1);
});
test('job maintenance contention preserves wait and no-wait admission behavior',async t=>{
  const f=fixture(t),meminfo=join(f.dir,'meminfo');writeFileSync(meminfo,'MemTotal: 20480000 kB\nMemAvailable: 16384000 kB\n');
  const env={...process.env,SASSATO_JOB_MEMINFO:meminfo,SASSATO_JOB_CORES:'8',SASSATO_JOB_SCOPE:'0'},args=[resolve('bin/sassato.js'),'--db',f.db,'--workspace','demo','--as','reviewer','job','run','--kind','other'];
  const denied=spawnSync(process.execPath,[...args,'--no-wait','--','true'],{env,encoding:'utf8',timeout:5000});assert.equal(denied.status,75,denied.stderr);assert.equal(f.s.get('SELECT count(*) n FROM jobs').n,0);
  const child=spawn(process.execPath,[...args,'--','true'],{env,stdio:['ignore','ignore','pipe']});let output='';child.stderr.on('data',bytes=>{output+=bytes;});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}});
  await until(()=>output.includes('maintenance lock is busy'));assert.equal(child.exitCode,null);
  const exit=once(child,'exit');f.maintenance.close();await exit;assert.equal(child.exitCode,0,output);
  assert.equal(f.s.get('SELECT status FROM jobs').status,'done');
});
