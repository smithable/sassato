import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, renameSync, symlinkSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildIndex, findIndex, showIndex } from '../dist/index.js';
import { indexCacheRoot, readSnapshot, snapshotPath, advanceLatest, publish } from '../dist/index-cache.js';
import { probeRepositoryIdentity, repositoryFingerprint } from '../dist/repository-identity.js';

function git(repo,...args) {
  const result=spawnSync('git',['-C',repo,...args],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);return result.stdout.trimEnd();
}
function write(repo,path,content) {mkdirSync(dirname(join(repo,path)),{recursive:true});writeFileSync(join(repo,path),content);}
function commit(repo,title='Fixture change') {git(repo,'add','.');git(repo,'-c','core.hooksPath=/dev/null','commit','-m',title);return git(repo,'rev-parse','HEAD');}
function setup(t) {
  const root=mkdtempSync(join(tmpdir(),'sassato-code-index-')),repo=join(root,'repo'),cache=join(root,'cache');mkdirSync(repo);
  git(repo,'init','-b','main');git(repo,'config','user.name','Fixture');git(repo,'config','user.email','fixture@example.invalid');
  write(repo,'src/timer.ts','export function setTimer(value: number): number { return value + 1; }\nexport const unused = 5;\n');
  write(repo,'src/use.ts',"import { setTimer as schedule } from './timer.js';\nexport function start() { return schedule(3); }\nrun('setTimer');\n");
  write(repo,'src/index.ts',"export { setTimer } from './timer.js';\n");
  write(repo,'src/timer.test.ts',"import { setTimer } from './timer.js';\nsetTimer(1);\n");
  const head=commit(repo,'Initial fixture');
  t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,repo,cache,head,options:{repo,cache,limit:100}};
}
test('full index provides definitions, aliases, imports, module exports and query-only operation hints',t=>{
  const {repo,cache,head,options}=setup(t),built=buildIndex(options);
  assert.equal(built.commit,head);assert.equal(built.analyzed,4);assert.equal(built.files,4);
  const found=showIndex('setTimer',options);assert.equal(found.state,'current');assert.equal(found.fallback,false);
  assert.ok(found.items.some(item=>item.path==='src/timer.ts'&&item.kind==='function'&&item.line===1));
  assert.ok(found.items.some(item=>item.kind==='function'&&item.related_tests.includes('src/timer.test.ts')));
  assert.ok(found.modules.some(module=>module.path==='src'&&module.description.includes('navigation aid')));
  assert.ok(found.items.some(item=>item.path==='src/use.ts'&&item.kind==='use'&&item.line===2));
  assert.ok(found.items.some(item=>item.path==='src/use.ts'&&item.relation.includes('named-reference')));
  const file=showIndex('src/index.ts',options);assert.ok(file.items.some(item=>item.kind==='import'&&item.relation==='src/timer.ts'));
  assert.ok(file.items.some(item=>item.kind==='export'&&item.name==='setTimer'));
  assert.ok(showIndex('src',options).items.some(item=>item.name==='start'));
  assert.equal(buildIndex(options).analyzed,0,'same committed snapshot reuses every file');
  assert.equal(readSnapshot(cache,built.repository,head).files.find(file=>file.path==='src/use.ts').uses.some(use=>use.kind==='named-reference'),false);
});
test('incremental update removes deleted files, handles renames and only analyzes changed blobs',t=>{
  const {repo,options,head}=setup(t);buildIndex(options);
  git(repo,'mv','src/timer.ts','src/clock.ts');rmSync(join(repo,'src/index.ts'));
  write(repo,'src/use.ts',"import { setTimer as schedule } from './clock.js';\nexport function start() { return schedule(4); }\n");
  const next=commit(repo),updated=buildIndex(options,`${head}..HEAD`);
  assert.equal(updated.commit,next);assert.equal(updated.files,3);assert.equal(updated.analyzed,2);assert.equal(updated.reused,1);
  assert.equal(showIndex('src/timer.ts',options).total,0);
  assert.ok(showIndex('setTimer',options).items.some(item=>item.path==='src/clock.ts'));
});
test('dirty view overlays staged, unstaged, untracked, renames and deletions without changing canonical data',t=>{
  const {repo,cache,options,head}=setup(t),built=buildIndex(options);
  write(repo,'src/timer.ts','export function stagedTimer() {}\n');git(repo,'add','src/timer.ts');
  write(repo,'src/timer.ts','export function dirtyTimer() {}\n');
  write(repo,'src/new.ts','export class NewTimer {}\n');
  git(repo,'mv','src/index.ts','src/barrel.ts');rmSync(join(repo,'src/use.ts'));
  const view=findIndex('Timer',options);assert.equal(view.state,'overlay');assert.notEqual(view.view,head);
  assert.ok(view.items.some(item=>item.name==='dirtyTimer'));assert.ok(view.items.some(item=>item.name==='NewTimer'));
  assert.equal(view.items.some(item=>item.name==='stagedTimer'),false);
  assert.equal(showIndex('src/use.ts',options).total,0);assert.ok(showIndex('src/barrel.ts',options).total>0);
  const canonical=readSnapshot(cache,built.repository,head);assert.ok(canonical.files.some(file=>file.path==='src/use.ts'));
  assert.ok(canonical.files.find(file=>file.path==='src/timer.ts').symbols.some(symbol=>symbol.name==='setTimer'));
  write(repo,'src/timer.ts','export function nextDirtyTimer() {}\n');assert.ok(showIndex('nextDirtyTimer',options).items.some(item=>item.kind==='function'));
});
test('divergent linked worktree never overlays latest-main; old or unrelated publishers cannot move latest back',t=>{
  const {root,repo,options,head}=setup(t),initial=buildIndex(options);
  write(repo,'src/main.ts','export function mainOnly() {}\n');const latest=commit(repo);buildIndex(options,`${head}..HEAD`);
  const branch=join(root,'branch');git(repo,'worktree','add','-b','different',branch,head);
  write(branch,'src/branch.ts','export function branchOnly() {}\n');const branchHead=commit(branch);
  const missing=findIndex('Only',{...options,repo:branch});assert.equal(missing.state,'missing');assert.equal(missing.fallback,true);
  assert.equal(missing.items.some(item=>item.name==='mainOnly'),false);assert.ok(missing.items.some(item=>item.name==='branchOnly'));
  const divergent=buildIndex({...options,repo:branch});assert.equal(divergent.latest_advanced,false);
  assert.equal(divergent.repository,initial.repository);assert.notEqual(divergent.checkout,initial.checkout);
  assert.equal(divergent.commit,branchHead);
  const pointer=join(dirname(dirname(initial.path)),'latest.json');assert.equal(JSON.parse(readFileSync(pointer)).commit,latest);
  const old=readSnapshot(options.cache,initial.repository,head);
  assert.equal(advanceLatest(options.cache,old,probeRepositoryIdentity(repo)),false);
  assert.equal(JSON.parse(readFileSync(pointer)).commit,latest);
});
test('missing and corrupted exact-head indexes visibly fall back to current source',t=>{
  const {options}=setup(t);assert.equal(showIndex('setTimer',options).state,'missing');
  const built=buildIndex(options);writeFileSync(built.path,'{not valid json');
  const stale=showIndex('setTimer',options);assert.equal(stale.state,'stale');assert.equal(stale.fallback,true);assert.match(stale.reason,/searching current source/);
  assert.ok(stale.items.some(item=>item.kind==='function'));
  assert.throws(()=>buildIndex(options),/JSON|snapshot|index/i);
});
test('secrets, generated files, symlinks and body literals never enter stored analysis',t=>{
  const {root,repo,options}=setup(t),marker='BODY_MARKER_DO_NOT_PERSIST';
  for(const path of ['.env','node_modules/no.ts','dist/no.ts','src/no.gen.ts','__snapshots__/no.ts','credentials.json'])write(repo,path,'export function excluded() {}\n');
  write(repo,'src/private.ts',`const token = "${'ghp_'+'X'.repeat(36)}"; export function privateThing() {}\n`);
  write(repo,'src/safe.ts',`export function safeName(value: string = 'default-literal') { return '${marker}'; }\n`);
  write(repo,'outside.ts','export function outside() {}\n');symlinkSync(join(repo,'outside.ts'),join(repo,'src','link.ts'));
  commit(repo);const built=buildIndex(options),snapshot=JSON.parse(readFileSync(built.path));
  assert.ok(snapshot.files.every(file=>!file.path.includes('node_modules')&&!file.path.includes('.env')&&!file.path.endsWith('.gen.ts')&&!file.path.includes('link.ts')));
  assert.equal(showIndex('privateThing',options).total,0);
  function inspect(path) {for(const part of readdirSync(path,{withFileTypes:true})){const file=join(path,part.name);if(part.isDirectory())inspect(file);else assert.ok(!readFileSync(file,'utf8').includes(marker));}}
  inspect(options.cache);
  assert.ok(!readFileSync(built.path,'utf8').includes('default-literal'));
  assert.ok(showIndex('safeName',options).items.some(item=>item.signature==='function safeName(value: string)'));
});
test('standalone CLI does not create coordination state; bounded results include snapshot identity',t=>{
  const {root,repo,cache}=setup(t),db=join(root,'must-not-exist.db');
  const run=(...args)=>spawnSync(process.execPath,[resolve('bin/sassato.js'),'index',...args,'--repo',repo,'--cache',cache,'--db',db,'--json'],{encoding:'utf8',timeout:15_000});
  const built=run('build');assert.equal(built.status,0,built.stderr);
  const found=run('find','Timer','--limit','1');assert.equal(found.status,0,found.stderr);const result=JSON.parse(found.stdout);
  assert.equal(result.items.length,1);assert.equal(result.truncated,true);assert.match(result.commit,/^[a-f0-9]{40}$/);assert.equal(existsSync(db),false);
});
test('Git filters and filesystem monitors are never executed by build or dirty queries',t=>{
  const {repo,options}=setup(t);
  write(repo,'.gitattributes','*.ts filter=fixture\n');commit(repo);
  git(repo,'config','filter.fixture.clean','touch filter-ran; cat');git(repo,'config','filter.fixture.process','touch process-ran; false');
  git(repo,'config','core.fsmonitor','touch monitor-ran');
  write(repo,'src/timer.ts','export function changedTimer() {}\n');
  buildIndex(options);assert.ok(showIndex('changedTimer',options).items.some(item=>item.kind==='function'));
  for(const marker of ['filter-ran','process-ran','monitor-ran'])assert.equal(existsSync(join(repo,marker)),false);
});
test('skip-worktree and unmerged indexes fail explicitly instead of presenting partial current views',t=>{
  const {repo,options}=setup(t);buildIndex(options);
  git(repo,'update-index','--skip-worktree','src/timer.ts');
  assert.throws(()=>findIndex('Timer',options),/Sparse|skip-worktree/);
  git(repo,'update-index','--no-skip-worktree','src/timer.ts');
  const blob=git(repo,'rev-parse','HEAD:src/timer.ts');
  const update=spawnSync('git',['-C',repo,'update-index','--index-info'],{input:`0 ${'0'.repeat(40)}\tsrc/timer.ts\n100644 ${blob} 1\tsrc/timer.ts\n100644 ${blob} 2\tsrc/timer.ts\n`,encoding:'utf8'});
  assert.equal(update.status,0,update.stderr);assert.throws(()=>findIndex('Timer',options),/Unmerged/);
});

