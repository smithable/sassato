import { DIGEST_LIMIT, DigestWindow, digestText, digestGroup, messageSent, MESSAGE_NOW_SQL, type DigestEntry, type WaitDigest } from './wait-digest.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store, type Row, type Param } from './storage.js';
import { AppError, check, integer } from './errors.js';
import { send } from './coordination.js';
import { roleWakePolicy, workspaceSettings, type WorkspaceSettings } from './workspace-settings.js';
import { getNotificationProgress, IDLE_TASK_LIMIT, lastIdleDelivery, scoredDeliveryState, type IdleDelivery, type ScoredDelivery } from './notification-progress.js';
import { effectiveWakePolicy, scoredWake, WORKFLOW_WAKE_POINTS, type ScoredItem, type WakeScore } from './wake-policy.js';

export interface WaitResult {
  reason:'digest'|'urgent'|'reply-needed'|'own-work'|'open-work'|'spare-work'|'stop'|'timeout'|'answer'|'blocker-resolved'|'blocker-assigned'|'dependency-dropped'|'task-assigned'|'task-ready'|'review-submitted'|'review-approved'|'review-rejected'|'supervisor-ping'|'nudge';
  role:string; cursor:number; message?:Row; stop?:Row;
  question?:string; blocker?:string; task?:string; tasks?:string[];
  /** Task version recorded by the workflow event, not a substitute for reading current work. */
  version?:number;
  nonce?:string;generation?:number;ping_deadline?:string;checkpoint_requested?:boolean;
  managed_observation?:string;
  digest?:WaitDigest;
  mode?:'scored';
  scored?:ScoredDelivery;
  idle?:IdleDelivery;
  /** T1253: a role that wrote nothing for the workspace's nudge_minutes is asked why. */
  nudge?:{minutes:number;count:number;text:string};
}
export interface WaitClock { now():number; monotonic():number; sleep(ms:number):Promise<void> }
const systemClock:WaitClock={now:Date.now,monotonic:()=>performance.now(),sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms))};
export interface WaitOptions {
  timeout?:number; stopFile?:string; since?:number; idleMinutes?:number; settle?:number; settleMax?:number;
  defaultIdleMinutes?:number; clock?:WaitClock;
  /** Ask a quiet agent role why (T1253); wake sets it, since the nudge writes its own events. */
  nudge?:boolean;
}
const maximum=(s:Store):number=>Number(s.get('SELECT coalesce(max(id),0) n FROM events WHERE workspace_id=?',s.ws)!.n);
export function idleOpenWork(s:Store,actor:string,spare=false):string[] {
  const roles=workspaceSettings(s).open_work_roles,takesOpen=roles===null||roles.includes(actor)?1:0;
  return s.all(`SELECT t.id FROM tasks t WHERE t.workspace_id=? AND t.status='open' AND t.spare=?
    AND (t.owner IS NULL OR t.owner=?) AND (t.for_role IS NULL OR t.for_role=?)
    AND (t.owner IS NOT NULL OR t.for_role IS NOT NULL OR ?=1) AND (t.human_only=0 OR ?=1)
    AND NOT EXISTS (SELECT 1 FROM blockers b WHERE b.workspace_id=t.workspace_id AND b.task_id=t.id AND b.status='open')
    AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.workspace_id=t.workspace_id AND q.task_id=t.id AND q.status='pending')
    AND NOT EXISTS (SELECT 1 FROM dependencies d JOIN tasks p ON p.workspace_id=d.workspace_id AND p.id=d.depends_on WHERE d.workspace_id=t.workspace_id AND d.task_id=t.id AND p.status!='done')
    ORDER BY t.priority DESC,t.id LIMIT ?`,s.ws,spare?1:0,actor,actor,takesOpen,s.role(actor).kind==='human'?1:0,spare?SPARE_OFFER_LIMIT:IDLE_TASK_LIMIT).map(r=>`T${r.id}`);
}
// Spare work goes only to a role whose provider the human listed (any, when the list is empty), and not at all
// while spare_work is off (T1102).
const SPARE_OFFER_LIMIT=3;
function idleSpareWork(s:Store,actor:string):string[] {
  const settings=workspaceSettings(s),provider=s.role(actor).provider;
  if(!settings.spare_work||settings.spare_providers.length&&!settings.spare_providers.includes(provider))return [];
  return idleOpenWork(s,actor,true);
}
function available(s:Store,actor:string,condition:string,params:Param[],includeDoing=false):string[] {
  // These are the same gates as tasks --available, applied to event candidates only, except that a
  // task neither owned nor routed wakes only the roles in open_work_roles (every role when unset).
  const roles=workspaceSettings(s).open_work_roles,takesOpen=roles===null||roles.includes(actor)?1:0;
  return s.all(`SELECT t.id FROM tasks t WHERE t.workspace_id=? AND t.spare=0 AND (t.status='open'${includeDoing?" OR (t.status='doing' AND t.owner=?)":''})
    AND (t.owner IS NULL OR t.owner=?) AND (t.for_role IS NULL OR t.for_role=?)
    AND (t.human_only=0 OR ?=1) AND (t.owner IS NOT NULL OR t.for_role IS NOT NULL OR ?=1)
    AND NOT EXISTS (SELECT 1 FROM blockers b WHERE b.workspace_id=t.workspace_id AND b.task_id=t.id AND b.status='open')
    AND NOT EXISTS (SELECT 1 FROM dependencies d JOIN tasks p ON p.workspace_id=d.workspace_id AND p.id=d.depends_on WHERE d.workspace_id=t.workspace_id AND d.task_id=t.id AND p.status!='done')
    AND (${condition}) ORDER BY t.id`,s.ws,...(includeDoing?[actor]:[]),actor,actor,s.role(actor).kind==='human'?1:0,takesOpen,...params).map(t=>`T${t.id}`);
}
function asked(s:Store,id:number,task:Row):string[] {
  const submitted=s.get("SELECT detail FROM events WHERE workspace_id=? AND entity='task' AND entity_id=? AND action='submitted' ORDER BY id DESC LIMIT 1",s.ws,`T${id}`);
  let named:unknown;try{named=submitted?JSON.parse(String(submitted.detail)).reviewers:undefined;}catch{named=undefined;}
  if(Array.isArray(named)&&named.length)return named.map(String);
  // A creator that is a person runs no waiter, so its tasks stay open to every eligible role.
  return task.creator&&task.creator!==task.owner&&s.role(String(task.creator)).kind!=="human"?[String(task.creator)]:[];
}
function workflow(s:Store,actor:string,event:Row):WaitResult|undefined {
  if(event.entity==='supervisor-ping' && event.entity_id===actor && event.action==='requested') {
    let detail:Row;try{detail=JSON.parse(event.detail);}catch{return undefined;}
    const ping=s.get('SELECT * FROM supervisor_pings WHERE workspace_id=? AND role=? AND nonce=? AND acknowledged_at IS NULL',s.ws,actor,String(detail.nonce??''));
    const current=s.get('SELECT generation,state,ping_epoch FROM managed_workers WHERE workspace_id=? AND role=?',s.ws,actor);
    if(ping && (!current || ['running','draining'].includes(current.state)) && ping.generation===(current?.generation??0) && ping.ping_epoch===(current?.ping_epoch??0))return {role:actor,cursor:event.id,reason:'supervisor-ping',nonce:ping.nonce,generation:ping.generation,ping_deadline:ping.deadline,...(detail.checkpoint_requested===true?{checkpoint_requested:true}:{})};
    return undefined;
  }
  // A role already observed its own successful action. Consume its event cursor
  // without waking, while leaving other recipients' independent cursors intact.
  if(event.actor===actor)return undefined;
  const base={role:actor,cursor:event.id};
  let detail:Row;try{detail=JSON.parse(event.detail);}catch{return undefined;}
  if(event.entity==='question'&&event.action==='answered') {
    if(detail.relayed_by===actor)return undefined; // It relayed the answer, so it knows it (T1103).
    const q=s.get("SELECT q.id,q.task_id FROM questions q JOIN tasks t ON t.workspace_id=q.workspace_id AND t.id=q.task_id WHERE q.workspace_id=? AND q.id=? AND q.status='answered' AND (q.asked_by=? OR t.owner=?)",s.ws,Number(String(event.entity_id).slice(1)),actor,actor);
    if(q)return {...base,reason:'answer',question:`H${q.id}`,task:`T${q.task_id}`};
    return undefined;
  }
  if(event.entity==='message'&&event.action==='sent'&&detail.reply===true) {
    // Mail that asks for a reply wakes each recipient once (urgent mail wakes until acknowledged);
    // context lists it until it is acknowledged.
    const message=/^M\d+$/.test(event.entity_id)?s.get("SELECT m.id,m.sender,substr(m.body,1,2000) AS body,length(m.body)>2000 AS truncated FROM receipts r JOIN messages m ON m.workspace_id=r.workspace_id AND m.id=r.message_id WHERE r.workspace_id=? AND r.message_id=? AND r.recipient=? AND r.state!='done' AND m.reply=1",s.ws,Number(event.entity_id.slice(1)),actor):undefined;
    if(message)return {...base,reason:'reply-needed',message:{id:`M${message.id}`,sender:message.sender,summary:String(message.body).replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim(),truncated:!!message.truncated,...(message.truncated?{inbox_command:`sassato inbox --peek --as ${actor} --workspace ${s.workspace}`}:{})}};
    return undefined;
  }
  if(event.entity!=='task'||!/^T\d+$/.test(event.entity_id))return undefined;
  const id=Number(event.entity_id.slice(1));
  const reviewUpdate=event.action==='updated'&&detail.after?.reviewed_by===null&&
    !!s.get("SELECT 1 FROM tasks WHERE workspace_id=? AND id=? AND status='review'",s.ws,id);
  const reviewRestored=event.action==='blocker-resolved'&&detail.after?.status==='review';
  if(reviewUpdate||reviewRestored||['submitted','review-approved','review-rejected'].includes(event.action)) {
    const task=s.get('SELECT owner,creator,status,reviewed_by FROM tasks WHERE workspace_id=? AND id=?',s.ws,id);
    if(!task||task.status==='done'||task.status==='dropped')return undefined;
    // A late reader needs the current review transition, not every superseded
    // submission/result. Metadata notes may advance the task version without
    // replacing that transition, so compare workflow events rather than versions.
    const superseded=s.get(`SELECT 1 FROM events WHERE workspace_id=? AND entity='task' AND entity_id=? AND id>?
      AND (action IN ('submitted','review-approved','review-rejected','completed','dropped','reopened') OR
        (action='blocker-resolved' AND CASE WHEN json_valid(detail) THEN json_extract(detail,'$.after.status')='review' ELSE 0 END) OR
        (?='review' AND action='updated' AND CASE WHEN json_valid(detail) THEN json_type(detail,'$.after.reviewed_by')='null' ELSE 0 END))
      LIMIT 1`,s.ws,event.entity_id,event.id,task.status);
    if(superseded)return undefined;
    const version=Number.isSafeInteger(detail.after?.version)&&detail.after.version>0?detail.after.version:undefined;
    if(event.action==='submitted'||reviewUpdate||reviewRestored) {
      // Reviews are untargeted: use the existing reviewTask eligibility rule. Human
      // operators may review their own work; agents require an independent owner.
      // Updates that clear approval while keeping review open are new review requests.
      // An already settled or withdrawn submission no longer needs a reviewer.
      // Who is asked (T801): the reviewers the latest submission named, else the task's creator
      // when someone other than its owner created it, else every eligible role as before.
      const reviewers=asked(s,id,task);
      if(task.status==='review'&&task.reviewed_by===null&&(task.owner!==actor||s.role(actor).kind==='human')&&
        (!reviewers.length||reviewers.includes(actor)))
        return {...base,reason:'review-submitted',task:event.entity_id,version};
      // The owner still needs its blocker/answer notification below, even though
      // an agent owner is not an eligible reviewer of the restored submission.
      if(!reviewRestored)return undefined;
    } else {
      if(task.owner!==actor)return undefined;
      if(event.action==='review-approved'&&(task.status!=='review'||task.reviewed_by===null))return undefined;
      if(event.action==='review-rejected'&&(!['doing','blocked'].includes(task.status)||task.reviewed_by!==null))return undefined;
      return {...base,reason:event.action==='review-approved'?'review-approved':'review-rejected',task:event.entity_id,version};
    }
  }
  if(event.action==='blocked') {
    const blocker=/^B\d+$/.test(detail.blocker??'')?Number(detail.blocker.slice(1)):null;
    const waiting=blocker===null?undefined:s.get(`SELECT b.id FROM blockers b JOIN tasks t ON t.workspace_id=b.workspace_id AND t.id=b.task_id
      WHERE b.workspace_id=? AND b.id=? AND b.task_id=? AND b.status='open' AND b.waiting_on=?
      AND b.kind IN ('agent','human') AND t.status NOT IN ('done','dropped')`,s.ws,blocker,id,actor);
    if(waiting)return {...base,reason:'blocker-assigned',blocker:detail.blocker,task:event.entity_id};
    return undefined;
  }
  if(event.action==='dropped') {
    // Cancellation is not successful completion. Notify affected roles to reconcile
    // the dependency, but keep the task unclaimable until its dependency is resolved.
    const tasks=s.all(`SELECT t.id FROM dependencies d
      JOIN tasks t ON t.workspace_id=d.workspace_id AND t.id=d.task_id
      JOIN tasks p ON p.workspace_id=d.workspace_id AND p.id=d.depends_on
      WHERE d.workspace_id=? AND d.depends_on=? AND p.status='dropped'
      AND t.status NOT IN ('done','dropped') AND (t.owner=? OR
        (t.owner IS NULL AND (t.for_role IS NULL OR t.for_role=?)))
      AND (t.human_only=0 OR ?=1) ORDER BY t.id`,s.ws,id,actor,actor,s.role(actor).kind==='human'?1:0).map(row=>`T${row.id}`);
    if(tasks.length)return {...base,reason:'dependency-dropped',task:event.entity_id,tasks};
    return undefined;
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
    // Clearing spare makes the task ready work; marking it spare never wakes anyone (T1102).
    const updated=event.action==='updated'&&(['for_role','human_only'].some(key=>Object.hasOwn(detail.after??{},key)&&detail.before?.[key]!==detail.after[key])||detail.before?.spare===1&&detail.after?.spare===0);
    const repaired=event.action==='import-repaired'&&(detail.after?.task?.status??detail.after?.status)==='open';
    if(!updated&&!repaired&&!['created','imported','reopened','released','handed-off','dependency-removed'].includes(event.action))return undefined;
    if(['created','imported','handed-off','updated'].includes(event.action)) {
      const assigned=s.get("SELECT id FROM tasks WHERE workspace_id=? AND id=? AND spare=0 AND status NOT IN ('done','dropped') AND (owner IS NULL OR owner=?) AND (for_role IS NULL OR for_role=?) AND (owner=? OR for_role=?)",s.ws,id,actor,actor,actor,actor);
      if(assigned)return {...base,reason:'task-assigned',task:event.entity_id,tasks:[event.entity_id]};
    }
    tasks=available(s,actor,'t.id=?',[id],event.action==='dependency-removed');
  }
  if(tasks.length)return {...base,reason,task:tasks[0],tasks};
  return undefined;
}
/** What one event would put in a role's digest, as the waiter decides it (for the digest statistics
 * behind digest_skip, T977): a waking kind (ordinary mail too, T1233), an extra entry kind while a digest collects, or nothing. */
