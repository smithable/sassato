import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { getWip, setWip, context } from '../dist/coordination.js';
import { addTask, takeTask, noteTask } from '../dist/tasks.js';
import { saveCheckpoint } from '../dist/recovery-write.js';
import { getCheckpoint, checkpointFingerprint } from '../dist/checkpoints.js';
import { observeRepository, validateRecoveryEvidence, inspectRecoveryEvidence } from '../dist/recovery-evidence.js';
import { saveNotificationProgress } from '../dist/notification-progress.js';

function git(directory,...args) {
  const result=spawnSync('git',['-C',directory,...args],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);return result.stdout.trimEnd();
}
function setup(test) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-evidence-')),repo=join(dir,'repo');mkdirSync(repo);
  const s=new Store(join(dir,'state.db'),'builder',{create:true});initWorkspace(s,'demo',{working_dir:repo});
  test.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return {s,dir,repo};
}
function commit(repo) {
  git(repo,'init','-b','main');git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.invalid');
  writeFileSync(join(repo,'example.txt'),'initial\n');git(repo,'add','example.txt');git(repo,'commit','-m','Initial test fixture');
}
const report={version:1,validation:[{command:'npm test',result:'199 tests passed'}],artifacts:['reports/test-results.txt'],jobs:[{id:'build-service',description:'Local development service',state:'running',disposition:'adopt',reference:'service://local/build'}]};

test('repository evidence disables configured clean and process filters in repository attributes',test=>{
  const {s,repo}=setup(test);commit(repo);
  writeFileSync(join(repo,'.gitattributes'),'example.txt filter=fixture\n');
  git(repo,'add','.gitattributes');git(repo,'commit','-m','Attributes fixture');
  git(repo,'config','filter.fixture.clean','touch .filter-ran; cat');
  git(repo,'config','filter.fixture.process','touch .process-ran; false');
  git(repo,'config','filter.fixture.required','true');
  writeFileSync(join(repo,'example.txt'),'changed\n'); // Same byte length forces content/filter comparison.
  const observed=observeRepository(repo);assert.equal(observed.status,'available');assert.equal(observed.dirty,true);
  assert.throws(()=>readFileSync(join(repo,'.filter-ran')));assert.throws(()=>readFileSync(join(repo,'.process-ran')));
  assert.equal(save(s).evidence.observed.repository.status,'available');
  git(repo,'config','--unset','filter.fixture.process');
  git(repo,'status','--porcelain');
  assert.equal(readFileSync(join(repo,'.filter-ran'),'utf8'),'','the fixture would execute its clean filter without suppression');
});

test('filter names that cannot be safely overridden never reach worktree status',test=>{
  const {repo}=setup(test);commit(repo);
  writeFileSync(join(repo,'.gitattributes'),'example.txt filter=odd=name\n');
  git(repo,'add','.gitattributes');git(repo,'commit','-m','Unusual filter fixture');
  git(repo,'config','filter.odd=name.clean','touch .odd-filter-ran; cat');
  writeFileSync(join(repo,'example.txt'),'changed\n');
  const observed=observeRepository(repo);assert.equal(observed.status,'unavailable');
  assert.match(observed.reason,/unsupported names/);
  assert.throws(()=>readFileSync(join(repo,'.odd-filter-ran')));
  git(repo,'status','--porcelain');assert.equal(readFileSync(join(repo,'.odd-filter-ran'),'utf8'),'');
});

test('a role without configured working_dir never captures the caller repository',test=>{
  const {s,repo}=setup(test);commit(repo);
  s.run("UPDATE roles SET working_dir=NULL WHERE workspace_id=? AND name='builder'",s.ws);
  const saved=save(s);assert.equal(saved.evidence.observed.repository.status,'unavailable');
  assert.equal(saved.evidence.observed.repository.directory,null);
  assert.match(saved.evidence.observed.repository.reason,/no configured working_dir/);
  assert.equal(saved.state,'current');
});

