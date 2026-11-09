import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store, SCHEMA_VERSION } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import * as c from '../dist/coordination.js';
import * as t from '../dist/tasks.js';
import { requestStop, acknowledgeStop, resumeWork } from '../dist/control.js';
import { setWorkspaceSettings } from '../dist/workspace-settings.js';
import { saveCheckpoint, getCheckpoint, contextAdvice } from '../dist/context-advice.js';

function setup(test) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-context-advice-')), db=join(dir,'state.db');
  const s=new Store(db,'builder',{create:true});initWorkspace(s,'demo');
  test.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  return {s,dir,db};
}
function as(s,actor,fn) {const old=s.actor;s.actor=actor;try{return fn();}finally{s.actor=old;}}
function save(s) {
  return saveCheckpoint(s,{current:'Implement parser; changes in src/parser.ts',next:'Run parser tests',notes:'Keep the public interface; rejected a regex-only parser. Tests not run yet; no open questions.',expected_version:c.getWip(s).version});
}
const compact={relation:'same',pressure:'high',jobs:'idle'};
const fresh={relation:'unrelated',pressure:'low',jobs:'idle'};

test('checkpoint atomically updates WIP, preserves history and rejects stale or incomplete writes',test=>{
  const {s}=setup(test),first=save(s);
  assert.equal(first.wip_version,1);assert.equal(c.getWip(s).current,first.current);
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

test('advice chooses continue, compact or fresh from explicit reports without mutating state',test=>{
  const {s,db}=setup(test);save(s);
  const before=s.get('SELECT max(id) AS n FROM events').n;
  const reader=new Store(db,'builder',{readonly:true});reader.use('demo');
  try {
    assert.equal(contextAdvice(reader,compact).recommendation,'compact');
    assert.equal(contextAdvice(reader,{...compact,relation:'related'}).recommendation,'compact');
    assert.equal(contextAdvice(reader,fresh).recommendation,'fresh');
    assert.equal(contextAdvice(reader,{...compact,pressure:'low'}).recommendation,'continue');
    const unknown=contextAdvice(reader);assert.equal(unknown.recommendation,'continue');
    assert.deepEqual(unknown.reported,{relation:'unknown',pressure:'unknown',jobs:'unknown',unsaved:false});
    assert.match(unknown.limitations,/No provider telemetry/);
  } finally {reader.close();}
  assert.equal(s.get('SELECT max(id) AS n FROM events').n,before);
});

test('missing checkpoint, unrecorded discoveries and unknown/running jobs defer reset advice',test=>{
  const {s}=setup(test);
  assert.equal(contextAdvice(s,compact).recommendation,'continue');save(s);
  for (const input of [{...compact,unsaved:true},{...compact,jobs:'unknown'},{...fresh,jobs:'running'},{...compact,relation:'unknown'}]) {
    assert.equal(contextAdvice(s,input).recommendation,'continue');
  }
  for (const input of [{relation:'different'},{pressure:'80%'},{jobs:'probably-idle'}]) assert.throws(()=>contextAdvice(s,input),/must be/);
});

test('task transitions and WIP edits stale checkpoints; unfinished work prevents unrelated fresh advice',test=>{
  const {s}=setup(test),task=t.addTask(s,{title:'Implement parser'});t.takeTask(s,task.id);save(s);
  assert.equal(contextAdvice(s,fresh).recommendation,'continue');
  assert.equal(contextAdvice(s,compact).recommendation,'compact');
  t.noteTask(s,task.id,'Parser implemented');assert.equal(getCheckpoint(s).state,'stale');
  save(s);t.doneTask(s,task.id);assert.equal(contextAdvice(s,fresh).recommendation,'continue');
  save(s);assert.equal(contextAdvice(s,fresh).recommendation,'fresh');
  c.setWip(s,{notes:'A new constraint',expected_version:c.getWip(s).version});assert.equal(getCheckpoint(s).state,'stale');
});

test('unread mail prevents reset even when saved; reads and acknowledgments change checkpoint freshness',test=>{
  const {s}=setup(test);save(s);
  const mail=as(s,'reviewer',()=>c.send(s,['builder'],'Review this constraint'));
  assert.equal(getCheckpoint(s).state,'stale');save(s);
  assert.equal(contextAdvice(s,fresh).recommendation,'continue');
  c.inbox(s);assert.equal(getCheckpoint(s).state,'stale');save(s);
  c.acknowledge(s,mail.id);assert.equal(getCheckpoint(s).state,'stale');save(s);
  assert.equal(contextAdvice(s,fresh).recommendation,'fresh');
});

test('human answers, shared facts, dependencies and configuration invalidate saved recovery assumptions',test=>{
  const {s}=setup(test),task=t.addTask(s,{title:'Implement parser'});t.takeTask(s,task.id);
  const question=t.askHuman(s,task.id,{question:'Keep interface?'});save(s);
  as(s,'human',()=>t.answerQuestion(s,question.id,'Yes'));
  assert.equal(getCheckpoint(s).state,'stale');save(s);
  as(s,'reviewer',()=>c.setFact(s,'parser-contract',{body:'Preserve interface',source:'src/parser.ts'}));
  assert.equal(getCheckpoint(s).state,'stale');save(s);
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

test('old checkpoints require review even when durable state is unchanged',test=>{
  const {s}=setup(test);save(s);
  const clock=Date.now;Date.now=()=>clock()+25*60*60_000;
  try {assert.equal(getCheckpoint(s).state,'stale');assert.match(getCheckpoint(s).reasons.join(' '),/24 hours/);assert.equal(contextAdvice(s,compact).recommendation,'continue');}
  finally {Date.now=clock;}
});

test('durable STOP, acknowledged STOP and configured stop files override all reset advice',test=>{
  const {s,dir}=setup(test);save(s);
  const request=as(s,'human',()=>requestStop(s,['builder']))[0];
  assert.equal(contextAdvice(s,fresh).recommendation,'stop');
  save(s);acknowledgeStop(s,request.id);assert.equal(contextAdvice(s,compact).recommendation,'stop');
  as(s,'human',()=>resumeWork(s,['builder']));assert.equal(contextAdvice(s,fresh).recommendation,'fresh');
  const path=join(dir,'STOP');as(s,'human',()=>setWorkspaceSettings(s,{stop_file:path}));save(s);
  writeFileSync(path,'stop');assert.equal(contextAdvice(s,fresh).recommendation,'stop');
});

test('CLI supports checkpoint recovery and readable/JSON advice with strict input validation',test=>{
  const {db}=setup(test),cli=resolve('bin/sassato.js');
  const run=(args,json=true)=>spawnSync(process.execPath,[cli,'--db',db,'--workspace','demo','--as','builder',...(json?['--json']:[]),...args],{encoding:'utf8',timeout:5000});
  const saved=run(['checkpoint','save','--current','Completed parser','--next','Review API','--notes','Tests passed']);
  assert.equal(saved.status,0,saved.stderr);assert.equal(JSON.parse(saved.stdout).wip_version,1);
  const advice=run(['context','advise','--relation','unrelated','--jobs','idle']);
  assert.equal(advice.status,0,advice.stderr);assert.equal(JSON.parse(advice.stdout).recommendation,'fresh');
  assert.match(run(['context','advise','--relation','same','--pressure','high','--jobs','idle'],false).stdout,/Context advice: compact/);
  assert.equal(JSON.parse(run(['checkpoint','show']).stdout).current,'Completed parser');
  assert.equal(run(['context','advise','--pressure','90']).status,2);
  assert.equal(run(['context','advise','unexpected']).status,2);
  assert.equal(run(['context','--jobs','idle']).status,2);
  assert.equal(run(['checkpoint','save','--current','Missing fields']).status,2);
  assert.equal(run(['checkpoint','save','--current','x','--next','y','--notes','z','--expect','2']).status,4);
  const brief=run(['context','--brief']);assert.equal(brief.status,0,brief.stderr);
  assert.ok(brief.stdout.length<5800);assert.match(brief.stdout,/checkpoint/);
});
