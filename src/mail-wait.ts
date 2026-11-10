import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store, type Row, type Param } from './storage.js';
import { AppError, check, integer } from './errors.js';
import { workspaceSettings } from './workspace-settings.js';
import { getNotificationProgress } from './notification-progress.js';

export interface WaitResult {
  reason:'urgent'|'stop'|'timeout'|'answer'|'blocker-resolved'|'task-assigned'|'task-ready'|'review-submitted'|'review-approved'|'review-rejected';
  role:string; cursor:number; message?:Row; stop?:Row;
  question?:string; blocker?:string; task?:string; tasks?:string[];
  /** Task version recorded by the workflow event, not a substitute for reading current work. */
  version?:number;
}
export interface WaitOptions { timeout?:number; stopFile?:string; since?:number }
const maximum=(s:Store):number=>Number(s.get('SELECT coalesce(max(id),0) n FROM events WHERE workspace_id=?',s.ws)!.n);
function available(s:Store,actor:string,condition:string,params:Param[],includeDoing=false):string[] {
  // These are the same gates as tasks --available, applied to event candidates only.
  return s.all(`SELECT t.id FROM tasks t WHERE t.workspace_id=? AND (t.status='open'${includeDoing?" OR (t.status='doing' AND t.owner=?)":''})
    AND (t.owner IS NULL OR t.owner=?) AND (t.for_role IS NULL OR t.for_role=?)
    AND (t.human_only=0 OR ?=1)
    AND NOT EXISTS (SELECT 1 FROM blockers b WHERE b.workspace_id=t.workspace_id AND b.task_id=t.id AND b.status='open')
    AND NOT EXISTS (SELECT 1 FROM dependencies d JOIN tasks p ON p.workspace_id=d.workspace_id AND p.id=d.depends_on WHERE d.workspace_id=t.workspace_id AND d.task_id=t.id AND p.status!='done')
    AND (${condition}) ORDER BY t.id`,s.ws,...(includeDoing?[actor]:[]),actor,actor,s.role(actor).kind==='human'?1:0,...params).map(t=>`T${t.id}`);
}
function workflow(s:Store,actor:string,event:Row):WaitResult|undefined {
  const base={role:actor,cursor:event.id};
  let detail:Row;try{detail=JSON.parse(event.detail);}catch{return undefined;}
  if(event.entity==='question'&&event.action==='answered') {
    const q=s.get("SELECT q.id,q.task_id FROM questions q JOIN tasks t ON t.workspace_id=q.workspace_id AND t.id=q.task_id WHERE q.workspace_id=? AND q.id=? AND q.status='answered' AND (q.asked_by=? OR t.owner=?)",s.ws,Number(String(event.entity_id).slice(1)),actor,actor);
    if(q)return {...base,reason:'answer',question:`H${q.id}`,task:`T${q.task_id}`};
    return undefined;
  }
  if(event.entity!=='task'||!/^T\d+$/.test(event.entity_id))return undefined;
  const id=Number(event.entity_id.slice(1));
  const reviewUpdate=event.action==='updated'&&detail.after?.reviewed_by===null&&
    !!s.get("SELECT 1 FROM tasks WHERE workspace_id=? AND id=? AND status='review'",s.ws,id);
  if(reviewUpdate||['submitted','review-approved','review-rejected'].includes(event.action)) {
    const task=s.get('SELECT owner,status,reviewed_by FROM tasks WHERE workspace_id=? AND id=?',s.ws,id);
    if(!task||task.status==='done'||task.status==='dropped')return undefined;
    // A late reader needs the current review transition, not every superseded
    // submission/result. Metadata notes may advance the task version without
    // replacing that transition, so compare workflow events rather than versions.
    const superseded=s.get(`SELECT 1 FROM events WHERE workspace_id=? AND entity='task' AND entity_id=? AND id>?
      AND (action IN ('submitted','review-approved','review-rejected','completed','dropped','reopened') OR
        (?='review' AND action='updated' AND CASE WHEN json_valid(detail) THEN json_type(detail,'$.after.reviewed_by')='null' ELSE 0 END))
      LIMIT 1`,s.ws,event.entity_id,event.id,task.status);
    if(superseded)return undefined;
    const version=Number.isSafeInteger(detail.after?.version)&&detail.after.version>0?detail.after.version:undefined;
    if(event.action==='submitted'||reviewUpdate) {
      // Reviews are untargeted: use the existing reviewTask eligibility rule. Human
      // operators may review their own work; agents require an independent owner.
      // Updates that clear approval while keeping review open are new review requests.
      // An already settled or withdrawn submission no longer needs a reviewer.
      if(task.status!=='review'||task.reviewed_by!==null||task.owner===actor&&s.role(actor).kind!=='human')return undefined;
      return {...base,reason:'review-submitted',task:event.entity_id,version};
    }
    if(task.owner!==actor)return undefined;
    if(event.action==='review-approved'&&(task.status!=='review'||task.reviewed_by===null))return undefined;
    if(event.action==='review-rejected'&&(!['doing','blocked'].includes(task.status)||task.reviewed_by!==null))return undefined;
    return {...base,reason:event.action==='review-approved'?'review-approved':'review-rejected',task:event.entity_id,version};
  }
  if(event.action==='blocker-resolved') {
    const blocker=/^B\d+$/.test(detail.blocker??'')?Number(detail.blocker.slice(1)):null;
    // answerQuestion resolves its blocker first, then emits the canonical answer event
    // in the same transaction. Report that answer once, including answer --close.
    const answer=blocker===null?undefined:s.get("SELECT 1 FROM questions q JOIN tasks t ON t.workspace_id=q.workspace_id AND t.id=q.task_id JOIN events e ON e.workspace_id=q.workspace_id AND e.entity='question' AND e.entity_id='H'||q.id AND e.action='answered' WHERE q.workspace_id=? AND q.blocker_id=? AND q.status='answered' AND (q.asked_by=? OR t.owner=?) AND e.id>? LIMIT 1",s.ws,blocker,actor,actor,event.id);
    if(answer)return undefined;
    const own=s.get("SELECT id FROM tasks WHERE workspace_id=? AND id=? AND owner=? AND status NOT IN ('done','dropped')",s.ws,id,actor);
    if(own)return {...base,reason:'blocker-resolved',blocker:detail.blocker,task:event.entity_id};
    const tasks=available(s,actor,'t.id=?',[id]);
    if(tasks.length)return {...base,reason:'task-ready',blocker:detail.blocker,task:tasks[0],tasks};
    return undefined;
  }
  let reason:WaitResult['reason']='task-ready',tasks:string[]=[];
  if(event.action==='completed'||(event.action==='import-repaired'&&(detail.after?.task?.status??detail.after?.status)==='done')) {
    tasks=available(s,actor,'EXISTS (SELECT 1 FROM dependencies d WHERE d.workspace_id=t.workspace_id AND d.task_id=t.id AND d.depends_on=?)',[id],true);
  } else {
    const updated=event.action==='updated'&&['for_role','human_only'].some(key=>Object.hasOwn(detail.after??{},key)&&detail.before?.[key]!==detail.after[key]);
    const repaired=event.action==='import-repaired'&&(detail.after?.task?.status??detail.after?.status)==='open';
    if(!updated&&!repaired&&!['created','imported','reopened','released','handed-off','dependency-removed'].includes(event.action))return undefined;
    if(['created','imported','handed-off','updated'].includes(event.action)) {
      const assigned=s.get("SELECT id FROM tasks WHERE workspace_id=? AND id=? AND status NOT IN ('done','dropped') AND (owner IS NULL OR owner=?) AND (for_role IS NULL OR for_role=?) AND (owner=? OR for_role=?)",s.ws,id,actor,actor,actor,actor);
      if(assigned)return {...base,reason:'task-assigned',task:event.entity_id,tasks:[event.entity_id]};
    }
    tasks=available(s,actor,'t.id=?',[id],event.action==='dependency-removed');
  }
  if(tasks.length)return {...base,reason,task:tasks[0],tasks};
  return undefined;
}
/** Read-only, non-consuming waiter. Save progress only after handling the returned notification. */
export async function waitForWork(s:Store, options:WaitOptions={}):Promise<WaitResult> {
  const actor=s.requireActor(),timeout=integer(options.timeout??0,'timeout seconds',0,2_147_483);
  const configuredStopFile=options.stopFile??workspaceSettings(s).stop_file;
  const stopFile=configuredStopFile===null?null:resolve(configuredStopFile);
  const initial=s.snapshot(()=>{
    const latest=maximum(s);
    const request=s.get('SELECT id,acknowledged_at FROM stop_requests WHERE workspace_id=? AND role=? AND cleared_at IS NULL',s.ws,actor);
    const stopped=stopFile&&existsSync(stopFile)?{file:stopFile}:request?{id:`R${request.id}`,acknowledged:!!request.acknowledged_at}:undefined;
    let cursor:number;
    if(options.since!==undefined) cursor=integer(options.since,'event cursor',0,Number.MAX_SAFE_INTEGER);
    else {
      try {cursor=getNotificationProgress(s)?.cursor??latest;}
      catch(error) {
        // Corrupt progress must not hide STOP. Cursor zero preserves all replayable
        // events and is returned only with STOP, never as a work/recovery fallback.
        if(!stopped || !(error instanceof AppError) || error.code!==4) throw error;
        cursor=0;
      }
    }
    return {latest,cursor,stopped};
  });
  const latest=initial.latest;
  let cursor=initial.cursor;
  check(cursor<=latest,`Event cursor ${cursor} is ahead of this workspace's latest event ${latest}; use a cursor from this workspace`,4);
  if(initial.stopped)return {reason:'stop',role:actor,cursor,stop:initial.stopped};
  const deadline=timeout?performance.now()+timeout*1000:Infinity;
  for(;;) {
    if(stopFile&&existsSync(stopFile))return {reason:'stop',role:actor,cursor,stop:{file:stopFile}};
    let more=false;
    const result=s.snapshot(():WaitResult|undefined=>{
      const stop=s.get('SELECT id,acknowledged_at FROM stop_requests WHERE workspace_id=? AND role=? AND cleared_at IS NULL',s.ws,actor);
      if(stop)return {reason:'stop',role:actor,cursor,stop:{id:`R${stop.id}`,acknowledged:!!stop.acknowledged_at}};
      const message=s.get("SELECT m.id,m.sender,substr(m.body,1,240) AS body FROM receipts r JOIN messages m ON m.workspace_id=r.workspace_id AND m.id=r.message_id WHERE r.workspace_id=? AND r.recipient=? AND r.state='unread' AND m.urgent=1 ORDER BY m.id LIMIT 1",s.ws,actor);
      if(message)return {reason:'urgent',role:actor,cursor,message:{id:`M${message.id}`,sender:message.sender,summary:String(message.body).replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim()}};
      const events=s.all('SELECT id,entity,entity_id,action,detail FROM events WHERE workspace_id=? AND id>? ORDER BY id LIMIT 200',s.ws,cursor);
      more=events.length===200;
      for(const event of events){const wake=workflow(s,actor,event);cursor=event.id;if(wake)return wake;}
      return undefined;
    });
    if(result)return result;
    const remaining=deadline-performance.now();
    if(remaining<=0)return {reason:'timeout',role:actor,cursor};
    // A bounded snapshot permits writers and checkpoints between batches and sleeps.
    await new Promise(resolve=>setTimeout(resolve,more?0:Math.min(500,remaining)));
  }
}
/** Backwards-compatible name; now also wakes for relevant workflow events. */
export const waitForUrgent=waitForWork;