export function digestKindOf(s:Store,actor:string,event:Row):{kind:string;wakes:boolean}|undefined {
  const wake=workflow(s,actor,event);
  if(wake)return {kind:wake.message?.reply?'reply-needed':wake.reason,wakes:true};
  const extra=extraDuringDigest(s,actor,event);
  return extra?{kind:extra.kind,wakes:extra.kind==='mail'}:undefined;
}
/** Immediate workflow signals may be behind a full mail page. Deliver them without crossing skipped events. */
function priorityWorkflow(s:Store,actor:string,cursor:number):{wake:WaitResult;event:Row}[] {
  const answer=s.get(`SELECT e.* FROM questions q JOIN tasks t ON t.workspace_id=q.workspace_id AND t.id=q.task_id
    JOIN events e ON e.workspace_id=q.workspace_id AND e.entity='question' AND e.entity_id='H'||q.id AND e.action='answered'
    WHERE q.workspace_id=? AND q.status='answered' AND (q.asked_by=? OR t.owner=?) AND e.id>? AND e.actor!=? AND json_valid(e.detail)
      AND coalesce(json_extract(e.detail,'$.relayed_by'),'')!=? ORDER BY e.id LIMIT 1`,s.ws,actor,actor,cursor,actor,actor);
  const ping=s.get(`SELECT e.* FROM supervisor_pings p LEFT JOIN managed_workers w ON w.workspace_id=p.workspace_id AND w.role=p.role
    JOIN events e ON e.workspace_id=p.workspace_id AND e.entity='supervisor-ping' AND e.entity_id=p.role AND e.action='requested'
      AND CASE WHEN json_valid(e.detail) THEN json_extract(e.detail,'$.nonce')=p.nonce ELSE 0 END
    WHERE p.workspace_id=? AND p.role=? AND p.acknowledged_at IS NULL AND p.generation=coalesce(w.generation,0)
      AND p.ping_epoch=coalesce(w.ping_epoch,0) AND (w.id IS NULL OR w.state IN ('running','draining')) AND e.id>? ORDER BY e.id LIMIT 1`,s.ws,actor,cursor);
  // Pings have explicit nonce ACKs; a replayed answer must never hide a later ping.
  const result:{wake:WaitResult;event:Row}[]=[];
  for(const event of [ping,answer].filter((event):event is Row=>Boolean(event))) {
    const wake=workflow(s,actor,event);if(wake)result.push({wake,event});
  }
  return result;
}
function entryFor(s:Store,wake:WaitResult,event?:Row):DigestEntry {
  const source=wake.message?messageSent(s,wake.message.id):event;
  const kind=wake.message?.reply?'reply-needed':wake.reason;
  const id=wake.nudge?'nudge':wake.message?.id??wake.question??wake.blocker??wake.task??String(event?.entity_id??'work');
  let summary=wake.message?.summary??wake.nudge?.text,task=wake.task;
  if(!summary&&wake.reason==='supervisor-ping')summary=`generation ${wake.generation}; nonce ${wake.nonce}; deadline ${wake.ping_deadline}${wake.checkpoint_requested?' · save a current checkpoint after reconciling work':''}`;
  if(!summary&&wake.question) {const row=s.get('SELECT question,answer,task_id FROM questions WHERE workspace_id=? AND id=?',s.ws,Number(wake.question.slice(1)));summary=row?`${row.question}: ${row.answer??''}`:wake.question;task??=row?`T${row.task_id}`:undefined;}
  if(!summary&&wake.task)summary=s.get('SELECT title FROM tasks WHERE workspace_id=? AND id=?',s.ws,Number(wake.task.slice(1)))?.title;
  if(!summary)summary=(wake.tasks??[]).join(', ')||wake.reason;
  const unchanged=unchangedIdleText(wake.idle);
  return {id,...(source?{event_id:`E${source.id}`}:{}) ,from:String(wake.message?.sender??source?.actor??wake.role),kind,...(task?{task}:{}),...(wake.tasks?{tasks:wake.tasks}:{}),summary:unchanged??digestText(summary),group:digestGroup(kind),...(unchanged?{unchanged:true}:{})};
}
/** Once a wake is collecting, include relevant ordinary mail and completed work too. */
function extraDuringDigest(s:Store,actor:string,event:Row):DigestEntry|undefined {
  if(event.actor===actor)return undefined;
  if(event.entity==='message'&&event.action==='sent') {
    let detail:Row={};try{detail=JSON.parse(event.detail);}catch{/* no detail */}
    // An answer's notice: its H entry is the delivery (T1099). Notices written before the mark are known by their words.
    if(detail.answer||detail.workflow_mirror&&/^H\d+ on T\d+ answered by /.test(String(detail.body??'')))return undefined;
    const row=s.get("SELECT m.id,m.sender,m.body,m.task_id FROM receipts r JOIN messages m ON m.workspace_id=r.workspace_id AND m.id=r.message_id WHERE r.workspace_id=? AND r.recipient=? AND r.state!='done' AND m.id=?",s.ws,actor,Number(String(event.entity_id).slice(1)));
    if(row)return {id:`M${row.id}`,event_id:`E${event.id}`,from:row.sender,kind:'mail',...(row.task_id?{task:`T${row.task_id}`}:{}) ,summary:digestText(row.body),group:'other'};
  }
  if(event.entity==='task'&&event.action==='completed') {
    const row=s.get('SELECT title FROM tasks WHERE workspace_id=? AND id=? AND (owner=? OR creator=?)',s.ws,Number(String(event.entity_id).slice(1)),actor,actor);
    if(row)return {id:event.entity_id,event_id:`E${event.id}`,from:event.actor,kind:'task-finished',task:event.entity_id,summary:digestText(row.title),group:'finished'};
  }
  return undefined;
}
/** Read-only, non-consuming waiter. Save progress only after handling the returned notification. */
export interface WaitObserver {
  inspect:()=>void;
  deliveredMail:ReadonlySet<string>;
}
export async function waitForWork(s:Store, options:WaitOptions={}, observer?:WaitObserver):Promise<WaitResult> {
  const actor=s.requireActor(),timeout=integer(options.timeout??0,'timeout seconds',0,2_147_483);
  const clock=options.clock??systemClock;
  const settle=integer(options.settle??(s.role(actor).kind==='human'?0:120),'settle seconds',0,3600),settleMax=integer(options.settleMax??600,'settle maximum seconds',1,3600);
  const window=new DigestWindow(settle,settleMax),entries=new Map<string,DigestEntry>();
  const configuredStopFile=options.stopFile??workspaceSettings(s).stop_file;
  const stopFile=configuredStopFile===null?null:resolve(configuredStopFile);
  const initial=s.snapshot(()=>{
    const latest=maximum(s);
    const request=s.get('SELECT id,acknowledged_at FROM stop_requests WHERE workspace_id=? AND role=? AND cleared_at IS NULL',s.ws,actor);
    const stopped=stopFile&&existsSync(stopFile)?{file:stopFile}:request?{id:`R${request.id}`,acknowledged:!!request.acknowledged_at}:undefined;
    let cursor:number;
    if(options.since!==undefined) cursor=integer(options.since,'event cursor',0,Number.MAX_SAFE_INTEGER);
    else {
      try {
        const progress=getNotificationProgress(s);
        check(progress || stopped,`No saved notification progress. Read sassato context --as ${actor} --workspace ${s.workspace}, then retain its cursor with wait --since CURSOR after reconciling pending work (or save it with progress save).`);
        cursor=progress?.cursor??0;
      }
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
  let cursor=initial.cursor,omitted=false;let priority:WaitResult|undefined,idleReceipt:IdleDelivery|undefined;
  const skip=new Set(workspaceSettings(s).digest_skip?.[actor]??[]);
  const add=(entry:DigestEntry):boolean=>{
    if(observer?.deliveredMail.has(entry.id))return true;
    // Kinds this role never acts on (digest_skip, T977) are passed over: they neither wake it nor fill its digest.
    if(skip.has(entry.kind))return true;
    const key=entry.id.startsWith('M')?entry.id:entry.event_id??`${entry.id}:${entry.kind}`;
    if(entries.has(key))return true;
    if(entries.size>=DIGEST_LIMIT){omitted=true;return false;}
    entries.set(key,entry);window.add(clock.monotonic());return true;
  };
  const digest=(flush:WaitDigest['flush'],immediate?:WaitResult):WaitResult=>({...(immediate??{reason:'digest' as const,role:actor}),cursor,
    ...(idleReceipt&&immediate?.reason!=='stop'?{idle:idleReceipt}:{}),
    ...(entries.size?{digest:{entries:[...entries.values()],total:entries.size,flush,settle,settle_max:settleMax,has_more:omitted||Boolean(priority&&priority.cursor>cursor)}}:{})});
  check(cursor<=latest,`Event cursor ${cursor} is ahead of this workspace's latest event ${latest}; use a cursor from this workspace`,4);
  if(initial.stopped)return {reason:'stop',role:actor,cursor,stop:initial.stopped};
  if(options.settle===undefined&&options.settleMax===undefined&&workspaceSettings(s).wake_mode==='scored')
    return waitForScoredWork(s,actor,cursor,latest,timeout,options,observer);
  const deadline=timeout?clock.monotonic()+timeout*1000:Infinity;
  // --idle-minutes: a role that holds doing tasks and has written nothing for that long is woken
  // with its own work (T660); one with none doing but open tasks of its own (its owner's or for it)
  // that it can take now is woken with those, to take one (T763). Work writes restart the idle period.
  const idle=integer(options.idleMinutes??options.defaultIdleMinutes??0,'idle minutes',0,10_080)*60_000;
  const idleState={next:clock.monotonic()+idle,from:latest};
  const nudgeMinutes=options.nudge&&s.role(actor).kind!=='human'?workspaceSettings(s).nudge_minutes:0;
  const nudgeState:NudgeState={next:nudgeMinutes?clock.now():Infinity,start:{id:latest,at:clock.now()},checked:0,answer:0};
  let nudged=false;
  for(;;) {
    priority=undefined;
    if(stopFile&&existsSync(stopFile))return digest('immediate',{reason:'stop',role:actor,cursor,stop:{file:stopFile}});
    observer?.inspect();
    let more=false;
    const result=s.snapshot(():WaitResult|undefined=>{
      const stop=s.get('SELECT id,acknowledged_at FROM stop_requests WHERE workspace_id=? AND role=? AND cleared_at IS NULL',s.ws,actor);
      if(stop)return digest('immediate',{reason:'stop',role:actor,cursor,stop:{id:`R${stop.id}`,acknowledged:!!stop.acknowledged_at}});
      const immediate=settle?priorityWorkflow(s,actor,cursor):[];priority=immediate[0]?.wake;
      for(const signal of immediate)add(entryFor(s,signal.wake,signal.event));
      const messages=s.all(`SELECT m.id,m.sender,substr(m.body,1,2000) AS body,length(m.body)>2000 AS truncated,m.reply,m.task_id,${MESSAGE_NOW_SQL} AS wake_now
        FROM receipts r JOIN messages m ON m.workspace_id=r.workspace_id AND m.id=r.message_id
        WHERE r.workspace_id=? AND r.recipient=? AND r.state IN ('unread','read') AND m.urgent=1 AND m.sender!=?
        ${observer?.deliveredMail.size?"AND m.id NOT IN (SELECT value FROM json_each(?))":""}
        ORDER BY wake_now DESC,m.id LIMIT ?`,s.ws,actor,actor,...(observer?.deliveredMail.size?[JSON.stringify(Array.from(observer.deliveredMail,id=>Number(id.slice(1))))]:[]),DIGEST_LIMIT+1);
      for(const message of messages) {
        const wake:WaitResult={reason:'urgent',role:actor,cursor,...(message.task_id?{task:`T${message.task_id}`}:{}) ,message:{id:`M${message.id}`,sender:message.sender,summary:String(message.body).replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim(),truncated:!!message.truncated,reply:!!message.reply,now:!!message.wake_now,...(message.truncated?{inbox_command:`sassato inbox --peek --as ${actor} --workspace ${s.workspace}`}:{})}};
        if(!settle)return wake;
        const included=add(entryFor(s,wake));
        if(message.wake_now)return digest('immediate',wake);
        if(!included)return priority?digest('immediate',priority):digest('capacity');
      }
      if(entries.size&&window.reason(clock.monotonic())==='max')return priority?digest('immediate',priority):digest('max');
      const events=s.all('SELECT id,entity,entity_id,actor,action,detail FROM events WHERE workspace_id=? AND id>? ORDER BY id LIMIT 200',s.ws,cursor);
      more=events.length===200;
      for(const event of events) {
        const wake=workflow(s,actor,event);
        if(!settle){cursor=event.id;if(wake&&!skip.has(wake.message?.reply?'reply-needed':wake.reason))return wake;continue;}
        // Ordinary mail opens a digest of its own (T1233): before, it joined one only while another entry was
        // open, and otherwise the cursor passed it unseen. Other extra kinds still only join an open digest.
        const entry=wake?entryFor(s,wake,event):entries.size||event.entity==='message'?extraDuringDigest(s,actor,event):undefined;
        if(entry&&!add(entry)) {
          if(wake&&['answer','supervisor-ping'].includes(wake.reason))return digest('immediate',priority??wake);
          return priority?digest('immediate',priority):digest('capacity'); // Never cross an omitted relevant event.
        }
        cursor=event.id;
        // A ping returns at once; an answer reads on to the end of the events already there, so answers
        // given together come in one digest (T1099).
        if(wake?.reason==='supervisor-ping')return digest('immediate',priority??wake);
        if(wake?.reason==='answer')priority??=wake;
      }
      return priority?digest('immediate',priority):undefined;
    });
    if(result)return result;
    if(idle&&!idleReceipt&&clock.monotonic()>=idleState.next) {
      const receipt=s.snapshot(()=>scanIdle(s,actor,clock,idle,idleState,skip));
      if(receipt) {
        const wake=idleResult(actor,cursor,receipt);
        if(!settle)return wake;
        if(!add(entryFor(s,wake)))return digest('capacity');
        idleReceipt=receipt;
      }
    }
    if(nudgeMinutes&&!nudged&&clock.now()>=nudgeState.next) {
      // The check and its write share one write transaction, so two waiters or a late answer cannot double it.
      const due=s.tx(()=>{
        const found=scanNudge(s,actor,nudgeMinutes,Math.floor(clock.now()),nudgeState);
        if(found?.escalate) {
          const to=workspaceSettings(s).nudge_escalate;
          // The mail is the role's own write, so the escalation event comes after it and still marks the end.
          if(to&&to!==actor)send(s,[to],`${actor} has written nothing for ${nudgeMinutes*3} minutes and answered neither of two nudges (an idle reason or a take). No more nudges until it writes.`);
          s.event('nudge',actor,'escalated',{minutes:nudgeMinutes,to});
        } else if(found) {
          // The text is built before the event, so a nudge is recorded only when it can be delivered.
          const text=nudgeText(s,actor,nudgeMinutes,found.count,found.tasks);
          s.event('nudge',actor,'sent',{minutes:nudgeMinutes,count:found.count,tasks:found.tasks});
          return {...found,text};
        }
        return found;
      });
      if(due&&!due.escalate) {
        const text=due.text!;
        const wake:WaitResult={reason:'nudge',role:actor,cursor,...(due.tasks.length?{tasks:due.tasks}:{}),nudge:{minutes:nudgeMinutes,count:due.count,text}};
        if(!settle)return wake;
        if(!add(entryFor(s,wake)))return digest('capacity');
        nudged=true;
      }
    }
    const at=clock.monotonic(),flush=window.reason(at);
    if(entries.size&&flush)return digest(flush);
    const remaining=deadline-at;
    if(remaining<=0)return entries.size?digest('deadline'):{reason:'timeout',role:actor,cursor};
    // A bounded snapshot permits writers and checkpoints between batches and sleeps.
    const idleDelay=idle&&!idleReceipt?idleState.next-at:Infinity;
    const nudgeDelay=nudgeMinutes&&!nudged?Math.max(0,nudgeState.next-clock.now()):Infinity;
    await clock.sleep(nextPause(more,remaining,Math.min(window.deadline()-at,idleDelay,nudgeDelay)));
  }
}
function idleWork(s:Store,actor:string) {
  const doing=s.all("SELECT id FROM tasks WHERE workspace_id=? AND owner=? AND status='doing' ORDER BY priority DESC,id LIMIT ?",s.ws,actor,IDLE_TASK_LIMIT).map(r=>`T${r.id}`);
  if(doing.length)return {reason:'own-work' as const,tasks:doing};
  const open=idleOpenWork(s,actor);
  if(open.length)return {reason:'open-work' as const,tasks:open};
  const spare=idleSpareWork(s,actor);
  return spare.length?{reason:'spare-work' as const,tasks:spare}:undefined;
}

const DAY=24*60*60_000;
// A role's own writes; its bookkeeping (checkpoints, progress, its waiter and the nudges it gets) is not work.
const idleActivity=(s:Store,actor:string,since:number)=>s.get(`SELECT id,created_at FROM events WHERE workspace_id=? AND id>? AND actor=?
  AND entity NOT IN ('wip','checkpoint','session','notification-progress','wake-enrollment','wake-delivery','watch-dispatch','supervisor-ping','waiter','nudge')
  ORDER BY id DESC LIMIT 1`,s.ws,since,actor);

// The nudge (T1253). A role that has written nothing for nudge_minutes is asked why, whether or not work is
// ready; it answers with idle-reason or by taking a task. After an answer it is not nudged again until
// something changes for it (mail to it, or an event that would wake it: a task assigned or made ready, a block
// resolved). Unanswered, it is nudged once more after the same interval, then the escalation role gets one
// ordinary mail, and the nudges stop until the role writes again.
interface NudgeState {next:number;start:{id:number;at:number};checked:number;answer:number;change?:{id:number;at:number}}
const NUDGE_RECHECK=60_000;
function changeFor(s:Store,actor:string,after:number):Row|undefined {
  for(;;) {
    const events=s.all("SELECT id,entity,entity_id,actor,action,detail,created_at FROM events WHERE workspace_id=? AND id>? AND actor!=? AND entity IN ('message','task','question') ORDER BY id LIMIT 500",s.ws,after,actor);
    for(const event of events) {
      if(event.entity==='message'&&event.action==='sent'&&/^M\d+$/.test(event.entity_id)&&
        s.get('SELECT 1 FROM receipts WHERE workspace_id=? AND message_id=? AND recipient=?',s.ws,Number(event.entity_id.slice(1)),actor))return event;
      if(workflow(s,actor,event))return event;
    }
    if(events.length<500)return undefined;
    after=events[events.length-1].id;
  }
}
/** A role's own write in SQL (T1253): not its bookkeeping, a read, an acknowledgement or a lease renewal. Shared by
 * the nudge and the stats time table, so 'working' there means what the nudge counts. */
export const OWN_WRITE=`entity NOT IN ('wip','checkpoint','session','notification-progress','wake-enrollment','wake-delivery','watch-dispatch','supervisor-ping','waiter','nudge')
    AND NOT (entity='message' AND action IN ('read','done')) AND NOT (entity='task' AND action='renewed')`;
function scanNudge(s:Store,actor:string,minutes:number,wall:number,state:NudgeState):{count:number;tasks:string[];escalate?:true;text?:string}|undefined {
  // A write of the role's own, not a read, an acknowledgement or a lease renewal; with none, its first waiter.
  const last=s.get(`SELECT id,created_at FROM events WHERE workspace_id=? AND actor=? AND ${OWN_WRITE}
    ORDER BY id DESC LIMIT 1`,s.ws,actor)??s.get("SELECT id,created_at FROM events WHERE workspace_id=? AND entity='waiter' AND entity_id=? ORDER BY id LIMIT 1",s.ws,actor);
  let base=last?{id:Number(last.id),at:Date.parse(last.created_at)}:state.start;
  // A session that starts or resumes gets the full interval from its start, not from its last write.
  const start=sessionStart(s,actor,minutes);
  if(start&&start.id>base.id)base=start;
  const reason=s.get("SELECT id FROM events WHERE workspace_id=? AND entity='idle' AND entity_id=? AND action='reason' ORDER BY id DESC LIMIT 1",s.ws,actor);
  const lastNudge=s.get("SELECT id FROM events WHERE workspace_id=? AND entity='nudge' AND entity_id=? AND action='sent' ORDER BY id DESC LIMIT 1",s.ws,actor);
  const take=lastNudge?s.get("SELECT id FROM events WHERE workspace_id=? AND entity='task' AND action='claimed' AND actor=? AND id>? ORDER BY id LIMIT 1",s.ws,actor,lastNudge.id):undefined;
  const answer=Math.max(Number(reason?.id??0),Number(take?.id??0));
  if(answer) {
    if(answer!==state.answer){state.answer=answer;state.checked=answer;state.change=undefined;}
    if(!state.change) {
      const change=changeFor(s,actor,state.checked);
      if(!change){state.checked=maximum(s);state.next=wall+NUDGE_RECHECK;return undefined;}
      state.change={id:Number(change.id),at:Date.parse(change.created_at)};
    }
    if(state.change.id>base.id)base=state.change;
  }
  const nudges=s.all("SELECT action,created_at FROM events WHERE workspace_id=? AND entity='nudge' AND entity_id=? AND id>? ORDER BY id",s.ws,actor,base.id);
  if(nudges.some(n=>n.action==='escalated')){state.next=wall+NUDGE_RECHECK;return undefined;}
  const sent=nudges.filter(n=>n.action==='sent');
  const due=(sent.length?Date.parse(sent[sent.length-1].created_at):base.at)+minutes*60_000;
  state.next=Math.min(Math.max(due,wall+1000),wall+NUDGE_RECHECK);
  if(wall<due)return undefined;
  state.next=wall+NUDGE_RECHECK;
  if(sent.length>=2)return {count:sent.length,tasks:[],escalate:true};
  return {count:sent.length+1,tasks:idleWork(s,actor)?.tasks??[]};
}
// The latest start of the role's session: its registration, or a waiter armed when the one before it never
// ended (the session died) or ended longer than the nudge interval ago. A re-arm right after a wake is no start.
function sessionStart(s:Store,actor:string,minutes:number):{id:number;at:number}|undefined {
  const at=(row:Row)=>({id:Number(row.id),at:Date.parse(row.created_at)});
  const registered=s.get("SELECT id,created_at FROM events WHERE workspace_id=? AND entity='session' AND action='registered' AND actor=? ORDER BY id DESC LIMIT 1",s.ws,actor);
  const waiters=s.all("SELECT id,action,created_at FROM events WHERE workspace_id=? AND entity='waiter' AND entity_id=? ORDER BY id DESC LIMIT 200",s.ws,actor);
  let armed:Row|undefined;
  for(let i=0;i<waiters.length&&!armed;i++) {
    if(waiters[i].action!=='armed')continue;
    const before=waiters[i+1];
    if(before?before.action==='armed'||Date.parse(waiters[i].created_at)-Date.parse(before.created_at)>minutes*60_000:waiters.length<200)armed=waiters[i];
  }
  const found=[registered,armed].filter((row):row is Row=>!!row).map(at).sort((x,y)=>y.id-x.id);
  return found[0];
}
function nudgeText(s:Store,actor:string,minutes:number,count:number,tasks:string[]):string {
  const answer=`Answer with sassato idle-reason "why" --as ${actor} --workspace ${s.workspace}, or take a task`;
  const escalate=workspaceSettings(s).nudge_escalate;
  const ready=tasks.length?`Ready for you: ${tasks.join(', ')}.`:`Nothing is ready for you: ask ${escalate&&escalate!==actor?escalate:'whoever assigns work'} for work in one line.`;
  return `No write from you for ${minutes} minutes (nudge ${count} of 2). ${answer}; no new nudge then until something changes for you. ${ready}`;
}

// Whether anything since the last idle wake makes the next one news (T1348). For own work, the holder's
// own writes on the listed tasks (a note answering the reminder) are not: the back-off goes on. Another
// role's change to one of them, even one followed by the holder's note, and the holder's writes elsewhere are.
function idleChange(s:Store,actor:string,observed:number,held:string[]):boolean {
  if(!held.length)return Boolean(idleActivity(s,actor,observed));
  const marks=held.map(()=>'?').join(',');
  return Boolean(s.get(`SELECT 1 FROM events WHERE workspace_id=? AND id>? AND entity='task' AND entity_id IN (${marks}) AND actor!=? LIMIT 1`,s.ws,observed,...held,actor)||
    s.get(`SELECT 1 FROM events WHERE workspace_id=? AND id>? AND actor=?
      AND entity NOT IN ('wip','checkpoint','session','notification-progress','wake-enrollment','wake-delivery','watch-dispatch','supervisor-ping','waiter','nudge')
      AND NOT (entity='task' AND entity_id IN (${marks})) LIMIT 1`,s.ws,observed,actor,...held));
}

function scanIdle(s:Store,actor:string,clock:WaitClock,interval:number,state:{next:number;from:number},skip:Set<string>):IdleDelivery|undefined {
  const now=clock.monotonic(), wall=Math.floor(clock.now());
  const activity=idleActivity(s,actor,state.from);
  if(activity) {
    state.from=activity.id;
    const age=Math.max(0,wall-Date.parse(activity.created_at))||0;
    state.next=now+Math.max(0,interval-age);
    if(state.next>now)return undefined;
  }
  state.next=now+interval;
  const work=idleWork(s,actor);
  if(!work||skip.has(work.reason))return undefined;
  const tasks=work.tasks.map(id=>({id,version:Number(s.get('SELECT version FROM tasks WHERE workspace_id=? AND id=?',s.ws,Number(id.slice(1)))!.version)}));
  let previous:IdleDelivery|undefined;
  try {previous=lastIdleDelivery(s,getNotificationProgress(s,actor));}
  catch(error) {
    // An explicit preview can replay even when its stored progress cannot be read.
    if(!(error instanceof AppError)||error.code!==4)throw error;
  }
  if(previous?.kind===work.reason && previous.delivered<=wall && tasks.length===previous.tasks.length &&
    tasks.every(task=>previous.tasks.some(old=>old.id===task.id&&(old.version===task.version||work.reason==='own-work'))) &&
    !idleChange(s,actor,previous.observed,work.reason==='own-work'?work.tasks:[])) {
    const delay=Math.min(DAY,interval*2**Math.min(previous.repeats,16));
    if(wall<previous.delivered+delay) {
      state.next=Math.min(state.next,now+previous.delivered+delay-wall);
      return undefined;
    }
    return {kind:work.reason,tasks,observed:maximum(s),since:previous.since,delivered:wall,repeats:Math.min(previous.repeats+1,16)};
  }
  return {kind:work.reason,tasks,observed:maximum(s),since:wall,delivered:wall,repeats:0};
}

export function unchangedIdleText(idle:IdleDelivery|undefined):string|undefined {
  if(!idle?.repeats)return undefined;
  return `unchanged since ${new Date(idle.since).toISOString()} · ${idle.tasks.map(task=>`${task.id} version ${task.version}`).join(', ')}`;
}

function idleResult(role:string,cursor:number,idle:IdleDelivery):WaitResult {
  const tasks=idle.tasks.map(task=>task.id);
  return {role,cursor,reason:idle.kind,task:tasks[0],tasks,idle};
}

interface ScoredEntry extends ScoredItem {
  entry:DigestEntry;
  signal?:WaitResult;
}

/** Read every eligible obligation in one snapshot, including quiet mail that has no timer. */
function scoredEntries(s:Store,actor:string,cursor:number,settings:WorkspaceSettings,seen:Set<number>,deliveredMail?:ReadonlySet<string>):ScoredEntry[] {
  const skip=new Set(settings.digest_skip?.[actor]??[]);
  const found:ScoredEntry[]=[];
  const ready=new Set<string>();
  const events=s.all(`SELECT id,entity,entity_id,actor,action,detail,created_at FROM events
    WHERE workspace_id=? AND id>? AND (
      (entity='message' AND action='sent' AND EXISTS (
        SELECT 1 FROM receipts r WHERE r.workspace_id=events.workspace_id AND r.recipient=?
        AND r.state!='done' AND r.message_id=CAST(substr(events.entity_id,2) AS INTEGER)
      )) OR (entity='question' AND action='answered') OR
      (entity='supervisor-ping' AND action='requested') OR (entity='task' AND action IN
        ('created','imported','updated','reopened','released','handed-off','dependency-removed','completed',
         'dropped','import-repaired','blocked','blocker-resolved','submitted','review-approved','review-rejected')))
    ORDER BY id`,s.ws,cursor,actor);
  for(const event of events) {
    if(event.actor===actor&&event.entity!=='supervisor-ping')continue;
    const at=Date.parse(event.created_at);
    if(event.entity==='message'){
      if(seen.has(event.id)||deliveredMail?.has(event.entity_id))continue;
      const message=s.get(`SELECT m.id,m.sender,m.body,m.task_id,m.reply,m.urgent,m.urgency,
        coalesce(m.immediate,${MESSAGE_NOW_SQL}) AS wake_now
        FROM receipts r JOIN messages m ON m.workspace_id=r.workspace_id AND m.id=r.message_id
        WHERE r.workspace_id=? AND r.recipient=? AND r.state!='done' AND 'M'||m.id=?`,s.ws,actor,event.entity_id);
      if(!message)continue;
      let mirror=false;
      try {const audit=JSON.parse(event.detail);mirror=audit?.workflow_mirror===true||typeof audit?.task_id==='string'&&typeof audit?.body==='string';} catch { /* Read the stored message flags if older audit metadata is absent. */ }
      const weight=mirror?0:message.urgency??(message.urgent?5:message.reply?3:1);
      const kind=message.reply?'reply-needed':message.urgent||weight>=5?'urgent':'mail';
      if(!message.wake_now&&weight<=1&&skip.has(kind))continue;
      const entry:DigestEntry={id:event.entity_id,event_id:`E${event.id}`,from:message.sender,kind,group:digestGroup(kind),summary:digestText(message.body),
        ...(message.task_id?{task:`T${message.task_id}`}:{})};
      found.push({at,event:event.id,weight,entry,...(message.wake_now?{immediate:'now' as const}:{})});
      continue;
    }
    let signal=workflow(s,actor,event);
    if(signal&&(signal.reason==='task-assigned'||signal.reason==='task-ready')){
      if(skip.has(signal.reason))continue;
      const tasks=(signal.tasks??[]).filter(task=>{
        const n=Number(task.slice(1));
        if(signal?.reason==='task-ready' && !available(s,actor,'t.id=?',[n],true).length)return false;
        if(signal?.reason==='task-assigned' && s.role(actor).kind!=='human' && s.get(
          'SELECT 1 FROM tasks WHERE workspace_id=? AND id=? AND human_only=1',s.ws,n))return false;
        const later=s.get(`SELECT 1 FROM events e WHERE e.workspace_id=? AND e.id>? AND ((e.entity='task'
          AND e.entity_id=? AND (e.action IN ('reopened','released','handed-off') OR
            (e.action='updated' AND CASE WHEN json_valid(e.detail) THEN
              json_extract(e.detail,'$.before.for_role') IS NOT json_extract(e.detail,'$.after.for_role') OR
              json_extract(e.detail,'$.before.human_only') IS NOT json_extract(e.detail,'$.after.human_only') ELSE 0 END)))
          OR (?='completed' AND e.entity='task' AND e.action='completed' AND EXISTS (
            SELECT 1 FROM dependencies d WHERE d.workspace_id=e.workspace_id AND d.task_id=? AND e.entity_id='T'||d.depends_on))) LIMIT 1`,
          s.ws,event.id,task,event.action,n);
        if(later||ready.has(task))return false;
        ready.add(task);return true;
      });
      if(!tasks.length)continue;
      signal={...signal,task:tasks[0],tasks};
    }
    // Delivered entries still represent their current obligation until the cursor passes them.
    // Superseded transitions above cannot mask a newer assignment or readiness transition.
    if(seen.has(event.id))continue;
    const entry=signal?entryFor(s,signal,event):extraDuringDigest(s,actor,event);
    if(!entry)continue;
    const immediate=signal?.reason==='supervisor-ping'||signal?.reason==='answer'?signal.reason:undefined;
    if(!immediate&&skip.has(entry.kind))continue;
    found.push({at,event:event.id,entry,weight:WORKFLOW_WAKE_POINTS[entry.kind]??0,immediate,signal});
  }
  return found;
}

async function waitForScoredWork(s:Store,actor:string,cursor:number,initialLatest:number,timeout:number,
  options:WaitOptions,observer?:WaitObserver):Promise<WaitResult> {
  const clock=options.clock??systemClock;
  const deadline=timeout?clock.monotonic()+timeout*1000:Infinity;
  const idleOverride=options.idleMinutes===undefined?undefined:integer(options.idleMinutes,'idle minutes',0,10_080);
  const idleState={next:clock.monotonic(),from:initialLatest};
  let previousInterval=0;
  const stopResult=(settings:WorkspaceSettings):WaitResult|undefined=>{
    const file=options.stopFile??settings.stop_file;
    if(file&&existsSync(resolve(file)))return {reason:'stop',role:actor,cursor,stop:{file:resolve(file)}};
    const request=s.get('SELECT id,acknowledged_at FROM stop_requests WHERE workspace_id=? AND role=? AND cleared_at IS NULL',s.ws,actor);
    if(request)return {reason:'stop',role:actor,cursor,stop:{id:`R${request.id}`,acknowledged:!!request.acknowledged_at}};
  };
  for(;;){
    const stop=s.snapshot(()=>stopResult(workspaceSettings(s)));
    if(stop)return stop;
    observer?.inspect();
    const scan=s.snapshot(()=>{
      const settings=workspaceSettings(s);
      const stop=stopResult(settings);
      if(stop)return {result:stop};
      if(settings.wake_mode==='legacy')return {legacy:true};
      const latest=maximum(s);
      const {seen,through}=scoredDeliveryState(s,actor,cursor);
      const pending=scoredEntries(s,actor,cursor,settings,seen,observer?.deliveredMail);
      const policy=effectiveWakePolicy(settings.speed,roleWakePolicy(settings,actor));
      const scored=scoredWake(pending,policy,clock.now());
      const idle=(idleOverride??(s.role(actor).kind==='agent'?policy.idle_minutes:0))*60_000;
      if(idle!==previousInterval) {
        idleState.next=previousInterval?idleState.next+idle-previousInterval:clock.monotonic()+idle;
        previousInterval=idle;
      }
      const receipt=idle&&clock.monotonic()>=idleState.next?scanIdle(s,actor,clock,idle,idleState,new Set(settings.digest_skip?.[actor])):undefined;
      const work=receipt?idleResult(actor,cursor,receipt):undefined;
      const cause=scored.reason??(through!==undefined&&pending.some(item=>item.event<=through)?'continuation':work?'idle':undefined);
      if(!cause)return {sleep:Math.min(scored.due-clock.now(),idle?idleState.next-clock.monotonic():Infinity)};
      const order=(item:ScoredEntry)=>item.immediate==='supervisor-ping'?0:item.immediate?1:item===scored.trigger?2:3;
      pending.sort((a,b)=>order(a)-order(b)||b.weight-a.weight||a.at-b.at||a.event-b.event);
      const room=work?DIGEST_LIMIT-1:DIGEST_LIMIT;
      const page=pending.slice(0,room),omitted=pending.slice(room);
      const boundary=omitted.reduce((first,item)=>Math.min(first,item.event-1),latest);
      const signal=scored.trigger?.signal??(work?{reason:work.reason,role:actor,cursor,task:work.task,tasks:work.tasks}:undefined);
      const entries:DigestEntry[]=page.map(item=>({...item.entry,weight:item.weight}));
      if(work)entries.push(entryFor(s,work));
      const score:WakeScore={
        reason:cause,total:scored.total,threshold:scored.threshold,speed:settings.speed,
        ...(scored.trigger?{trigger:scored.trigger.entry.id}:{}),
        ...(scored.trigger?.immediate?{immediate_cause:scored.trigger.immediate}:{}),
        ...(cause==='age'&&scored.trigger?{age_limit_seconds:scored.trigger.weight>=5?policy.urgent_seconds:policy.reply_seconds}:{}),
      };
      const result:WaitResult={...(signal??{reason:'digest',role:actor}),mode:'scored',cursor:boundary,
        scored:{score,event_ids:page.filter(item=>item.event>boundary).map(item=>item.event),...(omitted.length?{through:latest}:{}),...(receipt?{idle:receipt}:{})},
        digest:{
          entries,total:entries.length,flush:cause==='immediate'?'immediate':'scored',settle:0,settle_max:0,has_more:!!omitted.length,
          score,
        },
      };
      return {result};
    });
    if(scan.result)return s.snapshot(()=>stopResult(workspaceSettings(s)))??scan.result;
    if(scan.legacy) {
      const remaining=deadline-clock.monotonic();
      if(remaining<=0)return {reason:'timeout',role:actor,cursor,mode:'scored'};
      return waitForWork(s,{...options,since:cursor,timeout:timeout?Math.ceil(remaining/1000):0,
        settle:s.role(actor).kind==='human'?0:120},observer);
    }
    const remaining=deadline-clock.monotonic();
    if(remaining<=0)return {reason:'timeout',role:actor,cursor,mode:'scored'};
    await clock.sleep(nextPause(false,remaining,scan.sleep??Infinity));
  }
}
/** How long the waiter sleeps before looking again: never negative, since a quiet window that
 * ended between two clock reads would make Node warn (TimeoutNegativeWarning, T960). */
export function nextPause(more:boolean,remaining:number,windowLeft:number):number {
  return more?0:Math.max(0,Math.min(500,remaining,windowLeft));
}
/** Backwards-compatible name; now also wakes for relevant workflow events. */
export const waitForUrgent=waitForWork;
