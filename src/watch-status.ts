import { randomUUID } from 'node:crypto';
import { Store, type Row } from './storage.js';
import { check, name } from './errors.js';
import { processIdentity, send } from './coordination.js';
import { workspaceSettings } from './workspace-settings.js';

export interface WatchRun { id:string; role:string }
export type WatchExitReason='startup-refused'|'failed'|'unconfirmed'|'stopped'|'interrupted';
const exitReasons=new Set<WatchExitReason>(['startup-refused','failed','unconfirmed','stopped','interrupted']);
function recorded(s:Store,run:WatchRun):void {
  name(run.role);
  check(typeof run.id==='string'&&!!s.get("SELECT 1 FROM events WHERE workspace_id=? AND entity='watch' AND entity_id=? AND action='watch-started' AND json_valid(detail) AND json_extract(detail,'$.run_id')=?",s.ws,run.role,run.id),'Unknown watcher run in this workspace',4);
}
/** The launcher can begin a run before capability checks or terminal dispatch. */
export function beginWatchRun(s:Store,target:string):WatchRun {
  const role=name(target);s.role(role);
  const run={id:randomUUID(),role};
  s.event('watch',role,'watch-started',{role,run_id:run.id,state:'starting',pid:process.pid,process_start:processIdentity(process.pid)});
  return run;
}
export function markWatchReady(s:Store,run:WatchRun):void {
  s.tx(()=>{
    recorded(s,run);
    check(!s.get("SELECT 1 FROM events WHERE workspace_id=? AND entity='watch' AND entity_id=? AND action='watch-exited' AND json_valid(detail) AND json_extract(detail,'$.run_id')=?",s.ws,run.role,run.id),'Watcher run already exited',4);
    s.event('watch',run.role,'watch-ready',{role:run.role,run_id:run.id,state:'running',pid:process.pid,process_start:processIdentity(process.pid)});
  });
}
/** Idempotent across engine/launcher cleanup; fixed alerts never contain provider output. */
export function finishWatchRun(s:Store,run:WatchRun,reason:WatchExitReason):void {
  check(exitReasons.has(reason),'Invalid watcher exit reason');
  s.tx(()=>{
    recorded(s,run);
    if(s.get("SELECT 1 FROM events WHERE workspace_id=? AND entity='watch' AND entity_id=? AND action='watch-exited' AND json_valid(detail) AND json_extract(detail,'$.run_id')=?",s.ws,run.role,run.id))return;
    let alert='not-needed',message_id:string|null=null;
    if(reason!=='stopped'&&reason!=='interrupted') {
      const actor=s.actor;s.actor=run.role;
      try {
        const human=workspaceSettings(s).default_human;
        if(human===null)alert='no-recipient';
        else {
          check(s.role(human).kind==='human','Default watcher alert recipient must be human');
          const message=send(s,[human],`Sassato watcher for role ${run.role} exited (${reason}). Check sassato status and inspect the watcher before restarting it. Foreground sassato wait remains available.`,{urgent:true});
          alert='sent';message_id=message.id;
        }
      } catch {alert='failed';}
      finally{s.actor=actor;}
    }
    s.event('watch',run.role,'watch-exited',{role:run.role,run_id:run.id,state:'exited',reason,alert,message_id});
  });
}
/** Known exits are durable; a vanished recorded owner is visible without a service. */
export function latestWatchStatuses(s:Store):Row[] {
  return s.snapshot(()=>s.all(`SELECT e.* FROM events e WHERE e.workspace_id=? AND e.entity='watch'
    AND e.action IN ('watch-started','watch-ready','watch-exited') AND e.id=(
      SELECT max(latest.id) FROM events latest WHERE latest.workspace_id=e.workspace_id AND latest.entity='watch'
      AND latest.entity_id=e.entity_id AND latest.action IN ('watch-started','watch-ready','watch-exited')) ORDER BY e.entity_id`,s.ws).map(event=>{
    let detail:Row;try{detail=JSON.parse(event.detail);}catch{detail={};}
    let state=detail.state,reason=detail.reason??null;
    if(state!=='exited') {
      if(!detail.pid||!detail.process_start){state='unknown';reason='owner-unverified';}
      else {
        const identity=processIdentity(Number(detail.pid));
        if(identity!==detail.process_start) {
          if(identity!==null){state='exited';reason='owner-not-running';}
          else try{process.kill(Number(detail.pid),0);state='unknown';reason='owner-unverified';}
          catch(error){state=(error as NodeJS.ErrnoException).code==='ESRCH'?'exited':'unknown';reason=state==='exited'?'owner-not-running':'owner-unverified';}
        }
      }
    }
    return {role:event.entity_id,state,reason,run_id:detail.run_id??null,updated_at:event.created_at,alert:detail.alert??null};
  }));
}
