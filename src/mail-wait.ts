import { DIGEST_LIMIT, DigestWindow, digestText, digestGroup, messageSent, MESSAGE_NOW_SQL, type DigestEntry, type WaitDigest } from './wait-digest.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store, type Row, type Param } from './storage.js';
import { AppError, check, integer } from './errors.js';
import { workspaceSettings } from './workspace-settings.js';
import { getNotificationProgress } from './notification-progress.js';

export interface WaitResult {
  reason:'digest'|'urgent'|'reply-needed'|'own-work'|'open-work'|'stop'|'timeout'|'answer'|'blocker-resolved'|'blocker-assigned'|'dependency-dropped'|'task-assigned'|'task-ready'|'review-submitted'|'review-approved'|'review-rejected'|'supervisor-ping';
  role:string; cursor:number; message?:Row; stop?:Row;
  question?:string; blocker?:string; task?:string; tasks?:string[];
  /** Task version recorded by the workflow event, not a substitute for reading current work. */
  version?:number;
  nonce?:string;generation?:number;ping_deadline?:string;
  managed_observation?:string;
  digest?:WaitDigest;
}
export interface WaitOptions { timeout?:number; stopFile?:string; since?:number; idleMinutes?:number; settle?:number; settleMax?:number }
const maximum=(s:Store):number=>Number(s.get('SELECT coalesce(max(id),0) n FROM events WHERE workspace_id=?',s.ws)!.n);
function available(s:Store,actor:string,condition:string,params:Param[],includeDoing=false):string[] {
  // These are the same gates as tasks --available, applied to event candidates only, except that a
  // task neither owned nor routed wakes only the roles in open_work_roles (every role when unset).
  const roles=workspaceSettings(s).open_work_roles,takesOpen=roles===null||roles.includes(actor)?1:0;
  return s.all(`SELECT t.id FROM tasks t WHERE t.workspace_id=? AND (t.status='open'${includeDoing?" OR (t.status='doing' AND t.owner=?)":''})
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
    if(ping && (!current || ['running','draining'].includes(current.state)) && ping.generation===(current?.generation??0) && ping.ping_epoch===(current?.ping_epoch??0))return {role:actor,cursor:event.id,reason:'supervisor-ping',nonce:ping.nonce,generation:ping.generation,ping_deadline:ping.deadline};
    return undefined;
  }
  // A role already observed its own successful action. Consume its event cursor
  // without waking, while leaving other recipients' independent cursors intact.
  if(event.actor===actor)return undefined;
  const base={role:actor,cursor:event.id};
  let detail:Row;try{detail=JSON.parse(event.detail);}catch{return undefined;}
  if(event.entity==='question'&&event.action==='answered') {
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
/** Immediate workflow signals may be behind a full mail page. Deliver them without crossing skipped events. */
function priorityWorkflow(s:Store,actor:string,cursor:number):{wake:WaitResult;event:Row}[] {
  const answer=s.get(`SELECT e.* FROM questions q JOIN tasks t ON t.workspace_id=q.workspace_id AND t.id=q.task_id
    JOIN events e ON e.workspace_id=q.workspace_id AND e.entity='question' AND e.entity_id='H'||q.id AND e.action='answered'
    WHERE q.workspace_id=? AND q.status='answered' AND (q.asked_by=? OR t.owner=?) AND e.id>? AND e.actor!=? AND json_valid(e.detail) ORDER BY e.id LIMIT 1`,s.ws,actor,actor,cursor,actor);
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
  const id=wake.message?.id??wake.question??wake.blocker??wake.task??String(event?.entity_id??'work');
  let summary=wake.message?.summary,task=wake.task;
  if(!summary&&wake.reason==='supervisor-ping')summary=`generation ${wake.generation}; nonce ${wake.nonce}; deadline ${wake.ping_deadline}`;
  if(!summary&&wake.question) {const row=s.get('SELECT question,answer,task_id FROM questions WHERE workspace_id=? AND id=?',s.ws,Number(wake.question.slice(1)));summary=row?`${row.question}: ${row.answer??''}`:wake.question;task??=row?`T${row.task_id}`:undefined;}
  if(!summary&&wake.task)summary=s.get('SELECT title FROM tasks WHERE workspace_id=? AND id=?',s.ws,Number(wake.task.slice(1)))?.title;
  if(!summary)summary=(wake.tasks??[]).join(', ')||wake.reason;
  return {id,...(source?{event_id:`E${source.id}`}:{}) ,from:String(wake.message?.sender??source?.actor??wake.role),kind,...(task?{task}:{}),summary:digestText(summary),group:digestGroup(kind)};
}
/** Once a wake is collecting, include relevant ordinary mail and completed work too. */
function extraDuringDigest(s:Store,actor:string,event:Row):DigestEntry|undefined {
  if(event.actor===actor)return undefined;
  if(event.entity==='message'&&event.action==='sent') {
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
export async function waitForWork(s:Store, options:WaitOptions={}):Promise<WaitResult> {
  const actor=s.requireActor(),timeout=integer(options.timeout??0,'timeout seconds',0,2_147_483);
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
  let cursor=initial.cursor,omitted=false;let priority:WaitResult|undefined;
  const add=(entry:DigestEntry):boolean=>{
    const key=entry.id.startsWith('M')?entry.id:entry.event_id??`${entry.id}:${entry.kind}`;
    if(entries.has(key))return true;
    if(entries.size>=DIGEST_LIMIT){omitted=true;return false;}
    entries.set(key,entry);window.add(performance.now());return true;
  };
  const digest=(flush:WaitDigest['flush'],immediate?:WaitResult):WaitResult=>({...(immediate??{reason:'digest' as const,role:actor}),cursor,
    ...(entries.size?{digest:{entries:[...entries.values()],total:entries.size,flush,settle,settle_max:settleMax,has_more:omitted||Boolean(priority&&priority.cursor>cursor)}}:{})});
  check(cursor<=latest,`Event cursor ${cursor} is ahead of this workspace's latest event ${latest}; use a cursor from this workspace`,4);
  if(initial.stopped)return {reason:'stop',role:actor,cursor,stop:initial.stopped};
  const deadline=timeout?performance.now()+timeout*1000:Infinity;
  // --idle-minutes: a role that holds doing tasks and has written nothing for that long is woken
  // with its own work (T660); one with none doing but open tasks of its own (its owner's or for it)
  // that it can take now is woken with those, to take one (T763). Any write of its own starts the period again.
  const idle=integer(options.idleMinutes??0,'idle minutes',0,10_080)*60_000;
  let idleSince=performance.now(),idleFrom=latest;
  for(;;) {
    priority=undefined;
    if(stopFile&&existsSync(stopFile))return digest('immediate',{reason:'stop',role:actor,cursor,stop:{file:stopFile}});
    let more=false;
    const result=s.snapshot(():WaitResult|undefined=>{
      const stop=s.get('SELECT id,acknowledged_at FROM stop_requests WHERE workspace_id=? AND role=? AND cleared_at IS NULL',s.ws,actor);
      if(stop)return digest('immediate',{reason:'stop',role:actor,cursor,stop:{id:`R${stop.id}`,acknowledged:!!stop.acknowledged_at}});
      const immediate=settle?priorityWorkflow(s,actor,cursor):[];priority=immediate[0]?.wake;
      for(const signal of immediate)add(entryFor(s,signal.wake,signal.event));
      const messages=s.all(`SELECT m.id,m.sender,substr(m.body,1,2000) AS body,length(m.body)>2000 AS truncated,m.reply,m.task_id,${MESSAGE_NOW_SQL} AS wake_now
        FROM receipts r JOIN messages m ON m.workspace_id=r.workspace_id AND m.id=r.message_id
        WHERE r.workspace_id=? AND r.recipient=? AND r.state IN ('unread','read') AND m.urgent=1 AND m.sender!=?
        ORDER BY wake_now DESC,m.id LIMIT ?`,s.ws,actor,actor,DIGEST_LIMIT+1);
      for(const message of messages) {
        const wake:WaitResult={reason:'urgent',role:actor,cursor,...(message.task_id?{task:`T${message.task_id}`}:{}) ,message:{id:`M${message.id}`,sender:message.sender,summary:String(message.body).replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim(),truncated:!!message.truncated,reply:!!message.reply,now:!!message.wake_now,...(message.truncated?{inbox_command:`sassato inbox --peek --as ${actor} --workspace ${s.workspace}`}:{})}};
        if(!settle)return wake;
        const included=add(entryFor(s,wake));
        if(message.wake_now)return digest('immediate',wake);
        if(!included)return priority?digest('immediate',priority):digest('capacity');
      }
      if(entries.size&&window.reason(performance.now())==='max')return priority?digest('immediate',priority):digest('max');
      const events=s.all('SELECT id,entity,entity_id,actor,action,detail FROM events WHERE workspace_id=? AND id>? ORDER BY id LIMIT 200',s.ws,cursor);
      more=events.length===200;
      for(const event of events) {
        const wake=workflow(s,actor,event);
        if(!settle){cursor=event.id;if(wake)return wake;continue;}
        const entry=wake?entryFor(s,wake,event):entries.size?extraDuringDigest(s,actor,event):undefined;
        if(entry&&!add(entry)) {
          if(wake&&['answer','supervisor-ping'].includes(wake.reason))return digest('immediate',priority??wake);
          return priority?digest('immediate',priority):digest('capacity'); // Never cross an omitted relevant event.
        }
        cursor=event.id;
        if(wake&&['answer','supervisor-ping'].includes(wake.reason))return digest('immediate',priority??wake);
      }
      return priority?digest('immediate',priority):undefined;
    });
    if(result)return result;
    if(idle&&performance.now()-idleSince>=idle) {
      const own=s.snapshot(()=>{
        const wrote=s.get("SELECT max(id) AS id FROM events WHERE workspace_id=? AND id>? AND actor=? AND entity NOT IN ('session','notification-progress')",s.ws,idleFrom,actor)?.id;
        if(wrote){idleFrom=wrote;return undefined;}
        const doing=s.all("SELECT id FROM tasks WHERE workspace_id=? AND owner=? AND status='doing' ORDER BY priority DESC,id LIMIT 20",s.ws,actor).map(r=>`T${r.id}`);
        if(doing.length)return {reason:'own-work' as const,tasks:doing};
        // Only what can be taken now: no open blocker (a pending human question is one), no
        // unfinished dependency, nothing human-only for an agent (the gates of tasks --available).
        const open=s.all(`SELECT t.id FROM tasks t WHERE t.workspace_id=? AND t.status='open' AND (t.owner=? OR (t.owner IS NULL AND t.for_role=?))
          AND (t.human_only=0 OR ?=1)
          AND NOT EXISTS (SELECT 1 FROM blockers b WHERE b.workspace_id=t.workspace_id AND b.task_id=t.id AND b.status='open')
          AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.workspace_id=t.workspace_id AND q.task_id=t.id AND q.status='pending')
          AND NOT EXISTS (SELECT 1 FROM dependencies d JOIN tasks p ON p.workspace_id=d.workspace_id AND p.id=d.depends_on WHERE d.workspace_id=t.workspace_id AND d.task_id=t.id AND p.status!='done')
          ORDER BY t.priority DESC,t.id LIMIT 20`,s.ws,actor,actor,s.role(actor).kind==='human'?1:0).map(r=>`T${r.id}`);
        return open.length?{reason:'open-work' as const,tasks:open}:undefined;
      });
      if(own) {
        const wake:WaitResult={reason:own.reason,role:actor,cursor,task:own.tasks[0],tasks:own.tasks};
        if(!settle)return wake;
        if(!add(entryFor(s,wake)))return digest('capacity');
      }
      idleSince=performance.now();
    }
    const at=performance.now(),flush=window.reason(at);
    if(entries.size&&flush)return digest(flush);
    const remaining=deadline-at;
    if(remaining<=0)return entries.size?digest('deadline'):{reason:'timeout',role:actor,cursor};
    // A bounded snapshot permits writers and checkpoints between batches and sleeps.
    await new Promise(resolve=>setTimeout(resolve,more?0:Math.min(500,remaining,window.deadline()-performance.now())));
  }
}
/** Backwards-compatible name; now also wakes for relevant workflow events. */
export const waitForUrgent=waitForWork;
