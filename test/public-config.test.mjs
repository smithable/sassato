import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store, SCHEMA_VERSION } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { workspaceSettings, setWorkspaceSettings } from '../dist/workspace-settings.js';
import { setRole } from '../dist/coordination.js';
import { askHuman, askJohan, addTask, humanQueue, johanQueue } from '../dist/tasks.js';
import { previewImport, applyImport, exportMarkdown } from '../dist/migration.js';

const cli=resolve('bin/sassato.js');
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-public-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=join(dir,'state.db');
  const raw=args=>spawnSync(process.execPath,[cli,'--db',db,'--json',...args],{
    cwd:tmpdir(),encoding:'utf8',timeout:5000,env:{...process.env,SASSATO_WORKSPACE:'',SASSATO_ROLE:'',SASSATO_DB:''}
  });
  const run=args=>{const r=raw(args);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  return {dir,db,raw,run};
}
test('config supplies workspace and stable shared/per-role directories regardless of caller cwd',t=>{
  const f=fixture(t),project=join(f.dir,'project'),other=join(project,'other');mkdirSync(project);mkdirSync(other);
  const config=join(project,'sassato.config.json');
  writeFileSync(config,JSON.stringify({workspace:'demo',working_dir:'.',default_human:'alice',import_timezone:'America/New_York',stop_file:'STOP',roles:[
    {name:'builder',provider:'claude'},{name:'reviewer',provider:'codex',working_dir:'other'},
    {name:'alice',kind:'human'},{name:'bob',kind:'human'}
  ]}));
  const preview=f.run(['init','--config',config,'--dry-run']);assert.equal(preview.would_create,true);assert.equal(existsSync(f.db),false);
  f.run(['init','--config',config]);
  const roles=f.run(['roles','--workspace','demo']);
  assert.equal(roles.find(r=>r.name==='builder').working_dir,project);
  assert.equal(roles.find(r=>r.name==='reviewer').working_dir,other);
  assert.ok(roles.every(r=>r.model===null));
  assert.deepEqual(f.run(['workspace','settings','--workspace','demo']),{default_human:'alice',import_timezone:'America/New_York',stop_file:join(project,'STOP')});
  const task=f.run(['add','Choose','--workspace','demo','--as','builder']);
  assert.equal(f.run(['ask-human',task.id,'Ready?','--workspace','demo','--as','builder']).for_role,'alice');
  assert.equal(f.raw(['workspace','set','--default-human','bob','--workspace','demo','--as','builder']).status,3);
  f.run(['workspace','set','--default-human','bob','--stop-file','none','--workspace','demo','--as','alice']);
  assert.equal(f.run(['workspace','settings','--workspace','demo']).default_human,'bob');
  // Repeating init neither replaces roles nor resets runtime configuration.
  assert.equal(f.run(['init','--config',config]).created,false);
  assert.equal(f.run(['workspace','settings','--workspace','demo']).default_human,'bob');
});
test('new defaults are generic, unpinned and independent of a machine-wide stop file',t=>{
  const f=fixture(t);f.run(['init','--workspace','demo']);
  const roles=f.run(['roles','--workspace','demo']);
  assert.deepEqual(roles.map(r=>r.name),['builder','human','reviewer']);
  assert.ok(roles.every(r=>r.model===null&&r.permission_mode===null));
  assert.ok(roles.filter(r=>r.kind==='agent').every(r=>r.working_dir===tmpdir()));
  assert.deepEqual(f.run(['workspace','settings','--workspace','demo']),{default_human:null,import_timezone:'UTC',stop_file:null});
  const help=spawnSync(process.execPath,[cli,'--help'],{encoding:'utf8'});
  assert.doesNotMatch(help.stdout,/johan|smithable|fable|hassist/i);
});
test('invalid config is rejected before creating a database',t=>{
  const f=fixture(t),path=join(f.dir,'config.json');
  for(const change of [{working_dir:'missing'},{import_timezone:'Invalid/Zone'},{default_human:'builder'},{workspace_name:'typo'}]) {
    writeFileSync(path,JSON.stringify({workspace:'demo',...change}));
    assert.notEqual(f.raw(['init','--config',path]).status,0);
    assert.equal(existsSync(f.db),false);
  }
});
test('configured human can be changed but not silently demoted, and names have no special priority',t=>{
  const f=fixture(t),s=new Store(f.db,undefined,{create:true});t.after(()=>s.close());
  initWorkspace(s,'demo',{default_human:'bob',roles:[{name:'worker'},{name:'alice',kind:'human'},{name:'bob',kind:'human'},{name:'johan',kind:'human'}]});
  s.actor='worker';const task=addTask(s,{title:'Question'});assert.equal(askHuman(s,task.id,{question:'Pick'}).for_role,'bob');
  s.actor='alice';assert.throws(()=>setRole(s,'bob',{kind:'agent'}),/default human/);
  setWorkspaceSettings(s,{default_human:null});s.actor='worker';
  assert.throws(()=>askHuman(s,task.id,{question:'Ambiguous'}),/--for NAME/);
  assert.equal(s.get('PRAGMA user_version').user_version,SCHEMA_VERSION);
});
test('imports use arbitrary configured roles/humans and bind timezone changes to confirmation',t=>{
  const f=fixture(t),s=new Store(f.db,undefined,{create:true});t.after(()=>s.close());
  initWorkspace(s,'demo',{default_human:'sam',import_timezone:'America/New_York',roles:[{name:'writer'},{name:'checker',provider:'codex'},{name:'sam',kind:'human'}]});s.actor='sam';
  const backlog=join(f.dir,'backlog.md'),wip=join(f.dir,'wip.md'),sessions=join(f.dir,'sessions.md'),actions=join(f.dir,'actions');mkdirSync(actions);
  writeFileSync(backlog,'## writer\n1. Draft the greeting\n');
  writeFileSync(wip,'- 2026-11-09 10:00 (writer): Current work.\n- checker (2026-11-09 12:00+02:00): Checking.\n');
  writeFileSync(sessions,'codex resume 11111111-2222-3333-4444-555555555555 # role checker\n');
  writeFileSync(join(actions,'decision.md'),'# Choose a greeting\n\nSam: Use hello.\n');
  const input={backlog,wip,sessions,actions},preview=previewImport(s,input);
  assert.equal(preview.items.find(i=>i.kind==='wip'&&i.owner==='writer').sourceUpdatedAt,'2026-11-09T15:00:00.000Z');
  assert.equal(preview.items.find(i=>i.kind==='wip'&&i.owner==='checker').sourceUpdatedAt,'2026-11-09T10:00:00.000Z');
  assert.equal(preview.items.find(i=>i.kind==='session').provider,'codex');
  assert.equal(preview.items.find(i=>i.humanOnly).pendingQuestion,false);
  setWorkspaceSettings(s,{import_timezone:'UTC'});
  assert.throws(()=>applyImport(s,input,preview.digest),/preview changed/);
  const fresh=previewImport(s,input);applyImport(s,input,fresh.digest);
  assert.equal(s.get("SELECT owner FROM tasks WHERE title='Draft the greeting'").owner,'writer');
});
test('legacy database routing, named command aliases and export filename remain usable',t=>{
  const f=fixture(t),s=new Store(f.db,'johan',{create:true});t.after(()=>s.close());
  s.run('INSERT INTO workspaces(name,created_at) VALUES(?,?)','old','2026-01-01T00:00:00.000Z');s.ws=1;s.workspace='old';
  for(const [role,kind] of [['johan','human'],['other','human'],['worker','agent']])s.run('INSERT INTO roles(workspace_id,name,kind) VALUES(?,?,?)',1,role,kind);
  s.event('workspace','old','created',{roles:['johan','other','worker']});
  assert.equal(workspaceSettings(s).default_human,'johan');
  s.actor='worker';const task=addTask(s,{title:'Compatibility'});
  assert.equal(askHuman(s,task.id,{question:'Default?'}).for_role,'johan');
  assert.equal(askJohan(s,task.id,{question:'Named alias?'}).for_role,'johan');
  assert.deepEqual(johanQueue(s),humanQueue(s));
  const out=join(f.dir,'export');exportMarkdown(s,out);assert.match(readFileSync(join(out,'johan.md'),'utf8'),/Compatibility|Default/);
  assert.deepEqual(f.run(['johan','--workspace','old']),f.run(['humans','--workspace','old']));
  // Existing CLI consumers do not need a writable schema migration.
  assert.equal(s.get('PRAGMA user_version').user_version,SCHEMA_VERSION);
});
