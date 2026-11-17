import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,copyFileSync,chmodSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
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
import { enrollAttended } from '../dist/attended.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-attended-')),db=join(dir,'state.db'),repo=join(dir,'repo'),bin=join(dir,'bin');mkdirSync(repo);mkdirSync(bin);
  const run=(cmd,args,options={})=>{const result=spawnSync(cmd,args,{encoding:'utf8',timeout:60000,...options});assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  for(const args of [['init','-b','main'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid'],['-c','core.hooksPath=/dev/null','commit','--allow-empty','-m','seed']])run('git',args,{cwd:repo});
  copyFileSync(resolve('test/fixtures/attended-provider.py'),join(bin,'codex'));chmodSync(join(bin,'codex'),0o700);
  const s=new Store(db,'human',{create:true});initWorkspace(s,'demo');
  setRole(s,'builder',{kind:'agent',provider:'codex',working_dir:repo});setRole(s,'controller',{kind:'agent'});
  setWorkspaceSettings(s,{busy_checks:[{name:'fixture-protected-work',type:'command',argv:['/usr/bin/false'],cwd:dir,timeout_ms:1000}],stop_file:join(dir,'STOP')});
  const task=addTask(s,{title:'Disposable attended fixture',forRole:'builder',owner:'builder'});s.actor='builder';takeTask(s,task.id);saveNotificationProgress(s,{cursor:0,expected_version:0});s.actor='human';
  const registered=registerCheckout(s,repo);const enrollment={checkout:registered.checkout_id,task:task.id,controller_role:'controller',controller_lock:join(dir,'controller.lock'),maintenance_lock:join(dir,'maintenance.lock')};enrollAttended(s,'builder',enrollment);
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  const drive=(scenario,extra={})=>JSON.parse(run('python3',['-B',resolve('test/fixtures/attended-driver.py'),process.execPath,resolve('bin/sassato.js'),db,scenario],{env:{...process.env,PATH:bin+':'+process.env.PATH,...extra}}));
  return {s,dir,db,repo,drive,task,run};
}
test('attended controller completes two generations, keeps dirty bytes, replays mail and releases only after verified exit',t=>{
  const f=fixture(t),result=f.drive('complete');assert.equal(result.code,0,result.output);assert.equal(result.approvals,2);
  assert.equal(readFileSync(join(f.repo,'attended-probe.txt'),'utf8'),'line one\nline two\n');assert.equal(readFileSync(join(f.repo,'attended-sentinel.txt'),'utf8'),'keep these bytes\n');
  assert.equal(f.run('git',['rev-list','--count','HEAD'],{cwd:f.repo}).trim(),'3');assert.equal(f.s.get("SELECT count(*) n FROM managed_workers").n,1);
  assert.equal(f.s.get('SELECT generation,state,checkout_id FROM managed_workers').generation,2);assert.equal(f.s.get('SELECT state FROM managed_workers').state,'stopped');assert.equal(f.s.get('SELECT checkout_id FROM managed_workers').checkout_id,null);
  assert.equal(f.s.get("SELECT count(*) n FROM events WHERE action='attended-launch-intent'").n,2);assert.equal(f.s.get("SELECT count(*) n FROM events WHERE action='attended-exit-verified'").n,2);
  assert.equal(f.s.get("SELECT count(*) n FROM receipts WHERE recipient='builder' AND state='done'").n,1);assert.equal(f.s.get('SELECT status FROM tasks').status,'done');
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
