import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { Store } from '../dist/storage.js';
import { now } from '../dist/errors.js';
import { processIdentity, registerSession } from '../dist/coordination.js';
import { requestStop, stopStatus, acknowledgeStop, resumeWork } from '../dist/control.js';
import { stop } from '../dist/stop.js';
import { planLaunch, launch } from '../dist/launch.js';
import { addTask, takeTask } from '../dist/tasks.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-stop-')),s=new Store(join(dir,'state.db'),'human',{create:true});
  s.run('INSERT INTO workspaces(name,created_at) VALUES(?,?)','test',now());
  const ws=s.get('SELECT id FROM workspaces WHERE name=?','test').id;
  for(const role of ['human','a','b']) s.run('INSERT INTO roles(workspace_id,name,kind,provider,working_dir) VALUES(?,?,?,?,?)',ws,role,role==='human'?'human':'agent','claude',dir);
  s.use('test');t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,s};
}
function unknownSession(s,role='a') {
  const actor=s.actor;s.actor=role;
  try{return registerSession(s,{provider:'claude',external_id:'unknown'});}finally{s.actor=actor;}
}
async function provider(f,t,filename='claude',onTerm='') {
  const path=join(f.dir,filename),ready=join(f.dir,filename+'.ready');
  writeFileSync(path,`${onTerm}require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);\n`);
  const child=spawn(process.execPath,[path],{stdio:'ignore'});
  const exit=new Promise(res=>{child.once('exit',(code,signal)=>res({code,signal}));child.once('error',error=>res({error}));});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exit;});
  for(let i=0;i<100&&!existsSync(ready);i++)await new Promise(res=>setTimeout(res,5));
  assert(existsSync(ready),'fixture provider became ready');
  return {child,exit};
}
function register(s,pid,role='a') {const actor=s.actor;s.actor=role;try{return registerSession(s,{provider:'claude',external_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',pid});}finally{s.actor=actor;}}
function rawSession(s,{role='a',pid=null,fingerprint=null,provider='claude',ended=null}={}) {
  return s.run('INSERT INTO sessions(workspace_id,role,provider,external_id,pid,process_start,started_at,last_seen_at,ended_at) VALUES(?,?,?,?,?,?,?,?,?)',s.ws,role,provider,'fixture',pid,fingerprint,now(),now(),ended).lastInsertRowid;
}

test('default stop waits for the exact role acknowledgement without inventing it',{timeout:3000},async t=>{
  const f=fixture(t);unknownSession(f.s);let reported=0;
  const result=await stop(f.s,['a'],{timeout:2,onProgress(rows){reported++;if(reported===1){f.s.actor='a';acknowledgeStop(f.s,rows[0].id);f.s.actor='human';}}});
  assert(result.complete);assert(!result.timed_out);assert.equal(result.statuses[0].state,'acknowledged');assert.equal(reported,2);
  assert.equal(result.signals.length,0);
});

test('no-wait returns pending state; timeout does not clear durable stop intent',{timeout:3000},async t=>{
  const f=fixture(t);unknownSession(f.s);
  const immediate=await stop(f.s,['a'],{noWait:true});assert(!immediate.complete);assert(!immediate.timed_out);assert.equal(immediate.statuses[0].state,'waiting');
  const timed=await stop(f.s,['a'],{timeout:1});assert(!timed.complete);assert(timed.timed_out);assert.equal(timed.requests[0].id,immediate.requests[0].id);
  assert.equal(stopStatus(f.s,['a'])[0].id,immediate.requests[0].id);
});

test('a cleared request interrupts waiting instead of counting as acknowledgement',{timeout:3000},async t=>{
  const f=fixture(t);unknownSession(f.s);let cleared=false;
  const result=await stop(f.s,['a'],{timeout:2,onProgress(){if(!cleared){cleared=true;resumeWork(f.s,['a']);}}});
  assert(result.interrupted);assert(!result.complete);assert(!result.timed_out);assert.equal(result.statuses.length,0);
});

test('inactive roles complete immediately and agents cannot request runtime stops',async t=>{
  const f=fixture(t);const result=await stop(f.s,[],{all:true});assert(result.complete);assert(result.statuses.every(r=>r.state==='inactive'));
  f.s.actor='a';await assert.rejects(()=>stop(f.s,['b'],{force:true}),/human role/);
});

test('stop all completes for unregistered roles with unfinished tasks without changing their work',async t=>{
  const f=fixture(t);f.s.actor='a';const task=takeTask(f.s,addTask(f.s,{title:'Saved unfinished work'}).id);f.s.actor='human';
  const result=await stop(f.s,[],{all:true,timeout:1});
  assert(result.complete);assert(!result.timed_out);assert.equal(result.statuses.find(row=>row.role==='a').state,'inactive');
  assert.equal(result.statuses.find(row=>row.role==='a').pending_work,1);assert.equal(f.s.task(task.id).status,'doing');
});

test('force terminates only a verified fixture provider and never fabricates acknowledgement',async t=>{
  const f=fixture(t),p=await provider(f,t);register(f.s,p.child.pid);
  const result=await stop(f.s,['a'],{force:true});
  assert.equal(result.signals.length,1);assert.equal(result.signals[0].status,'sent');assert.equal(result.signals[0].pid,p.child.pid);
  // A child can briefly be a zombie before the parent's exit callback reaps it.
  assert.equal(result.complete,result.statuses[0].state==='exited');
  assert.equal(result.statuses[0].acknowledged_at,null);assert.equal((await p.exit).signal,'SIGTERM');assert.equal(result.signals[0].signal,'SIGTERM');
  assert.equal(stopStatus(f.s,['a'])[0].state,'exited');
  assert.equal((await stop(f.s,['a'],{force:true})).complete,true);
  assert.equal(f.s.get("SELECT count(*) n FROM events WHERE action='force-stop-signal'").n,1);
});

test('force inspects live ended registrations even when a newer dead row exists',async t=>{
  const f=fixture(t),p=await provider(f,t);register(f.s,p.child.pid);f.s.run('UPDATE sessions SET ended_at=?',now());
  rawSession(f.s,{pid:2_147_483_647,fingerprint:'old-boot:1',ended:now()});
  const result=await stop(f.s,['a'],{force:true});
  assert.equal(result.signals.filter(s=>s.status==='sent').length,1);assert.equal(result.signals[0].pid,p.child.pid);assert.equal((await p.exit).signal,'SIGTERM');
});

test('force gives SIGTERM a bounded grace period before escalating a stubborn provider',async t=>{
  const f=fixture(t),term=join(f.dir,'term');
  const p=await provider(f,t,'claude',`process.on('SIGTERM',()=>require('node:fs').writeFileSync(${JSON.stringify(term)},'received'));`);register(f.s,p.child.pid);
  const began=performance.now(),result=await stop(f.s,['a'],{force:true});
  assert(existsSync(term),'provider handled SIGTERM before escalation');
  assert.deepEqual(result.signals.map(row=>[row.signal,row.status]),[['SIGTERM','sent'],['SIGKILL','sent']]);
  assert(performance.now()-began>=900,'provider received the grace period');
  assert(performance.now()-began<2500,'force remains bounded');assert.equal((await p.exit).signal,'SIGKILL');
  assert.deepEqual(f.s.all("SELECT detail FROM events WHERE action='force-stop-signal' ORDER BY id").map(row=>JSON.parse(row.detail).signal),['SIGTERM','SIGKILL']);
});

test('force respects resume and cancellation during its grace period',async t=>{
  for(const mode of ['resume','abort']) {
    const f=fixture(t),term=join(f.dir,'term');
    const p=await provider(f,t,'claude',`process.on('SIGTERM',()=>require('node:fs').writeFileSync(${JSON.stringify(term)},'received'));`);register(f.s,p.child.pid);
    const abort=new AbortController();
    const resultPromise=stop(f.s,['a'],{force:true,signal:abort.signal});
    for(let i=0;i<100&&!existsSync(term);i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert(existsSync(term));
    if(mode==='resume')resumeWork(f.s,['a']);else abort.abort();
    const result=await resultPromise;
    assert(result.interrupted);assert(!result.complete);process.kill(p.child.pid,0);
    assert(!result.signals.some(row=>row.signal==='SIGKILL'&&row.status==='sent'));
  }
});

test('force does not escalate after the registered process identity changes during grace',async t=>{
  const f=fixture(t),term=join(f.dir,'term');
  const p=await provider(f,t,'claude',`process.on('SIGTERM',()=>require('node:fs').writeFileSync(${JSON.stringify(term)},'received'));`);register(f.s,p.child.pid);
  const resultPromise=stop(f.s,['a'],{force:true});
  for(let i=0;i<100&&!existsSync(term);i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert(existsSync(term));f.s.run('UPDATE sessions SET process_start=? WHERE pid=?','changed:1',p.child.pid);
  const result=await resultPromise;assert.deepEqual(result.signals.map(row=>row.signal),['SIGTERM']);process.kill(p.child.pid,0);
});

test('force refuses reused fingerprints, unrelated executables and unverifiable sessions',async t=>{
  const f=fixture(t),p=await provider(f,t);
  rawSession(f.s,{pid:p.child.pid,fingerprint:'wrong-boot:1'});
  const reused=await stop(f.s,['a'],{force:true});assert.equal(reused.signals[0].status,'refused');assert.equal(p.child.signalCode,null);
  f.s.run('UPDATE sessions SET ended_at=?',now());resumeWork(f.s,['a']);
  f.s.run('UPDATE sessions SET process_start=?,provider=? WHERE id=?',processIdentity(p.child.pid),'codex',1);
  const unrelated=await stop(f.s,['a'],{force:true});assert.equal(unrelated.signals[0].status,'refused');assert.equal(p.child.signalCode,null);
  unknownSession(f.s,'b');const unknown=await stop(f.s,['b'],{force:true});assert.equal(unknown.signals[0].status,'refused');
  process.kill(p.child.pid,0);
});

test('force refuses this CLI and its ancestors even with registered PID claims',async t=>{
  const f=fixture(t);rawSession(f.s,{pid:process.pid,fingerprint:processIdentity(process.pid),provider:'node'});
  rawSession(f.s,{role:'b',pid:process.ppid,fingerprint:processIdentity(process.ppid),provider:'claude'});
  const result=await stop(f.s,['a','b'],{force:true});
  assert.equal(result.signals.length,2);assert(result.signals.every(r=>r.status==='refused'&&/ancestors/.test(r.reason)));
});

test('force refuses provider PIDs shared with an unselected workspace',async t=>{
  const f=fixture(t),p=await provider(f,t);register(f.s,p.child.pid);
  const other=f.s.run('INSERT INTO workspaces(name,created_at) VALUES(?,?)','other',now()).lastInsertRowid;
  f.s.run('INSERT INTO roles(workspace_id,name,kind,provider) VALUES(?,?,?,?)',other,'private-role','agent','claude');
  f.s.run('INSERT INTO sessions(workspace_id,role,provider,pid,process_start,started_at,last_seen_at) VALUES(?,?,?,?,?,?,?)',other,'private-role','claude',p.child.pid,processIdentity(p.child.pid),now(),now());
  const result=await stop(f.s,['a'],{force:true});assert.equal(result.signals[0].status,'refused');assert.match(result.signals[0].reason,/unselected role or workspace/);
  assert(!result.signals[0].reason.includes('private-role'));process.kill(p.child.pid,0);
});

test('force cancellation before signalling leaves the provider untouched',async t=>{
  const f=fixture(t),p=await provider(f,t);register(f.s,p.child.pid);
  const result=await stop(f.s,['a'],{force:true,onProgress(){resumeWork(f.s,['a']);}});
  assert(result.interrupted);assert(!result.complete);assert.equal(result.signals[0].status,'refused');assert.match(result.signals[0].reason,/cleared or replaced/);
  process.kill(p.child.pid,0);assert.equal(f.s.get("SELECT count(*) n FROM events WHERE action='force-stop-signal'").n,0);
});

test('audit failure after force delivery is reported as sent, not a second refused signal',async t=>{
  const f=fixture(t),p=await provider(f,t);register(f.s,p.child.pid);
  const event=f.s.event.bind(f.s);f.s.event=(entity,id,action,detail)=>{if(action==='force-stop-signal')throw new Error('fixture audit failure');return event(entity,id,action,detail);};
  const result=await stop(f.s,['a'],{force:true});assert.equal(result.signals.length,1);assert.equal(result.signals[0].status,'sent');assert.match(result.signals[0].reason,/audit could not be recorded/);await p.exit;
});

test('stop guards both planning and actual native spawn after provider version check',async t=>{
  const f=fixture(t),bin=join(f.dir,'bin'),log=join(f.dir,'calls');mkdirSync(bin);
  const storage=pathToFileURL(resolve('dist/storage.js')).href,control=pathToFileURL(resolve('dist/control.js')).href;
  writeFileSync(join(bin,'claude'),`#!/usr/bin/env node\n(async()=>{require('node:fs').appendFileSync(${JSON.stringify(log)},process.argv.includes('--version')?'version\\n':'SPAWNED\\n');if(process.argv.includes('--version')){const {Store}=await import(${JSON.stringify(storage)});const {requestStop}=await import(${JSON.stringify(control)});const s=new Store(${JSON.stringify(f.s.path)},'human');s.use('test');requestStop(s,['a']);s.close();console.log('fixture');}})();\n`,{mode:0o755});
  const oldPath=process.env.PATH;process.env.PATH=`${bin}:${oldPath}`;t.after(()=>{process.env.PATH=oldPath;});
  await assert.rejects(()=>launch(f.s,['a'],{fresh:true,stopFile:join(f.dir,'absent-stop')}),/Stop requested/);
  assert.equal(readFileSync(log,'utf8'),'version\n');assert.equal(f.s.get('SELECT count(*) n FROM sessions').n,0);
  assert.throws(()=>planLaunch(f.s,['a'],{fresh:true}),/Stop requested/);
  assert(!existsSync(join(`${f.s.path}.launch`,'test','a.lock')));
});


test('force does not kill a shared provider when another selected role resumes before signalling',async t=>{
  const f=fixture(t),p=await provider(f,t);register(f.s,p.child.pid,'a');register(f.s,p.child.pid,'b');
  const result=await stop(f.s,['a','b'],{force:true,onProgress(){resumeWork(f.s,['b']);}});
  assert(result.interrupted);assert(!result.complete);assert.equal(result.signals.length,1);assert.equal(result.signals[0].status,'refused');
  assert.match(result.signals[0].reason,/unselected role or workspace/);process.kill(p.child.pid,0);
});
