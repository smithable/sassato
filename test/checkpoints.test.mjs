import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store, SCHEMA_VERSION } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import * as c from '../dist/coordination.js';
import * as t from '../dist/tasks.js';
import { requestStop, acknowledgeStop, resumeWork } from '../dist/control.js';
import { setWorkspaceSettings } from '../dist/workspace-settings.js';
import { saveCheckpoint } from '../dist/recovery-write.js';
import { getCheckpoint } from '../dist/checkpoints.js';

function setup(test) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-checkpoints-')), db=join(dir,'state.db');
  const s=new Store(db,'builder',{create:true});initWorkspace(s,'demo');
  test.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  return {s,dir,db};
}
function as(s,actor,fn) {const old=s.actor;s.actor=actor;try{return fn();}finally{s.actor=old;}}
function save(s) {
  return saveCheckpoint(s,{current:'Implement parser; changes in src/parser.ts',next:'Run parser tests',notes:'Keep the public interface; rejected a regex-only parser. Tests not run yet; no open questions.',expected_version:c.getWip(s).version});
}

test('checkpoint atomically updates WIP, preserves history and rejects stale or incomplete writes',test=>{
  const {s}=setup(test),first=save(s);
  assert.equal(first.wip_version,1);assert.equal(c.getWip(s).current,first.current);
  assert.equal(first.saved_at,getCheckpoint(s).saved_at);
  assert.equal(first.saved_at,s.get('SELECT created_at FROM events WHERE id=?',Number(first.id.slice(1))).created_at);
  assert.equal(new Date(first.saved_at).toISOString(),first.saved_at);
  const count=s.get('SELECT count(*) AS n FROM events').n;
  assert.throws(()=>saveCheckpoint(s,{current:'Updated',next:'Test',notes:'Constraints',expected_version:2}),/WIP changed/);
  assert.throws(()=>saveCheckpoint(s,{current:'Updated',next:'Test',expected_version:1}),/notes must be nonempty/);
  assert.throws(()=>saveCheckpoint(s,{current:'Updated',next:'Test',notes:'ghp_'+'A'.repeat(36),expected_version:1}),/Possible secret/);
  assert.equal(s.get('SELECT count(*) AS n FROM events').n,count);
  const second=save(s);assert.equal(second.wip_version,2);
  assert.notEqual(first.id,second.id);assert.equal(getCheckpoint(s).id,second.id);
  assert.equal(s.get("SELECT count(*) AS n FROM events WHERE entity='checkpoint'").n,2);
  assert.equal(s.get('PRAGMA user_version').user_version,SCHEMA_VERSION);
});

test('checkpoint recovery is role/workspace scoped and survives provider session replacement',test=>{
  const {s}=setup(test),saved=save(s);
  c.registerSession(s,{provider:'claude',external_id:'old'});c.endSession(s,'old');
  c.registerSession(s,{provider:'codex',external_id:'new'});c.heartbeat(s,'new');
  assert.equal(getCheckpoint(s).state,'current');
  assert.equal(as(s,'reviewer',()=>getCheckpoint(s)),null);
  assert.equal(as(s,'reviewer',()=>getCheckpoint(s,'builder')).id,saved.id);
  as(s,'reviewer',()=>save(s));assert.equal(getCheckpoint(s).id,saved.id);
  initWorkspace(s,'another');assert.equal(getCheckpoint(s),null);
  s.use('demo');assert.equal(getCheckpoint(s).id,saved.id);
  assert.equal(c.context(s).sections.checkpoint[0].id,saved.id);
});

test('task transitions and WIP edits stale checkpoints',test=>{
  const {s}=setup(test),task=t.addTask(s,{title:'Implement parser'});t.takeTask(s,task.id);save(s);
  t.noteTask(s,task.id,'Parser implemented');assert.equal(getCheckpoint(s).state,'stale');
  save(s);t.doneTask(s,task.id);assert.equal(getCheckpoint(s).state,'stale');
  save(s);assert.equal(getCheckpoint(s).state,'current');
  c.setWip(s,{notes:'A new constraint',expected_version:c.getWip(s).version});assert.equal(getCheckpoint(s).state,'stale');
});

