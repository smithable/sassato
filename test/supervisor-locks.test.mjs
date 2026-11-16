import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,renameSync,writeFileSync,readFileSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireSupervisorLock,requireSupervisorLease } from '../dist/supervisor-locks.js';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'sassato-maintenance-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
test('shared job leases exclude lifecycle work until every job releases',t=>{
  const dir=fixture(t),path=join(dir,'maintenance.lock'),first=acquireSupervisorLock(path,'shared'),second=acquireSupervisorLock(path,'shared');
  t.after(()=>{first.close();second.close();});
  assert.throws(()=>acquireSupervisorLock(path,'exclusive'),/busy/);
  first.close();assert.throws(()=>acquireSupervisorLock(path,'exclusive'),/busy/);
  second.close();const lifecycle=acquireSupervisorLock(path,'exclusive');t.after(()=>lifecycle.close());
  assert.throws(()=>acquireSupervisorLock(path,'shared'),/busy/);requireSupervisorLease(lifecycle,'exclusive');
  assert.throws(()=>requireSupervisorLease(first,'shared'),/current supervisor lock lease/);
});
test('the lock survives its acquisition helper exit and excludes an independent process',t=>{
  const path=join(fixture(t),'controller.lock'),lease=acquireSupervisorLock(path,'exclusive');t.after(()=>lease.close());
  const attempt=()=>spawnSync('flock',['--exclusive','--nonblock','--conflict-exit-code','75',path,'true'],{encoding:'utf8'});
  assert.equal(attempt().status,75);lease.close();assert.equal(attempt().status,0);
});
test('replaced lock paths and symlinks fail closed without truncating existing files',t=>{
  const dir=fixture(t),path=join(dir,'controller.lock');writeFileSync(path,'preserved');
  const lease=acquireSupervisorLock(path,'exclusive');t.after(()=>lease.close());
  assert.equal(readFileSync(path,'utf8'),'preserved');
  renameSync(path,path+'.old');writeFileSync(path,'replacement');assert.throws(()=>lease.assertHeld(),/identity changed/);
  const link=join(dir,'alias');symlinkSync(path,link);assert.throws(()=>acquireSupervisorLock(link,'exclusive'));
});
