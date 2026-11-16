import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { execFileSync,spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { addTask,takeTask } from '../dist/tasks.js';
import { registerCheckout } from '../dist/checkouts.js';
import { saveNotificationProgress,getNotificationProgress } from '../dist/notification-progress.js';
import { setWorkspaceSettings } from '../dist/workspace-settings.js';
import { setSupervisorPolicy } from '../dist/supervisor-policy.js';
import { captureFixtureConfiguration,supervisorDigest } from '../dist/supervisor-snapshot.js';
import { acquireSupervisorLock } from '../dist/supervisor-locks.js';
import { FixtureController } from '../dist/fixture-controller.js';
import { requestStop } from '../dist/control.js';

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
    const child=spawn(process.execPath,[program],{cwd:root,env:{...process.env,FIXTURE_DIST:resolve('dist'),FIXTURE_DB:db,FIXTURE_TRANSITION:secret.transition_id,FIXTURE_LAUNCH_TOKEN:secret.launch_token,SASSATO_WORKER_GENERATION:String(secret.generation),SASSATO_WORKER_TOKEN:secret.worker_token,...overrides},stdio:['ignore','ignore','pipe','ipc']});children.push(child);
    child.messages=[];child.on('message',message=>child.messages.push(message));let request=0;
    child.request=async message=>{const id=++request;child.send({...message,request:id});return until(()=>child.messages.find(row=>row.request===id),'fixture reply');};
    return child;
  }
  return {dir,root,db,s,task,progress,configuration,controller,maintenance,launch,start};
}
test('durable launch intent gates real fixture child; atomic readiness freezes the old worker',async t=>{
  const f=fixture(t),secret=await f.launch();
  assert.equal(f.s.get('SELECT state FROM managed_transitions WHERE id=?',secret.transition_id).state,'starting');
  await assert.rejects(()=>f.controller.releaseBootstrap(secret.transition_id,f.maintenance),/self-registration/);
  const child=f.start(secret);await until(()=>f.s.get('SELECT bootstrap_pid FROM managed_transitions WHERE id=?',secret.transition_id).bootstrap_pid);
  assert.equal((await child.request({type:'tool',path:join(f.root,'file.txt'),content:'too early'})).blocked,true);
  await assert.rejects(()=>f.launch(),/already has a durable generation/);
  await f.controller.releaseBootstrap(secret.transition_id,f.maintenance);
  await until(()=>child.messages.find(row=>row.acting||row.fatal),'reconciliation');assert.equal(child.messages.find(row=>row.fatal),undefined,JSON.stringify(child.messages));
  assert.equal(f.s.task(f.task.id).owner,'builder');assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),'preserved dirty file');
  assert.equal(getNotificationProgress(f.s,'builder').cursor,f.progress.cursor);
  const drain=f.controller.requestDrain(secret.worker_id,1,'handoff');assert.equal(f.controller.requestDrain(secret.worker_id,1,'handoff').id,drain.id);
  const report={version:1,objective:'Preserve worker objective',acceptance:['Dirty files and owner survive'],decisions:[{decision:'Same role',source:'Fixture test'}],open_issues:['Real providers remain unproven'],validation:[{command:'fixture bootstrap',result:'passed'}],artifacts:[],next_action:'Continue with the saved files',configuration:{digest:supervisorDigest(f.configuration),provenance:['Observed fixture executable and role settings']},jobs:[{id:'fixture-tool',state:'completed',evidence:'No active fixture jobs'}]};
  const ready=await child.request({type:'drain',transition:drain.id,nonce:JSON.parse(drain.payload).drain_nonce,report});
  assert.equal(ready.error,undefined,JSON.stringify(ready));assert.equal(ready.ready.state,'ready');
  assert.equal(f.s.get('SELECT state FROM managed_workers WHERE id=?',secret.worker_id).state,'ready');
  assert.equal(f.s.get('SELECT count(*) n FROM task_briefs').n,1);
  assert.equal((await child.request({type:'tool',path:join(f.root,'file.txt'),content:'after barrier'})).blocked,true);
  assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),'preserved dirty file');
  const stale=new Store(f.db,'builder',{managedCredentials:{generation:'1',token:secret.worker_token}});stale.use('demo');try{assert.throws(()=>stale.event('fixture','write','attempt',{}),/frozen/);}finally{stale.close();}
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
