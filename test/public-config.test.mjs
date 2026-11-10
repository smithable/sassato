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
import { askHuman, addTask, humanQueue } from '../dist/tasks.js';
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
  writeFileSync(config,JSON.stringify({workspace:'demo',working_dir:'.',default_human:'alice',import_timezone:'America/New_York',stop_file:'STOP',import_answer_markers:['Alice answered'],roles:[
    {name:'builder',provider:'claude'},{name:'reviewer',provider:'codex',working_dir:'other'},
    {name:'alice',kind:'human'},{name:'bob',kind:'human'}
  ]}));
  const preview=f.run(['init','--config',config,'--dry-run']);assert.equal(preview.would_create,true);assert.equal(existsSync(f.db),false);
  f.run(['init','--config',config]);
  const roles=f.run(['roles','--workspace','demo']);
  assert.equal(roles.find(r=>r.name==='builder').working_dir,project);
  assert.equal(roles.find(r=>r.name==='reviewer').working_dir,other);
  assert.ok(roles.every(r=>r.model===null));
  assert.deepEqual(f.run(['workspace','settings','--workspace','demo']),{default_human:'alice',import_timezone:'America/New_York',stop_file:join(project,'STOP'),busy_checks:[],import_answer_markers:['Alice answered'],import_role_aliases:{},import_timezone_aliases:{}});
  const task=f.run(['add','Choose','--workspace','demo','--as','builder']);
  assert.equal(f.run(['ask-human',task.id,'Ready?','--workspace','demo','--as','builder']).for_role,'alice');
  assert.equal(f.raw(['workspace','set','--default-human','bob','--workspace','demo','--as','builder']).status,3);
  f.run(['workspace','set','--default-human','bob','--stop-file','none','--workspace','demo','--as','alice']);
  assert.equal(f.run(['workspace','settings','--workspace','demo']).default_human,'bob');
  f.run(['workspace','set','--import-answer-markers','["Bob answered"]','--workspace','demo','--as','bob']);
  assert.deepEqual(f.run(['workspace','settings','--workspace','demo']).import_answer_markers,['Bob answered']);
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
  assert.deepEqual(f.run(['workspace','settings','--workspace','demo']),{default_human:null,import_timezone:'UTC',stop_file:null,busy_checks:[],import_answer_markers:[],import_role_aliases:{},import_timezone_aliases:{}});
  const help=spawnSync(process.execPath,[cli,'--help'],{encoding:'utf8'});
  assert.doesNotMatch(help.stdout,/ask-alice|ask-bob|project-specific-human/i);
});
test('invalid config is rejected before creating a database',t=>{
  const f=fixture(t),path=join(f.dir,'config.json');
  for(const change of [{working_dir:'missing'},{import_timezone:'Invalid/Zone'},{default_human:'builder'},{workspace_name:'typo'},{import_answer_markers:'Answer'},{import_answer_markers:['']},{import_answer_markers:['x'.repeat(201)]},{import_answer_markers:Array(33).fill('Approved')}]) {
    writeFileSync(path,JSON.stringify({workspace:'demo',...change}));
    assert.notEqual(f.raw(['init','--config',path]).status,0);
    assert.equal(existsSync(f.db),false);
  }
});
test('configured human can be changed but not silently demoted, and names have no special priority',t=>{
  const f=fixture(t),s=new Store(f.db,undefined,{create:true});t.after(()=>s.close());
  initWorkspace(s,'demo',{default_human:'bob',roles:[{name:'worker'},{name:'alice',kind:'human'},{name:'bob',kind:'human'},{name:'human',kind:'human'}]});
  s.actor='worker';const task=addTask(s,{title:'Question'});assert.equal(askHuman(s,task.id,{question:'Pick'}).for_role,'bob');
  s.actor='alice';assert.throws(()=>setRole(s,'bob',{kind:'agent'}),/default human/);
  setWorkspaceSettings(s,{default_human:null});s.actor='worker';
  assert.throws(()=>askHuman(s,task.id,{question:'Ambiguous'}),/--for NAME/);
  assert.equal(s.get('PRAGMA user_version').user_version,SCHEMA_VERSION);
});
test('imports use arbitrary configured roles/humans and bind timezone changes to confirmation',t=>{
  const f=fixture(t),s=new Store(f.db,undefined,{create:true});t.after(()=>s.close());
  initWorkspace(s,'demo',{default_human:'sam',import_timezone:'America/New_York',import_answer_markers:['Sam:'],roles:[{name:'writer'},{name:'checker',provider:'codex'},{name:'sam',kind:'human'}]});s.actor='sam';
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
test('legacy databases route through their bootstrap human and export the generic human queue',t=>{
  const f=fixture(t),s=new Store(f.db,'alice',{create:true});t.after(()=>s.close());
  s.run('INSERT INTO workspaces(name,created_at) VALUES(?,?)','old','2026-01-01T00:00:00.000Z');s.ws=1;s.workspace='old';
  for(const [role,kind] of [['alice','human'],['bob','human'],['worker','agent']])s.run('INSERT INTO roles(workspace_id,name,kind) VALUES(?,?,?)',1,role,kind);
  s.event('workspace','old','created',{roles:['alice','bob','worker']});
  assert.equal(workspaceSettings(s).default_human,'alice');
  assert.equal(workspaceSettings(s).stop_file,null);
  assert.equal(workspaceSettings(s).import_timezone,'UTC');
  assert.deepEqual(workspaceSettings(s).import_role_aliases,{});
  assert.deepEqual(workspaceSettings(s).import_timezone_aliases,{});
  s.actor='worker';const task=addTask(s,{title:'Compatibility'});
  assert.equal(askHuman(s,task.id,{question:'Default?'}).for_role,'alice');
  const out=join(f.dir,'export');exportMarkdown(s,out);
  assert.match(readFileSync(join(out,'humans.md'),'utf8'),/Default/);
  assert.equal(existsSync(join(out,'alice.md')),false);
  assert.deepEqual(f.run(['humans','--workspace','old']),humanQueue(s));
  // Existing records remain readable without rewriting their role identities.
  assert.equal(s.get('PRAGMA user_version').user_version,SCHEMA_VERSION);
});

test('answer markers are explicit literal prefixes, and changes invalidate an import preview',t=>{
  const f=fixture(t),s=new Store(f.db,undefined,{create:true});t.after(()=>s.close());
  initWorkspace(s,'demo',{default_human:'alice',roles:[{name:'builder'},{name:'alice',kind:'human'}]});s.actor='alice';
  const actions=join(f.dir,'actions');mkdirSync(actions);
  const records={
    'named.md':"# Decision\n## Alice's answers (2026-11-10)\nUse the first option.\n",
    'prefix.md':'# Decision\n**ALICE ANSWERED:** Yes.\n',
    'other-prefix.md':'# Decision\nAlice answeredness: Unrelated word.\n',
    'literal.md':'# Decision\n[Approved.+]: Yes.\n',
    'regex.md':'# Decision\nApprovedAnything: Not a literal marker.\n',
    'date-only.md':"# Decision\nAlice's answers (2026-11-10)\n## Next section\nNot an answer.\n",
    'pending.md':'# Decision\nAlice answered: TBD\n',
    'generic.md':'# Decision\nAnswer: Keep the generic label.\n'
  };
  for(const [name,body] of Object.entries(records))writeFileSync(join(actions,name),body);
  const before=previewImport(s,{actions});
  assert.deepEqual(before.items.filter(i=>i.answerEvidence).map(i=>i.source),[join(actions,'generic.md')]);
  setWorkspaceSettings(s,{import_answer_markers:["Alice's answers",'Alice answered','[Approved.+]:']});
  assert.throws(()=>applyImport(s,{actions},before.digest),/preview changed/);
  const after=previewImport(s,{actions});
  assert.deepEqual(after.items.filter(i=>i.answerEvidence).map(i=>i.source).sort(),['generic.md','literal.md','named.md','prefix.md'].map(name=>join(actions,name)).sort());
  applyImport(s,{actions},after.digest);
  assert.equal(s.get("SELECT count(*) n FROM questions WHERE status='pending'").n,4);
});

test('import alias configuration validates bounded literal maps and requires human authority',t=>{
  const f=fixture(t);f.run(['init','--workspace','demo']);
  const settings=['workspace','set','--workspace','demo','--as','human'];
  f.run([...settings,'--import-role-aliases','{" Old Writer ":"builder"}','--import-timezone-aliases','{" Local Time ":"America/New_York"}']);
  const configured=f.run(['workspace','settings','--workspace','demo']);
  assert.deepEqual(configured.import_role_aliases,{'old writer':'builder'});
  assert.deepEqual(configured.import_timezone_aliases,{'local time':'America/New_York'});
  for(const [flag,value] of [
    ['import-role-aliases',[]],['import-role-aliases',{' ':'builder'}],['import-role-aliases',{'Old':'builder',' old ':'builder'}],
    ['import-role-aliases',{'line\nbreak':'builder'}],['import-role-aliases',{'tab\tlabel':'builder'}],
    ['import-role-aliases',{'builder':'reviewer'}],['import-role-aliases',{'old':'missing'}],['import-role-aliases',{['x'.repeat(101)]:'builder'}],
    ['import-role-aliases',Object.fromEntries(Array.from({length:33},(_,i)=>['alias'+i,'builder']))],
    ['import-timezone-aliases',[]],['import-timezone-aliases',{'local':'Invalid/Zone'}],['import-timezone-aliases',{'UTC':'America/New_York'}],
    ['import-timezone-aliases',{'+02:00':'UTC'}],['import-timezone-aliases',{'Local':'UTC',' local ':'UTC'}]
  ]) {
    const response=f.raw([...settings,'--'+flag,JSON.stringify(value)]);assert.notEqual(response.status,0,flag+' '+JSON.stringify(value));
  }
  assert.equal(f.raw(['workspace','set','--workspace','demo','--as','builder','--import-role-aliases','{}']).status,3);
  const unchanged=f.run(['workspace','settings','--workspace','demo']);
  assert.deepEqual(unchanged.import_role_aliases,configured.import_role_aliases);
  assert.deepEqual(unchanged.import_timezone_aliases,configured.import_timezone_aliases);
});

test('role aliases are literal and explicit across backlog, WIP and session imports',t=>{
  const f=fixture(t),s=new Store(f.db,'alice',{create:true});t.after(()=>s.close());
  initWorkspace(s,'demo',{roles:[{name:'writer'},{name:'checker'},{name:'hassist'},{name:'alice',kind:'human'}]});
  const backlog=join(f.dir,'backlog.md'),wip=join(f.dir,'wip.md'),sessions=join(f.dir,'sessions.md');
  writeFileSync(backlog,'## human assistant\n1. Unmapped historical author\n## Reviewer[1].+\n1. Literal author\n## Reviewer1anything\n1. Similar spelling\n');
  writeFileSync(wip,'- Reviewer[1].+ (2026-11-10 10:00): Literal work.\n- human assistant (2026-11-10 11:00): Historical work.\n');
  writeFileSync(sessions,'claude --resume literal-session # role Reviewer[1].+\nclaude --resume historical-session # role human assistance\n');
  const input={backlog,wip,sessions},before=previewImport(s,input);
  assert(before.items.every(item=>item.owner===null));assert.equal(before.items.filter(item=>item.kind!=='task').length,0);
  setWorkspaceSettings(s,{import_role_aliases:{'Reviewer[1].+':'checker','human assistant':'hassist','human assistance':'hassist'}});
  const after=previewImport(s,input);
  assert.deepEqual(after.items.filter(item=>item.source===backlog).map(item=>item.owner),['hassist','checker',null]);
  assert.deepEqual(after.items.filter(item=>item.kind==='wip').map(item=>item.owner),['checker','hassist']);
  assert.deepEqual(after.items.filter(item=>item.kind==='session').map(item=>item.owner),['checker','hassist']);
  assert.throws(()=>applyImport(s,input,before.digest),/preview changed/);
  setWorkspaceSettings(s,{import_role_aliases:{'Reviewer[1].+':'writer','human assistant':'hassist','human assistance':'hassist'}});
  assert.throws(()=>applyImport(s,input,after.digest),/preview changed/);
});

test('time zone labels require explicit aliases, retain UTC default, and bind preview timestamps',t=>{
  const f=fixture(t),s=new Store(f.db,'human',{create:true});t.after(()=>s.close());
  initWorkspace(s,'demo',{roles:[{name:'writer'},{name:'checker'},{name:'human',kind:'human'}]});
  const wip=join(f.dir,'wip.md');
  writeFileSync(wip,'- writer (2026-11-10 10:00): No zone.\n- checker (2026-11-10 10:00 local time): Needs explicit alias.\n- checker (2026-11-10 11:00 unknown): Unknown label.\n- checker (stopped, 2026-11-10 12:00 unknown): Unknown stopped label.\n');
  const before=previewImport(s,{wip});assert.equal(before.items.length,1);assert.equal(before.items[0].sourceUpdatedAt,'2026-11-10T10:00:00.000Z');
  setWorkspaceSettings(s,{import_timezone_aliases:{'local time':'America/New_York'}});
  const after=previewImport(s,{wip});assert.equal(after.items.length,2);
  assert.equal(after.items.find(item=>item.owner==='checker').sourceUpdatedAt,'2026-11-10T15:00:00.000Z');
  assert.throws(()=>applyImport(s,{wip},before.digest),/preview changed/);
  setWorkspaceSettings(s,{import_timezone_aliases:{'local time':'UTC'}});
  assert.throws(()=>applyImport(s,{wip},after.digest),/preview changed/);
});

test('complete explicit author aliases take precedence over generic session and role prefixes',t=>{
  const f=fixture(t),s=new Store(f.db,'human',{create:true});t.after(()=>s.close());
  initWorkspace(s,'demo',{roles:[{name:'writer'},{name:'checker'},{name:'human',kind:'human'}],import_role_aliases:{'session writer':'checker','role writer':'checker'}});
  const wip=join(f.dir,'wip.md'),sessions=join(f.dir,'sessions.md');
  writeFileSync(wip,'- session writer (2026-11-10 10:00): Explicit alias.\n');
  assert.equal(previewImport(s,{wip}).items[0].owner,'checker');
  for(const label of ['session writer','role writer']) {
    writeFileSync(sessions,`claude --resume fixture-session # ${label}\n`);
    assert.equal(previewImport(s,{sessions}).items[0].owner,'checker');
  }
  setWorkspaceSettings(s,{import_role_aliases:{}});
  assert.equal(previewImport(s,{wip}).items[0].owner,'writer');
  assert.equal(previewImport(s,{sessions}).items[0].owner,'writer');
});
