// Cooperative attended controller. This never enables the enforced fixture path.
import { randomBytes,randomUUID } from 'node:crypto';
import { spawn,spawnSync } from 'node:child_process';
import { constants,existsSync,mkdirSync,readFileSync,realpathSync,statSync,symlinkSync } from 'node:fs';
import { dirname,isAbsolute,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Store,type Row } from './storage.js';
import { check,id,name,now,safe,text } from './errors.js';
import { activeStop } from './control.js';
import { workspaceSettings } from './workspace-settings.js';
import { observeBusyChecks } from './busy-checks.js';
import { acquireSupervisorLock,type SupervisorLease } from './supervisor-locks.js';
import { processIdentity,sessionState,registerSession,setWip,getWip,context,inbox } from './coordination.js';
import { planLaunch,resolveExecutable } from './launch.js';
import { inspectCheckout,registeredCheckout,bindCheckout,currentBinding } from './checkouts.js';
import { dirtyManifest } from './dirty-manifest.js';
import { assertPhysicalIdentity } from './repository-identity.js';
import { supervisorDigest as digest } from './supervisor-snapshot.js';
import { workerTokenHash } from './managed-generation.js';
import { getNotificationProgress } from './notification-progress.js';
import { positivelyGone,requestSupervisorPing } from './supervisor-monitor.js';
import { validateBriefInput } from './task-briefs.js';
import { CHECKPOINT_FORMAT,checkpointFingerprint } from './checkpoints.js';
import { observeTasks,MAX_CHECKPOINT_BYTES } from './recovery-evidence.js';

