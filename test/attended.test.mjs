import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,copyFileSync,chmodSync,symlinkSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { setRole } from '../dist/coordination.js';
import { addTask,takeTask } from '../dist/tasks.js';
import { registerCheckout } from '../dist/checkouts.js';
import { saveNotificationProgress } from '../dist/notification-progress.js';
import { setWorkspaceSettings } from '../dist/workspace-settings.js';
import { randomUUID } from 'node:crypto';
import { enrollAttended,enrollment } from '../dist/attended.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-attended-')),db=join(dir,'state.db'),repo=join(dir,'repo'),bin=join(dir,'bin');mkdirSync(repo);mkdirSync(bin);
  const run=(cmd,args,options={})=>{const result=spawnSync(cmd,args,{encoding:'utf8',timeout:60000,...options});assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  for(const args of [['init','-b','main'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid'],['-c','core.hooksPath=/dev/null','commit','--allow-empty','-m','seed']])run('git',args,{cwd:repo});
  copyFileSync(resolve('test/fixtures/attended-provider.py'),join(bin,'codex'));chmodSync(join(bin,'codex'),0o700);
  const s=new Store(db,'human',{create:true});initWorkspace(s,'demo');
  setRole(s,'builder',{kind:'agent',provider:'codex',working_dir:repo});setRole(s,'controller',{kind:'agent'});
  setWorkspaceSettings(s,{busy_checks:[{name:'fixture-protected-work',type:'command',argv:['/usr/bin/false'],cwd:dir,timeout_ms:1000},{name:'late-fixture-guard',type:'command',argv:['python3','-c','import pathlib,sys;sys.exit(0 if pathlib.Path(sys.argv[1]).exists() else 1)',join(dir,'late-busy')],cwd:dir,timeout_ms:1000}],stop_file:join(dir,'STOP')});
  const task=addTask(s,{title:'Disposable attended fixture',forRole:'builder',owner:'builder'});s.actor='builder';takeTask(s,task.id);saveNotificationProgress(s,{cursor:0,expected_version:0});s.actor='human';
  const registered=registerCheckout(s,repo);const enrollment={checkout:registered.checkout_id,task:task.id,controller_role:'controller',controller_lock:join(dir,'controller.lock'),maintenance_lock:join(dir,'maintenance.lock')};enrollAttended(s,'builder',enrollment);
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  const drive=(scenario,extra={})=>JSON.parse(run('python3',['-B',resolve('test/fixtures/attended-driver.py'),process.execPath,resolve('bin/sassato.js'),db,scenario],{env:{...process.env,PATH:bin+':'+process.env.PATH,ATTENDED_FIXTURE_DB:db,...extra}}));
  return {s,dir,db,repo,bin,drive,task,run};
}
test('attended controller completes two generations, keeps dirty bytes, replays mail and releases only after verified exit',t=>{
  const f=fixture(t),result=f.drive('complete');assert.equal(result.code,0,result.output);assert.equal(result.approvals,2);
  assert.equal(readFileSync(join(f.repo,'attended-probe.txt'),'utf8'),'line one\nline two\n');assert.equal(readFileSync(join(f.repo,'attended-sentinel.txt'),'utf8'),'keep these bytes\n');
  assert.equal(f.run('git',['rev-list','--count','HEAD'],{cwd:f.repo}).trim(),'3');assert.equal(f.s.get("SELECT count(*) n FROM managed_workers").n,1);
  assert.equal(f.s.get('SELECT generation,state,checkout_id FROM managed_workers').generation,2);assert.equal(f.s.get('SELECT state FROM managed_workers').state,'stopped');assert.equal(f.s.get('SELECT checkout_id FROM managed_workers').checkout_id,null);
  assert.equal(f.s.get("SELECT count(*) n FROM events WHERE action='attended-launch-intent'").n,2);assert.equal(f.s.get("SELECT count(*) n FROM events WHERE action='attended-exit-verified'").n,2);
  assert.equal(f.s.get("SELECT count(*) n FROM receipts WHERE recipient='builder' AND state='done'").n,1);assert.equal(f.s.get('SELECT status FROM tasks').status,'done');assert.equal(f.s.get("SELECT count(*) n FROM events WHERE entity='task-handoff' AND action='pending'").n,2);assert.equal(f.s.get("SELECT count(*) n FROM events WHERE entity='task-handoff' AND action='finalized'").n,2);
  assert.equal(f.s.get('SELECT count(*) n FROM checkout_bindings WHERE released_at IS NULL').n,0);
});
test('supervisor crash preserves ready worker and separate PTY; recovery uses fresh Enter and no duplicate launch',t=>{
  const f=fixture(t),result=f.drive('crash');assert.equal(result.code,0,result.output);assert.equal(result.crashed,true);assert.equal(result.restarted,true);assert.equal(result.approvals,2);
  assert.equal(f.s.get("SELECT count(*) n FROM events WHERE action='attended-launch-intent'").n,2);assert.equal(f.s.get("SELECT count(*) n FROM events WHERE action='attended-reconciled'").n,2);
  assert.equal(readFileSync(join(f.repo,'attended-sentinel.txt'),'utf8'),'keep these bytes\n');
});
test('provider PTY output cannot confirm retirement',t=>{
  const f=fixture(t),result=f.drive('no-confirmation');assert.equal(result.approvals,0);assert.equal(result.prompts,1,result.output);assert.equal(f.s.get("SELECT count(*) n FROM events WHERE action='attended-retirement-requested'").n,0);assert.equal(f.s.get('SELECT generation FROM managed_workers').generation,1);
});
test('a live provider helper blocks retirement, with no exemption',t=>{
  const f=fixture(t),result=f.drive('child',{ATTENDED_FIXTURE_CHILD:'1'});assert.notEqual(result.code,0);assert.match(result.output,/Other live group members/);assert.equal(result.approvals,0);assert.equal(f.s.get("SELECT count(*) n FROM events WHERE action='attended-retirement-requested'").n,0);
});
test('STOP after Enter blocks signaling and generation advance',t=>{
  const f=fixture(t),result=f.drive('stop-after-enter');assert.notEqual(result.code,0);assert.match(result.output,/STOP/);assert.equal(f.s.get("SELECT count(*) n FROM events WHERE action='attended-retirement-requested'").n,0);assert.equal(f.s.get('SELECT generation FROM managed_workers').generation,1);
});
test('pre-existing stop file launches no worker',t=>{
  const f=fixture(t);writeFileSync(join(f.dir,'STOP'),'fixture stop');const result=f.drive('stop-before');assert.notEqual(result.code,0);assert.match(result.output,/STOP/);assert.equal(f.s.get('SELECT count(*) n FROM managed_workers').n,0);
});

for(const scenario of ['cancel','busy-after-enter','dirty-after-enter','task-after-enter'])test(`attended ${scenario} blocks signal and successor`,t=>{
  const f=fixture(t),result=f.drive(scenario);assert.notEqual(result.code,0,result.output);assert.equal(result.prompts,1,result.output);
  assert.equal(f.s.get("SELECT count(*) n FROM events WHERE action='attended-retirement-requested'").n,0);assert.equal(f.s.get('SELECT generation FROM managed_workers').generation,1);
});

test('an Enter buffered before the proposal cannot approve retirement',t=>{
  const f=fixture(t),result=f.drive('pre-enter');assert.equal(result.approvals,0);assert.equal(result.prompts,1,result.output);assert.equal(f.s.get("SELECT count(*) n FROM events WHERE action='attended-retirement-requested'").n,0);
});
test('EOF at confirmation does not approve retirement',t=>{
  const f=fixture(t),result=f.drive('eof');assert.notEqual(result.code,0,result.output);assert.equal(f.s.get("SELECT count(*) n FROM events WHERE action='attended-retirement-requested'").n,0);
});
test('external guard becoming busy after Enter and the first idle check blocks the pidfd signal',t=>{
  const f=fixture(t),result=f.drive('late-busy',{ATTENDED_FIXTURE_LATE_BUSY:'1'});assert.notEqual(result.code,0,result.output);assert.match(result.output,/External busy guards/);assert.equal(f.s.get('SELECT generation FROM managed_workers').generation,1);assert.equal(f.s.get("SELECT count(*) n FROM events WHERE action='attended-exit-verified'").n,0);
});
test('the documented setup script enrolls a fresh disposable role without provider calls',t=>{
  const f=fixture(t),cli=resolve('bin/sassato.js');
  f.run(process.execPath,[cli,'init','--db',f.db,'--workspace','supervisor-probe','--humans','operator','--as','operator','--no-interactive']);
  writeFileSync(join(f.dir,'source-roles.json'),JSON.stringify([f.s.role('builder')]));symlinkSync(cli,join(f.bin,'sassato'));
  const setup=readFileSync('docs/attended-supervisor.md','utf8').split("python3 - <<'PY'\n")[1].split('\nPY')[0];
  f.run('python3',['-c',setup],{env:{...process.env,PATH:f.bin+':'+process.env.PATH,EVIDENCE:f.dir,PROBE_DB:f.db,PROBE_ROLE:'probe-script',PROBE_REPO:f.repo,SOURCE_ROLE:'builder',PROVIDER:'codex'}});
  assert.equal(f.s.get("SELECT count(*) n FROM events WHERE entity='attended-enrollment' AND entity_id='probe-script'").n,1);assert.equal(f.s.get('SELECT count(*) n FROM managed_workers').n,0);
  const detail=JSON.parse(f.s.get("SELECT detail FROM events WHERE entity='attended-enrollment' AND entity_id='probe-script'").detail);const busy=detail.busy_checks.find(row=>row.name==='release-heavy-jobs');
  const observed=spawnSync(busy.argv[0],busy.argv.slice(1),{encoding:'utf8',timeout:2000});assert.equal(observed.status,1,observed.stderr);
});

test('a reused conversation identity blocks generation 2 acknowledgment and never creates generation 3',t=>{
  const f=fixture(t),result=f.drive('reuse',{ATTENDED_FIXTURE_REUSE_ID:'1'});assert.notEqual(result.code,0,result.output);assert.match(result.output,/distinct conversation identity/);assert.equal(f.s.get('SELECT generation FROM managed_workers').generation,2);assert.equal(f.s.get("SELECT count(*) n FROM events WHERE action='attended-reconciled'").n,1);
});
test('restarting an uncertain unregistered intent never spawns or retries it',t=>{
  const f=fixture(t),p=enrollment(f.s,'builder'),at=new Date().toISOString(),worker=randomUUID(),transition=randomUUID();
  f.s.run('INSERT INTO managed_controllers VALUES(?,?,?,?,?,?,?)',p.controller_id,f.s.ws,p.controller_role,p.controller_lock,99999999,'fixture-previous-controller:0',at);
  f.s.run('INSERT INTO managed_workers(id,workspace_id,role,controller_id,generation,token_hash,state,provider,configuration_digest,updated_at,context,checkout_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',worker,f.s.ws,'builder',p.controller_id,1,'0'.repeat(64),'starting','codex','0'.repeat(64),at,JSON.stringify({evidence_kind:'cooperative-attended'}),p.checkout);
  f.s.run('INSERT INTO managed_transitions(id,worker_id,generation,idempotency_key,state,expected_task_versions,created_at,updated_at,payload) VALUES(?,?,?,?,?,?,?,?,?)',transition,worker,1,'uncertain','starting','[]',at,at,'{}');
  const result=f.drive('uncertain');assert.notEqual(result.code,0,result.output);assert.match(result.output,/Unregistered startup is uncertain/);assert.equal(f.s.get('SELECT generation FROM managed_workers').generation,1);assert.equal(f.s.get('SELECT count(*) n FROM managed_transitions').n,1);
});