test('historical reported text remains readable if a later write guard would reject it',test=>{
  const {s}=setup(test),saved=save(s),evidence=structuredClone(saved.evidence);
  const fakeHistoricalText='ghp_'+'X'.repeat(36); // Constructed fake string for a write-guard regression.
  evidence.reported.artifacts=[fakeHistoricalText];
  assert.throws(()=>validateRecoveryEvidence(evidence.reported),/Possible secret/);
  const read=inspectRecoveryEvidence(evidence);assert.equal(read.malformed,false);
  assert.deepEqual(read.evidence.reported.artifacts,[fakeHistoricalText]);
});
function save(s,evidence=report) {
  return saveCheckpoint(s,{current:'Implemented parser',next:'Check parser constraints before continuing',notes:'Preserve API. A development service is still running.',expected_version:getWip(s).version,evidence});
}

test('checkpoint separates observed Git/task evidence from agent claims and preserves dirty files',test=>{
  const {s,repo}=setup(test);commit(repo);
  const task=addTask(s,{title:'Implement parser'});takeTask(s,task.id);
  writeFileSync(join(repo,'example.txt'),'uncommitted work\n');
  const head=git(repo,'rev-parse','HEAD'),saved=save(s),evidence=saved.evidence;
  assert.equal(saved.format,3);assert.equal(evidence.version,1);
  assert.equal(evidence.observed.repository.directory,repo);assert.equal(evidence.observed.repository.root,repo);
  assert.equal(evidence.observed.repository.status,'available');assert.equal(evidence.observed.repository.head,head);
  assert.equal(evidence.observed.repository.branch,'main');assert.equal(evidence.observed.repository.dirty,true);
  assert.deepEqual(evidence.observed.tasks.items,[{id:task.id,version:s.task(task.id).version,status:'doing',owner:'builder',for_role:null}]);
  assert.deepEqual(evidence.reported,report);assert.equal(evidence.observed.notification_progress,null);
  assert.equal(readFileSync(join(repo,'example.txt'),'utf8'),'uncommitted work\n');assert.equal(git(repo,'rev-parse','HEAD'),head);
  assert.equal(saved.next,'Check parser constraints before continuing');
  assert.ok(JSON.stringify(context(s)).length<=5800);assert.equal(context(s).sections.checkpoint[0].evidence,undefined);
  noteTask(s,task.id,'New discovery');assert.equal(getCheckpoint(s).state,'stale');
});

test('repository observation identifies linked worktrees, detached HEAD and unborn branches',test=>{
  const {dir,repo}=setup(test);commit(repo);
  const linked=join(dir,'linked');git(repo,'worktree','add','-b','feature',linked);
  const worktree=observeRepository(linked);assert.equal(worktree.root,linked);assert.equal(worktree.branch,'feature');
  assert.notEqual(worktree.git_dir,worktree.common_dir);assert.equal(worktree.common_dir,join(repo,'.git'));
  git(linked,'checkout','--detach');const detached=observeRepository(linked);assert.equal(detached.status,'available');assert.equal(detached.branch,null);assert.match(detached.head,/^[0-9a-f]{40}$/);
  const empty=join(dir,'empty');mkdirSync(empty);git(empty,'init','-b','main');
  const unborn=observeRepository(empty);assert.equal(unborn.status,'available');assert.equal(unborn.head,null);assert.equal(unborn.branch,'main');
});

test('nonrepositories and unavailable Git are explicit; showing saved evidence does not run Git',test=>{
  const {s,repo}=setup(test),saved=save(s,undefined);
  assert.equal(saved.evidence.observed.repository.status,'unavailable');assert.equal(saved.evidence.observed.repository.dirty,null);
  const path=process.env.PATH;process.env.PATH='';
  try {
    assert.equal(observeRepository(repo).status,'unavailable');
    assert.deepEqual(getCheckpoint(s).evidence,saved.evidence);
  } finally {process.env.PATH=path;}
});

test('format2 records retain readable content and matching freshness with missing-evidence notices',test=>{
  const {s}=setup(test);
  const wip=setWip(s,{current:'Historical current',next:'Historical next',notes:'Historical validation'});
  s.tx(()=>s.event('checkpoint','builder','saved',{format:2,wip,fingerprint:checkpointFingerprint(s,'builder')}));
  const saved=getCheckpoint(s);assert.equal(saved.format,2);assert.equal(saved.state,'current');assert.equal(saved.current,'Historical current');
  assert.equal(saved.evidence,null);assert.match(saved.missing_evidence.join(' '),/older checkpoint/);
  const upgraded=save(s);assert.equal(upgraded.format,3);assert.equal(s.get("SELECT count(*) AS n FROM events WHERE entity='checkpoint'").n,2);
});

