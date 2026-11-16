import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync,writeFileSync,symlinkSync,renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { addTask,takeTask } from '../dist/tasks.js';
import { registerCheckout,bindCheckout,resolveWorkerPath,inspectCheckout,releaseCheckout } from '../dist/checkouts.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-checkouts-')),root=join(dir,'original'),linked=join(dir,'linked');mkdirSync(root);
  const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git('-C',root,'init','-b','main');writeFileSync(join(root,'file.txt'),'original');git('-C',root,'add','.');
  git('-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','Initial');git('-C',root,'worktree','add','-b','worker2',linked);
  mkdirSync(join(linked,'subdir'));writeFileSync(join(linked,'file.txt'),'second checkout');
  const s=new Store(join(dir,'state.db'),'builder',{create:true});initWorkspace(s,'demo');
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  const task=role=>{s.actor=role;const task=addTask(s,{title:'Work in '+role});takeTask(s,task.id);return task.id;};
  return {dir,root,linked,s,task,git};
}
test('two workers resolve source and state to their own checkout and exact cwd',t=>{
  const {s,root,linked,task}=fixture(t),first=registerCheckout(s,root),second=registerCheckout(s,linked);
  assert.equal(first.repository_id,second.repository_id);assert.notEqual(first.checkout_id,second.checkout_id);
  const a=task('builder');bindCheckout(s,{checkout:first.checkout_id,directory:root,task:a,provider:'claude',session:'first'});
  assert.equal(resolveWorkerPath(s,'file.txt').path,join(root,'file.txt'));
  const b=task('reviewer');bindCheckout(s,{checkout:second.checkout_id,directory:join(linked,'subdir'),task:b,provider:'codex',session:'second'});
  assert.equal(resolveWorkerPath(s,'file.txt').path,join(linked,'file.txt'));
  assert.equal(resolveWorkerPath(s,'file.txt').working_dir,join(linked,'subdir'));
  assert.throws(()=>resolveWorkerPath(s,'../original/file.txt'),/escapes/);
  symlinkSync(root,join(linked,'outside'));assert.throws(()=>resolveWorkerPath(s,'outside/file.txt'),/escapes/);
  s.actor='builder';assert.equal(resolveWorkerPath(s,'file.txt',a).checkout_id,first.checkout_id);
  assert.throws(()=>resolveWorkerPath(s,'file.txt',b),/No active/);
});
test('duplicate role and checkout reservations conflict across projects, never expire implicitly',t=>{
  const {s,root,linked,task}=fixture(t),a=registerCheckout(s,root),b=registerCheckout(s,linked),one=task('builder');
  const input={checkout:a.checkout_id,directory:root,task:one,provider:'claude',session:'first'};
  const binding=bindCheckout(s,input);assert.equal(bindCheckout(s,input).id,binding.id);
  assert.throws(()=>bindCheckout(s,{...input,checkout:b.checkout_id,directory:linked}),/Role already/);
  const two=task('reviewer');assert.throws(()=>bindCheckout(s,{...input,task:two,provider:'codex'}),/Checkout already/);
  initWorkspace(s,'other');const other=registerCheckout(s,root);assert.equal(other.checkout_id,a.checkout_id);
  const three=task('reviewer');assert.throws(()=>bindCheckout(s,{...input,task:three,provider:'codex'}),/Checkout already/);
  const four=task('builder');assert.throws(()=>bindCheckout(s,{...input,task:four}),/Role already/);
  s.use('demo');s.actor='builder';assert.throws(()=>releaseCheckout(s),/verified retirement/);
  const at=new Date().toISOString();
  s.run('INSERT INTO sessions(workspace_id,role,provider,external_id,pid,process_start,started_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?)',s.ws,'builder','claude','first',2147483000,'fixture-exited',at,at);
  releaseCheckout(s);s.actor='reviewer';
  assert.ok(bindCheckout(s,{...input,task:two,provider:'codex'}).id);
});
test('aliases reuse IDs but missing and replaced checkout paths require explicit rebind',t=>{
  const {s,root,dir,git}=fixture(t),a=registerCheckout(s,root),alias=join(dir,'alias');symlinkSync(root,alias);
  assert.equal(registerCheckout(s,alias).checkout_id,a.checkout_id);
  renameSync(root,join(dir,'moved'));assert.throws(()=>inspectCheckout(s,a.checkout_id));
  mkdirSync(root);git('-C',root,'init');assert.throws(()=>registerCheckout(s,root),/replaced/);
  assert.throws(()=>inspectCheckout(s,a.checkout_id),/identity changed/);
});
