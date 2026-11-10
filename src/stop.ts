import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Store, type Row } from './storage.js';
import { integer } from './errors.js';
import { processIdentity, sessionState } from './coordination.js';
import { requestStop, stopStatus, type StopRequest } from './control.js';
import { workspaceSettings } from './workspace-settings.js';
import { observeBusyChecks, type BusyStatus } from './busy-checks.js';

export interface StopOptions {
  all?:boolean; force?:boolean; noWait?:boolean; timeout?:number;
  signal?:AbortSignal;
  onProgress?:(statuses:StopRequest[],checks:BusyStatus[])=>void;
}
export interface StopSignal {
  role:string; session_id:string|null; pid:number|null;
  status:'sent'|'refused'; reason:string;
}
export interface StopResult {
  requests:StopRequest[]; statuses:StopRequest[]; complete:boolean; timed_out:boolean;
  interrupted:boolean; force:boolean; signals:StopSignal[]; limitations:string[];
  busy_checks:BusyStatus[]; machine_quiet:boolean|null;
}
const finished=new Set(['acknowledged','exited','inactive']);
const forceLimitations=[
  'Force signals only verified registered Claude/Codex provider PIDs. Descendant jobs and unrelated terminal processes are not guaranteed to stop.',
  'Signal delivery is not acknowledgement or confirmed exit. Use stop-status to inspect the result.',
];
function ancestors():Set<number>|null {
  if(process.platform!=='linux')return null;
  const protectedPids=new Set<number>([process.pid,process.ppid,1]);
  let pid=process.pid;
  try {
    for(let depth=0;depth<128;depth++) {
      if(pid<=1)return protectedPids;
      const stat=readFileSync(`/proc/${pid}/stat`,'utf8');
      const parent=Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]);
      if(!Number.isSafeInteger(parent)||parent<0||parent===pid)return null;
      if(parent===0)return protectedPids;
      protectedPids.add(parent);pid=parent;
    }
  }catch{return null;}
  return null;
}
function forceSignals(store:Store,requested:StopRequest[]):StopSignal[] {
  const protectedPids=ancestors(),signals:StopSignal[]=[],handled=new Set<string>();
  const capturedRequests=new Map(requested.map(r=>[r.role,r.id]));
  for(const request of requested) {
    const rows=store.all('SELECT * FROM sessions WHERE workspace_id=? AND role=? ORDER BY id DESC',store.ws,request.role);
    let considered=false;
    const result=(row:Row|undefined,status:StopSignal['status'],reason:string)=>{
      signals.push({role:request.role,session_id:row?`S${row.id}`:null,pid:row?.pid??null,status,reason});
    };
    for(const row of rows) {
      const state=sessionState(row),identity=row.pid?processIdentity(Number(row.pid)):null;
      const reused=identity!==null&&identity!==row.process_start;
      // Historical ended registrations can still own a live process. Inspect every row,
      // but do not turn harmless archived/dead rows into force-stop failures.
      if(state!=='running'&&!(row.id===rows[0].id&&(state==='unknown'||reused)))continue;
      considered=true;
      const key=`${row.pid}:${row.process_start}`;
      if(handled.has(key))continue;
      handled.add(key);
      if(!protectedPids) {result(row,'refused','Cannot establish this CLI process ancestry safely');continue;}
      if(!row.pid||protectedPids.has(Number(row.pid))) {result(row,'refused','Refusing to signal this CLI, its ancestors, or a missing PID');continue;}
      if(row.provider!=='claude'&&row.provider!=='codex') {result(row,'refused','Only registered Claude/Codex providers support force stop');continue;}
      if(state!=='running'||!row.process_start||identity!==row.process_start) {result(row,'refused','Process identity is absent, reused, or not the registered provider');continue;}
      store.tx(()=>{
        if(!stopStatus(store,[request.role]).some(active=>active.id===request.id)) {
          result(row,'refused','Stop request was cleared or replaced before signalling');return;
        }
        const shared=store.all('SELECT * FROM sessions WHERE pid=?',row.pid).find(other=>{
          if(other.process_start!==row.process_start||sessionState(other)!=='running')return false;
          if(other.workspace_id!==store.ws)return true;
          const captured=capturedRequests.get(other.role);
          // Each live role sharing this provider must still have its captured stop generation.
          // Being selected earlier is insufficient if another operator resumed it meanwhile.
          return !captured||!stopStatus(store,[other.role]).some(active=>active.id===captured);
        });
        if(shared) {result(row,'refused','Provider PID also belongs to an unselected role or workspace');return;}
        // Re-read registration and re-verify boot/start fingerprint plus provider argv directly
        // before kill. Keep the request-generation check and signal under the writer lock so
        // resume-work cannot commit between those actions.
        const current=store.get('SELECT * FROM sessions WHERE workspace_id=? AND id=?',store.ws,row.id);
        if(!current||current.pid!==row.pid||current.process_start!==row.process_start||sessionState(current)!=='running'||processIdentity(Number(current.pid))!==current.process_start) {
          result(row,'refused','Process changed before signalling; no signal sent');return;
        }
        try {
          process.kill(Number(current.pid),'SIGKILL');
        }catch(error) {
          const code=(error as NodeJS.ErrnoException).code;
          result(row,'refused',code==='ESRCH'?'Process exited before the signal could be delivered':`Signal could not be delivered${code?` (${code})`:''}`);
          return;
        }
        result(row,'sent','SIGKILL sent to the verified registered provider');
        try {store.event('session',`S${row.id}`,'force-stop-signal',{role:request.role,pid:row.pid,request_id:request.id,signal:'SIGKILL'});}
        catch {signals[signals.length-1].reason+='; audit could not be recorded (signal was delivered)';}
      });
    }
    if(!considered&&request.state==='waiting')result(rows[0],'refused','No verifiable registered provider process is available to signal');
  }
  return signals;
}
/** Persist requests first. Waiting observes cooperative acknowledgement or verified exit. */
export async function stop(store:Store,selected:string[],options:StopOptions={}):Promise<StopResult> {
  store.requireHuman();
  const timeout=integer(options.timeout??0,'timeout seconds',0,2_147_483);
  const deadline=timeout?performance.now()+timeout*1000:Infinity;
  const checks=options.all||selected.length===0?workspaceSettings(store).busy_checks:[];
  const requests=requestStop(store,selected,{all:options.all});
  const roles=requests.map(r=>r.role),ids=new Map(requests.map(r=>[r.role,r.id]));
  let statuses=stopStatus(store,roles);
  const result:StopResult={requests,statuses,complete:false,timed_out:false,interrupted:false,force:!!options.force,signals:[],limitations:options.force?[...forceLimitations]:[],busy_checks:checks.map(check=>({name:check.name,state:'unknown',reason:'Not checked'})),machine_quiet:null};
  const update=()=>{
    result.statuses=statuses;
    result.interrupted=!!options.signal?.aborted||requests.some(request=>!statuses.some(row=>row.role===request.role&&row.id===ids.get(request.role)));
    result.complete=!result.interrupted&&statuses.length===requests.length&&statuses.every(row=>finished.has(row.state))&&result.busy_checks.every(check=>check.state==='idle');
    result.machine_quiet=options.force||options.noWait||!(options.all||selected.length===0)?null:result.complete;
  };
  update();options.onProgress?.(statuses,result.busy_checks);
  if(options.signal?.aborted){update();return result;}
  if(options.force) {
    result.signals=forceSignals(store,requests);
    // The status snapshot predates signalling. Never convert delivery into a successful stop.
    const stillActive=stopStatus(store,roles);
    result.interrupted=requests.some(request=>!stillActive.some(row=>row.id===request.id));
    if(result.signals.length||result.interrupted)result.complete=false;
    return result;
  }
  if(options.noWait||result.interrupted)return result;
  if(checks.length){result.busy_checks=await observeBusyChecks(checks,deadline,options.signal);statuses=stopStatus(store,roles);update();options.onProgress?.(statuses,result.busy_checks);}
  let previous=JSON.stringify([statuses,result.busy_checks]);
  while(!result.complete&&!result.interrupted) {
    const remaining=deadline-performance.now();
    if(remaining<=0) {result.timed_out=true;break;}
    await new Promise<void>(resolveDelay=>{
      const done=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',done);resolveDelay();};
      const timer=setTimeout(done,Math.min(250,remaining));
      options.signal?.addEventListener('abort',done,{once:true});
      if(options.signal?.aborted)done();
    });
    statuses=stopStatus(store,roles);update();
    if(!result.interrupted&&checks.length){result.busy_checks=await observeBusyChecks(checks,deadline,options.signal);statuses=stopStatus(store,roles);update();}
    const next=JSON.stringify([statuses,result.busy_checks]);
    if(next!==previous) {options.onProgress?.(statuses,result.busy_checks);previous=next;}
  }
  return result;
}
