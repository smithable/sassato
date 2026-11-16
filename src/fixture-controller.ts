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

const canonicalLock=(path:string)=>resolve(realpathSync(dirname(path)),basename(path));
export interface FixtureLaunch {role:string;task:string;checkout:string;directory:string;configuration:Row;idempotency_key:string}
export interface FixtureLaunchSecret {worker_id:string;transition_id:string;generation:number;worker_token:string;launch_token:string}
export class FixtureController {
  private readonly policy:SupervisorPolicy;
  constructor(private readonly s:Store,private readonly controllerLease:SupervisorLease) {
    const policy=getSupervisorPolicy(s);check(policy,'A human must configure bounded supervisor policy first',3);this.policy=policy;
    this.authorize();
    s.tx(()=>{
      const prior=s.get('SELECT * FROM managed_controllers WHERE id=?',policy.controller_id);
      check(!prior || prior.workspace_id===s.ws && prior.role===s.requireActor() && prior.lock_path===controllerLease.path,'Controller identity is bound to another policy',4);
      if(prior && (prior.pid!==process.pid || prior.process_start!==processIdentity(process.pid))) {
        check(!s.get("SELECT id FROM managed_workers WHERE controller_id=? AND state NOT IN ('exited','stopped') LIMIT 1",policy.controller_id),'Controller recovery must reconcile existing generations before any launch',4);
      }
      if(!prior)s.run('INSERT INTO managed_controllers(id,workspace_id,role,lock_path,pid,process_start,created_at) VALUES(?,?,?,?,?,?,?)',policy.controller_id,s.ws,s.requireActor(),controllerLease.path,process.pid,processIdentity(process.pid),now());
      else s.run('UPDATE managed_controllers SET pid=?,process_start=? WHERE id=?',process.pid,processIdentity(process.pid),policy.controller_id);
    });
  }
  private authorize(maintenance?:SupervisorLease):void {
    requireSupervisorLease(this.controllerLease,'exclusive');
    check(this.controllerLease.path===canonicalLock(this.policy.controller_lock),'Controller lock differs from human policy',4);
    check(this.s.requireActor()===this.policy.controller_role && this.s.role(this.s.requireActor()).kind==='agent','Only the configured controller reporting role may drive fixtures',3);
    check(supervisorDigest(getSupervisorPolicy(this.s))===supervisorDigest(this.policy),'Supervisor policy changed; reacquire and reconcile',4);
    if(maintenance) {requireSupervisorLease(maintenance,'exclusive');check(maintenance.path===canonicalLock(this.policy.maintenance_lock),'Maintenance lock differs from human policy',4);}
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
