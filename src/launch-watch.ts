// An explicit human enrollment of an already-attached Codex thread. No provider launch,
// transcript access, approval forwarding or automatic re-enrollment.
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { check, name } from './errors.js';
import { sessionState, send } from './coordination.js';
import { acquireLaunchLock, resolveExecutable } from './launch.js';
import { assertOrdinaryLaunchAllowed } from './launch-admission.js';
import { waitForWork } from './mail-wait.js';
import { getNotificationProgress } from './notification-progress.js';
import { enrollPendingWake, enrollment, closePendingWake, pendingStop, stagePendingWake } from './pending-wake.js';
import { queueClient } from './queue-client.js';
import { Store } from './storage.js';
import { workspaceSettings, checkCodexVersion } from './workspace-settings.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const deadlineMs=300_000;
// A queue call on a loaded machine (a gate running) can take more than ten seconds: wait up to 30, and after a
// timeout try once more after a short pause (T663). A timed-out call may still have queued its line; a second
// "run sas wake --pending" line is harmless, since the pending result is consumed once.
const queueTimeoutMs=30_000,retryPauseMs=2_000;
// Mail and status carry a fixed reason only, never provider output: the full error stays in the launcher's terminal.
// Each pattern is anchored at the start of sassato's own message, so quoted provider output cannot pick a reason.
const reasons:[RegExp,string][]=[
  [/^Cannot read the Codex CLI version/,'Codex CLI version unreadable'],
  [/^Codex CLI [0-9.]+ is older than/,'Codex CLI older than the oldest supported version'],
  [/^Required Codex queue interface unavailable/,'Codex queue interface unavailable'],
  [/^Watcher session, endpoint or configuration changed/,'session, endpoint or configuration changed'],
  [/^Close the existing waiter enrollment/,'an earlier enrollment is still open'],
  [/^Reconcile the role’s notification progress/,'notification progress missing'],
  [/^Queue delivery is uncertain/,'queue delivery uncertain'],
  [/^Five minutes elapsed/,'no worker receipt within five minutes'],
];
/** The only reasons a watcher event carries; status shows any other stored text as the last one. */
export const WATCH_REASONS=new Set([...reasons.map(([,reason])=>reason),'interrupted','see the launcher terminal']);
const reasonOf=(error:unknown)=>{
  const text=String(error instanceof Error?error.message:error);
  return reasons.find(([pattern])=>pattern.test(text))?.[1]??'see the launcher terminal';
};

// Every folder from this one up to the root is the user's or root's, and only those can replace its entries:
// not writable by group or others unless sticky (as /tmp is).
function guarded(dir:string,uid:number|undefined):boolean {
  const st=statSync(dir,{bigint:true});
  const safe=(Number(st.uid)===uid || st.uid===0n) && ((st.mode & 0o022n)===0n || (st.mode & 0o1000n)!==0n);
  return safe && (dir==='/' || guarded(dirname(dir),uid));
}

function session(s: Store, thread: string, remote: string) {
  const role=s.requireActor();
  assertOrdinaryLaunchAllowed(s,role);
  const config=s.role(role);
  check(config.provider==='codex' && config.kind==='agent','Watch requires a Codex agent role',3);
  const row=s.get('SELECT * FROM sessions WHERE workspace_id=? AND role=? ORDER BY id DESC LIMIT 1',s.ws,role);
  check(row?.provider==='codex' && !row.ended_at && row.external_id===thread && sessionState(row)==='running',
    'Watch requires the live registered Codex remote TUI',4);
  const args=readFileSync(`/proc/${row.pid}/cmdline`,'utf8').split('\0').filter(Boolean);
  // Accept the documented explicit attach forms only. Do not infer a selected thread from a picker.
  const tail=args.slice(/^(?:node|nodejs)$/.test(args[0].split('/').at(-1)??'')?2:1);
  check(JSON.stringify(tail)===JSON.stringify(['--remote',remote,'resume',thread]) ||
    JSON.stringify(tail)===JSON.stringify(['resume',thread,'--remote',remote]),
    'Expected a Codex TUI attached with --remote ENDPOINT resume UUID',4);
  // Codex 0.167 links the given path to its real socket. Follow the user's own link only through folders no one
  // else can change, bind the identity to the socket itself, and send the queue calls to that resolved path.
  const given=remote.slice(7),uid=process.getuid?.(),link=lstatSync(given,{bigint:true});
  const target=realpathSync(given),endpoint=statSync(target,{bigint:true});
  check(Number(link.uid)===uid && endpoint.isSocket() && Number(endpoint.uid)===uid &&
    guarded(realpathSync(dirname(given)),uid) && guarded(dirname(target),uid),
    'Expected a local Unix socket owned by the current user, in a folder only that user can change',4);
  return {session:row.id as number,thread,pid:row.pid,start:row.process_start,
    socket:`${endpoint.dev}:${endpoint.ino}:${endpoint.ctimeNs}`,endpoint:`unix://${target}`,cwd:realpathSync(config.working_dir),
    policy:JSON.stringify([config.model,config.reasoning_effort,config.sandbox_mode,config.approval_policy,config.permission_mode,workspaceSettings(s).stop_file])};
}

