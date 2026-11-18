import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,symlinkSync,renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync,spawn } from 'node:child_process';
import { once } from 'node:events';
import { registerSession,endSession,sessionState } from '../dist/coordination.js';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { addTask,takeTask } from '../dist/tasks.js';
import { registerCheckout,bindCheckout,resolveWorkerPath,inspectCheckout,releaseCheckout } from '../dist/checkouts.js';

async function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-checkouts-')),root=join(dir,'original'),linked=join(dir,'linked');mkdirSync(root);
  const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git('-C',root,'init','-b','main');writeFileSync(join(root,'file.txt'),'original');git('-C',root,'add','.');
  git('-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','Initial');git('-C',root,'worktree','add','-b','worker2',linked);
  mkdirSync(join(linked,'subdir'));writeFileSync(join(linked,'file.txt'),'second checkout');
  const s=new Store(join(dir,'state.db'),'builder',{create:true});initWorkspace(s,'demo');
  const children={},historic=new Date().toISOString();
  s.run('INSERT INTO sessions(workspace_id,role,provider,external_id,started_at,last_seen_at,ended_at) VALUES(?,?,?,?,?,?,?)',s.ws,'builder','claude','earlier-pidless',historic,historic,historic);
  for(const [role,provider,external] of [['builder','claude','first'],['reviewer','codex','second']]) {
    const script=join(dir,provider+'.mjs');writeFileSync(script,"process.send('ready');process.on('message',m=>{if(m==='hide'){process.title='fixture-hidden';process.send('hidden');}});setInterval(()=>{},1000);\n");
    const child=spawn(process.execPath,[script],{cwd:root,stdio:['ignore','ignore','ignore','ipc']});await once(child,'message');
    s.actor=role;registerSession(s,{provider,external_id:external,pid:child.pid});children[role]=child;
  }
  s.actor='builder';
  t.after(async()=>{for(const child of Object.values(children))if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}s.close();rmSync(dir,{recursive:true,force:true});});
  const task=role=>{s.actor=role;const task=addTask(s,{title:'Work in '+role});takeTask(s,task.id);return task.id;};
  return {dir,root,linked,s,task,git,children};
}
test('worker paths reject direct and symlinked Git metadata in ordinary and linked checkouts',async t=>{
  const {root,linked,s,task,git}=await fixture(t),checkout=registerCheckout(s,root),id=task('builder');
  bindCheckout(s,{checkout:checkout.checkout_id,directory:root,task:id,provider:'claude',session:'first'});
  assert.throws(()=>resolveWorkerPath(s,'.git/config'),/Git metadata/);
  symlinkSync(join(root,'.git'),join(root,'metadata-alias'));
  assert.throws(()=>resolveWorkerPath(s,'metadata-alias/config'),/Git metadata/);
  assert.ok(resolveWorkerPath(s,'file.txt').path.endsWith('/file.txt'));
  const second=registerCheckout(s,linked),other=task('reviewer');
  bindCheckout(s,{checkout:second.checkout_id,directory:linked,task:other,provider:'codex',session:'second'});
  assert.throws(()=>resolveWorkerPath(s,'.git'),/Git metadata/);
  symlinkSync(join(linked,'.git'),join(linked,'gitfile-alias'));
  assert.throws(()=>resolveWorkerPath(s,'gitfile-alias'),/Git metadata/);
  assert.throws(()=>resolveWorkerPath(s,'.GiT/config'),/Git metadata/);
  const common=git('-C',linked,'rev-parse','--path-format=absolute','--git-common-dir').trim();
  symlinkSync(common,join(linked,'common-alias'));
  assert.throws(()=>resolveWorkerPath(s,'common-alias/config'),/escapes|Git metadata/);
});
test('two workers resolve source and state to their own checkout and exact cwd',async t=>{
  const {s,root,linked,task,children}=await fixture(t),first=registerCheckout(s,root),second=registerCheckout(s,linked);
  assert.equal(first.repository_id,second.repository_id);assert.notEqual(first.checkout_id,second.checkout_id);
  const a=task('builder');bindCheckout(s,{checkout:first.checkout_id,directory:root,task:a,provider:'claude',session:'first'});
  assert.equal(resolveWorkerPath(s,'file.txt').path,join(root,'file.txt'));
  const b=task('reviewer');assert.equal(bindCheckout(s,{checkout:second.checkout_id,directory:join(linked,'subdir'),task:b,provider:'codex',session:'second',mode:'review'}).mode,'review');
  assert.equal(resolveWorkerPath(s,'file.txt').path,join(linked,'file.txt'));
  assert.equal(resolveWorkerPath(s,'file.txt').working_dir,join(linked,'subdir'));
  assert.throws(()=>resolveWorkerPath(s,'../original/file.txt'),/escapes/);
  symlinkSync(root,join(linked,'outside'));assert.throws(()=>resolveWorkerPath(s,'outside/file.txt'),/escapes/);
  s.actor='builder';assert.equal(resolveWorkerPath(s,'file.txt',a).checkout_id,first.checkout_id);
  assert.throws(()=>resolveWorkerPath(s,'file.txt',b),/No active/);
});
test('duplicate role and checkout reservations conflict across projects, never expire implicitly',async t=>{
  const {s,root,linked,task,children}=await fixture(t),a=registerCheckout(s,root),b=registerCheckout(s,linked),one=task('builder');
  const input={checkout:a.checkout_id,directory:root,task:one,provider:'claude',session:'first'};
  const binding=bindCheckout(s,input);assert.equal(bindCheckout(s,input).id,binding.id);
  assert.throws(()=>bindCheckout(s,{...input,checkout:b.checkout_id,directory:linked}),/Role already/);
  const two=task('reviewer');assert.throws(()=>bindCheckout(s,{...input,task:two,provider:'codex',session:'second'}),/Checkout already/);
  initWorkspace(s,'other');s.actor='human';
  const at=new Date().toISOString();s.run('INSERT INTO sessions(workspace_id,role,provider,external_id,pid,process_start,started_at,last_seen_at) SELECT ?,role,provider,external_id,pid,process_start,?,? FROM sessions WHERE workspace_id=(SELECT id FROM workspaces WHERE name=?) AND ended_at IS NULL',s.ws,at,at,'demo');s.actor='reviewer';const other=registerCheckout(s,root);assert.equal(other.checkout_id,a.checkout_id);
  const three=task('reviewer');assert.throws(()=>bindCheckout(s,{...input,task:three,provider:'codex',session:'second'}),/Checkout already/);
  const four=task('builder');assert.throws(()=>bindCheckout(s,{...input,task:four}),/Role already/);
  s.use('demo');s.actor='builder';assert.throws(()=>releaseCheckout(s),/verified retirement/);
  const exited=once(children.builder,'exit');children.builder.kill();await exited;
  releaseCheckout(s);s.actor='reviewer';
  assert.ok(bindCheckout(s,{...input,task:two,provider:'codex',session:'second'}).id);
});
test('aliases reuse IDs but missing and replaced checkout paths require explicit rebind',async t=>{
  const {s,root,dir,git}=await fixture(t),a=registerCheckout(s,root),alias=join(dir,'alias');symlinkSync(root,alias);
  assert.equal(registerCheckout(s,alias).checkout_id,a.checkout_id);
  renameSync(root,join(dir,'moved'));assert.throws(()=>inspectCheckout(s,a.checkout_id));
  mkdirSync(root);git('-C',root,'init');assert.throws(()=>registerCheckout(s,root),/replaced/);
  assert.throws(()=>inspectCheckout(s,a.checkout_id),/identity changed/);
});
test('binding requires a verified session and detects replaced working subfolders',async t=>{
  const {s,root,linked,task}=await fixture(t),checkout=registerCheckout(s,linked),id=task('builder');
  const input={checkout:checkout.checkout_id,directory:join(linked,'subdir'),task:id,provider:'claude',session:'missing'};
  assert.throws(()=>bindCheckout(s,input),/verified provider session/);
  bindCheckout(s,{...input,session:'first'});
  renameSync(join(linked,'subdir'),join(linked,'old-subdir'));mkdirSync(join(linked,'subdir'));
  assert.throws(()=>resolveWorkerPath(s,'file.txt'),/working directory was replaced/);
  assert.throws(()=>bindCheckout(s,{...input,session:'first'}),/Role already/);
  assert.equal(readFileSync(join(root,'file.txt'),'utf8'),'original');
});
test('release rejects live/end-marker sessions and active jobs but ignores ended unrelated pidless history',async t=>{
  const {s,root,task,children}=await fixture(t),checkout=registerCheckout(s,root),id=task('builder');
  bindCheckout(s,{checkout:checkout.checkout_id,directory:root,task:id,provider:'claude',session:'first'});
  assert.throws(()=>releaseCheckout(s),/verified retirement/);endSession(s,'first');
  assert.throws(()=>releaseCheckout(s),/verified retirement/,'an end marker does not prove exit');
  const exited=once(children.builder,'exit');children.builder.kill();await exited;
  const at=new Date().toISOString();
  s.run("INSERT INTO jobs(workspace_id,role,kind,command,status,need_mb,cpu_need,margin,pid,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",s.ws,'builder','fixture','[]','running',1,1,1,2147483000,at);
  assert.throws(()=>releaseCheckout(s),/Settle owned jobs/);
  s.run("UPDATE jobs SET status='released' WHERE workspace_id=?",s.ws);
  assert.ok(releaseCheckout(s).released_at);
});
test('release cannot hide another live role process behind the exited bound session',async t=>{
  const {s,root,dir,task,children}=await fixture(t),checkout=registerCheckout(s,root),id=task('builder');
  bindCheckout(s,{checkout:checkout.checkout_id,directory:root,task:id,provider:'claude',session:'first'});
  const firstExit=once(children.builder,'exit');children.builder.kill();await firstExit;
  const child=spawn(process.execPath,[join(dir,'claude.mjs')],{cwd:root,stdio:['ignore','ignore','ignore','ipc']});await once(child,'message');
  children.builder=child;initWorkspace(s,'other');registerSession(s,{provider:'claude',external_id:'other-current',pid:child.pid});s.use('demo');
  assert.throws(()=>releaseCheckout(s),/verified retirement/);
  s.use('other');const ended=endSession(s,'other-current');s.use('demo');
  const hidden=once(child,'message');child.send('hide');await hidden;
  assert.equal(sessionState(s.get('SELECT * FROM sessions WHERE id=?',Number(ended.id.slice(1)))),'unknown');
  assert.doesNotThrow(()=>process.kill(child.pid,0));
  assert.throws(()=>releaseCheckout(s),/verified retirement/,'unknown PID-bearing process remains blocking after an end marker');
  const exit=once(child,'exit');child.kill();await exit;
  assert.ok(releaseCheckout(s).released_at);
});