test('mail delivery, reads and acknowledgments change checkpoint freshness',test=>{
  const {s}=setup(test);save(s);
  const mail=as(s,'reviewer',()=>c.send(s,['builder'],'Review this constraint'));
  assert.equal(getCheckpoint(s).state,'stale');save(s);
  c.inbox(s);assert.equal(getCheckpoint(s).state,'stale');save(s);
  c.acknowledge(s,mail.id);assert.equal(getCheckpoint(s).state,'stale');save(s);
});

test('human answers, dependencies and configuration invalidate saved recovery assumptions; unrelated facts do not',test=>{
  const {s}=setup(test),task=t.addTask(s,{title:'Implement parser'});t.takeTask(s,task.id);
  const question=t.askHuman(s,task.id,{question:'Keep interface?'});save(s);
  as(s,'human',()=>t.answerQuestion(s,question.id,'Yes'));
  assert.equal(getCheckpoint(s).state,'stale');save(s);
  as(s,'reviewer',()=>c.setFact(s,'parser-contract',{body:'Preserve interface',source:'src/parser.ts'}));
  assert.equal(getCheckpoint(s).state,'current');
  as(s,'human',()=>setWorkspaceSettings(s,{default_human:'human'}));
  assert.equal(getCheckpoint(s).state,'stale');
  const dep=as(s,'reviewer',()=>t.addTask(s,{title:'Define grammar',owner:'reviewer'}));
  t.addDependency(s,task.id,dep.id);save(s);
  as(s,'reviewer',()=>t.noteTask(s,dep.id,'Grammar changed'));assert.equal(getCheckpoint(s).state,'stale');
});

test('unrelated workspace activity does not invalidate a checkpoint',test=>{
  const {s}=setup(test);save(s);
  as(s,'reviewer',()=>{t.addTask(s,{title:'Other task',owner:'reviewer'});c.send(s,['human'],'Other message');c.setWip(s,{current:'Other work'});});
  assert.equal(getCheckpoint(s).state,'current');
});

test('targeted work dependencies, blockers and questions invalidate checkpoints without ownership',test=>{
  const {s}=setup(test);
  const task=as(s,'reviewer',()=>t.addTask(s,{title:'Work targeted to builder',owner:'reviewer',forRole:'builder'}));
  const dep=as(s,'reviewer',()=>t.addTask(s,{title:'Upstream grammar',owner:'reviewer'}));
  as(s,'reviewer',()=>t.addDependency(s,task.id,dep.id));save(s);
  as(s,'reviewer',()=>t.noteTask(s,dep.id,'Changed grammar'));assert.equal(getCheckpoint(s).state,'stale');save(s);
  const blocker=as(s,'reviewer',()=>t.blockTask(s,task.id,{kind:'external',waitingOn:'deployment',body:'Deployment needed'}));
  assert.equal(getCheckpoint(s).state,'stale');save(s);
  as(s,'reviewer',()=>t.resolveBlocker(s,blocker.id,'Deployment ready'));assert.equal(getCheckpoint(s).state,'stale');save(s);
  const question=as(s,'reviewer',()=>t.askHuman(s,task.id,{question:'Use new grammar?'}));
  assert.equal(getCheckpoint(s).state,'stale');save(s);
  as(s,'human',()=>t.answerQuestion(s,question.id,'Yes'));assert.equal(getCheckpoint(s).state,'stale');
  const visible=c.context(s).sections.checkpoint[0];assert.equal(visible.state,getCheckpoint(s).state);assert.equal(visible.stale,true);
  save(s);const current=c.context(s).sections.checkpoint[0];assert.equal(current.state,getCheckpoint(s).state);assert.equal(current.stale,false);
});

test('unsupported checkpoint format explains recovery and is consistently shown in context',test=>{
  const {s}=setup(test);save(s);
  s.tx(()=>s.event('checkpoint','builder','saved',{format:999,wip:{current:'Legacy recovery',version:1},fingerprint:'unknown'}));
  const shown=getCheckpoint(s);assert.equal(shown.state,'unsupported');assert.match(shown.reasons.join(' '),/format 999 is unsupported/i);
  const visible=c.context(s).sections.checkpoint[0];assert.equal(visible.state,shown.state);assert.equal(visible.stale,true);
});

test('malformed recovery fields are explicit and safe to show',test=>{
  const {s}=setup(test);save(s);
  const detail=JSON.parse(s.get("SELECT detail FROM events WHERE entity='checkpoint' ORDER BY id DESC LIMIT 1").detail);
  s.tx(()=>s.event('checkpoint','builder','saved',{...detail,wip:{current:42,version:-1}}));
  const shown=getCheckpoint(s);assert.equal(shown.state,'stale');assert.equal(shown.current,null);assert.equal(shown.next,null);assert.equal(shown.notes,null);assert.equal(shown.wip_version,null);
  assert.match(shown.reasons.join(' '),/incomplete|malformed|invalid/i);
});

