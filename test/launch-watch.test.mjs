import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn,spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { mkdtempSync,readFileSync,rmSync,writeFileSync,existsSync,symlinkSync,realpathSync,chmodSync,lstatSync,statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { Store } from '../dist/storage.js';
import { initWorkspace,status,renderStatus } from '../dist/admin.js';
import { registerSession,send } from '../dist/coordination.js';
import { requestStop } from '../dist/control.js';
import { saveNotificationProgress,getNotificationProgress } from '../dist/notification-progress.js';
import { launchWatch,reconcileWatch } from '../dist/launch-watch.js';
import { launchLockPath } from '../dist/launch-admission.js';
import { acceptCodexVersion,workspaceSettings,checkCodexVersion } from '../dist/workspace-settings.js';

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
if(args[0]==='--version'){console.log('codex-cli '+${JSON.stringify(version)});if(${JSON.stringify(mode)}==='notice')console.error('A newer version is available');}
else if(args.includes('--help'))console.log('--thread --remote --resume --message');
else if(args[0]==='queue'){
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
 if(${JSON.stringify(mode)}==='slow' && !fs.existsSync(${JSON.stringify(join(dir,'slow-once'))})){fs.writeFileSync(${JSON.stringify(join(dir,'slow-once'))},'1');setInterval(()=>{},1000);return;}
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
  t.after(async()=>{process.env.PATH=originalPath;worker.close();operator.close();child.kill();await exited;if(server.listening)server.close();rmSync(dir,{recursive:true,force:true});});
  return {operator,worker,dir,remote,calls,cli,child,server};
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
  assert.deepEqual(status(f.worker).watcher,{state:'exited',epoch:status(f.worker).watcher.epoch,reason:'queue delivery uncertain'});
  assert.equal(getNotificationProgress(f.worker).cursor,0);
  await assert.rejects(launchWatch(f.operator,'b',f.remote,thread),/Close the existing/);
  assert.equal(f.calls().length,1);
  const epoch=f.worker.get("SELECT id FROM events WHERE entity='wake-enrollment' AND action='opened'").id;
  assert.ok(f.worker.get("SELECT id FROM messages WHERE sender='b' AND body LIKE '%suspended%'"));
  const urgent=f.worker.all("SELECT body FROM messages WHERE sender='b' AND urgent=1 AND body LIKE 'The Codex waiter for b stopped%'");
  assert.equal(urgent.length,1);assert.match(urgent[0].body,/stopped: queue delivery uncertain\./);assert.doesNotMatch(urgent[0].body,/Deliver once|resume unavailable/);
  f.operator.event('watch-dispatch','b','exited',{epoch:1,reason:'queue delivery uncertain'});
  const after=status(f.worker).watcher;
  assert.equal(after.state,'exited');assert.equal(after.start_refused,'an earlier enrollment is still open');
  assert.match(renderStatus(status(f.worker)),/watcher exited E\d+ \(queue delivery uncertain\), a restart refused \(an earlier enrollment is still open\)/);
  assert.equal(f.cli('wake','--pending').status,0);
  assert.equal(reconcileWatch(f.operator,'b',epoch).closed,epoch);
});
test('a turn longer than the deadline keeps the one queued wake: one alert, receipt later, watch goes on',async t=>{
  const f=await fixture(t);
  send(f.operator,['b'],'Work',{now:true});
  let n=0;const clock=()=>++n*300001;
  const run=launchWatch(f.operator,'b',f.remote,thread,clock);run.catch(()=>{});
  await until(()=>!!f.worker.get("SELECT id FROM events WHERE entity='watch-dispatch' AND action='overdue'"));
  await delay(300);
  assert.equal(f.calls().length,1);
  assert.equal(f.worker.all("SELECT id FROM events WHERE entity='watch-dispatch' AND action='overdue'").length,1);
  const alerts=f.worker.all("SELECT body FROM messages WHERE sender='b' AND body LIKE '%no receipt for five minutes%'");
  assert.equal(alerts.length,1);assert.equal(f.worker.get("SELECT id FROM messages WHERE sender='b' AND urgent=1"),undefined);
  assert.equal(f.worker.get("SELECT id FROM events WHERE entity='watch-dispatch' AND action='exited'"),undefined);
  assert.equal(f.cli('wake','--pending').status,0);
  send(f.operator,['b'],'More work',{now:true});
  await until(()=>f.calls().length===2);
  requestStop(f.operator,['b']);
  assert.equal((await run).reason,'stopped');
  assert.equal(f.worker.all("SELECT id FROM messages WHERE sender='b' AND body LIKE '%no receipt for five minutes%'").length,1);
});
test('a wake waiting for its receipt ends the watch when the app server is gone, saying so',async t=>{
  const f=await fixture(t);
  send(f.operator,['b'],'Work',{now:true});
  const run=launchWatch(f.operator,'b',f.remote,thread,()=>performance.now()*1000);run.catch(()=>{});
  await until(()=>f.calls().length===1);
  f.server.close();
  await assert.rejects(run,/app server/);
  assert.equal(status(f.worker).watcher.reason,'the Codex app server is gone');
  assert.equal(f.calls().length,1);
  assert.equal(getNotificationProgress(f.worker).cursor,0);
});
test('a wake waiting for its receipt ends the watch when the window is gone, saying so',async t=>{
  const f=await fixture(t);
  send(f.operator,['b'],'Work',{now:true});
  const run=launchWatch(f.operator,'b',f.remote,thread);run.catch(()=>{});
  await until(()=>f.calls().length===1);
  f.child.kill();
  await assert.rejects(run,/live registered Codex/);
  assert.equal(status(f.worker).watcher.reason,'the Codex window is gone');
  assert.ok(f.worker.get("SELECT id FROM messages WHERE sender='b' AND urgent=1 AND body LIKE '%stopped: the Codex window is gone.%'"));
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
test('a newer untested Codex version starts with a warning, an older one is refused; a human marks one tested (T1098, T664)',async t=>{
  const f=await fixture(t,'success',false,'0.168.0');
  assert.deepEqual(workspaceSettings(f.operator).codex_versions,['0.167.0']);
  const settings=workspaceSettings(f.operator);
  assert.deepEqual(checkCodexVersion(settings,'codex-cli 0.167.0'),{version:'0.167.0',warning:null});
  assert.match(checkCodexVersion(settings,'codex-cli 0.168.0').warning,/Codex CLI 0\.168\.0 is not a tested version \(tested: 0\.167\.0\); starting anyway.*sassato codex accept 0\.168\.0/);
  assert.match(checkCodexVersion(settings,'codex-cli 1.0.0').warning,/not a tested version/);
  assert.throws(()=>checkCodexVersion(settings,'codex-cli 0.166.9'),/Codex CLI 0\.166\.9 is older than 0\.167\.0/);
  assert.throws(()=>checkCodexVersion(settings,'codex-cli 0.99.0'),/older than/);
  assert.throws(()=>checkCodexVersion({...settings,codex_versions:['0.166.0','0.167.0']},'codex-cli 0.166.0'),/older than/);
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
test('an older Codex version is refused at startup with one urgent mail and a status line (T663, T664)',async t=>{
  const f=await fixture(t,'success',false,'0.166.0');
  await assert.rejects(launchWatch(f.operator,'b',f.remote,thread),/older than 0\.167\.0/);
  assert.deepEqual(f.calls(),[]);
  const urgent=f.worker.all("SELECT body FROM messages WHERE urgent=1 AND body LIKE 'The Codex waiter for b did not start%'");
  assert.equal(urgent.length,1);
  assert.deepEqual(status(f.worker).watcher,{state:'refused',reason:'Codex CLI older than the oldest supported version'});
});
test('provider output never reaches the mail or the status line (T663)',async t=>{
  const f=await fixture(t,'success',false,'9.9.9 <script>secret</script>');
  await assert.rejects(launchWatch(f.operator,'b',f.remote,thread),/Cannot read the Codex CLI version/);
  const mail=f.worker.all("SELECT body FROM messages WHERE urgent=1 AND body LIKE 'The Codex waiter%'");
  assert.equal(mail.length,1);assert.equal(mail[0].body,'The Codex waiter for b did not start: Codex CLI version unreadable.');
  assert.doesNotMatch(renderStatus(status(f.worker)),/secret/);
  f.operator.event('watch-dispatch','b','refused',{reason:'<old provider text>'});
  assert.equal(status(f.worker).watcher.reason,'see the launcher terminal');
  await assert.rejects(launchWatch(f.operator,'b',f.remote,'not-a-thread'),/UUID/);
  assert.equal(f.worker.all("SELECT body FROM messages WHERE urgent=1 AND body LIKE 'The Codex waiter%'").length,2);
});
test('a notice on stderr beside a good version line is accepted (T664)',async t=>{
  const f=await fixture(t,'notice');
  const run=launchWatch(f.operator,'b',f.remote,thread);run.catch(()=>{});
  send(f.operator,['b'],'Work',{now:true});
  await until(()=>f.calls().length===1);
  assert.equal(status(f.worker).watcher.state,'enrolled');
  requestStop(f.operator,['b']);
  assert.equal((await run).reason,'stopped');
  assert.equal(f.worker.get("SELECT count(*) n FROM messages WHERE urgent=1 AND body LIKE 'The Codex waiter%'").n,0);
});
test('a queue call that times out is tried once more after a pause (T663)',async t=>{
  const f=await fixture(t,'slow');
  const run=launchWatch(f.operator,'b',f.remote,thread,undefined,{queueTimeoutMs:300,retryPauseMs:50});run.catch(()=>{});
  send(f.operator,['b'],'Work',{now:true});
  await until(()=>f.calls().length===2);
  assert.ok(f.worker.get("SELECT id FROM events WHERE entity='watch-dispatch' AND action='retry'"));
  requestStop(f.operator,['b']);
  assert.equal((await run).reason,'stopped');
  assert.equal(f.worker.get("SELECT count(*) n FROM messages WHERE urgent=1 AND body LIKE 'The Codex waiter%'").n,0);
});

test('status says an enrolled watcher whose launcher left no word is not running (T663)',async t=>{
  const f=await fixture(t);
  f.operator.event('wake-enrollment','b','opened',{});
  const watcher=status(f.worker).watcher;
  assert.equal(watcher.state,'enrolled');
  assert.equal(watcher.launcher_running,false);
  assert.match(renderStatus(status(f.worker)),/watcher enrolled E\d+, launcher not running/);
});
