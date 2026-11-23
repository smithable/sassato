import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { setWorkspaceSettings } from '../dist/workspace-settings.js';
import { codexRound,roundHeldBack,roundPassed,roundProcesses } from '../dist/codex-round.js';

// A fake codex: --version prints a version; exec prints a thread when FAKE_EXEC is ok and fails otherwise;
// app-server --listen exits at once (or, with FAKE_SERVER=stay, runs without opening its socket), so the probe never starts. The run records each call.
const fake=`#!/usr/bin/env node
const fs=require('fs'),args=process.argv.slice(2);fs.appendFileSync(process.env.FAKE_LOG,args[0]+' '+(process.env.SASSATO_DB||'-')+'\\n');
if(args[0]==='--version'){console.log('codex-cli 0.171.0');process.exit(0);}
if(args[0]==='exec'){if(process.env.FAKE_EXEC!=='ok')process.exit(1);console.log(JSON.stringify({type:'thread.started',thread_id:'b3f1c2d4-5b6e-4f70-8a9b-0c1d2e3f4a5b'}));process.exit(0);}
if(process.env.FAKE_SERVER==='stay'){const c=require('child_process').spawn('sleep',['300'],{stdio:'ignore'});fs.writeFileSync(process.env.FAKE_LOG+'.child',String(c.pid));setInterval(()=>{},1000);}else process.exit(1);
`;

function fixture(t,exec='ok') {
  const dir=mkdtempSync(join(tmpdir(),'sas-round-')),db=join(dir,'db'),log=join(dir,'calls');
  writeFileSync(join(dir,'codex'),fake,{mode:0o700});
  const saved={PATH:process.env.PATH,FAKE_LOG:process.env.FAKE_LOG,FAKE_EXEC:process.env.FAKE_EXEC,SASSATO_DB:process.env.SASSATO_DB};
  Object.assign(process.env,{PATH:dir+':'+saved.PATH,FAKE_LOG:log,FAKE_EXEC:exec});
  const real=new Store(db,'human',{create:true});
  initWorkspace(real,'team',{roles:[{name:'human',kind:'human'},{name:'fable',provider:'claude',working_dir:dir},{name:'b',provider:'codex',working_dir:dir,model:'gpt-test',sandbox_mode:'read-only',approval_policy:'never'}]});
  real.use('team');
  t.after(()=>{real.close();for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;rmSync(dir,{recursive:true,force:true});});
  const fable=()=>{const s=new Store(db,'fable');s.use('team');try{return s.all("SELECT m.body,m.urgency FROM messages m JOIN receipts r ON r.workspace_id=m.workspace_id AND r.message_id=m.id WHERE r.recipient='fable'");}finally{s.close();}};
  const events=()=>real.all("SELECT action,detail FROM events WHERE entity='codex-round'");
  return {dir,db,log,real,fable,events};
}
const timing={seedMs:5_000,startMs:1_500,wakeMs:1_000,longMs:1_000,stopMs:1_000,sleepSeconds:1};

test('a failed seed records the failure, mails the escalation role, and leaves the caller\'s environment as it was',async t=>{
  const f=fixture(t,'fail');setWorkspaceSettings(f.real,{nudge_escalate:'fable'});
  const before={PATH:process.env.PATH,SASSATO_DB:process.env.SASSATO_DB,SASSATO_WORKSPACE:process.env.SASSATO_WORKSPACE};
  const result=await codexRound(f.real,{timing});
  assert.equal(result.status,'failed');assert.equal(result.step,'seed');assert.equal(result.version,'0.171.0');assert.equal(result.model,'gpt-test');
  assert.match(String(result.reason),/codex exec ended with 1 and no thread/);
  assert.deepEqual({PATH:process.env.PATH,SASSATO_DB:process.env.SASSATO_DB,SASSATO_WORKSPACE:process.env.SASSATO_WORKSPACE},before);
  // The seed ran against the scratch database, never the real one.
  const calls=readFileSync(f.log,'utf8').trim().split('\n');
  assert.ok(calls.some(line=>line.startsWith('exec ')&&line.endsWith('round.db')),calls.join('\n'));
  assert.deepEqual(f.events().map(e=>e.action),['failed']);assert.equal(roundPassed(f.real,'0.171.0'),false);
  const mail=f.fable();assert.equal(mail.length,1);assert.equal(mail[0].urgency,5);
  assert.match(mail[0].body,/^Codex round failed on 0\.171\.0 at step "seed": .*Logs: .*codex-round\/0\.171\.0-/);
  assert.ok(existsSync(String(result.dir)),'the logs of a failed round are kept');
});

test('a probe that cannot start fails at the start step, after the seed thread was registered in the scratch database',async t=>{
  const f=fixture(t,'ok');
  const result=await codexRound(f.real,{timing});
  assert.equal(result.status,'failed');assert.equal(result.step,'start');
  const scratch=new Store(join(String(result.dir),'cwd','round.db'),'human');scratch.use('round');
  try{assert.deepEqual(scratch.all("SELECT role,external_id FROM sessions").map(r=>({...r})),[{role:'probe',external_id:'b3f1c2d4-5b6e-4f70-8a9b-0c1d2e3f4a5b'}]);}finally{scratch.close();}
  // No escalation role is set and there is no default human, so nobody is mailed; the event is still recorded.
  assert.equal(f.fable().length,0);assert.deepEqual(f.events().map(e=>e.action),['failed']);
});

