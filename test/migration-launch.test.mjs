import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { Store } from '../dist/storage.js';
import { now } from '../dist/errors.js';
import { previewImport, applyImport, exportMarkdown } from '../dist/migration.js';
import { planLaunch, launch, unlockLaunch, windowsTerminalArgs } from '../dist/launch.js';
import { registerSession, processIdentity } from '../dist/coordination.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-migration-'));
  const s=new Store(join(dir,'state.db'),'human',{create:true});
  s.run('INSERT INTO workspaces(name,created_at) VALUES(?,?)','test',now());
  const ws=s.get('SELECT id FROM workspaces WHERE name=?','test').id;
  for(const role of ['human','a','b','c','lead']) s.run('INSERT INTO roles(workspace_id,name,kind,provider,working_dir) VALUES(?,?,?,?,?)',ws,role,role==='human'?'human':'agent',role==='c'?'codex':'claude',dir);
  s.use('test');
  t.after(async()=>{
    const base=join(`${s.path}.launch`,'test');
    for(let i=0;i<100&&existsSync(base)&&readdirSync(base).some(name=>name.startsWith('.runtime-')||name.endsWith('.lock'));i++)await new Promise(res=>setTimeout(res,20));
    s.close();rmSync(dir,{recursive:true,force:true});
  });
  function file(name,body) {const path=join(dir,name);writeFileSync(path,body);return path;}
  return {dir,s,file};
}
function sourceOptions(f) {
  const backlog=f.file('backlog.md','# Backlog\n\n## A (engine)\n1. Implement keyboard navigation\n   Keep focus visible.\n2. (done, 2026-11-08) Ship accessible labels\n3. waits for B to provide the API\n4. Duplicate one\n4. Duplicate two\n\n## Anyone\n1. Improve diagnostics\n');
  const wip=f.file('wip.md','Old work log.\n- A was working on a stale branch.\n');
  const actions=join(f.dir,'actions');mkdirSync(actions);writeFileSync(join(actions,'decision.md'),'# Publish package\n\nPlease decide whether to publish.\n\n## Remaining question\nWait for tests?\n');
  const sessions=f.file('sessions.md','claude --resume 12345678-1234-1234-1234-123456789abc # project, session A\n');
  return {backlog,wip,actions,sessions};
}

test('preview is read-only and explicitly flags ambiguous legacy work',t=>{
  const f=fixture(t), options=sourceOptions(f),before=f.s.get('SELECT count(*) n FROM events').n;
  const ro=new Store(f.s.path,'human',{readonly:true});ro.use('test');
  const preview=previewImport(ro,options);ro.close();
  assert.equal(preview.digest.length,64);assert.equal(preview.summary.create,8);
  assert.equal(preview.items.find(x=>x.title==='Implement keyboard navigation').status,'open');
  assert.equal(preview.items.find(x=>x.title.startsWith('(done')).status,'done');
  assert(preview.items.filter(x=>x.title.startsWith('Duplicate')).every(x=>x.status==='blocked'));
  assert.equal(f.s.get('SELECT count(*) n FROM events').n,before);
  assert.equal(f.s.get('SELECT count(*) n FROM imports').n,0);
});

test('confirmed import preserves provenance, human queue and raw WIP, and is idempotent',t=>{
  const f=fixture(t),options=sourceOptions(f),raw=readFileSync(options.backlog,'utf8');
  const preview=previewImport(f.s,options),result=applyImport(f.s,options,preview.digest);
  assert.equal(result.created.length,7);
  assert.equal(f.s.get('SELECT count(*) n FROM imports').n,4);
  assert.equal(f.s.get('SELECT count(*) n FROM wip').n,0);
  assert.equal(f.s.get('SELECT raw FROM imports WHERE path=?',options.wip).raw,readFileSync(options.wip,'utf8'));
  assert.equal(f.s.get('SELECT count(*) n FROM questions').n,1);
  const action=f.s.get('SELECT * FROM tasks WHERE human_only=1');
  assert.equal(action.owner,'human');assert.equal(action.status,'blocked');assert.equal(action.for_role,'human');
  assert.match(action.body,/Wait for tests/);assert.match(action.body,/decision\.md:1/);
  assert.equal(f.s.get('SELECT count(*) n FROM sessions WHERE ended_at IS NULL').n,0);
  assert.equal(applyImport(f.s,options,preview.digest).created.length,0);
  assert.equal(readFileSync(options.backlog,'utf8'),raw);
});

