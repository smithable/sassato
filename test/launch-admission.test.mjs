import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,mkdirSync,copyFileSync,chmodSync,readFileSync,writeFileSync,rmSync,existsSync,symlinkSync,readdirSync,lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawn,spawnSync } from 'node:child_process';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { setRole } from '../dist/coordination.js';
import { addTask,takeTask } from '../dist/tasks.js';
import { registerCheckout } from '../dist/checkouts.js';
import { saveNotificationProgress } from '../dist/notification-progress.js';
import { setWorkspaceSettings } from '../dist/workspace-settings.js';
import { enrollAttended } from '../dist/attended.js';
import { assertNoOrdinaryLauncher,launchLockPath } from '../dist/launch-admission.js';

const cli=resolve('bin/sassato.js');
const delay=()=>new Promise(resolve=>setTimeout(resolve,10));
async function until(check,label){const deadline=Date.now()+30000;while(!check()){assert.ok(Date.now()<deadline,`Timed out: ${label}`);await delay();}}
function started(command,args,env){
  const child=spawn(command,args,{env,stdio:['ignore','pipe','pipe']});let out='',err='';
  child.stdout.on('data',data=>{out+=data;});child.stderr.on('data',data=>{err+=data;});
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve({code,out,err}));});
  return {child,done};
}
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'sassato-admission-')),db=join(dir,'state.db'),repo=join(dir,'repo'),bin=join(dir,'bin');mkdirSync(repo);mkdirSync(bin);
  for(const args of [['init','-b','main'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid'],['-c','core.hooksPath=/dev/null','commit','--allow-empty','-m','seed']]){
    const r=spawnSync('git',args,{cwd:repo,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  }
  for(const [source,target] of [['attended-provider.py','codex'],['admission-terminal.py','wt.exe']]){copyFileSync(resolve('test/fixtures',source),join(bin,target));chmodSync(join(bin,target),0o700);}
  const realPython=spawnSync('python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).stdout.trim();
  const s=new Store(db,'human',{create:true});initWorkspace(s,'demo');setRole(s,'builder',{kind:'agent',provider:'codex',working_dir:repo});setRole(s,'controller',{kind:'agent'});
  setWorkspaceSettings(s,{busy_checks:[{name:'fixture-idle',type:'command',argv:['/usr/bin/false'],cwd:dir,timeout_ms:1000}],stop_file:join(dir,'STOP')});
  const task=addTask(s,{title:'Disposable admission trial',forRole:'builder',owner:'builder'});s.actor='builder';takeTask(s,task.id);saveNotificationProgress(s,{cursor:0,expected_version:0});s.actor='human';
  const checkout=registerCheckout(s,repo);enrollAttended(s,'builder',{checkout:checkout.checkout_id,task:task.id,controller_role:'controller',controller_lock:join(dir,'controller.lock'),maintenance_lock:join(dir,'maintenance.lock')});
  const env={...process.env,PATH:bin+':'+process.env.PATH,WSL_DISTRO_NAME:'FixtureWSL',ATTENDED_FIXTURE_REAL_PYTHON:realPython};
  const marker=join(dir,'ordinary-spawned'),finish=join(dir,'ordinary-finish');
  const ordinary=(extra={},args=[],path=db,workspace='demo')=>started(process.execPath,[cli,'launch','builder','--fresh','--no-prompt','--db',path,'--workspace',workspace,'--as','human',...args],{...env,ATTENDED_FIXTURE_ORDINARY_MARKER:marker,ATTENDED_FIXTURE_ORDINARY_FINISH:finish,...extra});
  const attended=(extra={})=>started(realPython,['-B',resolve('test/fixtures/attended-driver.py'),process.execPath,cli,db,'complete'],{...env,...extra});
  function managed(state='starting'){
    const controller=randomUUID(),worker=randomUUID(),at=new Date().toISOString();
    s.run('INSERT INTO managed_controllers VALUES(?,?,?,?,?,?,?)',controller,s.ws,'controller',join(dir,'stub.lock'),null,null,at);
    s.run('INSERT INTO managed_workers(id,workspace_id,role,controller_id,generation,token_hash,state,provider,configuration_digest,updated_at,context) VALUES(?,?,?,?,?,?,?,?,?,?,?)',worker,s.ws,'builder',controller,1,'0'.repeat(64),state,'codex','0'.repeat(64),at,JSON.stringify({evidence_kind:'cooperative-attended'}));return worker;
  }
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,db,repo,bin,s,env,marker,finish,ordinary,attended,managed};
}

test('managed reservations refuse actual ordinary native and terminal launch before any provider or transport spawn',async t=>{
  const f=fixture(t),w=f.managed();
  for(const state of ['starting','reconciling','running','draining','ready','retiring','exited','blocked','stopped']){
    f.s.run('UPDATE managed_workers SET state=? WHERE id=?',state,w);
    for(const args of [[],['--new-window']]){const r=await f.ordinary({},args).done;assert.notEqual(r.code,0,r.out+r.err);assert.match(r.err,/reserved by a managed generation/);}
    assert.equal(existsSync(f.marker),false);
  }
  assert.equal(existsSync(join(f.dir,'terminal.ready')),false);assert.equal(existsSync(launchLockPath(f.s,'builder')),false);
});

for(const mode of ['same','alias','other-workspace'])test(`ordinary native pending launch excludes attended intent (${mode})`,async t=>{
  const alias=mode==='alias';
  const f=fixture(t),gate=join(f.dir,'version-release'),path=alias?join(f.dir,'alias.db'):f.db;if(alias)symlinkSync(f.db,path);
  if(mode==='other-workspace'){initWorkspace(f.s,'other');setRole(f.s,'builder',{kind:'agent',provider:'codex',working_dir:f.repo});f.s.use('demo');}
  const workspace=mode==='other-workspace'?'other':'demo';
  const ordinary=f.ordinary({ATTENDED_FIXTURE_VERSION_BARRIER:gate},[],path,workspace);
  try{
    await until(()=>existsSync(gate+'.ready'),'ordinary version barrier');assert.ok(existsSync(launchLockPath(f.s,'builder',workspace)));assert.equal(f.s.get('SELECT count(*) n FROM sessions').n,0);
    const controller=await f.attended().done;assert.equal(controller.code,0,controller.err);const r=JSON.parse(controller.out);assert.notEqual(r.code,0,r.output);assert.match(r.output,/pending ordinary launcher/);
    assert.equal(f.s.get('SELECT count(*) n FROM managed_workers').n,0);assert.equal(readdirSync(f.dir).some(name=>name.startsWith('.sat-')),false);
  }finally{writeFileSync(gate,'release');writeFileSync(f.finish,'exit');}
  const r=await ordinary.done;assert.equal(r.code,0,r.out+r.err);assert.equal(existsSync(f.marker),true);assert.equal(existsSync(launchLockPath(f.s,'builder')),false);
});

test('terminal dispatch reserves before native startup; attended loses and parent does not remove adopted child lease',async t=>{
  const f=fixture(t),gate=join(f.dir,'terminal-release'),ordinary=f.ordinary({ATTENDED_FIXTURE_TERMINAL_BARRIER:gate},['--new-window','--json']);
  try{
    await until(()=>existsSync(gate+'.ready'),'terminal transport barrier');const path=launchLockPath(f.s,'builder'),reservation=JSON.parse(readFileSync(path,'utf8'));assert.equal(reservation.phase,'dispatch');assert.equal(f.s.get('SELECT count(*) n FROM sessions').n,0);
    const controller=await f.attended().done;const r=JSON.parse(controller.out);assert.notEqual(r.code,0,r.output);assert.match(r.output,/pending ordinary launcher/);assert.equal(f.s.get('SELECT count(*) n FROM managed_workers').n,0);
    writeFileSync(gate,'dispatch');const launched=await ordinary.done;assert.equal(launched.code,0,launched.err);assert.equal(JSON.parse(launched.out)[0].status,'started');await until(()=>existsSync(f.marker),'native provider marker after session registration');
    const adopted=JSON.parse(readFileSync(path,'utf8'));assert.equal(adopted.phase,'native');assert.notEqual(adopted.pid,ordinary.child.pid);assert.equal(adopted.token,reservation.token);
  }finally{writeFileSync(gate,'dispatch');writeFileSync(f.finish,'exit');await ordinary.done;}
  await until(()=>!existsSync(launchLockPath(f.s,'builder')),'native lease release');
});

test('attended intent wins before registration and excludes both ordinary spawn paths',async t=>{
  const f=fixture(t),gate=join(f.dir,'holder-release');copyFileSync(resolve('test/fixtures/admission-python.py'),join(f.bin,'python3'));chmodSync(join(f.bin,'python3'),0o700);
  const controller=f.attended({ATTENDED_FIXTURE_HOLDER_BARRIER:gate});
  try{
    await until(()=>existsSync(gate+'.ready'),'owned holder barrier');assert.equal(f.s.get('SELECT state FROM managed_workers').state,'starting');assert.equal(f.s.get('SELECT count(*) n FROM sessions').n,0);
    for(const args of [[],['--new-window']]){const r=await f.ordinary({},args).done;assert.notEqual(r.code,0);assert.match(r.err,/reserved by a managed generation/);}
    assert.equal(existsSync(f.marker),false);
  }finally{writeFileSync(gate,'release');}
  const completed=await controller.done;assert.equal(completed.code,0,completed.err);const r=JSON.parse(completed.out);assert.equal(r.code,0,r.output);assert.equal(f.s.get("SELECT count(*) n FROM events WHERE action='attended-launch-intent'").n,2);
});

test('native pre-spawn fence rejects a managed reservation appearing after the launch plan',async t=>{
  const f=fixture(t),gate=join(f.dir,'version-release'),ordinary=f.ordinary({ATTENDED_FIXTURE_VERSION_BARRIER:gate});
  try{await until(()=>existsSync(gate+'.ready'),'ordinary post-plan barrier');f.managed();}
  finally{writeFileSync(gate,'release');writeFileSync(f.finish,'exit');}
  const r=await ordinary.done;assert.notEqual(r.code,0);assert.match(r.err,/reserved by a managed generation/);assert.equal(existsSync(f.marker),false);assert.equal(f.s.get('SELECT count(*) n FROM sessions').n,0);
});

test('terminal native child cannot adopt a reservation when managed state appeared after dispatch',async t=>{
  const f=fixture(t),gate=join(f.dir,'terminal-release'),ordinary=f.ordinary({ATTENDED_FIXTURE_TERMINAL_BARRIER:gate},['--new-window']);
  try{await until(()=>existsSync(gate+'.ready'),'terminal dispatch barrier');f.managed('reconciling');}
  finally{writeFileSync(gate,'dispatch');writeFileSync(f.finish,'exit');}
  const r=await ordinary.done;assert.notEqual(r.code,0);assert.match(r.err,/reserved by a managed generation/);assert.equal(existsSync(f.marker),false);assert.equal(existsSync(launchLockPath(f.s,'builder')),false);
});

for(const dangling of [false,true])test(`unknown ${dangling?'dangling':'unreadable'} ordinary reservation is preserved and blocks attended intent`,async t=>{
  const f=fixture(t),path=launchLockPath(f.s,'builder');mkdirSync(join(path,'..'),{recursive:true});
  if(dangling)symlinkSync(join(f.dir,'missing'),path);else writeFileSync(path,'not a trustworthy launch record');
  const controller=await f.attended().done;assert.equal(controller.code,0,controller.err);const r=JSON.parse(controller.out);assert.notEqual(r.code,0,r.output);assert.match(r.output,/pending ordinary launcher/);assert.equal(f.s.get('SELECT count(*) n FROM managed_workers').n,0);
  if(dangling)assert.equal(lstatSync(path).isSymbolicLink(),true);else assert.equal(readFileSync(path,'utf8'),'not a trustworthy launch record');
});


test('an orphan workspace directory blocks managed launch only for the reserved role',async t=>{
  const f=fixture(t),path=launchLockPath(f.s,'builder','retired');
  mkdirSync(join(path,'..'),{recursive:true});
  writeFileSync(path,'unverifiable orphan reservation');
  assert.equal(f.s.get("SELECT count(*) n FROM workspaces WHERE name='retired'").n,0);
  assert.doesNotThrow(()=>f.s.tx(()=>assertNoOrdinaryLauncher(f.s,'other')));
  const controller=await f.attended().done;assert.equal(controller.code,0,controller.err);
  const result=JSON.parse(controller.out);
  assert.notEqual(result.code,0,result.output);
  assert.match(result.output,/pending ordinary launcher.*unregistered workspace directory "retired"/);
  assert.equal(f.s.get('SELECT count(*) n FROM managed_workers').n,0);
  assert.equal(readFileSync(path,'utf8'),'unverifiable orphan reservation');
});
