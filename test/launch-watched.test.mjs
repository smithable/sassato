import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,readdirSync,mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { registerSession,endSession,sessionState } from '../dist/coordination.js';
import { launchWatched,checkSettings } from '../dist/launch-watched.js';

const thread='a3f1c2d4-5b6e-4f70-8a9b-0c1d2e3f4a5b';
// A fake codex: `app-server` on stdio answers initialize and thread/start with the -c settings it was given
// (FAKE_MODEL overrides the model, to show a mismatch); `app-server --listen unix://P` opens P and stays up;
// a window (`--remote E resume T`) stays up.
const fake=`#!/usr/bin/env node
const net=require('net'),args=process.argv.slice(2);
const c=key=>{const i=args.findIndex((a,j)=>args[j-1]==='-c'&&a.startsWith(key+'='));return i<0?undefined:JSON.parse(args[i].slice(key.length+1));};
const listen=args.indexOf('--listen');
if(args[0]==='app-server'&&listen>0){net.createServer().listen(args[listen+1].slice(7));}
else if(args[0]==='app-server'){
  let buf='';process.stdin.on('data',d=>{buf+=d;let at;while((at=buf.indexOf('\\n'))>=0){const m=JSON.parse(buf.slice(0,at));buf=buf.slice(at+1);
    if(m.id===1)console.log(JSON.stringify({id:1,result:{}}));
    if(m.id===2){const sandbox={'read-only':'readOnly','workspace-write':'workspaceWrite'}[c('sandbox_mode')];
      console.log(JSON.stringify({id:2,result:{model:process.env.FAKE_MODEL||c('model'),sandbox:{type:sandbox},approvalPolicy:c('approval_policy'),reasoningEffort:c('model_reasoning_effort')??'medium'}}));}}});
}
setInterval(()=>{},1000);
`;

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sas-lwatched-')),db=join(dir,'db'),codex=join(dir,'codex');
  writeFileSync(codex,fake,{mode:0o700});
  const originalPath=process.env.PATH,distro=process.env.WSL_DISTRO_NAME;process.env.PATH=dir+':'+originalPath;
  const operator=new Store(db,'human',{create:true});
  initWorkspace(operator,'team',{roles:[{name:'human',kind:'human'},{name:'b',provider:'codex',working_dir:dir,model:'gpt-test',sandbox_mode:'read-only',approval_policy:'never'}]});
  operator.use('team');
  const worker=new Store(db,'b');worker.use('team');
  registerSession(worker,{provider:'codex',external_id:thread});endSession(worker,thread);
  const children=[];
  const openWindow=(exe,args,cwd)=>{const child=spawn(exe,args,{cwd,stdio:'ignore'});children.push(child);};
  const watchers=[];
  t.after(()=>{
    process.env.PATH=originalPath;
    for(const child of children)child.kill();
    worker.close();operator.close();rmSync(dir,{recursive:true,force:true});
  });
  return {dir,operator,worker,codex,children,openWindow,watchers,options:{openWindow,startWatcher:roles=>{watchers.push(roles);return 4242;},waitMs:5000},distro};
}
const stopServer=r=>{try{process.kill(r.server);}catch{}};

test('launch --watched checks the settings, starts the server hidden, opens the window, registers it and starts one watcher (T1193)',async t=>{
  const f=fixture(t);
  const [r]=await launchWatched(f.operator,['b'],f.options);
  t.after(()=>stopServer(r));
  assert.equal(r.status,'started');assert.equal(r.thread,thread);assert.equal(r.watcher,4242);
  assert.deepEqual(f.watchers,[['b']]);
  const session=f.operator.get("SELECT * FROM sessions WHERE workspace_id=? AND role='b' AND ended_at IS NULL",f.operator.ws);
  assert.equal(session.external_id,thread);assert.equal(session.pid,r.window);assert.equal(sessionState(session),'running');
  // A second run refuses while the window and server it started are open, and says how to close them.
  await assert.rejects(launchWatched(f.operator,['b'],f.options),/already has an open window pid \d+.*--close-stale/);
  // --close-stale closes only what the earlier run started, then starts again.
  const [again]=await launchWatched(f.operator,['b'],{...f.options,closeStale:true});
  t.after(()=>stopServer(again));
  assert.notEqual(again.server,r.server);assert.notEqual(again.window,r.window);
  await delay(100);
  assert.throws(()=>process.kill(r.server,0));
});

test('launch --watched refuses a window it did not start, and never closes it',async t=>{
  const f=fixture(t);
  const foreign=spawn(f.codex,['--remote','unix:///elsewhere','resume',thread],{stdio:'ignore'});
  t.after(()=>foreign.kill());
  await delay(200);
  await assert.rejects(launchWatched(f.operator,['b'],{...f.options,closeStale:true}),new RegExp(`window pid ${foreign.pid}.*did not start it`));
  assert.equal(foreign.exitCode,null);
  assert.equal(f.watchers.length,0);
});

