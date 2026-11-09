import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { type Store, type Row } from './storage.js';
import { check, name, text } from './errors.js';
import { setWip, type WipInput } from './coordination.js';
import { workspaceSettings } from './workspace-settings.js';

export interface AdviceInput {
  relation?: 'same' | 'related' | 'unrelated' | 'unknown';
  pressure?: 'low' | 'high' | 'unknown';
  jobs?: 'idle' | 'running' | 'unknown';
  unsaved?: boolean;
}

/** Compare durable recovery inputs, not provider history or estimated token usage. */
function fingerprint(s: Store, role: string): string {
  const tasks = s.all('SELECT id,version FROM tasks WHERE workspace_id=? AND (owner=? OR for_role=?) ORDER BY id',s.ws,role,role);
  const blockers = s.all('SELECT b.id,b.status FROM blockers b JOIN tasks t ON t.workspace_id=b.workspace_id AND t.id=b.task_id WHERE b.workspace_id=? AND (t.owner=? OR b.waiting_on=?) ORDER BY b.id',s.ws,role,role);
  const questions = s.all('SELECT q.id,q.status,q.answer FROM questions q JOIN tasks t ON t.workspace_id=q.workspace_id AND t.id=q.task_id WHERE q.workspace_id=? AND (t.owner=? OR q.asked_by=?) ORDER BY q.id',s.ws,role,role);
  const dependencies = s.all('SELECT d.task_id,p.id,p.version FROM dependencies d JOIN tasks t ON t.workspace_id=d.workspace_id AND t.id=d.task_id JOIN tasks p ON p.workspace_id=d.workspace_id AND p.id=d.depends_on WHERE d.workspace_id=? AND t.owner=? ORDER BY d.task_id,p.id',s.ws,role);
  const mail = s.all("SELECT message_id,state FROM receipts WHERE workspace_id=? AND recipient=? AND state!='done' ORDER BY message_id",s.ws,role);
  const shared = s.get("SELECT coalesce(max(id),0) AS cursor FROM events WHERE workspace_id=? AND (entity='fact' OR entity='workspace' OR (entity='role' AND entity_id=? AND action IN ('created','updated')))",s.ws,role);
  const wip = s.get('SELECT version FROM wip WHERE workspace_id=? AND role=?',s.ws,role);
  return createHash('sha256').update(JSON.stringify({tasks,blockers,questions,dependencies,mail,shared,wip})).digest('hex');
}

export function saveCheckpoint(s: Store, input: WipInput): Row {
  // All fields must be supplied: silently carrying old notes into a recovery record is unsafe.
  text(input.current,'checkpoint current',10_000);
  text(input.next,'checkpoint next',10_000);
  text(input.notes,'checkpoint notes',10_000);
  return s.tx(()=>{
    const role=s.requireActor(), wip=setWip(s,input);
    const event=s.event('checkpoint',role,'saved',{format:1,wip,fingerprint:fingerprint(s,role)});
    return {id:`E${event}`,role,saved_at:wip.updated_at,wip_version:wip.version,current:wip.current,next:wip.next,notes:wip.notes,state:'current'};
  });
}

export function getCheckpoint(s: Store, target?: string): Row | null {
  const role=target ? name(target) : s.requireActor();s.role(role);
  return s.snapshot(()=>{
    const event=s.get("SELECT id,created_at,detail FROM events WHERE workspace_id=? AND entity='checkpoint' AND entity_id=? AND action='saved' ORDER BY id DESC LIMIT 1",s.ws,role);
    if (!event) return null;
    const detail=JSON.parse(event.detail), reasons:string[]=[];
    if (detail.format!==1 || detail.fingerprint!==fingerprint(s,role)) reasons.push('Saved work, mail, decisions, facts or configuration changed since the checkpoint.');
    if (!Number.isFinite(Date.parse(event.created_at)) || Date.now()-Date.parse(event.created_at)>24*60*60_000) reasons.push('Checkpoint is older than 24 hours; review and refresh it.');
    const wip=detail.wip;
    return {id:`E${event.id}`,role,saved_at:event.created_at,wip_version:wip.version,current:wip.current,next:wip.next,notes:wip.notes,state:reasons.length?'stale':'current',reasons};
  });
}