test('missing claims are distinct from explicit empty reports; malformed saved evidence never appears current',test=>{
  const {s}=setup(test);
  const saved=saveCheckpoint(s,{current:'Progress',next:'Verify files',notes:'No structured evidence supplied'});
  assert.equal(saved.evidence.reported,null);assert.match(saved.missing_evidence.join(' '),/not supplied/);
  const empty=save(s,{version:1,validation:[],artifacts:[],jobs:[]});assert.deepEqual(empty.evidence.reported.jobs,[]);
  assert.doesNotMatch(empty.missing_evidence.join(' '),/Agent validation/);
  const detail=JSON.parse(s.get("SELECT detail FROM events WHERE entity='checkpoint' ORDER BY id DESC LIMIT 1").detail);
  s.tx(()=>s.event('checkpoint','builder','saved',{...detail,evidence:{version:1,observed:{},reported:null}}));
  const malformed=getCheckpoint(s);assert.equal(malformed.state,'stale');assert.equal(malformed.current,detail.wip.current);assert.equal(malformed.evidence,null);
});

test('evidence validation rejects oversized, unknown, secret or ambiguous job claims without changing WIP',test=>{
  const {s}=setup(test);save(s);
  const before=getWip(s),events=s.get('SELECT count(*) AS n FROM events').n;
  const bad=[
    {...report,version:2}, {...report,unknown:true}, {...report,jobs:[{...report.jobs[0],disposition:'ignore'}]},
    {...report,jobs:[{...report.jobs[0],state:['running']}]}, {...report,jobs:[report.jobs[0],report.jobs[0]]}, {...report,artifacts:Array(21).fill('reference')},
    {...report,validation:[{command:'x'.repeat(1001),result:'passed'}]},
    {...report,artifacts:['ghp_'+'A'.repeat(36)]}, {...report,validation:Array.from({length:20},()=>({command:'x'.repeat(1000),result:'y'.repeat(2000)}))}
  ];
  for(const input of bad) assert.throws(()=>save(s,input));
  assert.deepEqual(getWip(s),before);assert.equal(s.get('SELECT count(*) AS n FROM events').n,events);
  assert.deepEqual(validateRecoveryEvidence({version:1,validation:[],artifacts:[],jobs:[]}),{version:1,validation:[],artifacts:[],jobs:[]});
});

test('task metadata is bounded and honestly reports truncated active owned or targeted work',test=>{
  const {s}=setup(test);
  for(let i=0;i<105;i++) addTask(s,{title:`Targeted ${i}`,forRole:'builder'});
  const saved=save(s),tasks=saved.evidence.observed.tasks;
  assert.equal(tasks.items.length,100);assert.equal(tasks.total,105);assert.equal(tasks.truncated,true);
  assert.match(saved.missing_evidence.join(' '),/truncated/);
});

test('historical evidence rejects malformed progress identities, times and cursor ordering while retaining recovery text',test=>{
  const {s}=setup(test);
  const progress=saveNotificationProgress(s,{cursor:0,expected_version:0});
  assert.equal(save(s).state,'current');
  const detail=JSON.parse(s.get("SELECT detail FROM events WHERE entity='checkpoint' ORDER BY id DESC LIMIT 1").detail);
  for(const patch of [
    {id:'not-an-event'},{id:'E0'},{id:'E9007199254740992'},
    {role:'bad role'},{role:'reviewer'},{saved_at:'not-a-date'},
    {saved_at:'2026-02-30T00:00:00.000Z'},{cursor:Number(progress.id.slice(1))},
    {id:'E999999',cursor:0}
  ]) {
    const corrupted=structuredClone(detail);Object.assign(corrupted.evidence.observed.notification_progress,patch);
    s.tx(()=>s.event('checkpoint','builder','saved',corrupted));
    const shown=getCheckpoint(s);assert.equal(shown.state,'stale',JSON.stringify(patch));assert.equal(shown.current,detail.wip.current);assert.equal(shown.evidence,null);
  }
  for(const observed_at of ['not-a-date','42','2026-02-30T00:00:00.000Z']) {
    const corrupted=structuredClone(detail);corrupted.evidence.observed.repository.observed_at=observed_at;
    s.tx(()=>s.event('checkpoint','builder','saved',corrupted));
    const shown=getCheckpoint(s);assert.equal(shown.state,'stale');assert.equal(shown.current,detail.wip.current);
  }
});