test('a server left running by a failed start is stopped by the sweep, with its child',async t=>{
  const f=fixture(t,'ok');process.env.FAKE_SERVER='stay';t.after(()=>{delete process.env.FAKE_SERVER;});
  const result=await codexRound(f.real,{timing});
  assert.equal(result.status,'failed');assert.equal(result.step,'start');assert.doesNotMatch(String(result.reason),/did not stop/);
  assert.deepEqual(roundProcesses(join(String(result.dir),'cwd','round.db')),{own:[],shared:[]});
  const child=Number(readFileSync(f.log+'.child','utf8'));
  assert.ok(child>0&&!existsSync(`/proc/${child}`)||/^Z/.test(readFileSync(`/proc/${child}/stat`,'utf8').split(') ')[1]),'the server\'s child was stopped');
  assert.ok(readFileSync(f.log,'utf8').includes('app-server'),'the server was started');
});

test('a version that passed is skipped unless forced; only a human runs a round; a model is needed',async t=>{
  const f=fixture(t,'fail');
  f.real.event('codex-round','0.171.0','passed',{});
  assert.deepEqual(await codexRound(f.real,{timing}),{version:'0.171.0',status:'skipped',reason:'A round already passed on this version'});
  assert.equal((await codexRound(f.real,{timing,force:true})).status,'failed');
  const agent=new Store(f.db,'b');agent.use('team');
  try{await assert.rejects(codexRound(agent,{timing}),/requires a human role/);}finally{agent.close();}
  f.real.run("UPDATE roles SET model=NULL WHERE name='b'");
  const none=await codexRound(f.real,{timing,force:true});
  assert.equal(none.status,'failed');assert.equal(none.step,'setup');assert.match(String(none.reason),/No Codex role names a model; give --model/);
});

test('after two failures on a version the round is skipped, with no mail, until forced; a new version is tried',async t=>{
  const f=fixture(t,'fail');setWorkspaceSettings(f.real,{nudge_escalate:'fable'});
  f.real.event('codex-round','0.171.0','failed',{step:'seed'});
  assert.equal(roundHeldBack(f.real),null,'one failure is tried once more');
  const second=await codexRound(f.real,{timing});
  assert.equal(second.status,'failed');
  assert.match(f.fable().at(-1).body,/failed 2 times on this version, so launch --watched skips it until codex round --force/);
  assert.deepEqual(roundHeldBack(f.real),{version:'0.171.0',failures:2});
  const mails=f.fable().length,events=f.events().length,calls=readFileSync(f.log,'utf8');
  const skipped=await codexRound(f.real,{timing});
  assert.equal(skipped.status,'skipped');assert.match(skipped.reason,/failed 2 times on this version; it is skipped until codex round --force/);
  assert.equal(f.fable().length,mails,'no mail');assert.equal(f.events().length,events,'no event');
  assert.match(readFileSync(f.log,'utf8').slice(calls.length),/^--version [^\n]*\n$/,'only the version is read');
  assert.equal((await codexRound(f.real,{timing,force:true})).status,'failed','--force runs it');
  f.real.event('codex-round','0.172.0','failed',{});
  assert.equal(roundHeldBack(f.real),null,'a new version has its own tries');
});

test('a round already running on the version is not started twice; the lock is let go when the round ends',async t=>{
  const f=fixture(t,'fail');
  const {launchDirectory}=await import('../dist/launch-admission.js');
  const {DatabaseSync}=await import('node:sqlite');
  const folder=join(launchDirectory(f.real.path,f.real.workspace),'codex-round');mkdirSync(folder,{recursive:true});
  const other=new DatabaseSync(join(folder,'0.171.0.lock'));other.exec('BEGIN EXCLUSIVE');
  assert.deepEqual(await codexRound(f.real,{timing}),{version:'0.171.0',status:'skipped',reason:'Another round on this version is running'});
  other.exec('ROLLBACK');other.close();
  assert.equal((await codexRound(f.real,{timing})).status,'failed');
  assert.equal((await codexRound(f.real,{timing})).status,'failed','the first round let the lock go');
});

test('the round\'s processes are those with its database, their children and their sessions; a process only working in its folder is not one',async t=>{
  const {spawn}=await import('node:child_process');
  const dir=mkdtempSync(join(tmpdir(),'sas-procs-')),db=join(dir,'cwd','round.db');mkdirSync(join(dir,'cwd'));
  const env={...process.env,SASSATO_DB:db},clean={...process.env};delete clean.SASSATO_DB;
  // A stranger working in the round's folder (a person's shell), in a session of its own.
  const stranger=spawn('sleep',['60'],{cwd:join(dir,'cwd'),env:clean,detached:true,stdio:'ignore'});
  // A round process in its own session, with a child that does not carry the database.
  const owner=spawn('sh',['-c','env -u SASSATO_DB sleep 60 & echo $!; wait'],{env,detached:true,stdio:['ignore','pipe','ignore']});
  const child=Number(await new Promise(done=>owner.stdout.once('data',chunk=>done(String(chunk).trim()))));
  t.after(()=>{for(const pid of [stranger.pid,owner.pid,child])try{process.kill(pid,'SIGKILL');}catch{}rmSync(dir,{recursive:true,force:true});});
  const sessions=new Set();
  const {own}=roundProcesses(db,sessions);
  assert.ok(own.includes(owner.pid)&&own.includes(child),JSON.stringify({own,owner:owner.pid,child}));
  assert.ok(!own.includes(stranger.pid),'a process only working in the folder is not the round\'s');
  // The owner stops; its orphan is still found through the session seen before.
  process.kill(owner.pid,'SIGKILL');await new Promise(done=>owner.once('exit',done));
  assert.ok(roundProcesses(db,sessions).own.includes(child));
  assert.ok(!roundProcesses(db).own.includes(child),'without the earlier scan the orphan has nothing tying it to the round');
});
