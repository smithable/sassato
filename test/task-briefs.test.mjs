import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,unlinkSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { execFileSync,spawnSync } from 'node:child_process';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { addTask,takeTask,handoffTask,noteTask } from '../dist/tasks.js';
import { registerCheckout,bindCheckout,currentBinding } from '../dist/checkouts.js';
import { saveTaskBrief,showTaskBrief,pendingBoundHandoff } from '../dist/task-briefs.js';
import { saveNotificationProgress } from '../dist/notification-progress.js';
import { dirtyManifest } from '../dist/dirty-manifest.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const input=()=>({version:1,objective:'Finish the parser',acceptance:['Parser handles all input'],decisions:[{decision:'Preserve the API',source:'task decision'}],open_issues:[],validation:[{command:'node --test parser.test.mjs',result:'Pending'}],artifacts:[],next_action:'Run parser regression',configuration:{digest:hash('fixture settings'),provenance:['fixture/settings.json']},jobs:[]});
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-briefs-')),root=join(dir,'checkout');mkdirSync(root);
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git('init','-b','main');for(const path of ['edit.txt','remove.txt','rename.txt'])writeFileSync(join(root,path),'base');
  git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','Initial');
  const db=join(dir,'state.db'),s=new Store(db,'builder',{create:true});initWorkspace(s,'demo');
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  const task=addTask(s,{title:'Parser'});takeTask(s,task.id);
  const checkout=registerCheckout(s,root);bindCheckout(s,{checkout:checkout.checkout_id,directory:root,task:task.id,provider:'claude',session:'fixture-session'});
  saveNotificationProgress(s,{cursor:0,expected_version:0});
  return {s,dir,root,db,git,task:task.id};
}
test('immutable bounded brief preserves staged, unstaged, rename, deletion and untracked evidence without contents',t=>{
  const {s,root,git,task}=fixture(t);
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
test('pending bound handoff retains ownership and reservation, including on missing or stale evidence',t=>{
  const {s,task}=fixture(t),binding=currentBinding(s).id,version=s.task(task).version;
  assert.throws(()=>handoffTask(s,task,'reviewer','Continue'),/brief-file/);
  const intent=pendingBoundHandoff(s,task,'reviewer','Continue',input(),version);
  assert.equal(intent.state,'pending-retirement');assert.equal(s.task(task).owner,'builder');assert.equal(currentBinding(s).id,binding);
  assert.equal(s.task(task).version,version);
  noteTask(s,task,'Requirements changed');assert.throws(()=>saveTaskBrief(s,task,input(),version),/Task changed/);
  assert.equal(showTaskBrief(s,task).id,intent.brief_id);
});
test('oversized, unknown jobs and incomplete brief input fail without partial persistence',t=>{
  const {s,task}=fixture(t),version=s.task(task).version;
  for(const value of [{...input(),acceptance:[]},{...input(),configuration:undefined},{...input(),jobs:[{id:'tests',state:'unknown',evidence:'Not settled'}]},{...input(),objective:'x'.repeat(32769)},{...input(),extra:'unknown'}]) {
    assert.throws(()=>saveTaskBrief(s,task,value,version));assert.equal(showTaskBrief(s,task),null);
  }
  assert.equal(currentBinding(s).task_id,Number(task.slice(1)));
});
test('manifest rejects symlink parents escaping checkout and does not execute clean filters',t=>{
  const {root,dir,git}=fixture(t),outside=join(dir,'outside');mkdirSync(outside);writeFileSync(join(outside,'data'),'outside');
  mkdirSync(join(root,'nested'));writeFileSync(join(root,'nested','data'),'base');git('add','nested/data');
  rmSync(join(root,'nested'),{recursive:true});symlinkSync(outside,join(root,'nested'));
  assert.throws(()=>dirtyManifest(root),/parent escapes/);
  rmSync(join(root,'nested'));mkdirSync(join(root,'nested'));writeFileSync(join(root,'nested','data'),'changed');
  const marker=join(dir,'filter-ran');git('config','filter.danger.clean',`touch ${marker}`);
  writeFileSync(join(root,'.gitattributes'),'*.txt filter=danger\n');writeFileSync(join(root,'edit.txt'),'dirty');
  dirtyManifest(root);
  assert.throws(()=>readFileSync(marker),/ENOENT/);
});
test('CLI registry, path resolution and pending handoff use fixture state only',t=>{
  const {db,root,dir,task,s}=fixture(t),cli=resolve('bin/sassato.js'),file=join(dir,'brief.json');writeFileSync(file,JSON.stringify(input()));
  const raw=args=>spawnSync(process.execPath,[cli,'--db',db,'--workspace','demo','--as','builder','--json',...args],{cwd:root,encoding:'utf8',timeout:5000});
  const run=args=>{const r=raw(args);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  assert.equal(run(['checkout','resolve','edit.txt']).path,join(root,'edit.txt'));
  assert.equal(run(['checkout','list']).length,1);
  assert.equal(run(['handoff',task,'reviewer','Continue','--brief-file',file,'--expect',String(s.task(task).version)]).state,'pending-retirement');
  assert.equal(run(['brief','show',task]).body.reported.objective,'Finish the parser');
  assert.equal(raw(['handoff',task,'reviewer','Unsafe']).status,4);assert.equal(s.task(task).owner,'builder');
});
