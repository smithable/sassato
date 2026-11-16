import { performance } from 'node:perf_hooks';
import type { Store,Row } from './storage.js';
import { check,now } from './errors.js';
import { workerTokenHash } from './managed-generation.js';
import { processIdentity } from './coordination.js';
import { activeStop } from './control.js';

/** Executed by an owned fixture child before any provider behavior is possible. */
export async function registerFixtureBootstrap(s:Store,transitionId:string,launchToken:string):Promise<{released:boolean;reason?:string;context?:Row}> {
  const start=processIdentity(process.pid);check(start,'Bootstrap PID identity is unavailable',4);
  const registered=s.tx(()=>{
    const row=s.get('SELECT t.*,w.role,w.context,w.generation AS worker_generation FROM managed_transitions t JOIN managed_workers w ON w.id=t.worker_id WHERE t.id=? AND w.workspace_id=? AND w.role=?',transitionId,s.ws,s.requireActor());
    check(row && row.state==='starting' && row.generation===row.worker_generation && row.launch_token_hash===workerTokenHash(launchToken),'Bootstrap intent/token/generation is not current',4);
    const payload=JSON.parse(row.payload);check(payload.context.evidence_kind==='fixture-only','Real provider bootstrap remains disabled',4);
    check(!row.bootstrap_pid || row.bootstrap_pid===process.pid && row.bootstrap_start===start,'Another bootstrap already registered; do not duplicate it',4);
    check(!activeStop(s,[s.requireActor()]),'STOP prevents bootstrap registration',4);
    s.run('UPDATE managed_transitions SET bootstrap_pid=?,bootstrap_start=?,updated_at=? WHERE id=?',process.pid,start,now(),transitionId);
    s.event('managed-transition',transitionId,'bootstrap-registered',{generation:row.generation,pid:process.pid,process_start:start,evidence_kind:'fixture-only'});
    return {generation:row.generation,payload};
  });
  const deadline=performance.now()+Math.max(0,Math.min(120000,Date.parse(registered.payload.bootstrap_deadline)-Date.now()));
  for(;;) {
    const row=s.get('SELECT t.*,w.generation AS worker_generation FROM managed_transitions t JOIN managed_workers w ON w.id=t.worker_id WHERE t.id=? AND w.workspace_id=? AND w.role=?',transitionId,s.ws,s.requireActor());
    if(!row || row.worker_generation!==registered.generation || row.launch_token_hash!==workerTokenHash(launchToken))return {released:false,reason:'Intent was superseded'};
    if(activeStop(s,[s.requireActor()]))return {released:false,reason:'STOP prevents bootstrap release'};
    if(['blocked','stopped'].includes(row.state))return {released:false,reason:'Intent was cancelled or blocked'};
    if(row.bootstrap_released_at && row.state==='reconciling')return {released:true,context:registered.payload.context};
    if(performance.now()>=deadline)return {released:false,reason:'Unreleased bootstrap deadline elapsed'};
    await new Promise(resolve=>setTimeout(resolve,50));
  }
}