const processHelper=fileURLToPath(new URL('../bin/attended-process.py',import.meta.url));
const ptyHelper=fileURLToPath(new URL('../bin/attended-pty.py',import.meta.url));
const bootstrap=fileURLToPath(new URL('./attended-bootstrap.js',import.meta.url));
const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
const kind='cooperative-attended';
export function enrollment(s:Store,role:string):Row {
  const event=s.get("SELECT detail FROM events WHERE workspace_id=? AND entity='attended-enrollment' AND entity_id=? AND action='configured' ORDER BY id DESC LIMIT 1",s.ws,name(role));
  check(event,'Human attended enrollment is required',3);return JSON.parse(event.detail);
}
export function enrollAttended(s:Store,role:string,input:unknown):Row {
  s.requireHuman();name(role);check(input && typeof input==='object' && !Array.isArray(input),'Enrollment must be an object');safe(input);
  const p=input as Row;
  check(Object.keys(p).sort().join(',')==='checkout,controller_lock,controller_role,maintenance_lock,task','Enrollment needs checkout, task, controller_role, controller_lock, maintenance_lock');
  check(s.role(role).kind==='agent' && ['codex','claude'].includes(s.role(role).provider),'Enroll an existing provider agent role');
  check(p.controller_role!==role && s.role(name(p.controller_role)).kind==='agent','Use a distinct existing controller reporting role');
  for(const key of ['controller_lock','maintenance_lock'])check(isAbsolute(text(p[key],key,4096)),'Use absolute native Linux lock paths');
  check(p.controller_lock!==p.maintenance_lock,'Controller and maintenance locks must differ');
  const checkout=registeredCheckout(s,text(p.checkout,'checkout',100)),task=s.task(text(p.task,'task',40));
  check(task.owner===role && task.status==='doing' && !task.human_only,'Enroll the assigned active agent-owned task',4);
  const cwd=realpathSync(s.role(role).working_dir);inspectCheckout(s,p.checkout,cwd);
  check(workspaceSettings(s).stop_file!==null,'Configure an explicit stop file before attended enrollment',4);
  check(!task.review_required,'Use a disposable task without a separate review requirement',4);
  check(workspaceSettings(s).busy_checks.length>0,'Configure positive gate/merge/release/heavy busy checks first',4);
  check(getNotificationProgress(s,role),'Initialize the disposable role handled cursor before enrollment',4);
  return s.tx(()=>{
    s.requireHuman();check(!s.get("SELECT id FROM managed_workers WHERE role=?",role),'Existing managed generation must be reconciled, never reenrolled',4);
    check(!s.get("SELECT id FROM checkout_bindings WHERE released_at IS NULL AND (role=? OR checkout_id=?)",role,p.checkout),'Existing checkout reservation blocks enrollment',4);
    check(!s.all('SELECT * FROM sessions WHERE role=?',role).some(row=>!row.pid || !row.process_start || !['ended','stale'].includes(sessionState(row))),'Live or unknown sessions cannot be enrolled',4);
    check(!s.get("SELECT id FROM events WHERE workspace_id=? AND entity='attended-enrollment' AND entity_id=?",s.ws,role),'Enrollment is immutable; use a new disposable role',4);
    const settings=workspaceSettings(s);const policy={...p,busy_checks:settings.busy_checks,stop_file:settings.stop_file,role,controller_id:randomUUID(),repository_id:checkout.repository_id,cwd,mode:kind,created_by:s.requireActor()};
    s.event('attended-enrollment',role,'configured',policy);return policy;
  });
}
export function attendedConfiguration(s:Store,role:string):Row {
  const plan=planLaunch(s,[role],{fresh:true,noPrompt:true})[0];
  check(plan.status==='ready','Existing sessions are observe-only; no adoption',4);
  const executable=realpathSync(resolveExecutable(plan.executable,true));
  const version=spawnSync(executable,['--version'],{encoding:'utf8',timeout:5000,maxBuffer:16384,stdio:['ignore','pipe','pipe'],shell:false});
  check(!version.error && version.status===0,'Provider version is unavailable',4);
  const value={provider:plan.provider,model:s.role(role).model,effort:s.role(role).reasoning_effort,sandbox:s.role(role).sandbox_mode,approval:s.role(role).approval_policy,permission_mode:s.role(role).permission_mode,executable,version:version.stdout.trim(),argv_template:plan.args,cwd:plan.cwd};
  text(value.version,'provider version',2000);safe(value);return value;
}
// Revalidation does not use planLaunch's already-running classification.
function currentConfiguration(s:Store,role:string,expected:Row):Row {
  const r=s.role(role),executable=realpathSync(resolveExecutable(r.provider,true));
  const version=spawnSync(executable,['--version'],{encoding:'utf8',timeout:5000,maxBuffer:16384,stdio:['ignore','pipe','pipe'],shell:false});
  check(!version.error && version.status===0,'Provider version is unavailable',4);
  const current={...expected,provider:r.provider,model:r.model,effort:r.reasoning_effort,sandbox:r.sandbox_mode,approval:r.approval_policy,permission_mode:r.permission_mode,executable,version:version.stdout.trim(),cwd:realpathSync(r.working_dir)};
  check(digest(current)===digest(expected),'Attended configuration subset changed; reconcile before lifecycle work',4);return current;
}
export function attendedSnapshot(s:Store,role:string,p:Row,configuration:Row):Row {
  currentConfiguration(s,role,configuration);
  const identity=inspectCheckout(s,p.checkout,p.cwd),manifest=dirtyManifest(identity.checkout_root),cwd=statSync(p.cwd,{bigint:true});
  const tasks=s.all("SELECT id,version,status,owner FROM tasks WHERE workspace_id=? AND owner=? AND status NOT IN ('done','dropped') ORDER BY id",s.ws,role);
  check(tasks.length<=100,'Too many assigned tasks for bounded handover');
  const progress=getNotificationProgress(s,role);check(progress,'Handled notification cursor is required',4);
  check(digest(identity)===digest(inspectCheckout(s,p.checkout,p.cwd)) && digest(manifest)===digest(dirtyManifest(identity.checkout_root)),'Checkout changed while capturing readiness',4);
  const snapshot={evidence_kind:kind,checkout_id:p.checkout,working_dir:p.cwd,identity,cwd_device:String(cwd.dev),cwd_inode:String(cwd.ino),manifest,manifest_digest:digest(manifest),task_versions:tasks,notification_progress:progress,configuration,configuration_digest:digest(configuration),task_id:p.task};
  check(Buffer.byteLength(JSON.stringify(snapshot))<=32768,'Complete attended launch snapshot exceeds 32768 bytes');return snapshot;
}
function snapshotEqual(s:Store,role:string,p:Row,snapshot:Row):void {
  const current=attendedSnapshot(s,role,p,snapshot.configuration);const expected=Object.fromEntries(Object.keys(current).map(key=>[key,snapshot[key]]));
  check(digest(current)===digest(expected),'HEAD, dirty files, tasks, settings or handled cursor changed; reconcile and approve again',4);
}
function reservationEqual(s:Store,role:string,snapshot:Row):void {
  assertPhysicalIdentity(snapshot.identity);const cwd=statSync(snapshot.working_dir,{bigint:true});
  check(String(cwd.dev)===snapshot.cwd_device && String(cwd.ino)===snapshot.cwd_inode,'Working directory identity changed',4);
  check(digest(getNotificationProgress(s,role))===digest(snapshot.notification_progress),'Handled notification cursor changed',4);
  const tasks=s.all("SELECT id,version,status,owner FROM tasks WHERE workspace_id=? AND owner=? AND status NOT IN ('done','dropped') ORDER BY id",s.ws,role);
  check(digest(tasks)===digest(snapshot.task_versions),'Task ownership/version changed',4);
}
function worker(s:Store,role:string):Row {
  const w=s.get('SELECT * FROM managed_workers WHERE workspace_id=? AND role=?',s.ws,role);check(w && JSON.parse(w.context).evidence_kind===kind,'No attended worker generation',4);return w;
}
function latest(s:Store,w:Row):Row {
  const t=s.get('SELECT * FROM managed_transitions WHERE worker_id=? AND generation=? ORDER BY rowid DESC LIMIT 1',w.id,w.generation);check(t,'Generation has no durable transition',4);return t;
}
function stopped(s:Store,p:Row):boolean {return !!activeStop(s,[p.role,p.controller_role]);}
function permitted(s:Store,p:Row):void {check(!stopped(s,p),'STOP prevents attended lifecycle work',4);const settings=workspaceSettings(s);check(settings.stop_file===p.stop_file && digest(settings.busy_checks)===digest(p.busy_checks),'Enrolled STOP/busy guard configuration changed',4);}
function settled(s:Store,role:string):void {
  check(!s.get("SELECT id FROM jobs WHERE role=? AND (status IN ('waiting','running') OR (orphans IS NOT NULL AND orphans!='[]')) LIMIT 1",role),'Running or unknown jobs block handover',4);
  for(const waiter of s.all('SELECT * FROM supervisor_waiters WHERE role=? AND ended_at IS NULL',role))check(positivelyGone(waiter.pid,waiter.process_start),'A live or unknown waiter blocks handover',4);
}
export function processObservation(w:Row,retire=false):Row {
  check(w.pid && w.process_start,'Process identity is missing; do not signal or launch',4);
  const result=spawnSync('python3',['-B',processHelper,retire?'retire':'observe',String(w.pid),w.process_start],{env:{...process.env,SASSATO_ATTENDED_SIGNAL_GUARDS:retire?JSON.stringify(w.signal_guards):''},encoding:'utf8',timeout:retire?50000:5000,maxBuffer:1_048_576,shell:false});
  check(!result.error && result.status===0,`Attended process observation failed: ${result.stdout.trim()||'unknown identity/membership'}`,4);
  return JSON.parse(result.stdout);
}
function ownCaller(w:Row):void {
  check(processIdentity(w.pid)===w.process_start,'Recorded worker leader is no longer live',4);
  const fields=readFileSync('/proc/self/stat','utf8').split(') ').at(-1)!.split(' ');
  check(Number(fields[2])===w.pid && Number(fields[3])===w.pid,'Command must originate in the owned provider process group',3);
}
export function attendedAssignment(s:Store):Row {
  const w=worker(s,s.requireActor()),t=latest(s,w),p=enrollment(s,w.role);ownCaller(w);
  return {worker_id:w.id,generation:w.generation,state:w.state,transition:t.id,task:p.task,configuration:JSON.parse(w.context).configuration,configuration_digest:w.configuration_digest,previous_brief:JSON.parse(t.payload).previous_brief??null,handled_cursor:JSON.parse(w.context).notification_progress.cursor,limitations:'Cooperative only. Settle all tools, waiters, nested/background/detached work; after ready start nothing.'};
}
export function reconcileAttended(s:Store,externalId:string):Row {
  const w=worker(s,s.requireActor()),t=latest(s,w),p=enrollment(s,w.role),snapshot=JSON.parse(w.context);ownCaller(w);permitted(s,p);
  check(w.state==='reconciling' && t.state==='reconciling' && t.bootstrap_released_at,'Bootstrap is not released for reconciliation',4);
  check(externalId!==JSON.parse(t.payload).previous_external_id,'A distinct conversation identity is required',4);text(externalId,'provider conversation identity',200);
  check(!s.get('SELECT id FROM sessions WHERE provider=? AND external_id=? AND (pid IS NULL OR pid!=? OR process_start IS NULL OR process_start!=?)',w.provider,externalId,w.pid,w.process_start),'Conversation identity was already used by another process/generation',4);
  snapshotEqual(s,w.role,p,snapshot);
  // Read recovery inputs without consuming receipts or advancing progress.
  const initial=context(s),mail=inbox(s,{peek:true,limit:100});
  return s.tx(()=>{
    permitted(s,p);reservationEqual(s,w.role,snapshot);check(worker(s,w.role).state==='reconciling','Generation changed',4);
    const session=registerSession(s,{provider:w.provider,external_id:externalId,pid:w.pid,replace:true});
    let binding:Row;
    if(w.binding_id){binding=currentBinding(s,p.task);check(binding.id===w.binding_id,'Binding changed',4);s.run('UPDATE checkout_bindings SET provider_session_id=?,session_row_id=? WHERE id=?',externalId,id(session.id,'S'),binding.id);}
    else binding=bindCheckout(s,{checkout:p.checkout,directory:p.cwd,task:p.task,provider:w.provider,session:externalId});
    s.run("UPDATE managed_workers SET state='running',binding_id=?,external_id=?,updated_at=? WHERE id=?",binding.id,externalId,now(),w.id);
    s.run("UPDATE managed_transitions SET state='complete',updated_at=? WHERE id=?",now(),t.id);
    s.event('managed-transition',t.id,'attended-reconciled',{generation:w.generation,external_id:externalId,handled_cursor:snapshot.notification_progress.cursor,context_cursor:initial.cursor,read_mail:mail.map(row=>row.id),evidence_kind:kind});
    return {state:'running',generation:w.generation,task:p.task,handled_cursor:snapshot.notification_progress.cursor};
  });
}
export function readyAttended(s:Store,report:unknown,expected:number):Row {
  const w=worker(s,s.requireActor()),p=enrollment(s,w.role),reported=validateBriefInput(report);ownCaller(w);permitted(s,p);
  check(w.state==='running','Worker must be running before cooperative handover',4);settled(s,w.role);
  const snapshot=attendedSnapshot(s,w.role,p,JSON.parse(w.context).configuration),binding=currentBinding(s,p.task);
  check(s.task(p.task).version===expected,'Task version changed',4);check(reported.configuration.digest===snapshot.configuration_digest,'Brief configuration digest differs',4);
  const body={version:1,reported,observed:{...snapshot,worker_generation:w.generation,binding_id:binding.id},readiness:'cooperative-attended; worker declares every tool/background job settled; no enforced barrier or escape containment'};
  check(Buffer.byteLength(JSON.stringify(body))<=32768,'Complete attended brief exceeds 32768 bytes');
  return s.tx(()=>{
    permitted(s,p);check(worker(s,w.role).state==='running','Generation changed',4);reservationEqual(s,w.role,snapshot);settled(s,w.role);
    const brief=randomUUID(),transition=randomUUID(),at=now();
    s.run('INSERT INTO task_briefs VALUES(?,?,?,?,?,?,?,?)',brief,s.ws,id(p.task,'T'),w.role,binding.id,JSON.stringify(body),digest(body),at);
    const pending=s.event('task-handoff',p.task,'pending',{to:w.generation===2?null:w.role,summary:reported.next_action,brief_id:brief,brief_digest:digest(body),task_version:expected,binding_id:binding.id,worker_id:w.id,generation:w.generation,successor_generation:w.generation===2?null:2,mode:kind});
    const payload={pending_handoff_event:`E${pending}`,operation:'attended-handoff',context:snapshot,launch_id:JSON.parse(w.context).launch_id,terminal:JSON.parse(w.context).terminal,completion:w.generation===2};
    s.run('INSERT INTO managed_transitions(id,worker_id,generation,idempotency_key,state,expected_task_versions,brief_id,created_at,updated_at,payload) VALUES(?,?,?,?,?,?,?,?,?,?)',transition,w.id,w.generation,`ready-${w.generation}`,'ready',JSON.stringify(snapshot.task_versions),brief,at,at,JSON.stringify(payload));
    const old=getWip(s);const wip=setWip(s,{current:reported.objective,next:reported.next_action,notes:`Cooperative attended generation ${w.generation} ready. Complete immutable brief ${brief}. All tools/waiters/background work declared settled. Start nothing; remain silent awaiting retirement.`,expected_version:old.version});
    const checkpoint={format:CHECKPOINT_FORMAT,wip,fingerprint:checkpointFingerprint(s,w.role),evidence:{version:1,observed:{repository:{status:'available',observed_at:at,directory:p.cwd,root:snapshot.identity.checkout_root,git_dir:snapshot.identity.git_dir,common_dir:snapshot.identity.git_common_dir,branch:snapshot.identity.branch,head:snapshot.identity.head,dirty:snapshot.manifest.length>0,reason:null},tasks:observeTasks(s,w.role),notification_progress:snapshot.notification_progress},reported:{version:1,validation:reported.validation,artifacts:reported.artifacts,jobs:reported.jobs.map(job=>({id:job.id,description:job.evidence,state:job.state,disposition:'finish'}))}}};
    check(Buffer.byteLength(JSON.stringify(checkpoint))<=MAX_CHECKPOINT_BYTES,'Complete attended checkpoint exceeds its bound');s.event('checkpoint',w.role,'saved',checkpoint);
    s.run("UPDATE managed_workers SET state='ready',context=?,updated_at=? WHERE id=?",JSON.stringify({...snapshot,launch_id:payload.launch_id,terminal:payload.terminal}),at,w.id);
    s.event('managed-transition',transition,'attended-ready',{generation:w.generation,brief_id:brief,evidence_kind:kind});
    return {state:'ready',generation:w.generation,brief_id:brief,instruction:'Start no tools, waiter or background work. Remain silent awaiting attended retirement.'};
  });
}
async function idle(s:Store,p:Row,lease:SupervisorLease):Promise<void> {
  lease.assertHeld();permitted(s,p);
  check(!s.get("SELECT id FROM jobs WHERE status IN ('waiting','running') OR (orphans IS NOT NULL AND orphans!='[]') LIMIT 1"),'Machine has running or unknown jobs',4);
  const checks=workspaceSettings(s).busy_checks;check(checks.length>0,'Missing busy guards are not idle',4);
  check((await observeBusyChecks(checks)).every(row=>row.state==='idle'),'Busy or unknown gate/merge/release/heavy guard',4);
  lease.assertHeld();permitted(s,p);
}
function snapshotOf(w:Row):Row {
  const {launch_id,terminal,...snapshot}=JSON.parse(w.context);return snapshot;
}
function guarded(s:Store,p:Row,w:Row):Row {
  permitted(s,p);settled(s,w.role);snapshotEqual(s,w.role,p,snapshotOf(w));
  const launch=s.get('SELECT payload FROM managed_transitions WHERE worker_id=? AND generation=? AND bootstrap_released_at IS NOT NULL ORDER BY rowid DESC LIMIT 1',w.id,w.generation);check(launch,'Owned launch release record is missing',4);
  const holder=JSON.parse(launch.payload);check(processIdentity(holder.holder_pid)===holder.holder_start || ['retiring','exited'].includes(w.state) && processObservation(w).exited,'PTY holder identity is unknown',4);
  const t=latest(s,w),body=s.get('SELECT * FROM task_briefs WHERE id=? AND workspace_id=?',t.brief_id,s.ws);
  check(body && digest(JSON.parse(body.body))===body.digest,'Complete immutable handover brief is missing',4);
  const brief=JSON.parse(body.body);check(digest(brief.observed.manifest)===digest(snapshotOf(w).manifest) && brief.observed.worker_generation===w.generation,'Brief does not bind this generation',4);
  const observation=processObservation(w);
  check(observation.exited || observation.live_members.length===1 && observation.live_members[0].pid===w.pid,'Other live group members block retirement',4);
  const identityOnly=(row:Row|null)=>row?{pid:row.pid,group:row.group,session:row.session,start:row.start}:null;
  const stableObservation={leader:identityOnly(observation.leader),live_members:observation.live_members.map(identityOnly),exited:observation.exited};
  return {transition:t.id,brief_id:t.brief_id,generation:w.generation,pid:w.pid,process_start:w.process_start,pgid:w.pid,checkout:p.cwd,head:brief.observed.identity.head,dirty:brief.observed.manifest,successor:w.generation===2?'final stop':`generation ${w.generation+1}`,observation:stableObservation};
}
function prepareRuntime(s:Store,p:Row,generation:number):string {
  const directory=join(dirname(s.path),`.sat-${p.controller_id.slice(0,12)}-${generation}`);check(Buffer.byteLength(join(directory,'terminal.sock'))<104,'Database parent path is too long for an attended Unix terminal socket',4);return directory;
}
function createRuntime(directory:string):void {
  mkdirSync(directory,{mode:0o700});
  for(const cli of ['sassato','sas']){const target=join(directory,cli);check(!existsSync(target),'Runtime already exists; reconcile uncertain startup instead of spawning again',4);symlinkSync(fileURLToPath(new URL('../bin/sassato.js',import.meta.url)),target);}
}
function intent(s:Store,p:Row,snapshot:Row,previous?:Row):{w:Row;t:Row;token:string;launch:string} {
  const generation=previous?previous.generation+1:1;check(generation<=2,'The attended probe has exactly two generations');
  const terminal=prepareRuntime(s,p,generation),token=randomBytes(32).toString('hex'),launch=randomBytes(32).toString('hex'),workerId=previous?.id??randomUUID(),transitionId=randomUUID(),launchId=randomUUID();
  s.tx(()=>{
    permitted(s,p);reservationEqual(s,p.role,snapshot);
    const current=s.get('SELECT * FROM managed_workers WHERE role=?',p.role);
    check(previous?current?.state==='exited' && current.generation===previous.generation:!current,'Existing generation/uncertain launch blocks spawning',4);
    if(!previous){
      check(!s.get('SELECT id FROM checkout_bindings WHERE released_at IS NULL AND (role=? OR checkout_id=?)',p.role,p.checkout),'Checkout is already bound',4);
      check(!s.get('SELECT id FROM managed_workers WHERE checkout_id=?',p.checkout),'Checkout has a durable managed reservation',4);
      check(s.all('SELECT * FROM sessions WHERE role=?',p.role).every(row=>row.pid && row.process_start && ['ended','stale'].includes(sessionState(row))),'Existing live or unknown sessions are observe-only',4);
      s.run('INSERT INTO managed_workers(id,workspace_id,role,controller_id,generation,token_hash,state,provider,configuration_digest,updated_at,context,checkout_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',workerId,s.ws,p.role,p.controller_id,generation,workerTokenHash(token),'starting',snapshot.configuration.provider,snapshot.configuration_digest,now(),JSON.stringify({...snapshot,launch_id:launchId,terminal}),p.checkout);
    }else s.run("UPDATE managed_workers SET generation=?,token_hash=?,state='starting',pid=NULL,process_start=NULL,configuration_digest=?,context=?,updated_at=? WHERE id=?",generation,workerTokenHash(token),snapshot.configuration_digest,JSON.stringify({...snapshot,launch_id:launchId,terminal}),now(),workerId);
    const prior=previous?latest(s,previous):null;
    if(prior){s.run("UPDATE managed_transitions SET state='complete',updated_at=? WHERE id=?",now(),prior.id);s.event('task-handoff',p.task,'finalized',{pending_event:JSON.parse(prior.payload).pending_handoff_event,brief_id:prior.brief_id,binding_id:previous!.binding_id,retired_generation:previous!.generation,successor_generation:generation,to:p.role,mode:kind});}
    const payload={operation:'attended-launch',context:snapshot,terminal,launch_id:launchId,bootstrap_deadline:new Date(Date.now()+120000).toISOString(),previous_brief:prior?.brief_id??null,previous_external_id:previous?.external_id??null};
    s.run('INSERT INTO managed_transitions(id,worker_id,generation,idempotency_key,state,expected_task_versions,launch_token_hash,created_at,updated_at,payload) VALUES(?,?,?,?,?,?,?,?,?,?)',transitionId,workerId,generation,launchId,'starting',JSON.stringify(snapshot.task_versions),workerTokenHash(launch),now(),now(),JSON.stringify(payload));
    s.event('managed-transition',transitionId,'attended-launch-intent',{generation,role:p.role,launch_id:launchId,evidence_kind:kind});
  });
  return {w:worker(s,p.role),t:latest(s,worker(s,p.role)),token,launch};
}
export function attendedPrompt(s:Store,w:Row):string {
  const p=enrollment(s,w.role),a=`--as ${w.role} --workspace ${s.workspace}`;
  return `You are a disposable cooperative attended supervisor probe, generation ${w.generation}. Never alter provider/host configuration, hooks or permissions. Settle ALL tools, nested/background/detached jobs and waiter before readiness. Process-group checks do not prove escaped work absent. No existing sessions are yours. Keep native compaction enabled. First read sassato supervise assignment ${a}, context, checkpoint, inbox --peek and live task ${p.task}, then verify Git/dirty files. Call sassato supervise reconcile --session-id YOUR_ACTUAL_NEW_CONVERSATION_ID ${a}; this is a new conversation, never resume another. Read the previous brief using brief show ${p.task} if present. Preserve the safely handled notification cursor and reconcile its unhandled mail once (legitimate redelivery is possible). At safe tool boundaries inspect and acknowledge generation-bound supervisor pings through sassato supervise ack NONCE --generation GENERATION, after reconciling context. A missed ping never permits termination. Task: generation1 writes exactly 'line one\\n' to attended-probe.txt and commits ONLY that file; also create uncommitted attended-sentinel.txt with 'keep these bytes\\n'. Generation2 MUST verify and preserve sentinel bytes, verify line one, append 'line two\\n' and commit ONLY attended-probe.txt. Commits include Signed-off-by: Johan Ekenlycka <johan@smithable.ai> and Co-Authored-By: Claude <noreply@anthropic.com>. Do not amend/reset/stash/switch/delete. Do not commit the sentinel. Save a complete JSON BriefInput report (version1, objective, acceptance[], decisions[{decision,source}], open_issues[], validation[{command,result}], artifacts[], next_action, configuration{digest: assignment.configuration_digest,provenance:['recorded attended configuration subset']}, jobs[]). Put this temporary report outside the scratch Git checkout; record its path as an artifact. Use sassato supervise ready --file REPORT --expect CURRENT_TASK_VERSION ${a} as your LAST tool call. After it succeeds remain silent, start no new tool, waiter or background work, and do not end your session or launch another. Never relax a failed guard. If STOP, checkpoint/stopped as instructed by live context and remain idle.`;
}
async function launchIntent(s:Store,p:Row,i:ReturnType<typeof intent>,lease:SupervisorLease):Promise<void> {
  // Final idle/snapshot observations precede intent creation in the caller.
  check(i.t.state==='starting' && !i.t.bootstrap_pid,'Uncertain or already registered launch may not spawn again',4);
  permitted(s,p);lease.assertHeld();
  const terminal=JSON.parse(i.t.payload).terminal;createRuntime(terminal);
  permitted(s,p);lease.assertHeld();
  const child=spawn('python3',['-B',ptyHelper,'holder',terminal,process.execPath,bootstrap],{detached:true,stdio:'ignore',shell:false,env:{...process.env,PATH:[terminal,dirname(process.execPath),process.env.PATH??''].join(':'),SASSATO_DB:s.path,SASSATO_WORKSPACE:s.workspace,SASSATO_ROLE:p.role,SASSATO_WORKER_GENERATION:String(i.w.generation),SASSATO_WORKER_TOKEN:i.token,SASSATO_ATTENDED_LAUNCH_TOKEN:i.launch,SASSATO_ATTENDED_TRANSITION:i.t.id}});
  await new Promise<void>((resolve,reject)=>{child.once('spawn',()=>resolve());child.once('error',reject);});child.unref();
  const holderStart=child.pid?processIdentity(child.pid):null;check(child.pid && holderStart,'Spawned PTY holder identity is unavailable; no retry',4);
  s.tx(()=>{permitted(s,p);const t=latest(s,worker(s,p.role));check(t.id===i.t.id && t.state==='starting','Startup changed after spawn',4);const payload=JSON.parse(t.payload);check(!payload.holder_pid || payload.holder_pid===child.pid && payload.holder_start===holderStart,'Unexpected bootstrap holder identity',4);s.run('UPDATE managed_transitions SET payload=?,updated_at=? WHERE id=?',JSON.stringify({...payload,spawned_holder_pid:child.pid,spawned_holder_start:holderStart}),now(),t.id);});
  const deadline=Date.now()+120000;
  while(Date.now()<deadline){
    permitted(s,p);const t=latest(s,worker(s,p.role));
    if(t.bootstrap_pid){await releaseAttendedBootstrap(s,p,t,lease);return;}
    check(child.exitCode===null && child.signalCode===null,'PTY holder exited during startup; no retry',4);await pause();
  }
  check(false,'Bootstrap registration deadline elapsed; uncertain startup blocks without retry',4);
}
async function releaseAttendedBootstrap(s:Store,p:Row,t:Row,lease:SupervisorLease):Promise<void> {
  const w=worker(s,p.role),payload=JSON.parse(t.payload);await idle(s,p,lease);snapshotEqual(s,p.role,p,payload.context);
  check(t.state==='starting' && !t.bootstrap_released_at && t.bootstrap_start && processIdentity(t.bootstrap_pid)===t.bootstrap_start,'Bootstrap ownership is unknown',4);
  check(payload.holder_pid===payload.spawned_holder_pid && payload.holder_start===payload.spawned_holder_start && processIdentity(payload.holder_pid)===payload.holder_start && Date.now()<Date.parse(payload.bootstrap_deadline),'PTY holder identity or bootstrap deadline invalid',4);
  s.tx(()=>{
    permitted(s,p);reservationEqual(s,p.role,payload.context);lease.assertHeld();
    const fresh=latest(s,worker(s,p.role));check(fresh.id===t.id && fresh.state==='starting','Launch changed',4);
    s.run("UPDATE managed_transitions SET state='reconciling',bootstrap_released_at=?,updated_at=? WHERE id=?",now(),now(),t.id);
    s.run("UPDATE managed_workers SET state='reconciling',pid=?,process_start=?,updated_at=? WHERE id=?",t.bootstrap_pid,t.bootstrap_start,now(),w.id);
    s.event('managed-transition',t.id,'attended-bootstrap-released',{generation:w.generation,pid:t.bootstrap_pid,process_start:t.bootstrap_start,holder_pid:payload.holder_pid,holder_start:payload.holder_start,evidence_kind:kind});
  });
}
export async function attachAttended(s:Store,role:string):Promise<void> {
  s.requireHuman();check(process.stdin.isTTY && process.stdout.isTTY,'Attach requires a separate human terminal',3);
  const w=worker(s,name(role)),p=enrollment(s,w.role),t=latest(s,w),launch=s.get('SELECT payload FROM managed_transitions WHERE worker_id=? AND generation=? AND bootstrap_released_at IS NOT NULL ORDER BY rowid DESC LIMIT 1',w.id,w.generation);
  check(launch && !['exited','stopped'].includes(w.state),'No live attended terminal',4);
  const payload=JSON.parse(launch.payload);check(processIdentity(payload.holder_pid)===payload.holder_start,'PTY holder is unavailable',4);
  check(!stopped(s,p),'STOP prevents terminal attach',4);
  const child=spawn('python3',['-B',ptyHelper,'attach',join(payload.terminal,'terminal.sock')],{stdio:'inherit',shell:false});
  const result=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});check(result===0,'Provider terminal disconnected',4);void t;
}
export async function runAttended(human:Store,role:string):Promise<Row> {
  human.requireHuman();check(process.platform==='linux' && process.stdin.isTTY && process.stdout.isTTY,'Attended mode requires a human Linux terminal',3);
  const p=enrollment(human,name(role));permitted(human,p);
  const s=new Store(human.path,p.controller_role);s.use(human.workspace);
  const controller=acquireSupervisorLock(p.controller_lock,'exclusive');let maintenance:SupervisorLease|undefined;
  try {
    const prior=s.get('SELECT * FROM managed_controllers WHERE id=?',p.controller_id);
    check(!prior || prior.role===p.controller_role && prior.lock_path===controller.path && prior.pid && prior.process_start && positivelyGone(prior.pid,prior.process_start),'Previous controller is live or uncertain; do not take over',4);
    s.tx(()=>{
      permitted(s,p);
      if(prior)s.run('UPDATE managed_controllers SET pid=?,process_start=? WHERE id=?',process.pid,processIdentity(process.pid),p.controller_id);
      else s.run('INSERT INTO managed_controllers VALUES(?,?,?,?,?,?,?)',p.controller_id,s.ws,p.controller_role,controller.path,process.pid,processIdentity(process.pid),now());
    });
    let w=s.get('SELECT * FROM managed_workers WHERE role=?',p.role);
    if(!w){
      const cfg=attendedConfiguration(s,p.role),snapshot=attendedSnapshot(s,p.role,p,cfg);
      check(s.task(p.task).owner===p.role && s.task(p.task).status==='doing','Assignment changed',4);
      maintenance=acquireSupervisorLock(p.maintenance_lock,'exclusive');await idle(s,p,maintenance);
      snapshotEqual(s,p.role,p,snapshot);
      const i=intent(s,p,snapshot);await launchIntent(s,p,i,maintenance);maintenance.close();maintenance=undefined;
    }
    console.log(`Cooperative attended probe ${p.role}. Unattended management remains OFF. Open a SECOND terminal: sassato supervise attach --role ${p.role} --as ${human.requireActor()} --workspace ${human.workspace} --db ${s.path}`);
    for(;;){
      controller.assertHeld();permitted(s,p);w=worker(s,p.role);check(w.controller_id===p.controller_id,'Controller ownership changed',4);
      let t=latest(s,w);
      if(w.state==='stopped'){check(t.reason==='completed','Stopped generation requires human reconciliation',4);return {role:p.role,state:'stopped',reason:'completed',generation:w.generation,unattended_enabled:false};}
      if(w.state==='starting'){
        // Startup intent already exists: a restart never repeats its spawn.
        check(t.bootstrap_pid && t.bootstrap_start,'Unregistered startup is uncertain; no automatic retry',4);
        maintenance=acquireSupervisorLock(p.maintenance_lock,'exclusive');await releaseAttendedBootstrap(s,p,t,maintenance);maintenance.close();maintenance=undefined;continue;
      }
      if(['running','reconciling','draining'].includes(w.state)){
        check(w.pid && processIdentity(w.pid)===w.process_start,'Released worker exited or changed before handover; human reconciliation required',4);if(w.state==='running')requestSupervisorPing(s,p.role);await pause();continue;
      }
      check(['ready','retiring','exited'].includes(w.state),'Blocked/unknown attended state; reconcile without relaunch',4);
      const proposal=guarded(s,p,w);
      if(!proposal.observation.exited){
        process.stdin.pause();while(process.stdin.read()!==null){/* Discard input buffered before this proposal. */}
        const flushed=spawnSync('python3',['-B',ptyHelper,'flush'],{stdio:['inherit','ignore','pipe'],timeout:2000,shell:false});check(!flushed.error && flushed.status===0,'Could not flush stale confirmation input',4);
        console.log(JSON.stringify({retirement:proposal},null,2));
        const terminal=createInterface({input:process.stdin,output:process.stdout});
        let answer:string;try{answer=await terminal.question('Press Enter to retire this exact generation (anything else cancels): ');}finally{terminal.close();}
        check(answer==='','Retirement was not approved',4);
        check(process.stdin.isTTY && process.stdout.isTTY,'Confirmation terminal was lost',4);
        maintenance=acquireSupervisorLock(p.maintenance_lock,'exclusive');await idle(s,p,maintenance);
        const after=guarded(s,p,worker(s,p.role));
        const exitedFromPriorRequest=w.state==='retiring' && after.observation.exited;
        check(exitedFromPriorRequest?digest({...proposal,observation:null})===digest({...after,observation:null}):digest(proposal)===digest(after),'Observation changed after Enter; fresh reconciliation/approval required',4);
        if(!exitedFromPriorRequest){
        s.tx(()=>{permitted(s,p);s.run("UPDATE managed_workers SET state='retiring',updated_at=? WHERE id=?",now(),w!.id);s.run("UPDATE managed_transitions SET state='retiring',updated_at=? WHERE id=?",now(),t.id);s.event('managed-transition',t.id,'attended-retirement-requested',{generation:w!.generation,pid:w!.pid,process_start:w!.process_start});});
        permitted(s,p);maintenance.assertHeld();const exit=processObservation({...w,signal_guards:{db:s.path,workspace:s.ws,roles:[p.role,p.controller_role],stop_file:workspaceSettings(s).stop_file,worker_id:w.id,generation:w.generation,task_versions:snapshotOf(w).task_versions,notification_progress:snapshotOf(w).notification_progress,node:process.execPath,busy_helper:fileURLToPath(new URL('./attended-checks.js',import.meta.url)),busy_checks:p.busy_checks}},true);check(exit.exited,'Whole observed group did not exit',4);
        }
      }else {
        check(['retiring','exited'].includes(w.state),'Worker exited before a recorded retirement request; no successor',4);
        maintenance=acquireSupervisorLock(p.maintenance_lock,'exclusive');await idle(s,p,maintenance);
      }
      snapshotEqual(s,p.role,p,snapshotOf(w));permitted(s,p);const exit=processObservation(w);check(exit.exited,'Exit is uncertain',4);
      s.tx(()=>{
        permitted(s,p);s.run("UPDATE managed_workers SET state='exited',updated_at=? WHERE id=?",now(),w!.id);s.run("UPDATE managed_transitions SET state='exited',updated_at=? WHERE id=?",now(),t.id);s.event('managed-transition',t.id,'attended-exit-verified',{generation:w!.generation,pid:w!.pid,process_start:w!.process_start,observation:exit});
        // This is a verified physical exit, never an artificial live session end.
        s.run('UPDATE sessions SET ended_at=?,last_seen_at=? WHERE workspace_id=? AND role=? AND pid=? AND process_start=? AND ended_at IS NULL',now(),now(),s.ws,w!.role,w!.pid,w!.process_start);
      });
      w=worker(s,p.role);t=latest(s,w);
      if(w.generation===2){
        s.tx(()=>{
          permitted(s,p);reservationEqual(s,w!.role,snapshotOf(w!));
          s.run("UPDATE managed_workers SET state='stopped',checkout_id=NULL,updated_at=? WHERE id=?",now(),w!.id);
          s.run("UPDATE managed_transitions SET state='stopped',reason='completed',updated_at=? WHERE id=?",now(),t.id);
          s.run('UPDATE checkout_bindings SET released_at=? WHERE id=?',now(),w!.binding_id);
          const task=s.task(p.task);check(task.owner===p.role && task.status==='doing','Task disposition changed',4);
          s.run("UPDATE tasks SET status='done',version=version+1,completed_at=?,updated_at=?,lease_until=NULL WHERE workspace_id=? AND id=?",now(),now(),s.ws,id(p.task,'T'));
          s.event('task',p.task,'attended-completed',{brief_id:t.brief_id,generation:2,owner:p.role});
          s.event('task-handoff',p.task,'finalized',{pending_event:JSON.parse(t.payload).pending_handoff_event,brief_id:t.brief_id,binding_id:w!.binding_id,retired_generation:2,successor_generation:null,to:null,reason:'completed',mode:kind});
          s.event('managed-transition',t.id,'attended-stopped',{reason:'completed',generation:2,brief_id:t.brief_id,binding_released:w!.binding_id});
        });
        maintenance!.close();maintenance=undefined;console.log('Generation 2 exited; probe completed. No generation 3; unattended mode stays OFF.');
        return {role:p.role,state:'stopped',reason:'completed',generation:2,unattended_enabled:false};
      }
      await idle(s,p,maintenance!);snapshotEqual(s,p.role,p,snapshotOf(w));
      const i=intent(s,p,snapshotOf(w),w);await launchIntent(s,p,i,maintenance!);maintenance!.close();maintenance=undefined;
      console.log('Generation 2 released; attach from the separate provider terminal.');
    }
  }finally{maintenance?.close();controller.close();s.close();}
}
