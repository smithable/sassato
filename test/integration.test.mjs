import { fixtureConfig } from './fixtures/team.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Store, SCHEMA_VERSION } from '../dist/storage.js';
import { initWorkspace, search } from '../dist/admin.js';
import { addTask } from '../dist/tasks.js';
const bin=resolve('bin/sassato.js');
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-cli-')),db=join(dir,'state.db');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  function raw(args,extra={}) {if(args[0]==='init'&&!args.includes('--config'))args=[...args,'--config',fixtureConfig];return spawnSync(process.execPath,[bin,'--db',db,'--workspace','team','--json',...args],{encoding:'utf8',env:{...process.env,SASSATO_ROLE:'',SASSATO_WORKSPACE:'',SASSATO_DB:''},...extra});}
  function run(args,extra) {const r=raw(args,extra);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
  run(['init']); return {dir,db,raw,run};
}
test('CLI cross-provider work, decisions, receipts and recovery across attached repositories',t=>{
  const {dir,db,run}=fixture(t);
  const engine=join(dir,'engine'),cloud=join(dir,'cloud');mkdirSync(engine);mkdirSync(cloud);
  for(const path of [engine,cloud])run(['workspace','attach',path,'--as','human']);
  run(['role','set','codex','--provider','codex','--as','human']);
  const task=run(['add','Recover OAuth redirect','--as','a','--review-required']);
  assert.equal(run(['take',task.id,'--as','a']).status,'doing');
  const q=run(['ask-human',task.id,'Choose callback host','--options','local|hosted','--recommend','2','--as','a']);
  assert.ok(q.id.startsWith('H'));
  assert.equal(run(['answer',q.id,'2','--as','human']).status,'answered');
  assert.equal(run(['show',task.id]).status,'doing');
  const ctx=run(['context','--as','a']);assert.equal(ctx.counts.inbox_unread,1);
  run(['context','--as','a']);assert.equal(run(['context','--as','a']).counts.inbox_unread,1);
  const msg=run(['inbox','--as','a'])[0];run(['ack',msg.id,'--as','a']);
  run(['submit',task.id,'Fixed; tests passed','--as','a']);
  run(['review',task.id,'--approve','--note','Verified independently','--as','codex']);
  run(['done',task.id,'--ref','demo#12','--as','a']);
  for(const cwd of [engine,cloud]) {
    const r=spawnSync(process.execPath,[bin,'--db',db,'tasks','--status','done','--json'],{cwd,encoding:'utf8',env:{...process.env,SASSATO_WORKSPACE:'',SASSATO_ROLE:''}});
    assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).items[0].id,task.id);
  }
  run(['fact','set','oauth/host','Callback uses hosted domain','--source','docs/auth.md','--as','b']);
  assert.ok(run(['search','hosted','--type','fact']).length);
  assert.ok(run(['search','callback','--type','question']).length);
  const fresh=run(['context','--as','a']);assert.ok(fresh.sections.facts.length);
  assert.equal(statSync(db).mode&0o777,0o600);
});
test('20 competing CLI processes produce exactly one claim and one audit event',async t=>{
  const {db,run}=fixture(t);const task=run(['add','Contested claim','--as','a']);
  const roles=Array.from({length:20},(_,i)=>`worker${i}`);
  // Setup uses the same permission boundary as real callers.
  for(const role of roles)run(['role','set',role,'--provider',role.endsWith('0')?'codex':'claude','--as','human']);
  const results=await Promise.all(roles.map(role=>new Promise((resolveResult,reject)=>{
    const child=spawn(process.execPath,[bin,'take',task.id,'--db',db,'--workspace','team','--as',role,'--json'],{stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',reject);child.on('exit',code=>resolveResult({code,out,err,role}));
  })));
  const winners=results.filter(r=>r.code===0);assert.equal(winners.length,1,JSON.stringify(results));
  assert.ok(results.filter(r=>r.code!==0).every(r=>r.code===4));
  const show=run(['show',task.id]);assert.equal(show.owner,winners[0].role);
  assert.equal(show.history.filter(e=>e.action==='claimed').length,1);
});
test('workspace isolation, version conflicts, errors and literal FTS input',t=>{
  const {run,raw}=fixture(t);const task=run(['add','Alpha OR Beta','--as','a']);
  run(['init','--workspace','other']);
  const foreign=raw(['show',task.id,'--workspace','other']);assert.equal(foreign.status,3);assert.equal(foreign.stdout,'');assert.ok(JSON.parse(foreign.stderr.trim().split('\n').find(line=>line.startsWith('{'))).error);
  assert.deepEqual(run(['search','Alpha','--workspace','other']),[]);
  run(['update',task.id,'--expect','1','--title','Alpha revised','--as','a']);
  assert.equal(raw(['update',task.id,'--expect','1','--title','lost update','--as','a']).status,4);
  assert.deepEqual(run(['search','Alpha OR Beta','--type','task']),[]); // literal words, never query operators
  assert.deepEqual(run(['search','" * : ()']),[]);
  assert.equal(raw(['take',task.id,'--as','b','--dry-run']).status,2);
  assert.equal(run(['show',task.id]).status,'open');
  assert.equal(raw(['take',task.id]).status,3);
  assert.equal(raw(['search','x','--limit','oops']).status,2);
  assert.equal(raw(['bogus']).status,2);
  assert.equal(raw(['add','credential sk-'+'x'.repeat(32),'--as','a']).status,2);
  assert.equal(raw(['add','x','--db','/mnt/c/test.db','--as','a']).status,2);
});
test('backup, restore, migration reopening and immediate transaction search durability',async t=>{
  const {dir,db,run,raw}=fixture(t);
  const task=run(['add','Durable committed state','--as','a']);
  const backup=join(dir,'backup.db'), restored=join(dir,'restored.db');
  run(['backup',backup,'--as','human']);run(['restore',backup,'--db',restored]);
  assert.equal(run(['show',task.id,'--db',restored]).title,'Durable committed state');
  assert.equal(run(['doctor','--db',restored]).ok,true);
  assert.notEqual(raw(['backup',backup,'--as','human']).status,0);
  assert.equal(raw(['restore',backup,'--db',restored]).status,4);
  const s=new Store(db,'a');s.use('team');
  try {
    assert.throws(()=>s.tx(()=>{addTask(s,{title:'Rollback marker'});throw new Error('abort');}));
    assert.deepEqual(search(s,'Rollback marker'),[]);
    assert.ok(search(s,'Durable committed').length);
    assert.throws(()=>s.run('DELETE FROM events WHERE workspace_id=?',s.ws),/append-only/);
    assert.equal(s.get('SELECT count(*) n FROM schema_migrations').n,SCHEMA_VERSION);
  }finally{s.close();}
  const again=new Store(db);again.use('team');assert.equal(again.get('PRAGMA user_version').user_version,SCHEMA_VERSION);again.close();
});
test('human-only command remains inert and context output is bounded',t=>{
  const {run,raw}=fixture(t);const task=run(['add','Human permission required','--human-only','--as','b']);
  assert.equal(raw(['take',task.id,'--as','a']).status,3);
  assert.ok(run(['humans']).some(r=>r.id===task.id));
  const r=raw(['context','--as','b']);assert.equal(r.status,0);assert.ok(r.stdout.length<6100);
});
test('search IDs expand to full records and retain workspace isolation',t=>{
  const {run,raw}=fixture(t);
  const sent=run(['send','b','Detailed message beyond a snippet','--as','a']);
  assert.equal(run(['show',sent.id]).body,'Detailed message beyond a snippet');
  const fact=run(['fact','set','a/key','Shared original fact','--source','fixture','--as','a']);
  assert.equal(run(['show',fact.id]).source,'fixture');
  const event=run(['search','original','--type','event'])[0];assert.ok(run(['show',event.id]).detail);
  run(['init','--workspace','other']);assert.equal(raw(['show',sent.id,'--workspace','other']).status,3);
});

test('role effort and permission settings reach literal provider argv and can be cleared',t=>{
  const {dir,run,raw}=fixture(t);
  const claude=run(['role','set','c','--provider','claude','--model','claude-opus-5-5','--dir',dir,'--effort','high','--permission-mode','acceptEdits','--as','human']);
  assert.equal(claude.reasoning_effort,'high');assert.equal(claude.permission_mode,'acceptEdits');
  let plan=run(['launch','c','--fresh','--dry-run','--no-prompt'])[0];
  assert.deepEqual(plan.args,['--model','claude-opus-5-5','--effort','high','--permission-mode','acceptEdits']);
  const resumed='12345678-1234-1234-1234-123456789abc';
  run(['session','register','--provider','claude','--session-id',resumed,'--as','c']);
  run(['session','end','--session-id',resumed,'--as','c']);
  assert.deepEqual(run(['launch','c','--resume','--dry-run','--no-prompt'])[0].args,['--resume',resumed,...plan.args]);
  assert.equal(raw(['role','set','c','--permission-mode','bypassPermissions','--as','c']).status,3);
  assert.equal(raw(['role','set','c','--effort','high;echo bad','--as','human']).status,2);
  assert.equal(raw(['role','set','c','--sandbox','danger-full-access','--as','human']).status,2);
  run(['role','set','codex','--provider','codex','--dir',dir,'--effort','xhigh','--sandbox','workspace-write','--approval','on-request','--as','human']);
  plan=run(['launch','codex','--dry-run','--no-prompt'])[0];
  assert.deepEqual(plan.args,['--config','model_reasoning_effort="xhigh"','--sandbox','workspace-write','--ask-for-approval','on-request']);
  run(['role','set','codex','--effort','inherit','--sandbox','inherit','--approval','inherit','--as','human']);
  assert.deepEqual(run(['launch','codex','--dry-run','--no-prompt'])[0].args,[]);
  // A manual Codex session participates without registering or using the launcher.
  const mail=run(['send','c','Available later','--as','codex']);
  assert.ok(run(['inbox','--peek','--as','c']).some(m=>m.id===mail.id));
  assert.ok(run(['context','--as','codex']).role==='codex');
});

test('CLI stop waits for a separate agent acknowledgment and preserves stop until human resume',async t=>{
  const {db,run,raw}=fixture(t);
  run(['session','register','--provider','claude','--session-id','manual-session','--as','a']);
  assert.equal(raw(['stop','a','--no-wait','--as','b']).status,3);
  const child=spawn(process.execPath,[bin,'--db',db,'--workspace','team','--json','stop','a','--timeout','5','--as','human'],{stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
  const exited=new Promise(resolveExit=>child.on('close',code=>resolveExit(code)));
  let pending=[];
  for(let i=0;i<30;i++) {
    pending=run(['stop-status','a']);if(pending.length)break;
    await new Promise(resolveDelay=>setTimeout(resolveDelay,50));
  }
  assert.equal(pending.length,1);assert.equal(child.exitCode,null);
  assert.equal(pending[0].state,'waiting');
  assert.match(JSON.stringify(run(['context','--as','a'])),/stopped R\d+/);
  const task=run(['add','Work after resume','--as','a']);
  assert.equal(raw(['take',task.id,'--as','a']).status,4);
  run(['stopped',pending[0].id,'--as','a']);
  assert.equal(await exited,0,err);assert.equal(JSON.parse(out).complete,true);
  assert.equal(raw(['take',task.id,'--as','a']).status,4);
  run(['resume-work','a','--as','human']);
  assert.equal(run(['take',task.id,'--as','a']).status,'doing');
  const timed=raw(['stop','a','--timeout','1','--as','human']);
  assert.equal(timed.status,4,timed.stderr);assert.equal(JSON.parse(timed.stdout).timed_out,true);
  assert.notEqual(run(['stop-status','a'])[0].id,pending[0].id);
  assert.equal(raw(['stopped',pending[0].id,'--as','a']).status,4);
  const forced=raw(['stop','a','--force','--as','human']);
  assert.equal(forced.status,4);assert.ok(JSON.parse(forced.stdout).signals.some(signal=>signal.status==='refused'));
});