test('mainline pointer ignores a feature descending from latest, and occupied locks are visible',t=>{
  const {root,repo,options,head}=setup(t),initial=buildIndex(options);
  const branch=join(root,'feature');git(repo,'worktree','add','-b','feature',branch,head);
  write(branch,'feature.ts','export function featureOnly() {}');commit(branch);
  assert.equal(buildIndex({...options,repo:branch}).latest_advanced,false);
  write(repo,'main.ts','export function mainOnly() {}');const next=commit(repo);
  assert.equal(buildIndex(options).latest_advanced,true);
  const dir=dirname(dirname(initial.path)),lock=join(dir,'publish.lock');mkdirSync(lock);
  const locked=buildIndex(options);assert.equal(locked.published,false);assert.equal(locked.latest_advanced,false);assert.match(locked.latest_notice,/owner.json/);
  rmSync(lock,{recursive:true});assert.equal(buildIndex(options).latest_advanced,true);
  writeFileSync(join(dir,'latest.json'),JSON.stringify({commit:'a'.repeat(40)}));
  assert.equal(buildIndex(options).commit,next,'invalid optional pointer cannot fail canonical publication');
});
test('oversized sources and assets remain queryable as explicitly path-only entries',t=>{
  const {repo,options}=setup(t);
  write(repo,'large.js',' '.repeat(3*1024*1024));write(repo,'large.bin',Buffer.alloc(20*1024*1024));commit(repo);buildIndex(options);
  const source=showIndex('large.js',options);assert.ok(source.items.some(item=>item.kind==='file'&&item.relation.includes('analysis size limit')));
  const asset=showIndex('large.bin',options);assert.ok(asset.items.some(item=>item.kind==='file'&&item.relation.includes('not verified')));
  assert.ok(showIndex('setTimer',options).items.some(item=>item.kind==='function'));
});
test('configured symlink roots work, writable roots and poisoned cache subdirectories fail closed',t=>{
  const {root,options}=setup(t),actual=join(root,'actual-cache'),alias=join(root,'cache-alias');mkdirSync(actual,{mode:0o700});symlinkSync(actual,alias);
  assert.equal(buildIndex({...options,cache:alias}).published,true);
  chmodSync(actual,0o777);assert.throws(()=>buildIndex({...options,cache:alias}),/owned|writable/);chmodSync(actual,0o700);
  const built=buildIndex(options),analysis=join(options.cache,'analysis');rmSync(analysis,{recursive:true});symlinkSync(actual,analysis);
  assert.throws(()=>{write(options.repo,'src/new.ts','export function newOne() {}');findIndex('newOne',options);},/symlink/);
  assert.ok(built.commit);
});
test('conditional operation dispatch arguments are discovered without persisting literals',t=>{
  const {repo,options}=setup(t);write(repo,'src/conditional.ts',`run(existing ? "setTimer" : "addTimer", {});`);commit(repo);const built=buildIndex(options);
  assert.ok(showIndex('setTimer',options).items.some(item=>item.path==='src/conditional.ts'&&item.relation.includes('named-reference')));
  assert.equal(JSON.parse(readFileSync(built.path)).files.find(file=>file.path==='src/conditional.ts').uses.some(use=>use.name==='setTimer'),false);
});

test('metadata exceeding the read limit is rejected before immutable publication',t=>{
  const {cache}=setup(t);indexCacheRoot(cache);const path=join(cache,'too-large.json');
  assert.throws(()=>publish(path,{payload:'x'.repeat(64*1024*1024)}),/size limit/);
  assert.equal(existsSync(path),false);
});