/** Report only durable identifiers. An open epoch survives a crashed watcher. */
export function watchStatus(s:Store,role:string) {
  s.role(name(role));
  const latest=(entity:string)=>s.get('SELECT id,action,detail FROM events WHERE workspace_id=? AND entity=? AND entity_id=? ORDER BY id DESC LIMIT 1',s.ws,entity,role);
  const registration=latest('wake-enrollment');
  const epoch=registration?.action==='opened'?registration.id:null;
  const result=latest('wake-delivery');
  const pending=epoch && result?.action==='pending' && JSON.parse(result.detail).epoch===epoch ? result.id:null;
  return {role,epoch,pending,progress:getNotificationProgress(s,role)?.cursor??null};
}

export function reconcileWatch(operator:Store,role:string,epoch:number) {
  operator.requireHuman();name(role);
  const release=acquireLaunchLock(operator,role);
  try {
    const worker=new Store(operator.path,role);
    try {worker.use(operator.workspace);closePendingWake(worker,epoch);}
    finally {worker.close();}
    operator.event('watch',role,'reconciled',{epoch});
    return {closed:epoch,progress:'preserved'};
  } finally {release();}
}

export async function launchWatch(operator:Store,role:string,remote:string,thread:string,clock=()=>performance.now(),timing={queueTimeoutMs,retryPauseMs}) {
  const human=operator.requireHuman();name(role);
  // Every refused start past this point is recorded and mailed (T663).
  const refused=(error:unknown)=>{
    const reason=reasonOf(error);
    record(operator,role,'refused',{reason});
    warnHuman(operator,human,`The Codex waiter for ${role} did not start: ${reason}.`);
    return error;
  };
  let release:()=>void;
  try {
    check(uuid.test(thread),'A registered Codex thread UUID is required');
    check(/^unix:\/\/\/[^\s\0]+$/.test(remote),'Use an explicit local unix:///absolute/path endpoint');
    release=acquireLaunchLock(operator,role);
  } catch(error) {throw refused(error);}
  try {
    let s:Store;
    try {s=new Store(operator.path,role);} catch(error) {throw refused(error);}
    try {
      try {s.use(operator.workspace);} catch(error) {throw refused(error);}
      return await observe(s,human,remote,thread,clock,timing,refused);
    } finally {s.close();}
  } finally {release();}
}

// One urgent mail to the workspace's default human (else the human who started the watch): fixed text, the role
// and the reason only, so a watcher that stops is seen by someone and not only in a terminal tab (T663).
/** A watcher event on a failure path: a failed write (a busy database) must not replace the failure or stop the mail. */
function record(s:Store,role:string,action:string,detail:Record<string,unknown>) {
  try {s.event('watch-dispatch',role,action,detail);}
  catch(error) {console.error(`Could not record the watcher's ${action}: ${error instanceof Error?error.message:error}`);}
}
function warnHuman(s:Store,human:string,text:string) {
  try {send(s,[workspaceSettings(s).default_human??human],text,{urgent:true});}
  catch(error) {console.error(`Could not send the urgent mail: ${error instanceof Error?error.message:error}`);}
}

