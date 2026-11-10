import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { setWorkspaceSettings, workspaceSettings } from '../dist/workspace-settings.js';
import { validateBusyChecks, observeBusyChecks } from '../dist/busy-checks.js';
import { stop } from '../dist/stop.js';
import { activeStop, acknowledgeStop, resumeWork } from '../dist/control.js';
import { loadConfig } from '../dist/config.js';
import { registerSession } from '../dist/coordination.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-busy-')),s=new Store(join(dir,'state.db'),'human',{create:true});
  initWorkspace(s,'test',{roles:[{name:'human',kind:'human'},{name:'builder',kind:'agent'}]});
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return {dir,s};
}
const command=(name,script,timeout_ms=500)=>({name,type:'command',argv:[process.execPath,'-e',script],timeout_ms});
const pause=ms=>new Promise(resolvePause=>setTimeout(resolvePause,ms));

test('busy commands distinguish busy, idle, failed and timed-out without shell interpretation',async t=>{
  const {dir}=fixture(t),unexpected=join(dir,'unexpected');
  const checks=validateBusyChecks([
    command('busy','process.exit(0)'),command('idle','process.exit(1)'),command('failed','process.exit(2)'),
    command('timeout','setInterval(()=>{},1000)',100),{name:'missing',type:'command',argv:[join(dir,'absent')]},
    {name:'literal',type:'command',argv:[process.execPath,'-e','process.exit(process.argv[1].startsWith(";")?1:2)',`; touch ${unexpected}`]}
  ],dir);
  const statuses=await observeBusyChecks(checks);
  assert.deepEqual(statuses.map(row=>row.state),['busy','idle','unknown','unknown','unknown','idle']);
  assert.match(statuses[3].reason,/timed out/);assert(!existsSync(unexpected));
});

