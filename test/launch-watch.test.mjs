import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn,spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { mkdtempSync,readFileSync,rmSync,writeFileSync,existsSync,symlinkSync,realpathSync,chmodSync,lstatSync,statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { registerSession,send } from '../dist/coordination.js';
import { requestStop } from '../dist/control.js';
import { saveNotificationProgress,getNotificationProgress } from '../dist/notification-progress.js';
import { launchWatch,reconcileWatch } from '../dist/launch-watch.js';
import { launchLockPath } from '../dist/launch-admission.js';
import { acceptCodexVersion,workspaceSettings } from '../dist/workspace-settings.js';

const thread='f837a924-bc2e-472b-9bca-07b93cc531ae';
async function until(fn) {
  for(let i=0;i<150;i++){if(fn())return;await delay(40);}
  throw Error('Fixture condition timed out');
}
async function fixture(t,mode='success',link=false,version='0.167.0') {
  const dir=mkdtempSync(join(tmpdir(),'sas-lwatch-')), db=join(dir,'db'),log=join(dir,'calls');
  const endpoint=join(dir,'server'),server=createServer();server.listen(endpoint);await once(server,'listening');
  if(link)symlinkSync(endpoint,join(dir,'server.sock'));
  const remote='unix://'+(link?join(dir,'server.sock'):endpoint);
  const provider=join(dir,'codex');
  writeFileSync(provider,`#!/usr/bin/env node
const fs=require('fs'),args=process.argv.slice(2);
if(args[0]==='--version')console.log('codex-cli '+${JSON.stringify(version)});
else if(args.includes('--help'))console.log('--thread --remote --resume --message');
else if(args[0]==='queue'){
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
 if(${JSON.stringify(mode)}==='warning' || (${JSON.stringify(mode)}==='stop-warning' && args.join(' ').includes('Check Sassato STOP'))){console.error('resume unavailable');setTimeout(()=>{},350);}
 console.log('Queued message ${thread} for thread ${thread}.');
}else {fs.writeFileSync(${JSON.stringify(join(dir,'up'))},'1');setInterval(()=>{},1000)}
`,{mode:0o700});
  const child=spawn(provider,['--remote',remote,'resume',thread],{stdio:'ignore'});
  const exited=once(child,'exit');await until(()=>existsSync(join(dir,'up')));
  const originalPath=process.env.PATH;process.env.PATH=dir+':'+originalPath;
  const operator=new Store(db,'human',{create:true});
  initWorkspace(operator,'team',{roles:[{name:'human',kind:'human'},{name:'b',provider:'codex',working_dir:dir}]});operator.use('team');
  const worker=new Store(db,'b');worker.use('team');
  registerSession(worker,{provider:'codex',external_id:thread,pid:child.pid});
  saveNotificationProgress(worker,{cursor:0,expected_version:0});
  const calls=()=>existsSync(log)?readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[];
  const cli=(...args)=>spawnSync(process.execPath,[resolve('bin/sassato.js'),...args,'--db',db,'--as','b','--workspace','team'],
    {encoding:'utf8',env:{...process.env,CODEX_THREAD_ID:thread}});
  t.after(async()=>{process.env.PATH=originalPath;worker.close();operator.close();child.kill();await exited;server.close();rmSync(dir,{recursive:true,force:true});});
  return {operator,worker,dir,remote,calls,cli,child};
}
test('attached thread gets one fixed prompt per pending result, STOP preempts receipt',async t=>{
  const f=await fixture(t);
  const run=launchWatch(f.operator,'b',f.remote,thread);run.catch(()=>{});
  send(f.operator,['b'],'Private first message',{now:true});
  await until(()=>f.calls().length===1);
  const read=f.cli('wake','--pending');
  assert.equal(read.status,0,read.stderr);
  assert.match(read.stdout,/Private first message/);
  send(f.operator,['b'],'Private second message',{now:true});
  await until(()=>f.calls().length===2);
  assert.ok(f.calls().every(a=>a[a.indexOf('--message')+1]==='Run sas wake --pending --as b --workspace team.'));
  assert.doesNotMatch(JSON.stringify(f.calls()),/Private/);
  assert.ok(f.calls().every(a=>a[a.indexOf('--thread')+1]===thread && a[a.indexOf('--remote')+1]===f.remote));
  requestStop(f.operator,['b']);
  assert.equal((await run).reason,'stopped');
  assert.equal(f.calls().length,3);assert.match(f.calls()[2].join(' '),/Check Sassato STOP/);
  assert.equal(existsSync(launchLockPath(f.operator,'b')),false);
  assert.equal(f.child.exitCode,null);
});
test('warning despite exit zero suspends, preserves pending work, explicit close allows replay',async t=>{
  const f=await fixture(t,'warning');
  send(f.operator,['b'],'Deliver once',{now:true});
  await assert.rejects(launchWatch(f.operator,'b',f.remote,thread),/uncertain/);
  assert.equal(getNotificationProgress(f.worker).cursor,0);
  await assert.rejects(launchWatch(f.operator,'b',f.remote,thread),/Close the existing/);
  assert.equal(f.calls().length,1);
  const epoch=f.worker.get("SELECT id FROM events WHERE entity='wake-enrollment' AND action='opened'").id;
  assert.ok(f.worker.get("SELECT id FROM messages WHERE sender='b' AND body LIKE '%suspended%'"));
  assert.equal(f.cli('wake','--pending').status,0);
  assert.equal(reconcileWatch(f.operator,'b',epoch).closed,epoch);
});
test('accepted wake without receipt reaches its deadline once and alerts the operator',async t=>{
  const f=await fixture(t);
  send(f.operator,['b'],'Work',{now:true});
  let n=0;const clock=()=>++n*300001;
  await assert.rejects(launchWatch(f.operator,'b',f.remote,thread,clock),/Five minutes/);
  assert.equal(f.calls().length,1);
  assert.equal(getNotificationProgress(f.worker).cursor,0);
});
test('agent enrollment and a different thread or endpoint fail before dispatch',async t=>{
  const f=await fixture(t);
  await assert.rejects(launchWatch(f.worker,'b',f.remote,thread),/human/);
  await assert.rejects(launchWatch(f.operator,'b',f.remote,'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),/registered/);
  await assert.rejects(launchWatch(f.operator,'b',f.remote+'other',thread),/attached/);
  assert.deepEqual(f.calls(),[]);
});

test('crash after dispatch keeps a single pending result, recoverable without resending',async t=>{
  const f=await fixture(t);
  const args=[resolve('bin/sassato.js'),'launch-watch','b','--remote',f.remote,'--session-id',thread,
    '--db',f.worker.path,'--workspace','team','--as','human'];
  send(f.operator,['b'],'Work awaiting receipt',{now:true});
  const launcher=spawn(process.execPath,args,{stdio:'ignore'}),exit=once(launcher,'exit');
  try {
    await until(()=>f.calls().length===1);
    const locked=spawnSync(process.execPath,args,{encoding:'utf8'});
    assert.notEqual(locked.status,0);
    assert.match(locked.stderr,/Launch lock exists/);
  }finally{launcher.kill('SIGKILL');await exit;}
  assert.equal(f.calls().length,1);
  const status=f.cli('watch-status','b');
  assert.equal(status.status,0,status.stderr);
  const {epoch,pending}=JSON.parse(status.stdout);
  assert.ok(pending && epoch);
  assert.equal(f.cli('wake','--pending').status,0);
  const {unlockLaunch}=await import('../dist/launch.js');
  unlockLaunch(f.operator,['b']);
  reconcileWatch(f.operator,'b',epoch);
  assert.deepEqual(JSON.parse(f.cli('watch-status','b').stdout).epoch,null);
  assert.equal(f.calls().length,1);
});
test('quiet wait suspends when the configured policy changes without queueing a turn',async t=>{
  const f=await fixture(t);
  const run=launchWatch(f.operator,'b',f.remote,thread);run.catch(()=>{});
  await until(()=>!!f.worker.get("SELECT id FROM events WHERE entity='wake-enrollment'"));
  f.operator.run("UPDATE roles SET sandbox_mode='read-only' WHERE workspace_id=? AND name='b'",f.operator.ws);
  await assert.rejects(run,/configuration changed/);
  assert.deepEqual(f.calls(),[]);
});
test('failed STOP notification still closes the epoch and preserves the unconsumed cursor',async t=>{
  const f=await fixture(t,'stop-warning');
  send(f.operator,['b'],'Pending for next start',{now:true});
  const run=launchWatch(f.operator,'b',f.remote,thread);run.catch(()=>{});
  await until(()=>f.calls().length===1);
  requestStop(f.operator,['b']);
  await until(()=>f.calls().length===2);
  assert.equal(JSON.parse(f.cli('watch-status','b').stdout).epoch,null);
  await assert.rejects(run,/uncertain/);
  assert.equal(f.calls().length,2);
  assert.equal(getNotificationProgress(f.worker).cursor,0);
  assert.equal(JSON.parse(f.cli('watch-status','b').stdout).epoch,null);
  assert.ok(f.worker.get("SELECT id FROM messages WHERE sender='b' AND body LIKE '%STOP observed%'"));
});
test('a full page of outstanding urgent receipts does not crowd out the next wake',async t=>{
  const f=await fixture(t);
  const messages=Array.from({length:101},(_,i)=>send(f.operator,['b'],'Item '+i,{urgent:true}));
  const run=launchWatch(f.operator,'b',f.remote,thread);run.catch(()=>{});
  try{
    await until(()=>f.calls().length===1);
    const first=JSON.parse(f.cli('wake','--pending','--json').stdout);
    assert.equal(first.result.digest.total,100);
    const now=send(f.operator,['b'],'Immediate later item',{now:true});
    await until(()=>f.calls().length===2);
    const next=JSON.parse(f.cli('wake','--pending','--json').stdout);
    assert.ok(next.result.digest.entries.some(e=>e.id===now.id));
    assert.ok(!next.result.digest.entries.some(e=>e.id===messages[0].id));
  }finally{requestStop(f.operator,['b']);await run;}
});
test('the 50-minute eligible-work result survives dispatch with its original task IDs',async t=>{
  const f=await fixture(t);
  const {addTask}=await import('../dist/tasks.js');
  const task=addTask(f.operator,{title:'Eligible idle task',forRole:'b'});
  const before=getNotificationProgress(f.worker),cursor=f.worker.get('SELECT max(id) AS id FROM events').id;
  saveNotificationProgress(f.worker,{cursor,expected_version:before.version});
  const real=performance.now.bind(performance);
  let shift=0;performance.now=()=>real()+shift;
  const run=launchWatch(f.operator,'b',f.remote,thread,real);run.catch(()=>{});
  try{
    await until(()=>!!f.worker.get("SELECT id FROM events WHERE entity='wake-enrollment'"));
    shift+=50*60_000+1;
    await delay(650);
    shift+=600_001;
    await until(()=>f.calls().length===1);
    const read=JSON.parse(f.cli('wake','--pending','--json').stdout);
    assert.ok(read.result.digest.entries.some(e=>e.kind==='open-work' && e.tasks.includes(task.id)));
  }finally{performance.now=real;requestStop(f.operator,['b']);await run;}
});
test('a socket given by its symlink path (Codex 0.167) is watched',async t=>{
  const f=await fixture(t,'success',true);
  const run=launchWatch(f.operator,'b',f.remote,thread);run.catch(()=>{});
  send(f.operator,['b'],'Linked',{now:true});
  await until(()=>f.calls().length===1);
  assert.equal(f.calls()[0][f.calls()[0].indexOf('--remote')+1],'unix://'+realpathSync(join(f.dir,'server')));
  requestStop(f.operator,['b']);
  assert.equal((await run).reason,'stopped');
  // The socket may be a shared Codex daemon's: ending the watch leaves the link and the socket in place.
  assert.ok(lstatSync(join(f.dir,'server.sock')).isSymbolicLink());
  assert.equal(realpathSync(join(f.dir,'server.sock')),realpathSync(join(f.dir,'server')));
  assert.ok(statSync(join(f.dir,'server')).isSocket());
});
test('a symlink to something other than a socket is refused',async t=>{
  const f=await fixture(t,'success',true);
  const sock=f.remote.slice(7);rmSync(sock);writeFileSync(join(f.dir,'plain'),'x');symlinkSync(join(f.dir,'plain'),sock);
  await assert.rejects(launchWatch(f.operator,'b',f.remote,thread),/Unix socket/);
});
test('a link retargeted to another socket after enrollment stops the watch before dispatch',async t=>{
  const f=await fixture(t,'success',true);
  const run=launchWatch(f.operator,'b',f.remote,thread);run.catch(()=>{});
  await delay(300);
  const other=join(f.dir,'other'),server=createServer();server.listen(other);await once(server,'listening');t.after(()=>server.close());
  rmSync(f.remote.slice(7));symlinkSync(other,f.remote.slice(7));
  send(f.operator,['b'],'After the swap',{now:true});
  await assert.rejects(run);
  assert.equal(f.calls().length,0);
});
test('a socket in a folder others can write is refused',async t=>{
  const f=await fixture(t,'success',true);
  chmodSync(f.dir,0o777);
  await assert.rejects(launchWatch(f.operator,'b',f.remote,thread),/folder only that user/);
});
test('an unaccepted Codex version is refused until a human accepts it (T1098)',async t=>{
  const f=await fixture(t,'success',false,'0.168.0');
  assert.deepEqual(workspaceSettings(f.operator).codex_versions,['0.167.0']);
  await assert.rejects(launchWatch(f.operator,'b',f.remote,thread),/Codex CLI 0\.168\.0 is not an accepted version \(accepted: 0\.167\.0\)\. A human accepts it with: sassato codex accept 0\.168\.0/);
  assert.throws(()=>acceptCodexVersion(f.worker,'0.168.0'),/Only a human accepts a Codex version/);
  const refused=f.cli('codex','accept','0.168.0');assert.notEqual(refused.status,0);assert.match(refused.stderr,/Only a human/);
  assert.deepEqual(acceptCodexVersion(f.operator,'0.168.0'),['0.167.0','0.168.0']);
  const listed=f.cli('codex','versions','--json');assert.equal(listed.status,0,listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).accepted,['0.167.0','0.168.0']);
  assert.deepEqual(acceptCodexVersion(f.operator,'0.168.0',true),['0.168.0']);
  for(let i=1;i<16;i++)acceptCodexVersion(f.operator,`1.0.${i}`);
  assert.equal(acceptCodexVersion(f.operator,'1.0.3').length,16);
  assert.throws(()=>acceptCodexVersion(f.operator,'2.0.0'),/1 to 16/);
  acceptCodexVersion(f.operator,'0.168.0',true);
  assert.throws(()=>acceptCodexVersion(f.operator,'latest'),/exact Codex version/);
  const run=launchWatch(f.operator,'b',f.remote,thread);run.catch(()=>{});
  send(f.operator,['b'],'First',{now:true});
  await until(()=>f.calls().length===1);
  requestStop(f.operator,['b']);
  assert.equal((await run).reason,'stopped');
});
