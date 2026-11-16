import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { addTask,takeTask,noteTask } from '../dist/tasks.js';
import { workerTokenHash } from '../dist/managed-generation.js';

const token='fixture-worker-'.repeat(4);
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-generation-')),db=join(dir,'state.db');
  const admin=new Store(db,'human',{create:true});initWorkspace(admin,'demo');admin.actor='builder';
  const task=addTask(admin,{title:'Owned work'}).id;takeTask(admin,task);admin.actor='human';
  const at=new Date().toISOString();
  admin.run('INSERT INTO managed_controllers VALUES(?,?,?,?,?,?,?)','controller',admin.ws,'reviewer',join(dir,'controller.lock'),null,null,at);
  // This models the write fence only; it is not a provider launch or handoff proof.
  admin.run('INSERT INTO managed_workers VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)','worker',admin.ws,'builder','controller',null,1,workerTokenHash(token),'running','claude',null,null,null,'0'.repeat(64),at);
  const connections=[];
  const worker=(generation='1',secret=token,mode='normal')=>{
    const s=new Store(db,'builder',{managedCredentials:{generation,token:secret},managedWriteMode:mode});s.use('demo');connections.push(s);return s;
  };
  t.after(()=>{connections.forEach(s=>s.close());admin.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,db,admin,task,worker};
}
test('every managed legacy write requires current generation and token; unmanaged roles remain compatible',t=>{
  const {admin,task,worker}=fixture(t),valid=worker();
  noteTask(valid,task,'Current worker writes');
  for(const s of [worker('',''),worker('2'),worker('1','wrong-token-value'.repeat(3))]) {
    assert.throws(()=>noteTask(s,task,'Must not commit'),/generation|authentication/);
  }
  assert.equal(admin.get("SELECT count(*) n FROM events WHERE entity_id=? AND action='note'",task).n,1);
  admin.actor='reviewer';assert.ok(addTask(admin,{title:'Unmanaged compatibility'}).id);
});
test('stale connections, direct run and writes inside read snapshots cannot bypass the fence',t=>{
  const {admin,task,worker}=fixture(t),old=worker();
  admin.run('UPDATE managed_workers SET generation=2,token_hash=? WHERE id=?',workerTokenHash('new-fixture-token'.repeat(3)),'worker');
  assert.throws(()=>noteTask(old,task,'Old generation'),/generation/);
  assert.throws(()=>old.run('UPDATE tasks SET title=? WHERE id=?','Bypass',Number(task.slice(1))),/generation/);
  assert.throws(()=>old.snapshot(()=>old.run('UPDATE tasks SET title=? WHERE id=?','Snapshot bypass',Number(task.slice(1)))),/generation/);
  assert.equal(admin.task(task).title,'Owned work');
});
test('changing workspace or actor inside a transaction rechecks managed authority',t=>{
  const {admin,task}=fixture(t);
  assert.throws(()=>admin.tx(()=>{admin.actor='builder';admin.run('UPDATE tasks SET title=? WHERE id=?','Bypass',Number(task.slice(1)));}),/generation/);
  admin.actor='human';assert.equal(admin.task(task).title,'Owned work');
});
test('frozen generations reject normal writes while narrow reconciliation and stop acknowledgments are distinct',t=>{
  const {admin,task,worker}=fixture(t),normal=worker();
  admin.run("UPDATE managed_workers SET state='ready' WHERE id='worker'");
  assert.throws(()=>noteTask(normal,task,'Frozen write'),/frozen/);
  assert.throws(()=>noteTask(worker('1',token,'reconcile'),task,'Not reconciling'),/frozen/);
  admin.run("UPDATE managed_workers SET state='reconciling' WHERE id='worker'");
  assert.throws(()=>noteTask(normal,task,'Before acknowledgment'),/frozen/);
  // Only the dedicated reconcile handler receives this internal Store mode.
  assert.doesNotThrow(()=>worker('1',token,'reconcile').tx(()=>{}));
});
test('legacy CLI mutations cannot omit generation credentials; reads and unmanaged commands still work',t=>{
  const {db,task}=fixture(t),cli=resolve('bin/sassato.js');
  const run=(args,credentials={})=>spawnSync(process.execPath,[cli,'--db',db,'--workspace','demo','--as','builder','--json',...args],{encoding:'utf8',env:{...process.env,SASSATO_WORKER_GENERATION:'',SASSATO_WORKER_TOKEN:'',...credentials},timeout:5000});
  assert.equal(run(['show',task]).status,0);
  assert.equal(run(['note',task,'Missing credentials']).status,4);
  const good=run(['note',task,'Current credentials'],{SASSATO_WORKER_GENERATION:'1',SASSATO_WORKER_TOKEN:token});assert.equal(good.status,0,good.stderr);
  assert.equal(good.stdout.includes(token),false);
});
