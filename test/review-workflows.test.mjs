import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA_VERSION } from '../dist/storage.js';
import { initWorkspace, search } from '../dist/admin.js';
import { workspaceSettings, setWorkspaceSettings } from '../dist/workspace-settings.js';
import { addTask, takeTask, noteTask, updateTask } from '../dist/tasks.js';
import { previewImport, applyImport } from '../dist/migration.js';
import { retitleImportedTasks } from '../dist/retitle.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-review-')),db=join(dir,'state.db');
  let s=new Store(db,'human',{create:true});
  initWorkspace(s,'demo',{roles:[{name:'builder'},{name:'reviewer'},{name:'human',kind:'human'}]});
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,db,get s(){return s;},reopen(){s.close();s=new Store(db,'human');s.use('demo');return s;}};
}

test('historical standard timezone aliases do not break unrelated settings updates',t=>{
  const {s}=fixture(t),before=workspaceSettings(s);
  s.event('workspace','demo','settings-updated',{settings:{...before,import_timezone_aliases:{est:'UTC',cet:'UTC',gmt:'America/New_York','local time':'UTC'}}});
  assert.deepEqual(workspaceSettings(s).import_timezone_aliases,{'local time':'UTC'});
  assert.deepEqual(setWorkspaceSettings(s,{import_answer_markers:['Approved:']}).import_timezone_aliases,{'local time':'UTC'});
  assert.throws(()=>setWorkspaceSettings(s,{import_timezone_aliases:{est:'UTC'}}),/standard zones/);
});

test('housekeeping stays in audit but not search; schema migration removes old search copies',t=>{
  const f=fixture(t);let s=f.s;
  const events=[['session','S1','heartbeat'],['message','M1','read'],['message','M1','done'],['notification-progress','builder','saved']];
  for(const [entity,id,action] of events) {
    const n=s.event(entity,id,action,{marker:'housekeepingquartz'});
    assert.equal(s.get("SELECT 1 FROM documents WHERE type='event' AND entity_id=?",`E${n}`),undefined);
    // Recreate the old index without changing the authoritative audit.
    s.index('event',`E${n}`,'housekeepingquartz','legacy indexed record');
  }
  const task=takeTask(s,addTask(s,{title:'Substantive work'}).id);noteTask(s,task.id,'retainquartznote');
  const before=s.all('SELECT * FROM events ORDER BY id');
  s.db.exec('DROP TABLE jobs; ALTER TABLE messages DROP COLUMN reply; DELETE FROM schema_migrations WHERE version>=6; PRAGMA user_version=5;');
  s=f.reopen();
  assert.equal(s.get('PRAGMA user_version').user_version,SCHEMA_VERSION);
  assert.deepEqual(s.all('SELECT * FROM events ORDER BY id'),before);
  assert.equal(search(s,'housekeepingquartz').length,0);
  assert.ok(search(s,'retainquartznote').length);
  s.db.exec("INSERT INTO search(search) VALUES('integrity-check')");
});

test('retitle previews imported active work by owner and preserves bodies and history',t=>{
  const {s,dir}=fixture(t),backlog=join(dir,'backlog.md');
  writeFileSync(backlog,'## builder\n1. (READY after review (step 2), 2026-11-10) Implement useful parser\n2. (taken, truncated status with no closing parenthesis\n3. (ready, yesterday) Old title to preserve\n## reviewer\n1. (taken, earlier) Other owner work\n');
  const input={backlog};applyImport(s,input,previewImport(s,input).digest);
  s.actor='builder';
  const manual=s.get("SELECT * FROM tasks WHERE body LIKE '%Old title to preserve%'");
  updateTask(s,`T${manual.id}`,{version:manual.version,title:'(API) Revised scope'});
  const proposed=retitleImportedTasks(s);
  assert.equal(proposed.length,1);assert.equal(proposed[0].title,'Implement useful parser');assert.equal(proposed[0].applied,false);
  const old={...s.task(proposed[0].id)};
  assert.throws(()=>retitleImportedTasks(s,{owner:'reviewer',apply:true}),/Only a human/);
  retitleImportedTasks(s,{apply:true});
  const updated=s.task(proposed[0].id);assert.equal(updated.title,'Implement useful parser');assert.equal(updated.body,old.body);assert.equal(updated.status,old.status);assert.equal(updated.version,old.version+1);
  assert.deepEqual(retitleImportedTasks(s),[]);assert.equal(s.task(`T${manual.id}`).title,'(API) Revised scope');
  assert.ok(s.get("SELECT 1 FROM events WHERE entity='task' AND entity_id=? AND action='updated'",proposed[0].id));
});

test('sent CLI shows delivery states and relayed answers retain human authority and typist',t=>{
  const {db}=fixture(t),bin=resolve('bin/sassato.js');
  function raw(args){return spawnSync(process.execPath,[bin,'--db',db,'--workspace','demo',...args],{encoding:'utf8'});}
  function run(args){const r=raw([...args,'--json']);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
  const message=run(['send','reviewer','Please review','--as','builder']);
  assert.match(raw(['sent','--as','builder']).stdout,/reviewer: unread/);
  run(['inbox','--as','reviewer']);assert.match(raw(['sent','--as','builder']).stdout,/reviewer: read/);
  run(['ack',message.id,'--as','reviewer']);assert.match(raw(['sent','--as','builder']).stdout,/reviewer: acked/);
  const task=run(['add','Decision','--as','builder']);
  const question=run(['ask-human',task.id,'Which way?','--as','builder']);
  assert.equal(raw(['answer',question.id,'Yes','--as','builder','--relayed-by','human']).status,3);
  const answer=run(['answer',question.id,'Yes','--as','human','--relayed-by','reviewer']);
  assert.equal(answer.answered_by,'human');assert.equal(answer.relayed_by,'reviewer');
  const audit=new DatabaseSync(db,{readOnly:true});
  try {assert.equal(JSON.parse(audit.prepare("SELECT detail FROM events WHERE entity='question' AND action='answered' ORDER BY id DESC LIMIT 1").get().detail).relayed_by,'reviewer');} finally {audit.close();}
});