test('the settings check refuses a mismatch before anything starts',async t=>{
  const f=fixture(t);
  process.env.FAKE_MODEL='gpt-other';t.after(()=>{delete process.env.FAKE_MODEL;});
  await assert.rejects(launchWatched(f.operator,['b'],f.options),/model gpt-other, not gpt-test: settings mismatch/);
  assert.equal(f.children.length,0);assert.equal(f.watchers.length,0);
  delete process.env.FAKE_MODEL;
  await checkSettings(f.codex,['-c','model="m"','-c','sandbox_mode="workspace-write"','-c','approval_policy="never"'],{model:'m',sandbox:'workspaceWrite',approval:'never',effort:null},f.dir,5000);
  await assert.rejects(checkSettings(f.codex,['-c','model="m"','-c','sandbox_mode="read-only"','-c','approval_policy="never"'],{model:'m',sandbox:'workspaceWrite',approval:'never',effort:null},f.dir,5000),/sandbox readOnly, not workspaceWrite/);
});

test('launch --watched needs the human, a resumable session and a fully set role; dry run starts nothing',async t=>{
  const f=fixture(t);
  await assert.rejects(launchWatched(f.worker,['b'],f.options));
  const [plan]=await launchWatched(f.operator,['b'],{...f.options,dryRun:true});
  assert.equal(plan.status,'ready');assert.deepEqual(plan.window.slice(1),['--remote',plan.server.at(-1),'resume',thread]);
  assert.ok(plan.server.includes('model="gpt-test"'));
  assert.equal(f.children.length,0);
  f.operator.run("UPDATE roles SET approval_policy=NULL WHERE workspace_id=? AND name='b'",f.operator.ws);
  await assert.rejects(launchWatched(f.operator,['b'],f.options),/Set a model, sandbox and approval policy/);
  assert.ok(!existsSync(join(f.dir,'nothing')));
});

test('a dry run with --close-stale names what it would close and closes nothing (T1193 review)',async t=>{
  const f=fixture(t);
  const [r]=await launchWatched(f.operator,['b'],f.options);
  t.after(()=>stopServer(r));
  const [plan]=await launchWatched(f.operator,['b'],{...f.options,closeStale:true,dryRun:true});
  assert.match(plan.would_close,new RegExp(`window pid ${r.window}`));
  process.kill(r.server,0);process.kill(r.window,0);
});

test('a window that never opens stops the server again and records nothing; earlier roles still get the watcher',async t=>{
  const f=fixture(t);
  await assert.rejects(launchWatched(f.operator,['b'],{...f.options,openWindow:()=>{},waitMs:1000}),/window did not start/);
  await delay(100);
  const servers=readdirSync('/proc').filter(p=>/^\d+$/.test(p)).filter(p=>{try{return readFileSync(`/proc/${p}/cmdline`,'utf8').includes(join(f.dir,'db.launch'))&&readFileSync(`/proc/${p}/cmdline`,'utf8').includes('--listen');}catch{return false;}});
  assert.deepEqual(servers,[]);
  assert.equal(f.watchers.length,0);
  // b starts, then an unknown role fails: b still gets its watcher.
  await assert.rejects(launchWatched(f.operator,['b','nobody'],f.options));
  assert.deepEqual(f.watchers,[['b']]);
  const session=f.operator.get("SELECT pid FROM sessions WHERE workspace_id=? AND role='b' AND ended_at IS NULL",f.operator.ws);
  t.after(()=>{for(const p of readdirSync('/proc').filter(p=>/^\d+$/.test(p))){try{if(readFileSync(`/proc/${p}/cmdline`,'utf8').includes(join(f.dir,'db.launch')))process.kill(Number(p));}catch{}}});
  assert.ok(session.pid);
});

test('a state file that does not match what this command writes is not trusted: no process is signalled',async t=>{
  const f=fixture(t);
  const victim=spawn(f.codex,['--remote','unix:///x','resume',thread],{stdio:'ignore'});
  t.after(()=>victim.kill());
  await delay(200);
  const watched=join(f.dir,'db.launch','team','watched');
  mkdirSync(watched,{recursive:true});
  writeFileSync(join(watched,'b.json'),JSON.stringify({role:'b',thread,endpoint:'unix:///x',server:{pid:victim.pid},window:{pid:victim.pid,identity:''}}));
  await assert.rejects(launchWatched(f.operator,['b'],{...f.options,closeStale:true}),/did not start it/);
  assert.equal(victim.exitCode,null);
});