test('changed preview is rejected; changed imported items never overwrite live work',t=>{
  const f=fixture(t),options={backlog:f.file('backlog.md','## A\n1. Original item\n')};
  const preview=previewImport(f.s,options);
  writeFileSync(options.backlog,'## A\n1. Changed item\n');
  assert.throws(()=>applyImport(f.s,options,preview.digest),/preview changed/);
  const current=previewImport(f.s,options);applyImport(f.s,options,current.digest);
  f.s.run("UPDATE tasks SET body='Live work and new notes' WHERE workspace_id=?",f.s.ws);
  writeFileSync(options.backlog,'## A\n1. Changed again\n');
  const next=previewImport(f.s,options);assert.equal(next.summary.conflict,1);
  assert.equal(applyImport(f.s,options,next.digest).created.length,0);
  assert.equal(f.s.get('SELECT body FROM tasks').body,'Live work and new notes');
});

test('imports require human actor and reject suspected secrets before preserving raw data',t=>{
  const f=fixture(t),options={backlog:f.file('backlog.md','## A\n1. Ordinary item\n')};
  const digest=previewImport(f.s,options).digest;f.s.actor='a';
  assert.throws(()=>applyImport(f.s,options,digest),/human role/);
  f.s.actor='human';writeFileSync(options.backlog,`## A\n1. sk-${'x'.repeat(30)}\n`);
  assert.throws(()=>previewImport(f.s,options),/secret rejected/);
  assert.equal(f.s.get('SELECT count(*) n FROM imports').n,0);
});

test('duplicate legacy session identities and newer registry state are not overwritten',t=>{
  const f=fixture(t),line='claude --resume 12345678-1234-1234-1234-123456789abc # project, session A\n';
  const sessions=f.file('sessions.md',line+line);
  const duplicate=previewImport(f.s,{sessions});assert.equal(duplicate.summary.conflict,2);
  applyImport(f.s,{sessions},duplicate.digest);assert.equal(f.s.get('SELECT count(*) n FROM sessions').n,0);
  writeFileSync(sessions,line);f.s.actor='a';registerSession(f.s,{provider:'claude',external_id:'different-session'});f.s.actor='human';
  const existing=previewImport(f.s,{sessions});assert.equal(existing.summary.conflict,1);
  applyImport(f.s,{sessions},existing.digest);
  assert.equal(f.s.get('SELECT count(*) n FROM sessions').n,1);
  assert.equal(f.s.get('SELECT external_id FROM sessions').external_id,'different-session');
});