export function contextAdvice(s: Store, input: AdviceInput = {}): Row {
  const relation=input.relation??'unknown', pressure=input.pressure??'unknown', jobs=input.jobs??'unknown';
  check(['same','related','unrelated','unknown'].includes(relation),'relation must be same, related, unrelated or unknown');
  check(['low','high','unknown'].includes(pressure),'pressure must be low, high or unknown');
  check(['idle','running','unknown'].includes(jobs),'jobs must be idle, running or unknown');
  return s.snapshot(()=>{
    const role=s.requireActor(), checkpoint=getCheckpoint(s);
    const request=s.get('SELECT id FROM stop_requests WHERE workspace_id=? AND role=? AND cleared_at IS NULL',s.ws,role);
    const stopFile=workspaceSettings(s).stop_file;
    const externalStop=!!stopFile && existsSync(stopFile);
    const active=Number(s.get("SELECT count(*) AS n FROM tasks WHERE workspace_id=? AND owner=? AND status IN ('doing','blocked','review')",s.ws,role)!.n);
    const unread=Number(s.get("SELECT count(*) AS n FROM receipts WHERE workspace_id=? AND recipient=? AND state='unread'",s.ws,role)!.n);
    const reasons:string[]=[], steps:string[]=[];
    let recommendation:'continue'|'compact'|'fresh'|'stop'='continue';
    if (request || externalStop) {
      recommendation='stop';
      reasons.push('STOP takes precedence over context management.');
      steps.push(request ? `Follow context STOP instructions for R${request.id}; checkpoint, settle jobs and acknowledge it. Stay stopped until a human resumes work.` : 'Follow the configured stop-file instructions; do not restart work or remove the stop file.');
    } else {
      if (jobs!=='idle') {
        reasons.push(jobs==='running'?'Tools or background jobs are reported running.':'Running-job status is unknown.');
        steps.push('Finish or safely settle your tools and waiters, then report --jobs idle before a reset.');
      }
      if (input.unsaved || checkpoint?.state!=='current') {
        reasons.push(input.unsaved?'The agent reports unsaved discoveries.':!checkpoint?'No recovery checkpoint has been saved.':'The recovery checkpoint needs refreshing.');
        if (checkpoint?.state==='stale') reasons.push(...checkpoint.reasons);
        steps.push('Review current state and save checkpoint current, next and notes, including constraints, discoveries, files, tests and unresolved questions.');
      }
      if (unread) {
        reasons.push(`${unread} unread message(s) need inspection.`);
        steps.push('Read inbox, handle relevant updates, then refresh the checkpoint.');
      }
      if (!reasons.length) {
        if (relation==='unrelated' && active===0) {
          recommendation='fresh';reasons.push('Next work is reported unrelated, no owned tasks are doing/blocked/in review, and the checkpoint is current.');
          steps.push('Use the provider fresh-chat control, or end the old session before an authorized fresh launch. Reload Sassato context and checkpoint, then verify files.');
        } else if (relation==='unrelated' && active>0) {
          reasons.push('Owned work is still doing, blocked or in review; settle or hand it off before starting an unrelated session.');
        } else if (pressure==='high' && (relation==='same' || relation==='related')) {
          recommendation='compact';reasons.push('Context pressure is reported high and the current reasoning remains relevant.');
          steps.push('Use provider-native compaction if available; otherwise retain native auto-compaction. Reload Sassato context after compaction.');
        } else {
          reasons.push(relation==='unknown'?'Task relatedness is unknown; retain context until the agent assesses the next task.':pressure==='unknown'?'Context pressure is unknown; no need for a proactive reset is established.':'Related work can continue with the reported low context pressure.');
        }
      }
    }
    return {
      workspace:s.workspace,role,advisory:true,recommendation,reasons,next_steps:steps,
      reported:{relation,pressure,jobs,unsaved:!!input.unsaved},
      checkpoint:checkpoint?{id:checkpoint.id,state:checkpoint.state,saved_at:checkpoint.saved_at,wip_version:checkpoint.wip_version}:null,
      active_tasks:active,unread_messages:unread,
      limitations:'No provider telemetry or process inspection. Current means saved-state freshness only; verify files and unsaved reasoning. Advice neither executes a reset nor grants permission. Continue can mean checkpoint or settle jobs first; it does not authorize new work.'
    };
  });
}

export function renderAdvice(advice: Row): string {
  return [`Context advice: ${advice.recommendation} (advisory only)`,...advice.reasons.map((reason:string)=>`- ${reason}`),...advice.next_steps.map((step:string)=>`Next: ${step}`),advice.limitations].join('\n');
}
