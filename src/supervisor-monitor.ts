import { randomUUID } from 'node:crypto';
import type { Store,Row } from './storage.js';
import { check,integer,name,now,text } from './errors.js';
import { processIdentity,sessions } from './coordination.js';
import { getCheckpoint } from './checkpoints.js';
import { activeStop, assertWorkAllowed } from './control.js';
import { roleWakePolicy, workspaceSettings } from './workspace-settings.js';
import { effectiveWakePolicy } from './wake-policy.js';

export const PING_INTERVAL_MS=60_000,PING_DEADLINE_MS=120_000;
function generation(s:Store,role:string):number {
  return Number(s.get('SELECT generation FROM managed_workers WHERE workspace_id=? AND role=?',s.ws,role)?.generation??0);
}
const acting=(worker:Row|undefined)=>!worker || ['running','draining'].includes(worker.state);
function checkpointDue(s:Store,role:string,clock:number,minutes:number):boolean {
  const checkpoint=getCheckpoint(s,role);
  if(!checkpoint || !checkpoint.own_changes_since || clock-Date.parse(checkpoint.saved_at)<minutes*60_000)return false;
  return !activeStop(s,[role]) &&
    !s.get("SELECT 1 FROM jobs WHERE role=? AND status IN ('waiting','running')",role) &&
    Boolean(s.get("SELECT 1 FROM tasks WHERE workspace_id=? AND owner=? AND status='doing' LIMIT 1",s.ws,role));
}
export function requestSupervisorPing(s:Store,target:string,clock=Date.now()):Row {
  const role=name(target);check(s.role(role).kind==='agent','Only agent roles receive supervisor pings');
  return s.tx(()=>{
    s.requireActor();assertWorkAllowed(s,s.requireActor());
    const worker=s.get('SELECT generation,state,ping_epoch FROM managed_workers WHERE workspace_id=? AND role=?',s.ws,role),gen=worker?.generation??0,epoch=worker?.ping_epoch??0;
    const prior=s.get('SELECT * FROM supervisor_pings WHERE workspace_id=? AND role=? AND generation=? AND ping_epoch=? ORDER BY rowid DESC LIMIT 1',s.ws,role,gen,epoch);
    if(!acting(worker))return {role,generation:gen,state:'suspended',lifecycle_state:worker!.state,prior_ping:prior??null};
    // A fresh cadence must never hide an older unanswered deadline. Keep the
    // epoch's outstanding obligation until answered, even when already overdue.
    const settings=workspaceSettings(s);
    const policy=settings.wake_mode==='scored'?effectiveWakePolicy(settings.speed,roleWakePolicy(settings,role)):null;
    const interval=policy?policy.ping_minutes*60_000:PING_INTERVAL_MS;
    if(prior && (!prior.acknowledged_at || clock-Date.parse(prior.requested_at)<interval))return prior;
    const checkpoint_requested=policy?checkpointDue(s,role,clock,policy.checkpoint_minutes):false;
    const ping={id:randomUUID(),workspace_id:s.ws,role,generation:gen,ping_epoch:epoch,nonce:randomUUID(),requested_at:new Date(clock).toISOString(),deadline:new Date(clock+PING_DEADLINE_MS).toISOString(),acknowledged_at:null};
    s.run('INSERT INTO supervisor_pings(id,workspace_id,role,generation,nonce,requested_at,deadline,acknowledged_at,ping_epoch) VALUES(?,?,?,?,?,?,?,?,?)',ping.id,s.ws,role,gen,ping.nonce,ping.requested_at,ping.deadline,null,epoch);
    s.event('supervisor-ping',role,'requested',{nonce:ping.nonce,generation:gen,deadline:ping.deadline,...(checkpoint_requested?{checkpoint_requested:true}:{})});
    return checkpoint_requested?{...ping,checkpoint_requested:true}:ping;
  });
}
export function acknowledgeSupervisorPing(s:Store,nonce:string,expectedGeneration:number,clock=Date.now()):Row {
  text(nonce,'ping nonce',100);integer(expectedGeneration,'worker generation',0);
  return s.tx(()=>{
    const actor=s.requireActor(),ping=s.get('SELECT * FROM supervisor_pings WHERE workspace_id=? AND role=? AND nonce=?',s.ws,actor,nonce);
    check(ping,'Ping does not belong to this role',3);
    const worker=s.get('SELECT state,ping_epoch FROM managed_workers WHERE workspace_id=? AND role=?',s.ws,actor);
    check(acting(worker) && ping.generation===expectedGeneration && generation(s,actor)===expectedGeneration && ping.ping_epoch===(worker?.ping_epoch??0),'Ping belongs to a superseded generation or lifecycle epoch',4);
    if(ping.acknowledged_at)return ping;
    const at=new Date(clock).toISOString();s.run('UPDATE supervisor_pings SET acknowledged_at=? WHERE id=? AND acknowledged_at IS NULL',at,ping.id);
    s.event('supervisor-ping',actor,'acknowledged',{id:ping.id,generation:expectedGeneration,late:clock>Date.parse(ping.deadline)});
    return {...ping,acknowledged_at:at};
  });
}
export function positivelyGone(pid:number,start:string):boolean {
  const current=processIdentity(pid);
  if(current)return current!==start;
  try {process.kill(pid,0);return false;}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH';}
}
export function armManagedWaiter(s:Store,cursor:number):Row|null {
  const actor=s.requireActor();if(!s.get('SELECT id FROM managed_workers WHERE workspace_id=? AND role=?',s.ws,actor))return null;
  integer(cursor,'wait cursor',0);const start=processIdentity(process.pid);check(start,'Waiter process identity is unavailable',4);
  const writer=s.writableFork();
  try {return writer.tx(()=>{
    const prior=writer.get('SELECT * FROM supervisor_waiters WHERE role=? AND ended_at IS NULL',actor);
    if(prior) {
      check(positivelyGone(prior.pid,prior.process_start),'A live or unknown waiter already exists for this role',4);
      writer.run('UPDATE supervisor_waiters SET ended_at=? WHERE id=?',now(),prior.id);
    }
    const row={id:randomUUID(),workspace_id:s.ws,role:actor,pid:process.pid,process_start:start,generation:generation(writer,actor),cursor,armed_at:now(),ended_at:null};
    writer.run('INSERT INTO supervisor_waiters VALUES(?,?,?,?,?,?,?,?,?)',row.id,s.ws,actor,row.pid,start,row.generation,cursor,row.armed_at,null);return row;
  });}finally{writer.close();}
}
export function disarmManagedWaiter(s:Store,lease:Row|null,cursor?:number):void {
  if(!lease)return;const writer=s.writableFork();
  try {writer.tx(()=>{
    check(lease.pid===process.pid && lease.process_start===processIdentity(process.pid),'Only the originating waiter can close its observation',3);
    writer.run('UPDATE supervisor_waiters SET ended_at=?,cursor=? WHERE workspace_id=? AND id=? AND pid=? AND process_start=?',now(),cursor===undefined?lease.cursor:integer(cursor,'wait cursor',0),s.ws,lease.id,process.pid,lease.process_start);
  });}finally{writer.close();}
}
export function supervisorStatus(s:Store,clock=Date.now()):Row {
  return s.snapshot(()=>{
    const runtime=sessions(s);
    const workers=s.all("SELECT name FROM roles WHERE workspace_id=? AND kind='agent' ORDER BY name LIMIT 100",s.ws).map(({name:role})=>{
      const worker=s.get("SELECT id,generation,state,controller_id,ping_epoch,json_extract(context,'$.evidence_kind') AS mode FROM managed_workers WHERE workspace_id=? AND role=?",s.ws,role);
      const prior=s.get('SELECT * FROM supervisor_pings WHERE workspace_id=? AND role=? AND generation=? ORDER BY rowid DESC LIMIT 1',s.ws,role,worker?.generation??0);
      const ping=prior?.ping_epoch===(worker?.ping_epoch??0)?prior:undefined;
      const waiter=s.get('SELECT * FROM supervisor_waiters WHERE workspace_id=? AND role=? AND ended_at IS NULL',s.ws,role);
      const checkpoint=getCheckpoint(s,role),session=runtime.find(row=>row.role===role)??null;
      const response=!ping?'unconfirmed':ping.acknowledged_at?(Date.parse(ping.acknowledged_at)<=Date.parse(ping.deadline)?'acknowledged':'late'):clock>Date.parse(ping.deadline)?'overdue':'pending';
      const armed=Boolean(waiter && waiter.generation===(worker?.generation??0) && processIdentity(waiter.pid)===waiter.process_start);
      const jobs=s.all("SELECT id,status,kind FROM jobs WHERE role=? AND status IN ('waiting','running') ORDER BY id LIMIT 100",role);
      const work=s.all("SELECT id,status,version FROM tasks WHERE workspace_id=? AND owner=? AND status NOT IN ('done','dropped') ORDER BY id LIMIT 100",s.ws,role).map(row=>({...row,id:`T${row.id}`}));
      return {role,management:worker??{state:'observe-only'},session,responsiveness:{state:acting(worker)?response:'suspended',lifecycle_state:worker?.state??null,ping:ping??null,prior_ping:prior??null},checkpoint:checkpoint?{id:checkpoint.id,state:checkpoint.state,reasons:checkpoint.reasons}:null,waiter:{registered:Boolean(waiter),armed,observation:waiter??null},jobs,work};
    });
    return {observed_at:new Date(clock).toISOString(),management_enabled:false,reason:'Unattended provider management remains disabled. Cooperative attended probes use separate human-confirmed enrollment and do not establish enforced tool barriers, containment, complete job exclusion or full configuration continuity.',workers};
  });
}
