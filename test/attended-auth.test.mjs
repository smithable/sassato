import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { workerTokenHash } from '../dist/managed-generation.js';
import { processIdentity } from '../dist/coordination.js';
import { attendedAssignment } from '../dist/attended.js';

const token='ancestry-fixture-'.repeat(4);
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-ancestry-auth-')),db=join(dir,'state.db');
  const admin=new Store(db,'human',{create:true});initWorkspace(admin,'demo');
  const at=new Date().toISOString();
  admin.run('INSERT INTO managed_controllers VALUES(?,?,?,?,?,?,?)','controller',admin.ws,'reviewer',join(dir,'controller.lock'),null,null,at);
  admin.event('attended-enrollment','builder','configured',{role:'builder',controller_role:'reviewer',task:'T1',stop_file:null,busy_checks:[]});
  const context=JSON.stringify({evidence_kind:'cooperative-attended',configuration:{},notification_progress:{cursor:0}});
  admin.run('INSERT INTO managed_workers(id,workspace_id,role,controller_id,generation,token_hash,state,provider,pid,process_start,configuration_digest,updated_at,context) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)','worker',admin.ws,'builder','controller',1,workerTokenHash(token),'running','codex',process.pid,processIdentity(process.pid),'0'.repeat(64),at,context);
  admin.run('INSERT INTO managed_transitions(id,worker_id,generation,idempotency_key,state,expected_task_versions,created_at,updated_at,payload) VALUES(?,?,?,?,?,?,?,?,?)','transition','worker',1,'fixture','complete','[]',at,at,'{}');
  const connections=[];
  const connect=(generation='1',secret=token)=>{const s=new Store(db,'builder',{readonly:true,managedCredentials:{generation,token:secret}});s.use('demo');connections.push(s);return s;};
  t.after(()=>{connections.forEach(s=>s.close());admin.close();rmSync(dir,{recursive:true,force:true});});
  return {admin,connect};
}
test('assignment reads authenticate captured credentials and freeze stale generations',t=>{
  const {admin,connect}=fixture(t);
  assert.equal(attendedAssignment(connect()).worker_id,'worker');
  for(const s of [connect('',''),connect('2'),connect('1','wrong-token-'.repeat(4))])assert.throws(()=>attendedAssignment(s),/generation|authentication/);
  const stale=connect();admin.run('UPDATE managed_workers SET generation=2 WHERE id=?','worker');
  admin.run('UPDATE managed_transitions SET generation=2 WHERE id=?','transition');
  assert.throws(()=>attendedAssignment(stale),/generation/);
});
test('an outsider with copied credentials and the same UID and group cannot read assignment',async t=>{
  const {admin,connect}=fixture(t);
  const child=spawn(process.execPath,['-e',"process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
  await once(child,'message');
  try{
    admin.run('UPDATE managed_workers SET pid=?,process_start=? WHERE id=?',child.pid,processIdentity(child.pid),'worker');
    assert.throws(()=>attendedAssignment(connect()),/proven live ancestry/);
    const exit=once(child,'exit');child.kill();await exit;
    assert.throws(()=>attendedAssignment(connect()),/proven live ancestry/);
  }finally{if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill();await exit;}}
});
