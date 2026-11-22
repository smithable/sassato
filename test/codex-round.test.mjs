import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,readdirSync } from 'node:fs';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { setWorkspaceSettings } from '../dist/workspace-settings.js';
import { codexRound,roundPassed } from '../dist/codex-round.js';

// A fake codex: --version prints a version; exec prints a thread when FAKE_EXEC is ok and fails otherwise;
// app-server --listen exits at once (or, with FAKE_SERVER=stay, runs without opening its socket), so the probe never starts. The run records each call.
const fake=`#!/usr/bin/env node
const fs=require('fs'),args=process.argv.slice(2);fs.appendFileSync(process.env.FAKE_LOG,args[0]+' '+(process.env.SASSATO_DB||'-')+'\\n');
if(args[0]==='--version'){console.log('codex-cli 0.171.0');process.exit(0);}
if(args[0]==='exec'){if(process.env.FAKE_EXEC!=='ok')process.exit(1);console.log(JSON.stringify({type:'thread.started',thread_id:'b3f1c2d4-5b6e-4f70-8a9b-0c1d2e3f4a5b'}));process.exit(0);}
if(process.env.FAKE_SERVER==='stay'){setInterval(()=>{},1000);}else process.exit(1);
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

test('a server left running by a failed start is stopped by the sweep of the round\'s folder',async t=>{
  const f=fixture(t,'ok');process.env.FAKE_SERVER='stay';t.after(()=>{delete process.env.FAKE_SERVER;});
  const result=await codexRound(f.real,{timing});
  assert.equal(result.status,'failed');assert.equal(result.step,'start');
  const left=readdirSync('/proc').filter(pid=>/^\d+$/.test(pid)).filter(pid=>{try{return readFileSync(`/proc/${pid}/cmdline`,'utf8').includes(String(result.dir));}catch{return false;}});
  assert.deepEqual(left,[]);
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
  await assert.rejects(codexRound(f.real,{timing,force:true}),/No Codex role names a model; give --model/);
});
