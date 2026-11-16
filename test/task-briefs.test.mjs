import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,unlinkSync,symlinkSync,chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { execFileSync,spawnSync,spawn } from 'node:child_process';
import { once } from 'node:events';
import { registerSession,endSession } from '../dist/coordination.js';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { addTask,takeTask,handoffTask,noteTask,releaseTask } from '../dist/tasks.js';
import { registerCheckout,bindCheckout,currentBinding } from '../dist/checkouts.js';
import { saveTaskBrief,showTaskBrief,pendingBoundHandoff } from '../dist/task-briefs.js';
import { saveNotificationProgress } from '../dist/notification-progress.js';
import { dirtyManifest } from '../dist/dirty-manifest.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const input=()=>({version:1,objective:'Finish the parser',acceptance:['Parser handles all input'],decisions:[{decision:'Preserve the API',source:'task decision'}],open_issues:[],validation:[{command:'node --test parser.test.mjs',result:'Pending'}],artifacts:[],next_action:'Run parser regression',configuration:{digest:hash('fixture settings'),provenance:['fixture/settings.json']},jobs:[]});
async function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-briefs-')),root=join(dir,'checkout');mkdirSync(root);
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git('init','-b','main');for(const path of ['edit.txt','remove.txt','rename.txt'])writeFileSync(join(root,path),'base');
  git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','Initial');
  const db=join(dir,'state.db'),s=new Store(db,'builder',{create:true});initWorkspace(s,'demo');
  const script=join(dir,'claude.mjs');writeFileSync(script,"process.send('ready');setInterval(()=>{},1000);\n");
  const child=spawn(process.execPath,[script],{cwd:root,stdio:['ignore','ignore','ignore','ipc']});await once(child,'message');
  registerSession(s,{provider:'claude',external_id:'fixture-session',pid:child.pid});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}s.close();rmSync(dir,{recursive:true,force:true});});
  const task=addTask(s,{title:'Parser'});takeTask(s,task.id);
  const checkout=registerCheckout(s,root);bindCheckout(s,{checkout:checkout.checkout_id,directory:root,task:task.id,provider:'claude',session:'fixture-session'});
  saveNotificationProgress(s,{cursor:0,expected_version:0});
  return {s,dir,root,db,git,task:task.id};
}
test('immutable bounded brief preserves staged, unstaged, rename, deletion and untracked evidence without contents',async t=>{
  const {s,root,git,task}=await fixture(t);
  writeFileSync(join(root,'edit.txt'),'staged');git('add','edit.txt');const staged=git('rev-parse',':edit.txt').trim();
  writeFileSync(join(root,'edit.txt'),'unstaged');unlinkSync(join(root,'remove.txt'));git('mv','rename.txt','renamed.txt');
  const secret='private fixture body never persisted';writeFileSync(join(root,'untracked.txt'),secret);
  const version=s.task(task).version,brief=saveTaskBrief(s,task,input(),version),observed=brief.body.observed;
  assert.equal(observed.repository.working_dir,root);assert.equal(observed.notification_progress.cursor,0);
  const manifest=observed.dirty_manifest,map=new Map(manifest.map(entry=>[entry.path,entry]));
  assert.ok(map.get('edit.txt').index.some(value=>value.includes(staged)));
  assert.equal(map.get('edit.txt').working,'sha256:'+hash('unstaged'));
  assert.equal(map.get('remove.txt').working,'missing');assert.equal(map.get('rename.txt').working,'missing');
  assert.equal(map.get('renamed.txt').working,'sha256:'+hash('base'));
  assert.equal(map.get('untracked.txt').working,'sha256:'+hash(secret));
  assert.equal(JSON.stringify(brief).includes(secret),false);assert.ok(Buffer.byteLength(JSON.stringify(brief.body))<=32768);
  assert.equal(showTaskBrief(s,task).id,brief.id);
  assert.throws(()=>s.run('UPDATE task_briefs SET digest=? WHERE id=?','changed',brief.id),/immutable/);
  assert.equal(readFileSync(join(root,'edit.txt'),'utf8'),'unstaged');
});
test('pending bound handoff retains ownership and reservation, including on missing or stale evidence',async t=>{
  const {s,task}=await fixture(t),binding=currentBinding(s).id,version=s.task(task).version;
  assert.throws(()=>handoffTask(s,task,'reviewer','Continue'),/brief-file/);
  const intent=pendingBoundHandoff(s,task,'reviewer','Continue',input(),version);
  assert.equal(intent.state,'pending-retirement');assert.equal(s.task(task).owner,'builder');assert.equal(currentBinding(s).id,binding);
  assert.throws(()=>releaseTask(s,task,'Give up'),/Bound work cannot be released/);
  assert.equal(s.task(task).version,version);
  noteTask(s,task,'Requirements changed');assert.throws(()=>saveTaskBrief(s,task,input(),version),/Task changed/);
  assert.equal(showTaskBrief(s,task).id,intent.brief_id);
});
test('manifest rejects hidden index flags, sparse configuration, Git operations and invalid UTF-8 paths',async t=>{
  const {root,git}=await fixture(t);
  for(const flag of ['assume-unchanged','skip-worktree']) {
    git('update-index','--'+flag,'edit.txt');writeFileSync(join(root,'edit.txt'),'hidden work');
    assert.throws(()=>dirtyManifest(root),/index flags/);git('update-index','--no-'+flag,'edit.txt');
  }
  git('config','core.sparseCheckout','true');assert.throws(()=>dirtyManifest(root),/Sparse/);git('config','core.sparseCheckout','false');
  writeFileSync(join(root,'.git','MERGE_HEAD'),git('rev-parse','HEAD'));
  assert.throws(()=>dirtyManifest(root),/In-progress Git/);unlinkSync(join(root,'.git','MERGE_HEAD'));
  const blob=git('rev-parse','HEAD:edit.txt').trim();
  const unmerged=spawnSync('git',['-C',root,'update-index','--index-info'],{input:`0 ${'0'.repeat(40)}\tedit.txt\n100644 ${blob} 1\tedit.txt\n100644 ${blob} 2\tedit.txt\n`,encoding:'utf8'});
  assert.equal(unmerged.status,0,unmerged.stderr);assert.throws(()=>dirtyManifest(root),/Unmerged index/);
  git('update-index','--add','--cacheinfo',`100644,${blob},edit.txt`);
  git('update-index','--add','--cacheinfo',`160000,${git('rev-parse','HEAD').trim()},unsupported-submodule`);
  assert.throws(()=>dirtyManifest(root),/Submodule index/);git('update-index','--force-remove','unsupported-submodule');
  const path=Buffer.concat([Buffer.from(root+'/invalid-'),Buffer.from([255])]);writeFileSync(path,'must never be omitted');
  assert.throws(()=>dirtyManifest(root),/Non-UTF8/);unlinkSync(path);
});
test('large clean indexes do not overflow the dirty-path stage query',async t=>{
  const {root,git}=await fixture(t);
  mkdirSync(join(root,'many'));
  for(let i=0;i<12000;i++)writeFileSync(join(root,'many',String(i).padStart(5,'0')+'-'+('a'.repeat(85))+'.txt'),'same');
  git('add','many');git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-q','-m','Large index');
  writeFileSync(join(root,'edit.txt'),'small edit');
  assert.deepEqual(dirtyManifest(root).map(entry=>entry.path),['edit.txt']);
});
test('Git capture never holds the SQLite writer lock, including pending handoff',async t=>{
  const {s,db,root,dir,task}=await fixture(t),bin=join(dir,'bin');mkdirSync(bin);
  const realGit=execFileSync('which',['git'],{encoding:'utf8'}).trim(),wrapper=join(bin,'git');
  writeFileSync(wrapper,`#!${process.execPath}\nimport {DatabaseSync} from 'node:sqlite';\nimport {spawnSync} from 'node:child_process';\nconst db=new DatabaseSync(${JSON.stringify(db)});db.exec('PRAGMA busy_timeout=20;BEGIN IMMEDIATE;ROLLBACK');db.close();\nconst r=spawnSync(${JSON.stringify(realGit)},process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);\n`);chmodSync(wrapper,0o700);
  const old=process.env.PATH;process.env.PATH=bin+':'+old;
  try {assert.equal(pendingBoundHandoff(s,task,'reviewer','Continue',input(),s.task(task).version).state,'pending-retirement');}
  finally {process.env.PATH=old;}
  assert.equal(readFileSync(join(root,'edit.txt'),'utf8'),'base');
});
test('oversized, unknown jobs and incomplete brief input fail without partial persistence',async t=>{
  const {s,task}=await fixture(t),version=s.task(task).version;
  for(const value of [{...input(),acceptance:[]},{...input(),configuration:undefined},{...input(),jobs:[{id:'tests',state:'unknown',evidence:'Not settled'}]},{...input(),objective:'x'.repeat(32769)},{...input(),extra:'unknown'}]) {
    assert.throws(()=>saveTaskBrief(s,task,value,version));assert.equal(showTaskBrief(s,task),null);
  }
  assert.equal(currentBinding(s).task_id,Number(task.slice(1)));
});
test('manifest rejects symlink parents escaping checkout and does not execute clean filters',async t=>{
  const {root,dir,git}=await fixture(t),outside=join(dir,'outside');mkdirSync(outside);writeFileSync(join(outside,'data'),'outside');
  mkdirSync(join(root,'nested'));writeFileSync(join(root,'nested','data'),'base');git('add','nested/data');
  rmSync(join(root,'nested'),{recursive:true});symlinkSync(outside,join(root,'nested'));
  assert.throws(()=>dirtyManifest(root),/parent escapes/);
  rmSync(join(root,'nested'));mkdirSync(join(root,'nested'));writeFileSync(join(root,'nested','data'),'changed');
  const marker=join(dir,'filter-ran');git('config','filter.danger.clean',`touch ${marker}`);
  writeFileSync(join(root,'.gitattributes'),'*.txt filter=danger\n');writeFileSync(join(root,'edit.txt'),'dirty');
  dirtyManifest(root);
  assert.throws(()=>readFileSync(marker),/ENOENT/);
});
test('CLI registry, path resolution and pending handoff use fixture state only',async t=>{
  const {db,root,dir,task,s}=await fixture(t),cli=resolve('bin/sassato.js'),file=join(dir,'brief.json');writeFileSync(file,JSON.stringify(input()));
  const raw=args=>spawnSync(process.execPath,[cli,'--db',db,'--workspace','demo','--as','builder','--json',...args],{cwd:root,encoding:'utf8',timeout:5000});
  const run=args=>{const r=raw(args);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  assert.equal(run(['checkout','resolve','edit.txt']).path,join(root,'edit.txt'));
  assert.equal(run(['checkout','list']).length,1);
  assert.equal(run(['handoff',task,'reviewer','Continue','--brief-file',file,'--expect',String(s.task(task).version)]).state,'pending-retirement');
  assert.equal(run(['brief','show',task]).body.reported.objective,'Finish the parser');
  assert.equal(raw(['handoff',task,'reviewer','Unsafe']).status,4);assert.equal(s.task(task).owner,'builder');
  assert.equal(raw(['handoff',task,'reviewer','Unsafe','--expect','1']).status,2);
});
