// Disposable fixture preload: race after capture, immediately before BEGIN IMMEDIATE.
// It changes only the test database selected by the test CLI, never a real worker.
import { Store } from '../../dist/storage.js';
const original=Store.prototype.tx;
let changed=false;
Store.prototype.tx=function(fn){
  if(!changed && this.ws && this.actor==='builder' && process.argv.includes('ready') && new Error().stack.includes('readyAttended')){
    changed=true;
    const race=process.env.ATTENDED_FIXTURE_TX_RACE;
    const sql={
      generation:'UPDATE managed_workers SET generation=generation+1',
      'worker-tuple':"UPDATE managed_workers SET external_id='changed-before-tx'",
      binding:"UPDATE checkout_bindings SET provider_session_id='changed-before-tx'",
      session:"UPDATE sessions SET external_id='changed-before-tx' WHERE ended_at IS NULL",
    }[race];
    if(!sql)throw new Error('Unknown fixture race');
    this.db.prepare(sql).run();
  }
  return original.call(this,fn);
};
