// Fixture-only reconciliation/readiness helpers. These are not production provider adapters.
import { randomUUID } from 'node:crypto';
import type { Store,Row } from './storage.js';
import { check,now } from './errors.js';
import { activeStop } from './control.js';
import * as coordination from './coordination.js';
import { bindCheckout,currentBinding } from './checkouts.js';
import { getCheckpoint,checkpointFingerprint,CHECKPOINT_FORMAT } from './checkpoints.js';
import { getNotificationProgress } from './notification-progress.js';
import { observeTasks,validateRecoveryEvidence,MAX_CHECKPOINT_BYTES } from './recovery-evidence.js';
import { validateBriefInput } from './task-briefs.js';
import { captureSupervisorSnapshot,assertSupervisorSnapshot,assertSupervisorReservation,supervisorDigest } from './supervisor-snapshot.js';
import { positivelyGone } from './supervisor-monitor.js';

function ownTransition(s:Store,id:string):{worker:Row;transition:Row;payload:Row} {
  const transition=s.get('SELECT * FROM managed_transitions WHERE id=?',id);check(transition,'Transition is missing',3);
  const worker=s.get('SELECT * FROM managed_workers WHERE workspace_id=? AND role=? AND id=?',s.ws,s.requireActor(),transition.worker_id);
  check(worker && worker.generation===transition.generation,'Transition does not belong to this generation',4);
  const payload=JSON.parse(transition.payload);check(payload.context.evidence_kind==='fixture-only','Real provider reconciliation is disabled',4);
  check(worker.pid===process.pid && worker.process_start===coordination.processIdentity(process.pid),'Only the recorded fixture process may reconcile its generation',3);
  return {worker,transition,payload};
}
function saveObservedFixtureCheckpoint(s:Store,snapshot:Row,wip:Row,reported:unknown):void {
  const repository={status:'available',observed_at:now(),directory:snapshot.working_dir,root:snapshot.identity.checkout_root,git_dir:snapshot.identity.git_dir,common_dir:snapshot.identity.git_common_dir,branch:snapshot.identity.branch,head:snapshot.identity.head,dirty:snapshot.manifest.length>0,reason:null};
  const detail={format:CHECKPOINT_FORMAT,wip,fingerprint:checkpointFingerprint(s,s.requireActor()),evidence:{version:1,observed:{repository,tasks:observeTasks(s,s.requireActor()),notification_progress:getNotificationProgress(s)},reported}};
  check(Buffer.byteLength(JSON.stringify(detail))<=MAX_CHECKPOINT_BYTES,'Complete fixture checkpoint exceeds its bound');
  s.event('checkpoint',s.requireActor(),'saved',detail);
}
export function acknowledgeFixtureRecovery(s:Store,id:string,externalId:string):Row {
  const {worker,transition,payload}=ownTransition(s,id);
  check(worker.state==='reconciling' && transition.state==='reconciling' && transition.bootstrap_released_at,'Bootstrap has not been released for reconciliation',4);
  check(externalId!==worker.external_id,'A fresh conversation identity is required',4);
  assertSupervisorSnapshot(s,worker.role,payload.context);
  check(!activeStop(s,[worker.role]),'STOP prevents recovery acknowledgment',4);
  const context=coordination.context(s),checkpoint=getCheckpoint(s),mail=coordination.inbox(s,{peek:true,limit:100}),wip=coordination.getWip(s);
  check(Number(s.get("SELECT count(*) n FROM receipts WHERE workspace_id=? AND recipient=? AND state!='done'",s.ws,worker.role)!.n)<=100,'Reconcile the pending inbox before managed recovery',4);
  const records=payload.context.task_versions.map((task:Row)=>s.task(`T${task.id}`));
  return s.tx(()=>{
    const fresh=ownTransition(s,id);check(fresh.worker.state==='reconciling' && !activeStop(s,[worker.role]),'Recovery state or STOP changed',4);
    assertSupervisorReservation(s,worker.role,payload.context);
    const session=coordination.registerSession(s,{provider:worker.provider,external_id:externalId,pid:process.pid,replace:true});
    let binding:Row;
    if(worker.binding_id) {
      binding=currentBinding(s,payload.context.task_id);
      check(binding.id===worker.binding_id && binding.checkout_id===payload.context.checkout_id,'Checkout reservation changed',4);
      s.run('UPDATE checkout_bindings SET provider_session_id=?,session_row_id=? WHERE id=?',externalId,Number(session.id.slice(1)),binding.id);
    } else binding=bindCheckout(s,{checkout:payload.context.checkout_id,directory:payload.context.working_dir,task:payload.context.task_id,provider:worker.provider,session:externalId});
    const at=now();s.run("UPDATE managed_workers SET binding_id=?,external_id=?,state='running',updated_at=? WHERE id=?",binding.id,externalId,at,worker.id);
    s.run("UPDATE managed_transitions SET state='complete',updated_at=? WHERE id=?",at,id);
    const recoveredWip=coordination.setWip(s,{current:wip.current||s.task(payload.context.task_id).title,next:wip.next||'Read the assigned task and continue in the verified checkout.',notes:wip.notes||`Fixture-only generation ${worker.generation}; initial context, inbox, task records, configuration, dirty files and handled cursor verified. Real provider management remains disabled.`,expected_version:wip.version});
    saveObservedFixtureCheckpoint(s,payload.context,recoveredWip,checkpoint?.evidence?.reported??null);
    s.event('managed-transition',id,'reconciled',{generation:worker.generation,checkpoint:checkpoint?.id??null,context_cursor:context.cursor,read_tasks:records.map((row:Row)=>`T${row.id}`),read_mail:mail.map(row=>row.id),handled_cursor:payload.context.notification_progress.cursor,evidence_kind:'fixture-only'});
    return {worker_id:worker.id,generation:worker.generation,state:'running',external_id:externalId,binding_id:binding.id};
  });
}
export interface FixtureBarrier {nonce:string;generation:number;tool_start_blocked:true;inventory_complete:true;active_jobs:unknown[]}
export function saveFixtureReady(s:Store,id:string,report:unknown,barrier:FixtureBarrier):Row {
  const {worker,transition,payload}=ownTransition(s,id),reported=validateBriefInput(report);
  check(worker.state==='draining' && transition.state==='draining','Worker is not draining',4);
  check(barrier.nonce===payload.drain_nonce && barrier.generation===worker.generation && barrier.tool_start_blocked===true && barrier.inventory_complete===true && Array.isArray(barrier.active_jobs) && barrier.active_jobs.length===0,'A complete enforced fixture tool barrier and settled inventory are required',4);
  const prior=JSON.parse(worker.context),snapshot:Row={...captureSupervisorSnapshot(s,worker.role,prior.checkout_id,prior.working_dir,prior.configuration),task_id:prior.task_id,evidence_kind:'fixture-only'};
  check(reported.configuration.digest===snapshot.configuration_digest,'Reported fixture configuration digest differs from observed settings',4);
  const binding=currentBinding(s,snapshot.task_id),wip=coordination.getWip(s);
  const evidence=validateRecoveryEvidence({version:1,validation:reported.validation,artifacts:reported.artifacts,jobs:reported.jobs.map(job=>({id:job.id,description:job.evidence,state:job.state,disposition:'finish'}))});
  const body={version:1,reported,observed:{...snapshot,worker_generation:worker.generation,binding_id:binding.id,barrier},readiness:'fixture-only; not real provider proof'};
  check(Buffer.byteLength(JSON.stringify(body))<=32768,'Complete managed fixture brief exceeds 32768 bytes');
  return s.tx(()=>{
    const fresh=ownTransition(s,id);check(fresh.worker.state==='draining' && fresh.transition.state==='draining' && !activeStop(s,[worker.role]),'Drain state or STOP changed',4);
    assertSupervisorReservation(s,worker.role,snapshot);
    check(!s.get("SELECT id FROM jobs WHERE role=? AND (status IN ('waiting','running') OR (orphans IS NOT NULL AND orphans!='[]')) LIMIT 1",worker.role),'Running or unknown owned jobs block readiness',4);
    for(const waiter of s.all('SELECT * FROM supervisor_waiters WHERE role=? AND ended_at IS NULL',worker.role)) {
      check(positivelyGone(waiter.pid,waiter.process_start),'A live or unknown waiter must settle before readiness',4);
      s.run('UPDATE supervisor_waiters SET ended_at=? WHERE id=?',now(),waiter.id);
    }
    const briefId=randomUUID(),at=now();s.run('INSERT INTO task_briefs VALUES(?,?,?,?,?,?,?,?)',briefId,s.ws,Number(snapshot.task_id.slice(1)),worker.role,binding.id,JSON.stringify(body),supervisorDigest(body),at);
    const nextWip=coordination.setWip(s,{current:reported.objective,next:reported.next_action,notes:`Fixture-only managed handoff ready. Complete immutable brief ${briefId}; transition ${id}; generation ${worker.generation}. The brief contains acceptance, decisions/provenance, open issues, validation and exact next action. Wait for verified retirement; do not start new tools.`,expected_version:wip.version});
    s.run("UPDATE managed_workers SET state='ready',updated_at=? WHERE id=?",at,worker.id);
    s.run("UPDATE managed_transitions SET state='ready',brief_id=?,expected_task_versions=?,payload=?,updated_at=? WHERE id=?",briefId,JSON.stringify(snapshot.task_versions),JSON.stringify({...payload,ready_context:snapshot,ready_barrier:barrier}),at,id);
    saveObservedFixtureCheckpoint(s,snapshot,nextWip,evidence);
    s.event('managed-transition',id,'ready',{brief_id:briefId,generation:worker.generation,evidence_kind:'fixture-only'});
    return {brief_id:briefId,checkpoint:getCheckpoint(s),generation:worker.generation,state:'ready'};
  });
}
