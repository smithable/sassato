// Experimental fixture protocol only. No CLI path supplies a real-provider
// adapter here; production providers remain observe-only until independently gated.
import { randomBytes,randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename,dirname,resolve } from 'node:path';
import type { Store,Row } from './storage.js';
import { check,now,text } from './errors.js';
import { activeStop } from './control.js';
import { processIdentity,sessionState } from './coordination.js';
import { registeredCheckout } from './checkouts.js';
import { workerTokenHash } from './managed-generation.js';
import { getSupervisorPolicy,type SupervisorPolicy } from './supervisor-policy.js';
import { requireSupervisorLease,type SupervisorLease } from './supervisor-locks.js';
import { captureSupervisorSnapshot,assertSupervisorSnapshot,assertSupervisorReservation,supervisorDigest } from './supervisor-snapshot.js';
import { workspaceSettings } from './workspace-settings.js';
import { observeBusyChecks } from './busy-checks.js';
import { positivelyGone } from './supervisor-monitor.js';

const canonicalLock=(path:string)=>resolve(realpathSync(dirname(path)),basename(path));
export interface FixtureLaunch {role:string;task:string;checkout:string;directory:string;configuration:Row;idempotency_key:string}
export interface FixtureLaunchSecret {worker_id:string;transition_id:string;generation:number;worker_token:string;launch_token:string}
// Supplied only by a deterministic fixture adapter. This is never real-provider
// containment evidence and cannot enable a production adapter or signaling path.
export interface FixtureScopeObservation {kind:'fixture-only';worker_id:string;generation:number;pid:number;process_start:string;descendants:'empty'|'running'|'unknown'}
export class FixtureController {
  private readonly policy:SupervisorPolicy;
  private recoveryPending=false;
  constructor(private readonly s:Store,private readonly controllerLease:SupervisorLease) {
    const policy=getSupervisorPolicy(s);check(policy,'A human must configure bounded supervisor policy first',3);this.policy=policy;
    this.authorize(undefined,true);
    s.tx(()=>{
      const prior=s.get('SELECT * FROM managed_controllers WHERE id=?',policy.controller_id);
      check(!prior || prior.workspace_id===s.ws && prior.role===s.requireActor() && prior.lock_path===controllerLease.path,'Controller identity is bound to another policy',4);
      if(prior && (prior.pid!==process.pid || prior.process_start!==processIdentity(process.pid))) {
        check(prior.pid && prior.process_start && positivelyGone(prior.pid,prior.process_start),'Previous controller identity is live or uncertain; the OS lock alone does not grant takeover',4);
        this.recoveryPending=!!s.get("SELECT id FROM managed_workers WHERE controller_id=? LIMIT 1",policy.controller_id);
      }
      if(!prior)s.run('INSERT INTO managed_controllers(id,workspace_id,role,lock_path,pid,process_start,created_at) VALUES(?,?,?,?,?,?,?)',policy.controller_id,s.ws,s.requireActor(),controllerLease.path,process.pid,processIdentity(process.pid),now());
      else if(!this.recoveryPending)s.run('UPDATE managed_controllers SET pid=?,process_start=? WHERE id=?',process.pid,processIdentity(process.pid),policy.controller_id);
    });
  }
  private authorize(maintenance?:SupervisorLease,recovery=false):void {
    requireSupervisorLease(this.controllerLease,'exclusive');
    check(this.controllerLease.path===canonicalLock(this.policy.controller_lock),'Controller lock differs from human policy',4);
    check(this.s.requireActor()===this.policy.controller_role && this.s.role(this.s.requireActor()).kind==='agent','Only the configured controller reporting role may drive fixtures',3);
    check(supervisorDigest(getSupervisorPolicy(this.s))===supervisorDigest(this.policy),'Supervisor policy changed; reacquire and reconcile',4);
    check(!this.recoveryPending || recovery,'Controller recovery must reconcile existing generations before lifecycle work',4);
    if(maintenance) {requireSupervisorLease(maintenance,'exclusive');check(maintenance.path===canonicalLock(this.policy.maintenance_lock),'Maintenance lock differs from human policy',4);}
  }
  async reconcileController(maintenance:SupervisorLease):Promise<Row[]> {
    this.authorize(maintenance,true);
    const workers=this.s.all('SELECT * FROM managed_workers WHERE workspace_id=? AND controller_id=? ORDER BY role',this.s.ws,this.policy.controller_id);
    check(workers.length<=this.policy.maximum_workers,'Existing worker count exceeds human policy',4);
    const observations:Row[]=[];
    for(const worker of workers) {
      check(this.policy.worker_roles.includes(worker.role),'Existing role is outside human policy',4);
      const transition=this.s.get('SELECT * FROM managed_transitions WHERE worker_id=? AND generation=? ORDER BY created_at DESC,rowid DESC LIMIT 1',worker.id,worker.generation);
      check(transition,'Generation has no durable transition; ownership is unproven',4);
      const payload=JSON.parse(transition.payload),context=payload.ready_context??JSON.parse(worker.context);
      check(context.evidence_kind==='fixture-only','Real provider reattachment is disabled',4);
      this.permitted(worker.role,context.checkout_id);assertSupervisorSnapshot(this.s,worker.role,context);
      const effectiveState=payload.suspended_from??worker.state;
      const pid=effectiveState==='starting'?transition.bootstrap_pid:worker.pid,start=effectiveState==='starting'?transition.bootstrap_start:worker.process_start;
      check(pid && start,'Uncertain spawn has no registered identity; reconcile manually without another spawn',4);
      const live=processIdentity(pid)===start,gone=positivelyGone(pid,start);
      check(live || gone,'Recorded process ownership/exit is uncertain',4);
      if(effectiveState==='starting')check(['starting','blocked','stopped'].includes(transition.state) && !transition.bootstrap_released_at && transition.launch_token_hash,'Startup intent is inconsistent',4);
      else {
        const launch=this.s.get('SELECT id FROM managed_transitions WHERE worker_id=? AND generation=? AND bootstrap_pid=? AND bootstrap_start=? AND bootstrap_released_at IS NOT NULL',worker.id,worker.generation,pid,start);
        check(launch,'Live process is not tied to this controller launch token and release',4);
        check(live || ['retiring','exited','blocked','stopped'].includes(worker.state),'Post-release process failure requires human reconciliation',4);
      }
      observations.push({worker_id:worker.id,generation:worker.generation,state:worker.state,pid,process_start:start,live,exited:gone,context,evidence_kind:'fixture-only'});
    }
    // Recovery itself performs the same nonblocking maintenance and positive-idle
    // checks as an ordinary action. No recovered observation authorizes a spawn.
    const checks=workspaceSettings(this.s).busy_checks;check(checks.length>0,'Positive protected-job checks are required',4);
    check(!this.s.get("SELECT id FROM jobs WHERE status IN ('waiting','running') OR (orphans IS NOT NULL AND orphans!='[]') LIMIT 1"),'Running or unknown jobs block controller recovery',4);
    check((await observeBusyChecks(checks)).every(row=>row.state==='idle'),'Busy or unknown checks block controller recovery',4);
    return this.s.tx(()=>{
      this.authorize(maintenance,true);
      for(const observation of observations) {
        const current=this.worker(observation.worker_id);this.permitted(current.role,observation.context.checkout_id);
        check(current.generation===observation.generation && current.state===observation.state,'Generation changed during controller recovery',4);
        assertSupervisorReservation(this.s,current.role,observation.context);
        check(observation.live?processIdentity(observation.pid)===observation.process_start:positivelyGone(observation.pid,observation.process_start),'Process changed during controller recovery',4);
      }
      this.s.run('UPDATE managed_controllers SET pid=?,process_start=? WHERE id=?',process.pid,processIdentity(process.pid),this.policy.controller_id);
      this.s.event('managed-controller',this.policy.controller_id,'fixture-reconciled',{workers:observations.map(({context,...rest})=>rest),evidence_kind:'fixture-only'});
      this.recoveryPending=false;return observations.map(({context,...rest})=>rest);
    });
  }
  private worker(id:string):Row {
    const worker=this.s.get('SELECT * FROM managed_workers WHERE workspace_id=? AND controller_id=? AND id=?',this.s.ws,this.policy.controller_id,id);
    check(worker && this.policy.worker_roles.includes(worker.role),'Worker is not owned by this controller policy',3);return worker;
  }
  private transition(id:string):Row {
    const row=this.s.get('SELECT * FROM managed_transitions WHERE id=?',text(id,'transition id',100));
    check(row,'Transition not found',3);const worker=this.worker(row.worker_id);
    check(row.generation===worker.generation,'Transition generation is stale',4);return row;
  }
  private permitted(role:string,checkout:string):void {
    check(this.policy.worker_roles.includes(role) && this.s.role(role).kind==='agent','Role is outside human policy',3);
    check(this.policy.repository_ids.includes(registeredCheckout(this.s,checkout).repository_id),'Repository is outside human policy',3);
    check(!activeStop(this.s,[role,this.s.requireActor()]),'STOP prevents fixture lifecycle work',4);
  }
  async beginLaunch(input:FixtureLaunch,maintenance:SupervisorLease):Promise<FixtureLaunchSecret> {
    this.authorize(maintenance);this.permitted(input.role,input.checkout);text(input.idempotency_key,'idempotency key',200);
    check(input.configuration.evidence_kind==='fixture-only','Real providers have no enabled management adapter',4);
    const task=this.s.task(input.task);check(task.owner===input.role && ['doing','review'].includes(task.status) && !task.human_only,'Launch must preserve an existing agent-owned assignment',3);
    const context:Row={...captureSupervisorSnapshot(this.s,input.role,input.checkout,input.directory,input.configuration),task_id:input.task,evidence_kind:'fixture-only'};
    await this.assertIdle(input.role,maintenance);
    return this.s.tx(()=>{
      this.authorize(maintenance);this.permitted(input.role,input.checkout);
      assertSupervisorReservation(this.s,input.role,context);
      check(!this.s.get('SELECT id FROM managed_workers WHERE role=?',input.role),'Role already has a durable generation; reconcile it instead of relaunching',4);
      check(!this.s.get('SELECT id FROM checkout_bindings WHERE released_at IS NULL AND (role=? OR checkout_id=?)',input.role,input.checkout),'Existing checkout/worker reservation blocks launch',4);
      const sessions=this.s.all('SELECT * FROM sessions WHERE role=?',input.role);
      check(sessions.every(row=>row.pid && row.process_start && ['ended','stale'].includes(sessionState(row))),'Existing live or unknown terminals are observe-only',4);
      check(Number(this.s.get("SELECT count(*) n FROM managed_workers WHERE controller_id=? AND state NOT IN ('exited','stopped')",this.policy.controller_id)!.n)<this.policy.maximum_workers,'Human worker limit reached',4);
      const secret={worker_id:randomUUID(),transition_id:randomUUID(),generation:1,worker_token:randomBytes(32).toString('hex'),launch_token:randomBytes(32).toString('hex')},at=now();
      this.s.run('INSERT INTO managed_workers(id,workspace_id,role,controller_id,binding_id,generation,token_hash,state,provider,configuration_digest,updated_at,context) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',secret.worker_id,this.s.ws,input.role,this.policy.controller_id,null,1,workerTokenHash(secret.worker_token),'starting',input.configuration.provider,context.configuration_digest,at,JSON.stringify(context));
      this.s.run('INSERT INTO managed_transitions(id,worker_id,generation,idempotency_key,state,expected_task_versions,launch_token_hash,retry_count,created_at,updated_at,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)',secret.transition_id,secret.worker_id,1,input.idempotency_key,'starting',JSON.stringify(context.task_versions),workerTokenHash(secret.launch_token),0,at,at,JSON.stringify({context,bootstrap_deadline:new Date(Date.now()+120000).toISOString(),initial_launch:true}));
      this.s.event('managed-transition',secret.transition_id,'launch-intent',{worker_id:secret.worker_id,generation:1,evidence_kind:'fixture-only'});return secret;
    });
  }
  async assertIdle(role:string,maintenance:SupervisorLease):Promise<void> {
    this.authorize(maintenance);check(!activeStop(this.s,[role,this.s.requireActor()]),'STOP prevents fixture lifecycle work',4);
    check(!this.s.get("SELECT id FROM jobs WHERE status IN ('waiting','running') OR (orphans IS NOT NULL AND orphans!='[]') LIMIT 1"),'Running or unknown job inventory blocks lifecycle work',4);
    const checks=workspaceSettings(this.s).busy_checks;
    check(checks.length>0,'Positive protected-job checks are required; missing configuration is not idle',4);
    const observations=await observeBusyChecks(checks);
    check(observations.length===checks.length && observations.every(row=>row.state==='idle'),'Busy or unknown protected-job checks block lifecycle work',4);
    this.authorize(maintenance);check(!activeStop(this.s,[role,this.s.requireActor()]),'STOP arrived during idle checks',4);
  }
  requestDrain(workerId:string,generation:number,idempotencyKey:string):Row {
    this.authorize();text(idempotencyKey,'idempotency key',200);
    return this.s.tx(()=>{
      this.authorize();const worker=this.worker(workerId),context=JSON.parse(worker.context);
      this.permitted(worker.role,context.checkout_id);
      check(worker.generation===generation,'Drain generation is stale',4);
      const previous=this.s.get('SELECT * FROM managed_transitions WHERE worker_id=? AND idempotency_key=?',workerId,idempotencyKey);
      if(previous){check(previous.generation===generation,'Idempotency key belongs to a different generation',4);return previous;}
      check(worker.state==='running' && !this.s.get("SELECT id FROM managed_transitions WHERE worker_id=? AND state NOT IN ('complete','blocked','stopped')",workerId),'Worker already has an active transition',4);
      const id=randomUUID(),at=now(),payload={context,drain_nonce:randomUUID(),evidence_kind:'fixture-only'};
      check(context.evidence_kind==='fixture-only','Real provider drain remains disabled',4);
      this.s.run('INSERT INTO managed_transitions(id,worker_id,generation,idempotency_key,state,expected_task_versions,retry_count,created_at,updated_at,payload) VALUES(?,?,?,?,?,?,?,?,?,?)',id,workerId,generation,idempotencyKey,'draining',JSON.stringify(context.task_versions),0,at,at,JSON.stringify(payload));
      this.s.run("UPDATE managed_workers SET state='draining',updated_at=? WHERE id=?",at,workerId);
      this.s.event('managed-transition',id,'drain-requested',{generation,evidence_kind:'fixture-only'});return this.transition(id);
    });
  }
  async prepareFixtureRetirement(id:string,maintenance:SupervisorLease):Promise<Row> {
    this.authorize(maintenance);const transition=this.transition(id),worker=this.worker(transition.worker_id),payload=JSON.parse(transition.payload);
    check(['ready','retiring'].includes(transition.state) && ['ready','retiring'].includes(worker.state) && transition.brief_id && payload.ready_barrier?.tool_start_blocked===true && payload.ready_barrier?.inventory_complete===true && payload.ready_barrier?.active_jobs?.length===0,'A complete fixture readiness barrier is required before retirement',4);
    check(payload.ready_context.evidence_kind==='fixture-only','Real provider retirement is disabled',4);
    assertSupervisorSnapshot(this.s,worker.role,payload.ready_context);await this.assertIdle(worker.role,maintenance);
    return this.s.tx(()=>{
      this.authorize(maintenance);const fresh=this.transition(id),current=this.worker(worker.id);
      check(['ready','retiring'].includes(fresh.state) && ['ready','retiring'].includes(current.state) && current.pid && processIdentity(current.pid)===current.process_start,'Fixture process identity or readiness changed',4);
      this.permitted(worker.role,payload.ready_context.checkout_id);assertSupervisorReservation(this.s,worker.role,payload.ready_context);
      const at=now();this.s.run("UPDATE managed_workers SET state='retiring',updated_at=? WHERE id=?",at,worker.id);
      this.s.run("UPDATE managed_transitions SET state='retiring',updated_at=? WHERE id=?",at,id);
      this.s.event('managed-transition',id,'fixture-retirement-requested',{generation:worker.generation,signaled:false,evidence_kind:'fixture-only'});return this.transition(id);
    });
  }
  async recordFixtureExit(id:string,scope:FixtureScopeObservation,maintenance:SupervisorLease):Promise<Row> {
    this.authorize(maintenance);const transition=this.transition(id),worker=this.worker(transition.worker_id),payload=JSON.parse(transition.payload);
    check(transition.state==='retiring' && worker.state==='retiring' && payload.ready_context?.evidence_kind==='fixture-only','Only a ready, retiring fixture can record exit',4);
    check(scope.kind==='fixture-only' && scope.worker_id===worker.id && scope.generation===worker.generation && scope.pid===worker.pid && scope.process_start===worker.process_start && scope.descendants==='empty','Complete matching fixture scope evidence is required; unknown descendants block',4);
    check(positivelyGone(worker.pid,worker.process_start),'Recorded fixture PID has not conclusively exited',4);
    assertSupervisorSnapshot(this.s,worker.role,payload.ready_context);await this.assertIdle(worker.role,maintenance);
    return this.s.tx(()=>{
      this.authorize(maintenance);const current=this.worker(worker.id);this.permitted(current.role,payload.ready_context.checkout_id);
      check(current.state==='retiring' && this.transition(id).state==='retiring' && current.pid===scope.pid && current.process_start===scope.process_start && positivelyGone(current.pid,current.process_start),'Fixture exit identity changed or is uncertain',4);
      assertSupervisorReservation(this.s,current.role,payload.ready_context);
      const at=now();this.s.run("UPDATE managed_workers SET state='exited',updated_at=? WHERE id=?",at,worker.id);
      this.s.run("UPDATE managed_transitions SET state='exited',payload=?,updated_at=? WHERE id=?",JSON.stringify({...payload,exit_observation:{...scope,observed_at:at,real_provider_proof:false}}),at,id);
      this.s.event('managed-transition',id,'fixture-exited',{generation:worker.generation,real_provider_proof:false});return this.transition(id);
    });
  }
  async startReplacement(id:string,maintenance:SupervisorLease):Promise<FixtureLaunchSecret> {
    this.authorize(maintenance);const transition=this.transition(id),worker=this.worker(transition.worker_id),payload=JSON.parse(transition.payload);
    check(transition.state==='exited' && worker.state==='exited' && payload.exit_observation?.kind==='fixture-only' && payload.exit_observation?.descendants==='empty','Verified fixture exit is required before generation advance',4);
    return this.nextFixtureGeneration(id,payload.ready_context,maintenance,false);
  }
  async retryUnreleasedStartup(id:string,maintenance:SupervisorLease):Promise<FixtureLaunchSecret> {
    this.authorize(maintenance);const transition=this.transition(id),worker=this.worker(transition.worker_id),payload=JSON.parse(transition.payload);
    check(transition.state==='starting' && worker.state==='starting' && !transition.bootstrap_released_at && transition.retry_count===0 && transition.bootstrap_pid && transition.bootstrap_start && positivelyGone(transition.bootstrap_pid,transition.bootstrap_start),'Only one conclusively exited startup before release may retry; uncertain or post-release failure requires a human',4);
    return this.nextFixtureGeneration(id,payload.context,maintenance,true);
  }
  blockTransition(id:string,reason:string,maintenance:SupervisorLease):Row {
    try {
      this.authorize(maintenance,true);text(reason,'block reason',2000);
      return this.s.tx(()=>{
        this.authorize(maintenance,true);const transition=this.transition(id),worker=this.worker(transition.worker_id),payload=JSON.parse(transition.payload);
        check(!['complete','exited'].includes(transition.state),'Completed or exited work cannot be blocked as an active transition',4);
        const state=activeStop(this.s,[worker.role,this.s.requireActor()])?'stopped':'blocked',at=now();
        this.s.run('UPDATE managed_transitions SET state=?,reason=?,payload=?,updated_at=? WHERE id=?',state,reason,JSON.stringify({...payload,suspended_from:payload.suspended_from??transition.state}),at,id);
        this.s.run('UPDATE managed_workers SET state=?,updated_at=? WHERE id=?',state,at,worker.id);
        this.s.event('managed-transition',id,state,{reason,generation:worker.generation,evidence_kind:'fixture-only'});return this.transition(id);
      });
    } finally {maintenance.close();}
  }
  async resumeFixtureTransition(id:string,maintenance:SupervisorLease):Promise<Row> {
    this.authorize(maintenance);const transition=this.transition(id),worker=this.worker(transition.worker_id),payload=JSON.parse(transition.payload),context=payload.ready_context??payload.context;
    check(['blocked','stopped'].includes(transition.state) && worker.state===transition.state && ['starting','reconciling','draining','ready','retiring'].includes(payload.suspended_from),'No suspended fixture transition can resume',4);
    check(context.evidence_kind==='fixture-only','Real provider management is disabled',4);
    this.permitted(worker.role,context.checkout_id);assertSupervisorSnapshot(this.s,worker.role,context);await this.assertIdle(worker.role,maintenance);
    return this.s.tx(()=>{
      this.authorize(maintenance);this.permitted(worker.role,context.checkout_id);const fresh=this.transition(id),current=this.worker(worker.id);
      check(fresh.state===transition.state && current.state===worker.state,'Blocked state changed during reconciliation',4);
      assertSupervisorReservation(this.s,worker.role,context);
      if(payload.suspended_from==='starting')check(!fresh.bootstrap_released_at,'A released bootstrap cannot return to startup',4);
      else check(current.pid && processIdentity(current.pid)===current.process_start,'Post-release worker failure requires a human; it cannot resume automatically',4);
      const at=now(),{suspended_from,...rest}=payload;
      this.s.run('UPDATE managed_transitions SET state=?,reason=NULL,payload=?,updated_at=? WHERE id=?',suspended_from,JSON.stringify(rest),at,id);
      this.s.run('UPDATE managed_workers SET state=?,updated_at=? WHERE id=?',suspended_from,at,worker.id);
      this.s.event('managed-transition',id,'fixture-resumed',{generation:worker.generation,state:suspended_from,evidence_kind:'fixture-only'});return this.transition(id);
    });
  }
  private async nextFixtureGeneration(id:string,context:Row,maintenance:SupervisorLease,retry:boolean):Promise<FixtureLaunchSecret> {
    const transition=this.transition(id),worker=this.worker(transition.worker_id),payload=JSON.parse(transition.payload);
    check(context?.evidence_kind==='fixture-only','Real providers remain observe-only',4);
    assertSupervisorSnapshot(this.s,worker.role,context);await this.assertIdle(worker.role,maintenance);
    return this.s.tx(()=>{
      this.authorize(maintenance);const fresh=this.transition(id),current=this.worker(worker.id);this.permitted(worker.role,context.checkout_id);
      check(fresh.state===transition.state && current.state===worker.state && fresh.retry_count===transition.retry_count && fresh.bootstrap_released_at===transition.bootstrap_released_at,'Transition changed before generation advance',4);
      check(retry?fresh.bootstrap_pid && fresh.bootstrap_start && positivelyGone(fresh.bootstrap_pid,fresh.bootstrap_start):current.pid && current.process_start && positivelyGone(current.pid,current.process_start),'Old process exit is no longer conclusive',4);
      assertSupervisorReservation(this.s,worker.role,context);
      const secret={worker_id:worker.id,transition_id:id,generation:worker.generation+1,worker_token:randomBytes(32).toString('hex'),launch_token:randomBytes(32).toString('hex')},at=now();
      this.s.run("UPDATE managed_workers SET generation=?,token_hash=?,state='starting',pid=NULL,process_start=NULL,context=?,configuration_digest=?,updated_at=? WHERE id=?",secret.generation,workerTokenHash(secret.worker_token),JSON.stringify(context),context.configuration_digest,at,worker.id);
      this.s.run("UPDATE managed_transitions SET generation=?,state='starting',launch_token_hash=?,bootstrap_pid=NULL,bootstrap_start=NULL,bootstrap_released_at=NULL,retry_count=?,payload=?,updated_at=? WHERE id=?",secret.generation,workerTokenHash(secret.launch_token),retry?1:0,JSON.stringify({...payload,context,bootstrap_deadline:new Date(Date.now()+120000).toISOString(),previous_generation:worker.generation}),at,id);
      this.s.event('managed-transition',id,retry?'fixture-startup-retry-intent':'fixture-replacement-intent',{generation:secret.generation,previous_generation:worker.generation,evidence_kind:'fixture-only'});return secret;
    });
  }
  async releaseBootstrap(transitionId:string,maintenance:SupervisorLease):Promise<Row> {
    this.authorize(maintenance);const transition=this.transition(transitionId),worker=this.worker(transition.worker_id),payload=JSON.parse(transition.payload);
    check(transition.state==='starting' && worker.state==='starting','Bootstrap is not awaiting release',4);
    assertSupervisorSnapshot(this.s,worker.role,payload.context);await this.assertIdle(worker.role,maintenance);
    return this.s.tx(()=>{
      this.authorize(maintenance);const fresh=this.transition(transitionId);
      assertSupervisorReservation(this.s,worker.role,payload.context);
      check(fresh.state==='starting' && fresh.bootstrap_pid && fresh.bootstrap_start && processIdentity(fresh.bootstrap_pid)===fresh.bootstrap_start,'Bootstrap self-registration is missing or uncertain; do not spawn another',4);
      check(Date.now()<=Date.parse(payload.bootstrap_deadline) && !activeStop(this.s,[worker.role,this.s.requireActor()]),'Bootstrap deadline or STOP prevents release',4);
      const at=now();this.s.run("UPDATE managed_transitions SET bootstrap_released_at=?,state='reconciling',updated_at=? WHERE id=? AND state='starting'",at,at,transitionId);
      this.s.run("UPDATE managed_workers SET state='reconciling',pid=?,process_start=?,updated_at=? WHERE id=?",fresh.bootstrap_pid,fresh.bootstrap_start,at,worker.id);
      this.s.event('managed-transition',transitionId,'bootstrap-released',{generation:worker.generation,evidence_kind:'fixture-only'});return this.transition(transitionId);
    });
  }
}