test('expired or aborted rounds report every pending check as unknown without executing commands',async t=>{
  const {dir}=fixture(t),marker=join(dir,'must-not-run');
  const checks=validateBusyChecks([command('one',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');process.exit(1)`),command('two','process.exit(1)')]);
  const aborted=new AbortController();aborted.abort();
  for(const rows of [await observeBusyChecks(checks,0),await observeBusyChecks(checks,Infinity,aborted.signal)]) {
    assert.deepEqual(rows.map(row=>[row.name,row.state]),[['one','unknown'],['two','unknown']]);
  }
  assert.equal(existsSync(marker),false);
});

test('flock check sees a held lock, not mere file presence, and never creates a missing lock',async t=>{
  const {dir}=fixture(t),path=join(dir,'gate.lock'),ready=join(dir,'ready');writeFileSync(path,'pid=12345 host=fixture-host\n');
  const checks=validateBusyChecks([{name:'gate',type:'flock',path},{name:'absent',type:'flock',path:join(dir,'absent')}]);
  assert.deepEqual((await observeBusyChecks(checks)).map(row=>row.state),['idle','idle']);
  assert(!existsSync(join(dir,'absent')));
  const child=spawn('flock',['--exclusive','--no-fork',path,process.execPath,'-e',`require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`],{stdio:'ignore'});
  const exited=new Promise(resolveExit=>{child.once('exit',resolveExit);child.once('error',resolveExit);});
  t.after(async()=>{child.kill('SIGKILL');await exited;});
  for(let n=0;n<200&&!existsSync(ready);n++)await pause(10);
  assert(existsSync(ready),'fixture lock was acquired');
  assert.equal((await observeBusyChecks(checks))[0].state,'busy');
  child.kill('SIGTERM');await exited;
  assert.equal((await observeBusyChecks(checks))[0].state,'idle');
});

test('stop all waits for busy checks under its existing timeout and preserves stop intent',async t=>{
  const {s,dir}=fixture(t),marker=join(dir,'busy');writeFileSync(marker,'busy');
  setWorkspaceSettings(s,{busy_checks:[command('gate',`process.exit(require('node:fs').existsSync(${JSON.stringify(marker)})?0:1)`)]});
  const seen=[];let released=false;
  const report=await stop(s,[],{all:true,timeout:2,onProgress(_rows,checks){seen.push(checks.map(row=>row.state));if(checks[0]?.state==='busy'&&!released){released=true;rmSync(marker);}}});
  assert(report.complete);assert.equal(report.machine_quiet,true);assert(seen.some(row=>row[0]==='busy'));assert.equal(report.busy_checks[0].state,'idle');
  setWorkspaceSettings(s,{busy_checks:[command('failure','process.exit(7)')]});
  const start=performance.now(),timed=await stop(s,[],{all:true,timeout:1});
  assert(timed.timed_out);assert(!timed.complete);assert.equal(timed.machine_quiet,false);assert.equal(timed.busy_checks[0].state,'unknown');
  assert(performance.now()-start<1800);assert(activeStop(s));
});

test('no-wait, force and named-role stops never execute machine busy commands',async t=>{
  const {s,dir}=fixture(t),marker=join(dir,'ran');
  setWorkspaceSettings(s,{busy_checks:[command('check',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');process.exit(1)`)]});
  for(const options of [{all:true,noWait:true},{all:true,force:true}]){
    const report=await stop(s,[],options);assert.equal(report.machine_quiet,null);assert.equal(report.complete,true);assert.equal(report.busy_checks[0].state,'unknown');assert(!existsSync(marker));
  }
  const named=await stop(s,['builder']);assert(named.complete);assert.equal(named.machine_quiet,null);assert(!existsSync(marker));
  s.actor='builder';registerSession(s,{provider:'claude',external_id:'pending'});s.actor='human';
  const pending=await stop(s,[],{all:true,noWait:true});assert(!pending.complete);assert.equal(pending.machine_quiet,null);assert(!existsSync(marker));
  const forced=await stop(s,[],{all:true,force:true});assert(!forced.complete);assert.equal(forced.machine_quiet,null);assert(!existsSync(marker));
});

test('a check observed idle before agents stop is re-probed after the final acknowledgement',async t=>{
  const {s,dir}=fixture(t),marker=join(dir,'shutdown-job'),count=join(dir,'check-count');
  s.actor='builder';registerSession(s,{provider:'claude',external_id:'shutdown'});s.actor='human';
  setWorkspaceSettings(s,{busy_checks:[command('shutdown',`const fs=require('node:fs'),path=${JSON.stringify(count)};let n=0;try{n=Number(fs.readFileSync(path,'utf8'))}catch{}fs.writeFileSync(path,String(n+1));process.exit(fs.existsSync(${JSON.stringify(marker)})?0:1)`)]});
  let acknowledged=false,sawBusyAfterStop=false;
  const report=await stop(s,[],{all:true,timeout:3,onProgress(rows,checks){
    if(checks[0]?.state==='idle'&&!acknowledged){
      assert.equal(rows.find(r=>r.role==='builder').state,'waiting');
      writeFileSync(marker,'job started during shutdown');s.actor='builder';acknowledgeStop(s,rows.find(r=>r.role==='builder').id);s.actor='human';acknowledged=true;
    }else if(checks[0]?.state==='busy'&&acknowledged){sawBusyAfterStop=true;rmSync(marker);}
  }});
  assert(acknowledged);assert(sawBusyAfterStop,'completion must not reuse the pre-stop idle observation');
  assert(report.complete);assert.equal(report.machine_quiet,true);assert.equal(Number(readFileSync(count,'utf8')),3);
});

test('a timed-out or cancelled final check never reuses an early idle observation',async t=>{
  for(const mode of ['timeout','cancel']) {
    const {s,dir}=fixture(t),count=join(dir,'round');
    s.actor='builder';registerSession(s,{provider:'claude',external_id:'shutdown'});s.actor='human';
    setWorkspaceSettings(s,{busy_checks:[command('final',`const fs=require('node:fs'),path=${JSON.stringify(count)};let n=0;try{n=Number(fs.readFileSync(path,'utf8'))}catch{}fs.writeFileSync(path,String(n+1));if(n===0)process.exit(1);setInterval(()=>{},1000)`,10_000)]});
    const abort=new AbortController();let acknowledged=false;
    const timer=mode==='cancel'?setInterval(()=>{if(existsSync(count)&&Number(readFileSync(count,'utf8'))===2)abort.abort();},10):undefined;
    try {
      const report=await stop(s,[],{all:true,timeout:1,signal:abort.signal,onProgress(rows,checks){
        if(checks[0]?.state==='idle'&&!acknowledged){s.actor='builder';acknowledgeStop(s,rows.find(row=>row.role==='builder').id);s.actor='human';acknowledged=true;}
      }});
      assert(acknowledged);assert(!report.complete);assert.equal(report.machine_quiet,false);assert.equal(report.busy_checks[0].state,'unknown');
      assert.equal(report.interrupted,mode==='cancel');assert.equal(report.timed_out,mode==='timeout');assert.equal(Number(readFileSync(count,'utf8')),2);
    } finally {clearInterval(timer);}
  }
});

test('waiting retries only busy and unknown checks; another stop observes every check anew',async t=>{
  const {s,dir}=fixture(t),counts={idle:join(dir,'idle'),busy:join(dir,'busy'),unknown:join(dir,'unknown')};
  const counted=(name,failures,code)=>command(name,`const fs=require('node:fs'),path=${JSON.stringify(counts[name])};let n=0;try{n=Number(fs.readFileSync(path,'utf8'))}catch{}fs.writeFileSync(path,String(++n));process.exit(n<=${failures}?${code}:1)`);
  setWorkspaceSettings(s,{busy_checks:[counted('idle',0,0),counted('busy',1,0),counted('unknown',2,2)]});
  const cancellation=new AbortController(),timer=setTimeout(()=>cancellation.abort(),3000);
  let report;try{report=await stop(s,[],{all:true,signal:cancellation.signal});}finally{clearTimeout(timer);}
  assert(report.complete);assert.equal(report.machine_quiet,true);assert(!report.timed_out);
  assert.deepEqual(Object.values(counts).map(path=>Number(readFileSync(path,'utf8'))),[1,2,3]);
  const repeated=await stop(s,[],{all:true,timeout:2});assert(repeated.complete);
  assert.deepEqual(Object.values(counts).map(path=>Number(readFileSync(path,'utf8'))),[2,3,4]);
});

test('stop deadline caps a longer configured command timeout',async t=>{
  const {s}=fixture(t);
  setWorkspaceSettings(s,{busy_checks:[command('slow','setInterval(()=>{},1000)',10_000)]});
  const start=performance.now(),report=await stop(s,[],{all:true,timeout:1});
  assert(report.timed_out);assert(!report.complete);assert.equal(report.machine_quiet,false);
  assert.equal(report.busy_checks[0].state,'unknown');assert.match(report.busy_checks[0].reason,/timed out|timeout reached/);
  assert(performance.now()-start<1800);
});

test('interrupting the CLI kills and reaps its busy command before returning interrupted',async t=>{
  const {s,dir}=fixture(t);
  for(const signal of ['SIGINT','SIGTERM']) {
    const path=join(dir,signal+'.pid');
    setWorkspaceSettings(s,{busy_checks:[command('slow',`require('node:fs').writeFileSync(${JSON.stringify(path)},String(process.pid));setInterval(()=>{},1000)`,10_000)]});
    const child=spawn(process.execPath,[resolve('bin/sassato.js'),'stop','--all','--json','--db',s.path,'--workspace','test','--as','human'],{stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',data=>{output+=data;});child.stderr.resume();
    const exited=new Promise(resolveExit=>{child.once('exit',(code,signal)=>resolveExit({code,signal}));child.once('error',error=>resolveExit({error}));});
    let checkPid;
    t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;if(checkPid)try{process.kill(checkPid,'SIGKILL');}catch{ /* Check was already reaped. */ }});
    for(let n=0;n<200&&!existsSync(path);n++)await pause(10);
    assert(existsSync(path),'busy command started');checkPid=Number(readFileSync(path,'utf8'));
    child.kill(signal);const result=await exited;
    assert.deepEqual(result,{code:4,signal:null});
    const report=JSON.parse(output);assert(report.interrupted);assert(!report.complete);assert.equal(report.machine_quiet,false);
    assert.throws(()=>process.kill(checkPid,0),{code:'ESRCH'});checkPid=undefined;
    assert(activeStop(s));
  }
});

test('quiet stop status has no normal output and includes acknowledgements and optional stop files',async t=>{
  const {s,dir}=fixture(t),path=join(dir,'STOP');
  const cli=(...args)=>spawnSync(process.execPath,[resolve('bin/sassato.js'),'stop-status','--quiet','--db',s.path,'--workspace','test',...args],{encoding:'utf8'});
  let result=cli();assert.equal(result.status,0);assert.equal(result.stdout,'');
  const report=await stop(s,['builder'],{noWait:true});s.actor='builder';acknowledgeStop(s,report.requests[0].id);s.actor='human';
  result=cli('--json');assert.equal(result.status,4);assert.equal(result.stdout,'');
  resumeWork(s);writeFileSync(path,'stop');assert.equal(cli().status,0);
  setWorkspaceSettings(s,{stop_file:path});assert.equal(cli().status,4);
  setWorkspaceSettings(s,{stop_file:null});assert.equal(cli('--stop-file',path).status,4);
  rmSync(path);assert.equal(cli('--stop-file',path).status,0);
});

test('busy configuration resolves paths, rejects malformed checks, and requires human changes',t=>{
  const {s,dir}=fixture(t),file=join(dir,'config.json');
  writeFileSync(file,JSON.stringify({busy_checks:[{name:'gate',type:'flock',path:'gate.lock'},{name:'command',type:'command',argv:['./busy'],cwd:'.'}]}));
  const config=loadConfig(file);assert.equal(config.busy_checks[0].path,join(dir,'gate.lock'));assert.equal(config.busy_checks[1].argv[0],join(dir,'busy'));assert.equal(config.busy_checks[1].cwd,dir);
  for(const invalid of [null,{},[{name:'a',type:'command',argv:[]}],[{name:'a',type:'command',argv:['node'],timeout_ms:10001}],[{name:'a',type:'flock',path:'x',unknown:true}]])assert.throws(()=>validateBusyChecks(invalid));
  s.actor='builder';assert.throws(()=>setWorkspaceSettings(s,{busy_checks:config.busy_checks}),/human role/);
  assert.deepEqual(workspaceSettings(s).busy_checks,[]);
});