async function observe(s:Store,human:string,remote:string,thread:string,clock:()=>number,timing:{queueTimeoutMs:number;retryPauseMs:number},refused:(error:unknown)=>unknown) {
  const role=s.requireActor();
  let bound:ReturnType<typeof session>,client:string,pinned:string,options:{cwd:string},epoch:number;
  const clientIdentity=()=>{const st=statSync(client,{bigint:true});return [st.dev,st.ino,st.ctimeNs].join(':');};
  const identity=()=>check(pinned===clientIdentity() && JSON.stringify(session(s,thread,remote))===JSON.stringify(bound),
    'Watcher session, endpoint or configuration changed',4);
  try {
    bound=session(s,thread,remote);client=realpathSync(resolveExecutable('codex',true));
    pinned=clientIdentity();options={cwd:bound.cwd};
    // A notice on stderr (an update hint) is accepted for these two reads when the exit and the answer are right;
    // the queue call itself stays strict (T664).
    const version=await queueClient(client,['--version'],options);
    check(version.code===0 && !version.timedOut,'Cannot read the Codex CLI version',4);
    const {warning}=checkCodexVersion(workspaceSettings(s),version.stdout);
    if(warning)console.error(warning);
    const help=await queueClient(client,['queue','--help'],options);
    check(help.code===0 && !help.timedOut && ['thread','message','resume','remote'].every(flag=>new RegExp(`--${flag}\\b`).test(help.stdout)),'Required Codex queue interface unavailable',4);
    identity();
    check(getNotificationProgress(s),'Reconcile the role’s notification progress before enrollment',4);
    epoch=enrollPendingWake(s,{session:bound.session,thread});
  } catch(error) {throw refused(error);}
  console.error(`Watching ${role} (enrollment E${epoch}). Interrupt to suspend; reconcile explicitly before restarting.`);
  const controller=new AbortController(),cancel=()=>controller.abort();
  process.on('SIGTERM',cancel);process.on('SIGINT',cancel);
  const messages=new Map<string,{at:number;reported:boolean}>(),deliveredMail=new Set<string>();
  const alert=(message:string)=>send(s,[human],`Waiter for ${role}, enrollment E${epoch}: ${message}`);
  const exited=(error:unknown)=>{
    const reason=reasonOf(error);
    record(s,role,'exited',{epoch,reason});
    warnHuman(s,human,`The Codex waiter for ${role} stopped: ${reason}. Nothing wakes ${role} until it is started again; sassato watch-status ${role} shows enrollment E${epoch}.`);
  };
  const inspect=()=>{
    controller.signal.throwIfAborted();identity();
    if(pendingStop(s))return;
    enrollment(s,epoch);
    if(!messages.size)return;
    const unhandled=new Set(s.all(`SELECT message_id FROM receipts WHERE workspace_id=? AND recipient=? AND state!='done'
      AND message_id IN (SELECT value FROM json_each(?))`,s.ws,role,JSON.stringify(Array.from(messages.keys(),id=>Number(id.slice(1)))))
      .map(row=>'M'+row.message_id));
    const overdue:string[]=[];
    for(const [id,status] of messages) {
      if(!unhandled.has(id)){messages.delete(id);deliveredMail.delete(id);}
      else if(!status.reported && clock()-status.at>=deadlineMs){overdue.push(id);status.reported=true;}
    }
    if(overdue.length)alert(`acknowledgements outstanding: ${overdue.length}. See ${overdue.slice(0,12).join(', ')}.`);
  };
  const consumed=(pending:number)=>{
    const last=s.get("SELECT action,detail FROM events WHERE workspace_id=? AND entity='wake-delivery' AND entity_id=? ORDER BY id DESC LIMIT 1",s.ws,role);
    return last?.action==='consumed' && JSON.parse(last.detail).pending===pending;
  };
  const queue=async(stopping:boolean,pending?:number)=>{
    identity();controller.signal.throwIfAborted();
    if(!stopping && pendingStop(s))return false;
    if(!stopping)enrollment(s,epoch);
    const message=stopping?`Check Sassato STOP for ${role}. Run sas context --as ${role} --workspace ${s.workspace}; follow the stop instructions and do not re-arm.`:
      `Run sas wake --pending --as ${role} --workspace ${s.workspace}.`;
    const args=['queue','--thread',thread,'--remote',bound.endpoint,'--message',message,'--resume'];
    // Staging is the durable intent for work. Record STOP intent too, before crossing processes.
    if(stopping)s.event('watch-dispatch',role,'stop-intent',{epoch});
    let result=await queueClient(client,args,{...options,signal:controller.signal,timeoutMs:timing.queueTimeoutMs});
    // One retry, for work only and only after a silent hang: a STOP notice is never sent twice, and a call that
    // printed anything is uncertain as it stands. Eligibility is checked again before the second call. A hung first
    // call may still have queued its line; the worker then reads the result once and the second line finds
    // "No pending wake", which changes nothing (T663 accepts this for a watcher that keeps going under load).
    if(result.timedOut && !stopping && pending!==undefined && !controller.signal.aborted && !result.stdout.trim() && !result.stderr.trim()){
      s.event('watch-dispatch',role,'retry',{epoch});
      await delay(timing.retryPauseMs,undefined,{signal:controller.signal});
      identity();
      if(pendingStop(s))return false;
      enrollment(s,epoch);
      if(consumed(pending))return true;
      result=await queueClient(client,args,{...options,signal:controller.signal,timeoutMs:timing.queueTimeoutMs});
    }
    const receipt=new RegExp(`^Queued message ([a-f0-9-]+) for thread ${thread}\\.$`,'i').exec(result.stdout.trim());
    const confirmed=!!receipt && uuid.test(receipt[1]) && !result.stderr.trim() && result.code===0 && !result.timedOut;
    s.event('watch-dispatch',role,'returned',{epoch,stop:stopping,code:result.code,confirmed});
    check(confirmed,
      'Queue delivery is uncertain; inspect the worker and pending result before re-enrolling',4);
    return true;
  };
  let stopping=false;
  const stop=async()=>{
    stopping=true;
    // Fence outstanding work before the external STOP notice can block or fail.
    s.tx(()=>{
      const last=s.get("SELECT id FROM events WHERE workspace_id=? AND entity='wake-enrollment' AND entity_id=? ORDER BY id DESC LIMIT 1",s.ws,role);
      if(last?.id===epoch)closePendingWake(s,epoch);
    });
    const request=s.get('SELECT acknowledged_at FROM stop_requests WHERE workspace_id=? AND role=? AND cleared_at IS NULL',s.ws,role);
    if(!request?.acknowledged_at)await queue(true);
    return {role,epoch,reason:'stopped'};
  };
  try {
    for(;;){
      if(pendingStop(s))return await stop();
      inspect();
      const progress=getNotificationProgress(s)!;
      const result=await waitForWork(s,{since:progress.cursor,defaultIdleMinutes:50},{inspect,deliveredMail});
      if(result.reason==='stop' || pendingStop(s))return await stop();
      inspect();
      const pending=stagePendingWake(s,epoch,progress,result);
      if(pendingStop(s))return await stop();
      inspect();
      if(!await queue(false,pending))return await stop();
      const deadline=clock()+deadlineMs;
      for(;;){
        if(pendingStop(s))return await stop();
        inspect();
        if(consumed(pending))break;
        check(clock()<deadline,'Five minutes elapsed without a worker receipt; inspect the worker and consume the pending result',4);
        await delay(500);
      }
      const ids=(result.digest?.entries??[]).filter(entry=>entry.id.startsWith('M') &&
        ['urgent','reply-needed'].includes(entry.kind)).map(entry=>entry.id);
      if(result.message)ids.push(String(result.message.id));
      for(const id of ids){messages.set(id,{at:clock(),reported:false});deliveredMail.add(id);}
    }
  } catch(error) {
    // An interrupt is the human's own act at the terminal: recorded, not mailed, whatever was under way.
    const interrupted=()=>{s.event('watch-dispatch',role,'suspended',{epoch,reason:'interrupted'});};
    if(controller.signal.aborted){interrupted();throw error;}
    // Preserve intent, epoch and cursor on unknown delivery. A human may still have the worker consume it.
    if(!stopping && pendingStop(s)){
      try {return await stop();}
      catch(stopError){
        if(controller.signal.aborted){interrupted();throw stopError;}
        alert('STOP observed. Enrollment closed; confirm the worker saw STOP.');throw stopError;
      }
    }
    if(stopping){alert('STOP observed. Verify the worker saw STOP and check enrollment status.');throw error;}
    exited(error);
    try {alert(`automatic dispatch suspended. Inspect the terminal and pending result; explicitly reconcile epoch ${epoch} before restarting.`);}
    catch(alertError) {console.error(`Could not send the alert: ${alertError instanceof Error?alertError.message:alertError}`);}
    throw error;
  } finally {process.off('SIGTERM',cancel);process.off('SIGINT',cancel);}
}