test('old checkpoints require review even when durable state is unchanged',test=>{
  const {s}=setup(test);save(s);
  const clock=Date.now;Date.now=()=>clock()+25*60*60_000;
  try {assert.equal(getCheckpoint(s).state,'stale');assert.match(getCheckpoint(s).reasons.join(' '),/24 hours/);const entry=c.context(s).sections.checkpoint[0];assert.equal(entry.state,getCheckpoint(s).state);assert.equal(entry.stale,true);}
  finally {Date.now=clock;}
});

test('saving recovery under STOP preserves requests and does not acknowledge or resume',test=>{
  const {s}=setup(test);
  const request=as(s,'human',()=>requestStop(s,['builder']))[0];
  save(s);assert.equal(c.context(s).sections.stop[0].acknowledged,false);
  acknowledgeStop(s,request.id);save(s);
  assert.equal(c.context(s).sections.stop[0].acknowledged,true);
  as(s,'human',()=>resumeWork(s,['builder']));
  assert.equal(c.context(s).sections.stop,undefined);
});

test('CLI preserves checkpoint recovery and rejects removed advice syntax',test=>{
  const {db}=setup(test),cli=resolve('bin/sassato.js');
  const run=(args,json=true)=>spawnSync(process.execPath,[cli,'--db',db,'--workspace','demo','--as','builder',...(json?['--json']:[]),...args],{encoding:'utf8',timeout:5000});
  const saved=run(['checkpoint','save','--current','Completed parser','--next','Review API','--notes','Tests passed']);
  assert.equal(saved.status,0,saved.stderr);assert.equal(JSON.parse(saved.stdout).wip_version,1);
  const removed=run(['context','advise']);
  assert.equal(removed.status,2);assert.match(removed.stderr,/Unexpected argument: advise/);assert.equal(removed.stdout,'');
  for(const flag of ['--pressure','--relation','--jobs','--unsaved']) {
    const result=run(['context',flag,'unknown']);assert.equal(result.status,2);assert.match(result.stderr,/Unknown option/);
  }
  assert.doesNotMatch(run(['--help'],false).stdout,/context advise|--pressure|--relation|--jobs|--unsaved/);
  assert.equal(JSON.parse(run(['checkpoint','show']).stdout).current,'Completed parser');
  assert.equal(run(['context','advise','--pressure','90']).status,2);
  assert.equal(run(['context','advise','unexpected']).status,2);
  assert.equal(run(['context','--jobs','idle']).status,2);
  assert.equal(run(['checkpoint','save','--current','Missing fields']).status,2);
  assert.equal(run(['checkpoint','save','--current','x','--next','y','--notes','z','--expect','2']).status,4);
  const brief=run(['context','--brief']);assert.equal(brief.status,0,brief.stderr);
  assert.ok(brief.stdout.length<5800);assert.match(brief.stdout,/checkpoint/);
});

test('a checkpoint behind its role\'s own writes turns stale after thirty minutes or ten changes',test=>{
  const {s}=setup(test);save(s);
  c.send(s,['human'],'Please read PR 4');
  let cp=getCheckpoint(s);assert.equal(cp.own_changes_since,1);assert.equal(cp.state,'current');
  const real=Date.now;Date.now=()=>real()+31*60_000;
  try {
    cp=getCheckpoint(s);assert.equal(cp.state,'stale');assert.match(cp.reasons.join(' '),/1 of your own changes/);
    assert.equal(c.context(s).sections.checkpoint[0].own_changes_since,1);
  } finally {Date.now=real;}
  save(s);assert.equal(getCheckpoint(s).state,'current');assert.equal(getCheckpoint(s).own_changes_since,0);
  for(let i=0;i<10;i++)c.send(s,['human'],`Note ${i}`);
  assert.equal(getCheckpoint(s).state,'stale');
  save(s);as(s,'reviewer',()=>c.send(s,['human'],'Not builder\'s'));c.setWip(s,{current:'Still mine',expected_version:c.getWip(s).version});
  assert.equal(getCheckpoint(s).own_changes_since,0);
});
