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
import { workspaceSettings } from './workspace-settings.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const deadlineMs=300_000;

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
  const target=link.isSymbolicLink()?realpathSync(given):given,endpoint=statSync(target,{bigint:true});
  const owned=(st:{uid:bigint,mode:bigint})=>Number(st.uid)===uid && (st.mode & 0o022n)===0n;
  check(Number(link.uid)===uid && endpoint.isSocket() && Number(endpoint.uid)===uid &&
    owned(statSync(dirname(given),{bigint:true})) && owned(statSync(dirname(target),{bigint:true})),
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

export async function launchWatch(operator:Store,role:string,remote:string,thread:string,clock=()=>performance.now()) {
  const human=operator.requireHuman();name(role);
  check(uuid.test(thread),'A registered Codex thread UUID is required');
  check(/^unix:\/\/\/[^\s\0]+$/.test(remote),'Use an explicit local unix:///absolute/path endpoint');
  const release=acquireLaunchLock(operator,role);
  try {
    const s=new Store(operator.path,role);
    try {s.use(operator.workspace);return await observe(s,human,remote,thread,clock);}
    finally {s.close();}
  } finally {release();}
}

async function observe(s:Store,human:string,remote:string,thread:string,clock:()=>number) {
  const role=s.requireActor(),bound=session(s,thread,remote),client=realpathSync(resolveExecutable('codex',true));
  const clientIdentity=()=>{const st=statSync(client,{bigint:true});return [st.dev,st.ino,st.ctimeNs].join(':');};
  const pinned=clientIdentity(),options={cwd:bound.cwd};
  const version=await queueClient(client,['--version'],options);
  check(version.code===0 && !version.timedOut && !version.stderr.trim() && /^codex(?:-cli)? 0\.167\.0$/.test(version.stdout.trim()),'Expected Codex CLI 0.167.0',4);
  const help=await queueClient(client,['queue','--help'],options);
  check(help.code===0 && !help.timedOut && !help.stderr.trim() && ['thread','message','resume','remote'].every(flag=>new RegExp(`--${flag}\\b`).test(help.stdout)),'Required Codex queue interface unavailable',4);
  const identity=()=>check(pinned===clientIdentity() && JSON.stringify(session(s,thread,remote))===JSON.stringify(bound),
    'Watcher session, endpoint or configuration changed',4);
  identity();
  check(getNotificationProgress(s),'Reconcile the role’s notification progress before enrollment',4);
  const epoch=enrollPendingWake(s,{session:bound.session,thread});
  console.error(`Watching ${role} (enrollment E${epoch}). Interrupt to suspend; reconcile explicitly before restarting.`);
  const controller=new AbortController(),cancel=()=>controller.abort();
  process.on('SIGTERM',cancel);process.on('SIGINT',cancel);
  const messages=new Map<string,{at:number;reported:boolean}>(),deliveredMail=new Set<string>();
  const alert=(message:string)=>send(s,[human],`Waiter for ${role}, enrollment E${epoch}: ${message}`);
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
  const queue=async(stopping:boolean)=>{
    identity();controller.signal.throwIfAborted();
    if(!stopping && pendingStop(s))return false;
    if(!stopping)enrollment(s,epoch);
    const message=stopping?`Check Sassato STOP for ${role}. Run sas context --as ${role} --workspace ${s.workspace}; follow the stop instructions and do not re-arm.`:
      `Run sas wake --pending --as ${role} --workspace ${s.workspace}.`;
    const args=['queue','--thread',thread,'--remote',bound.endpoint,'--message',message,'--resume'];
    // Staging is the durable intent for work. Record STOP intent too, before crossing processes.
    if(stopping)s.event('watch-dispatch',role,'stop-intent',{epoch});
    const result=await queueClient(client,args,{...options,signal:controller.signal});
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
      if(!await queue(false))return await stop();
      const deadline=clock()+deadlineMs;
      for(;;){
        if(pendingStop(s))return await stop();
        inspect();
        const last=s.get("SELECT action,detail FROM events WHERE workspace_id=? AND entity='wake-delivery' AND entity_id=? ORDER BY id DESC LIMIT 1",s.ws,role);
        if(last?.action==='consumed' && JSON.parse(last.detail).pending===pending)break;
        check(clock()<deadline,'Five minutes elapsed without a worker receipt; inspect the worker and consume the pending result',4);
        await delay(500);
      }
      const ids=(result.digest?.entries??[]).filter(entry=>entry.id.startsWith('M') &&
        ['urgent','reply-needed'].includes(entry.kind)).map(entry=>entry.id);
      if(result.message)ids.push(String(result.message.id));
      for(const id of ids){messages.set(id,{at:clock(),reported:false});deliveredMail.add(id);}
    }
  } catch(error) {
    // Preserve intent, epoch and cursor on unknown delivery. A human may still have the worker consume it.
    if(!stopping && pendingStop(s)){
      try {return await stop();}
      catch(stopError){alert('STOP observed. Enrollment closed; confirm the worker saw STOP.');throw stopError;}
    }
    if(stopping){alert('STOP observed. Verify the worker saw STOP and check enrollment status.');throw error;}
    alert(`automatic dispatch suspended. Inspect the terminal and pending result; explicitly reconcile epoch ${epoch} before restarting.`);
    throw error;
  } finally {process.off('SIGTERM',cancel);process.off('SIGINT',cancel);}
}