test('exports retain histories and refuse to overwrite files',t=>{
  const f=fixture(t),options=sourceOptions(f);applyImport(f.s,options,previewImport(f.s,options).digest);
  const out=join(f.dir,'export'),result=exportMarkdown(f.s,out);
  assert(result.files.includes('backlog.md'));assert(result.files.includes('items/T1.md'));
  assert.match(readFileSync(join(out,'items/T1.md'),'utf8'),/## History[\s\S]*imported/);
  assert.match(readFileSync(join(out,'humans.md'),'utf8'),/Publish package/);
  assert.throws(()=>exportMarkdown(f.s,out),/new directory/);
});

test('launcher dry-run preserves database and never creates a lock or deletes stop signal',async t=>{
  const f=fixture(t),stop=f.file('stop','Stop'),before=f.s.get('SELECT count(*) n FROM events').n;
  const plans=await launch(f.s,['a'],{dryRun:true,fresh:true,stopFile:stop});
  assert.equal(plans[0].mode,'fresh');assert.equal(plans[0].status,'ready');
  assert.equal(f.s.get('SELECT count(*) n FROM events').n,before);
  assert(!existsSync(`${f.s.path}.launch`));assert(existsSync(stop));
  await assert.rejects(()=>launch(f.s,['a'],{fresh:true,stopFile:stop}),/Stop signal/);
  assert(!existsSync(`${f.s.path}.launch`));
});

test('launcher rejects uncertain sessions and requires explicit usable resume ID',t=>{
  const f=fixture(t);assert.throws(()=>planLaunch(f.s,['a'],{resume:true}),/No usable saved/);
  f.s.actor='a';registerSession(f.s,{provider:'claude',external_id:'old-id'});f.s.actor='human';
  assert.throws(()=>planLaunch(f.s,['a'],{fresh:true}),/cannot be verified/);
  f.s.run('UPDATE sessions SET ended_at=?',now());
  assert.throws(()=>planLaunch(f.s,['a']),/invalid/);
  assert.equal(planLaunch(f.s,['a'],{fresh:true})[0].mode,'fresh');
});

test('resume and provider/model arguments remain literal argv; native does not use shell text',t=>{
  const f=fixture(t),session='12345678-1234-1234-1234-123456789abc',model='model;$(touch no-such-file)';
  f.s.run('UPDATE roles SET model=? WHERE workspace_id=? AND name=?',model,f.s.ws,'c');
  f.s.run('INSERT INTO sessions(workspace_id,role,provider,external_id,started_at,last_seen_at,ended_at) VALUES(?,?,?,?,?,?,?)',f.s.ws,'c','codex',session,now(),now(),now());
  const plan=planLaunch(f.s,['c'],{resume:true,noPrompt:true})[0];
  assert.deepEqual(plan.args,['resume',session,'--model',model]);
  assert.throws(()=>planLaunch(f.s,['a','b']),/one interactive role/);
  assert.throws(()=>planLaunch(f.s,['a'],{fresh:true,resume:true}),/either/);
});

function fakeProvider(f,t,{selfRegister=false,delay=150}={}) {
  const bin=join(f.dir,'bin');mkdirSync(bin);const log=join(f.dir,'provider.log');
  const storage=pathToFileURL(resolve('dist/storage.js')).href,coord=pathToFileURL(resolve('dist/coordination.js')).href;
  const program=`#!/usr/bin/env node\n(async()=>{if(process.argv.includes('--version')){console.log('fake-provider 1');return;}require('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');${selfRegister?`const {Store}=await import(${JSON.stringify(storage)});const {registerSession}=await import(${JSON.stringify(coord)});const s=new Store(process.env.SASSATO_DB,process.env.SASSATO_ROLE);s.use(process.env.SASSATO_WORKSPACE);registerSession(s,{provider:'claude',external_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',pid:process.pid,replace:true});s.close();`:''}setTimeout(()=>{},${delay});})().catch(e=>{console.error(e);process.exitCode=1});\n`;
  writeFileSync(join(bin,'claude'),program,{mode:0o755});const previousPath=process.env.PATH;process.env.PATH=`${bin}:${previousPath}`;t.after(()=>{process.env.PATH=previousPath;});
  return {bin,log};
}

test('native fake-provider lifecycle preserves hook session ID and records exit',async t=>{
  const f=fixture(t),fake=fakeProvider(f,t,{selfRegister:true,delay:220});
  const plans=await launch(f.s,['a'],{fresh:true,noPrompt:true,stopFile:join(f.dir,'no-stop')});
  assert.equal(plans[0].status,'exited');assert.equal(readFileSync(fake.log,'utf8').trim(),'[]');
  const row=f.s.get('SELECT * FROM sessions WHERE role=? ORDER BY id DESC LIMIT 1','a');
  assert.equal(row.external_id,'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');assert(row.ended_at);
  assert(!existsSync(join(`${f.s.path}.launch`,'test','a.lock')));
});

test('two simultaneous launch attempts start only one provider',async t=>{
  const f=fixture(t),fake=fakeProvider(f,t,{delay:220});
  const other=new Store(f.s.path,'human');other.use('test');t.after(()=>other.close());
  const options={fresh:true,noPrompt:true,stopFile:join(f.dir,'no-stop')};
  const results=await Promise.allSettled([launch(f.s,['a'],options),launch(other,['a'],options)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(readFileSync(fake.log,'utf8').trim().split('\n').length,1);
  assert.equal(f.s.get('SELECT count(*) n FROM sessions WHERE ended_at IS NULL').n,0);
});

test('verified live session is skipped even in fresh mode',async t=>{
  const f=fixture(t),fake=fakeProvider(f,t,{delay:1200});
  const child=spawn(join(fake.bin,'claude'),[],{stdio:'ignore'});await new Promise((res,rej)=>{child.once('spawn',res);child.once('error',rej);});
  const exited=new Promise(res=>child.once('exit',res));t.after(async()=>{child.kill();await exited;});
  for(let n=0;n<100&&!existsSync(fake.log);n++) await new Promise(res=>setTimeout(res,5));
  assert(existsSync(fake.log),'fake provider reached its running phase');
  f.s.actor='a';registerSession(f.s,{provider:'claude',external_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',pid:child.pid});f.s.actor='human';
  const plan=await launch(f.s,['a'],{fresh:true,noPrompt:true,stopFile:join(f.dir,'no-stop')});
  assert.equal(plan[0].status,'already-running');assert(!existsSync(`${f.s.path}.launch`));
});

test('stale launch locks are explicit and live launcher locks cannot be removed',t=>{
  const f=fixture(t),dir=join(`${f.s.path}.launch`,'test');mkdirSync(dir,{recursive:true});
  const path=join(dir,'a.lock');writeFileSync(path,JSON.stringify({pid:process.pid,identity:processIdentity(process.pid)}));
  assert.throws(()=>unlockLaunch(f.s,['a']),/still running/);
  writeFileSync(path,JSON.stringify({pid:process.pid,identity:'old-boot:old-start'}));
  assert.deepEqual(unlockLaunch(f.s,['a']),{unlocked:['a']});assert(!existsSync(path));
});

test('Claude hook discovers provider PID, replaces ID on clear, and leaves receipts unread',async t=>{
  const f=fixture(t),fake=fakeProvider(f,t,{delay:100});
  const hook=resolve('examples/claude-hook.mjs'),output=join(f.dir,'hook-output.json');
  const first='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',second='bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  const program=`#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('fixture');process.exit(0);}
const {spawnSync}=require('node:child_process');
const result=[];
for(const event of [{hook_event_name:'SessionStart',session_id:${JSON.stringify(first)}},{hook_event_name:'SessionStart',session_id:${JSON.stringify(second)}},{hook_event_name:'UserPromptSubmit',session_id:${JSON.stringify(second)}}]) {
const r=spawnSync(process.execPath,[${JSON.stringify(hook)}],{input:JSON.stringify(event),encoding:'utf8',env:process.env});result.push({status:r.status,stdout:r.stdout,stderr:r.stderr});
}
require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify(result));
setTimeout(()=>{},100);
`;
  writeFileSync(join(fake.bin,'claude'),program,{mode:0o755});
  f.s.run('INSERT INTO messages(workspace_id,sender,body,created_at) VALUES(?,?,?,?)',f.s.ws,'human','Please inspect this task',now());
  f.s.run('INSERT INTO receipts(workspace_id,message_id,recipient) VALUES(?,?,?)',f.s.ws,1,'a');
  await launch(f.s,['a'],{fresh:true,noPrompt:true,stopFile:join(f.dir,'no-stop')});
  const results=JSON.parse(readFileSync(output,'utf8'));
  assert.equal(results.length,3);assert(results.every(r=>r.status===0&&r.stdout.includes('test / a')&&!r.stderr.includes('hook unavailable')));
  assert(results.every(r=>r.stdout.length<=6000));
  const current=f.s.get('SELECT * FROM sessions WHERE role=? ORDER BY id DESC LIMIT 1','a');
  assert.equal(current.external_id,second);assert(current.ended_at);
  assert.equal(f.s.get('SELECT state FROM receipts WHERE recipient=?','a').state,'unread');
});

test('unrecognized hook input fails advisory without echoing secrets or blocking',async()=>{
  const {spawnSync}=await import('node:child_process');
  const secret='sk-'+ 's'.repeat(30);
  const result=spawnSync(process.execPath,[resolve('examples/claude-hook.mjs')],{input:secret,encoding:'utf8'});
  assert.equal(result.status,0);assert.equal(result.stdout,'');assert.match(result.stderr,/hook unavailable/);assert(!result.stderr.includes(secret));
});


test('new-window plans create one separate Windows Terminal window per role and clean native payloads',async t=>{
  const f=fixture(t),options={newWindow:true,distro:'Ubuntu',fresh:true,dryRun:true};
  const plans=await launch(f.s,['a','b'],options);
  assert.equal(plans.length,2);
  for(const plan of plans) {
    assert.equal(plan.terminal,'windows-terminal');assert.equal(plan.window,'new');
    const args=windowsTerminalArgs(f.s,plan,options);
    assert.deepEqual(args.slice(0,5),['-w','new','new-tab','--title',plan.role]);
    const payload=JSON.parse(Buffer.from(args.at(-1),'base64url').toString('utf8'));
    assert.equal(payload.role,plan.role);assert.equal(payload.options.terminal,'native');
    assert.equal(payload.options.all,false);assert(!('newWindow' in payload.options));assert(!('window' in payload.options));
    assert.equal(planLaunch(f.s,[plan.role],payload.options)[0].terminal,'native');
  }
  assert.equal(f.s.get('SELECT count(*) n FROM sessions').n,0);
  assert(!existsSync(`${f.s.path}.launch`));
});

test('named-window tabs remain unchanged and new-window conflicts fail clearly',t=>{
  const f=fixture(t),options={terminal:'windows-terminal',distro:'Ubuntu'};
  assert.equal(planLaunch(f.s,['a'],options)[0].window,'test');
  const plan=planLaunch(f.s,['a'],{...options,window:'team'})[0];
  assert.equal(plan.window,'team');assert.deepEqual(windowsTerminalArgs(f.s,plan,options).slice(0,3),['-w','team','new-tab']);
  assert.equal(planLaunch(f.s,['a'])[0].window,null);
  assert.throws(()=>planLaunch(f.s,['a'],{newWindow:true,terminal:'native'}),/cannot use the native/);
  assert.throws(()=>planLaunch(f.s,['a'],{newWindow:true,window:'team'}),/Choose --new-window or --window/);
  assert.throws(()=>windowsTerminalArgs(f.s,{...plan,status:'already-running'},options),/already active/);
  assert.throws(()=>windowsTerminalArgs(f.s,{...plan,window:'team;new-tab'},options),/command.*characters|semicolons/);
  f.s.actor='a';registerSession(f.s,{provider:'claude',external_id:'unknown'});f.s.actor='human';
  assert.throws(()=>planLaunch(f.s,['a'],{newWindow:true,distro:'Ubuntu'}),/cannot be verified/);
});


function fakeWindowsTerminal(f,t,{versionCode=0,worker=true,forged=false,missingProvider=false,unknownActor=false}={}) {
  const bin=join(f.dir,'terminal-bin'),log=join(f.dir,'terminal.jsonl'),providerLog=join(f.dir,'provider-environment.json');mkdirSync(bin);
  if(!missingProvider)writeFileSync(join(bin,'claude'),`#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('fixture-provider');process.exit(${versionCode});}
const {spawnSync}=require('node:child_process');
const commands=['sassato','sas'].map(command=>{const r=spawnSync(command,['--version','--json'],{encoding:'utf8',env:process.env});return {command,status:r.status,output:r.stdout,error:r.error?.message};});
require('node:fs').writeFileSync(${JSON.stringify(providerLog)},JSON.stringify({node:process.execPath,path:process.env.PATH,commands}));
setTimeout(()=>{},350);
`,{mode:0o755});
  writeFileSync(join(bin,'wt.exe'),`#!/usr/bin/env node
const args=process.argv.slice(2),fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
const payload=JSON.parse(Buffer.from(args.at(-1),'base64url'));
${unknownActor?`payload.actor='missing-role';args[args.length-1]=Buffer.from(JSON.stringify(payload)).toString('base64url');`:''}
${forged?`fs.writeFileSync(require('node:path').join(payload.runtime.startup.directory,'response.json'),JSON.stringify({token:payload.runtime.startup.token,status:'started',session_id:'S999999',pid:process.pid,process_start:'fake'}));`:worker?`const at=args.indexOf('--exec');const child=require('node:child_process').spawn(args[at+1],args.slice(at+2),{env:{...process.env,PATH:'/usr/bin:/bin'},stdio:'ignore',detached:true});child.unref();`:''}
`,{mode:0o755});
  const previousPath=process.env.PATH,previousDistro=process.env.WSL_DISTRO_NAME;
  process.env.PATH=missingProvider?`${bin}:${resolve(process.execPath,'..')}`:`${bin}:${previousPath}`;process.env.WSL_DISTRO_NAME='FixtureWSL';
  t.after(()=>{process.env.PATH=previousPath;if(previousDistro===undefined)delete process.env.WSL_DISTRO_NAME;else process.env.WSL_DISTRO_NAME=previousDistro;});
  return {bin,log,providerLog};
}

test('Windows Terminal carries absolute provider and restores node/sassato despite stripped WSL PATH',async t=>{
  const f=fixture(t),fake=fakeWindowsTerminal(f,t);
  const plans=await launch(f.s,['a'],{newWindow:true,fresh:true,noPrompt:true,stopFile:join(f.dir,'no-stop')});
  assert.equal(plans[0].status,'started');assert.equal(plans[0].executable,join(fake.bin,'claude'));assert.match(plans[0].runtimeSessionId,/^S[0-9]+$/);assert(plans[0].pid>0);
  const call=JSON.parse(readFileSync(fake.log,'utf8').trim()),payload=JSON.parse(Buffer.from(call.at(-1),'base64url'));
  assert.equal(payload.runtime.executable,join(fake.bin,'claude'));assert(payload.runtime.path.includes(fake.bin));
  assert(!existsSync(payload.runtime.startup.directory),'parent removes completed startup handshake');
  for(let i=0;i<100&&!existsSync(fake.providerLog);i++)await new Promise(res=>setTimeout(res,10));
  const env=JSON.parse(readFileSync(fake.providerLog,'utf8'));
  assert.equal(env.node,process.execPath);assert(env.commands.every(command=>command.status===0&&JSON.parse(command.output).version));
});

test('Windows Terminal provider-version failure is returned to caller, not reported as dispatched',async t=>{
  const f=fixture(t),fake=fakeWindowsTerminal(f,t,{versionCode:17});
  await assert.rejects(()=>launch(f.s,['a'],{newWindow:true,fresh:true,noPrompt:true,stopFile:join(f.dir,'no-stop')}),/Cannot run/);
  assert(existsSync(fake.log));assert(!existsSync(fake.providerLog));
  assert.equal(f.s.get('SELECT count(*) n FROM sessions').n,0);
  const base=join(`${f.s.path}.launch`,'test');assert(!readdirSync(base).some(name=>name.startsWith('.startup-')||name.startsWith('.runtime-')||name.endsWith('.lock')));
});

test('missing provider fails before dispatch while dry-run remains usable',async t=>{
  const f=fixture(t),fake=fakeWindowsTerminal(f,t,{missingProvider:true});
  const preview=await launch(f.s,['a'],{newWindow:true,dryRun:true,fresh:true});assert.equal(preview[0].executable,'claude');
  await assert.rejects(()=>launch(f.s,['a'],{newWindow:true,fresh:true,stopFile:join(f.dir,'no-stop')}),/Cannot find executable claude/);
  assert(!existsSync(fake.log));assert(!existsSync(`${f.s.path}.launch`));
});

test('startup success response must match a verified live registry process',async t=>{
  const f=fixture(t),fake=fakeWindowsTerminal(f,t,{forged:true});
  await assert.rejects(()=>launch(f.s,['a'],{newWindow:true,fresh:true,stopFile:join(f.dir,'no-stop')}),/exited or changed before startup confirmation/);
  assert(existsSync(fake.log));assert(!existsSync(fake.providerLog));assert.equal(f.s.get('SELECT count(*) n FROM sessions').n,0);
});

test('Claude bootstrap snapshots then arms one role-scoped background waiter before work',t=>{
  const f=fixture(t),plan=planLaunch(f.s,['a'],{fresh:true})[0],prompt=plan.args.at(-1);
  const context='sassato context --json --as a --workspace test';
  const waiter='sassato wait --since CURSOR --as a --workspace test';
  assert(prompt.indexOf(context)>=0);assert(prompt.indexOf(context)<prompt.indexOf(waiter));
  assert.match(prompt,/numeric snapshot_cursor as CURSOR/);assert.match(prompt,/Replace CURSOR with that snapshot_cursor/);
  assert.match(prompt,/BEFORE beginning work or going idle, start exactly one native Claude Code background tool-task/);
  assert.match(prompt,/If one waiter is already active, keep it/);
  assert.match(prompt,/Never use a foreground wait, shell &, nohup, or an outer shell loop/);
  assert.match(prompt,/human answers, resolved blockers, assignments or handoffs, and newly ready tasks/);
  assert.match(prompt,/ordinary mail does not wake/);
  assert.match(prompt,/cursor returned by wait, not a newer context cursor/);
  assert.match(prompt,/On timeout, rearm with the cursor returned by wait/);
  assert.match(prompt,/On STOP, do not rearm until a human resumes/);
  assert.equal(plan.args.filter(arg=>arg.includes(context)).length,1,'all bootstrap text remains one literal provider argv value');
  assert(!plan.args.includes('--since'),'watcher flags are instructions, not provider CLI flags');
});

test('Codex bootstrap remains pull-based and no-prompt omits all startup instructions',t=>{
  const f=fixture(t),codex=planLaunch(f.s,['c'],{fresh:true})[0].args.at(-1);
  assert.match(codex,/sassato context --as c --workspace test --brief/);
  assert(!codex.includes('sassato wait'));assert.match(codex,/inbox and task context between tasks/);
  assert.match(codex,/No background wake-up is assumed/);
  assert.deepEqual(planLaunch(f.s,['a'],{fresh:true,noPrompt:true})[0].args,[]);
  assert.deepEqual(planLaunch(f.s,['c'],{fresh:true,noPrompt:true})[0].args,[]);
  f.s.run('UPDATE roles SET model=? WHERE workspace_id=? AND name=?','opus',f.s.ws,'a');
  assert.deepEqual(planLaunch(f.s,['a'],{fresh:true,noPrompt:true})[0].args,['--model','opus']);
});


test('worker setup errors acknowledge failure instead of waiting for startup timeout',async t=>{
  const f=fixture(t);fakeWindowsTerminal(f,t,{unknownActor:true});
  const started=Date.now();
  await assert.rejects(()=>launch(f.s,['a'],{newWindow:true,fresh:true,stopFile:join(f.dir,'no-stop')}),/Unknown role missing-role/);
  assert(Date.now()-started<5000,'failure was delivered promptly');
});

test('failed registration terminates only its new provider even if SIGTERM is ignored',{timeout:5000},async t=>{
  const f=fixture(t),fake=fakeProvider(f,t),pidFile=join(f.dir,'failed-provider.pid');
  writeFileSync(join(fake.bin,'claude'),`#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('fixture');process.exit(0);}
require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
`,{mode:0o755});
  const event=f.s.event.bind(f.s);f.s.event=(entity,id,action,detail)=>{if(entity==='session'&&action==='registered')throw new Error('fixture registration rejected');return event(entity,id,action,detail);};
  await assert.rejects(()=>launch(f.s,['a'],{fresh:true,noPrompt:true,stopFile:join(f.dir,'no-stop')}),/fixture registration rejected/);
  const pid=Number(readFileSync(pidFile,'utf8'));assert.equal(processIdentity(pid),null);
  assert.equal(f.s.get('SELECT count(*) n FROM sessions').n,0);assert(!existsSync(join(`${f.s.path}.launch`,'test','a.lock')));
});

test('Windows Terminal without a worker acknowledgement times out and cleans its handshake',{timeout:20000},async t=>{
  const f=fixture(t),fake=fakeWindowsTerminal(f,t,{worker:false}),started=Date.now();
  await assert.rejects(()=>launch(f.s,['a'],{newWindow:true,fresh:true,stopFile:join(f.dir,'no-stop')}),/No verified startup acknowledgement.*15 seconds/);
  assert(Date.now()-started>=14000);assert(Date.now()-started<19000);assert(existsSync(fake.log));
  assert.equal(f.s.get('SELECT count(*) n FROM sessions').n,0);
  const base=join(`${f.s.path}.launch`,'test');assert(!readdirSync(base).some(name=>name.startsWith('.startup-')));
});
