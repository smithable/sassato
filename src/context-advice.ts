import { existsSync } from 'node:fs';
import { type Store, type Row } from './storage.js';
import { check, text } from './errors.js';
import { setWip, type WipInput } from './coordination.js';
import { workspaceSettings } from './workspace-settings.js';
import { CHECKPOINT_FORMAT, checkpointFingerprint, getCheckpoint } from './checkpoints.js';
export { getCheckpoint } from './checkpoints.js';

export interface AdviceInput {
  relation?: 'same' | 'related' | 'unrelated' | 'unknown';
  pressure?: 'low' | 'high' | 'unknown';
  jobs?: 'idle' | 'running' | 'unknown';
  unsaved?: boolean;
}

export function saveCheckpoint(s: Store, input: WipInput): Row {
  // All fields must be supplied: silently carrying old notes into a recovery record is unsafe.
  text(input.current,'checkpoint current',10_000);
  text(input.next,'checkpoint next',10_000);
  text(input.notes,'checkpoint notes',10_000);
  return s.tx(()=>{
    const role=s.requireActor(), wip=setWip(s,input);
    const event=s.event('checkpoint',role,'saved',{format:CHECKPOINT_FORMAT,wip,fingerprint:checkpointFingerprint(s,role)});
    const savedAt=s.get('SELECT created_at FROM events WHERE workspace_id=? AND id=?',s.ws,event)!.created_at;
    return {id:`E${event}`,role,saved_at:savedAt,wip_version:wip.version,current:wip.current,next:wip.next,notes:wip.notes,state:'current'};
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
    const active=Number(s.get("SELECT count(*) AS n FROM tasks WHERE workspace_id=? AND (owner=? OR for_role=?) AND status IN ('doing','blocked','review')",s.ws,role,role)!.n);
    const unread=Number(s.get("SELECT count(*) AS n FROM receipts WHERE workspace_id=? AND recipient=? AND state='unread'",s.ws,role)!.n);
    const reasons:string[]=[], steps:string[]=[];
    let recommendation:'continue'|'compact'|'fresh'|'stop'='continue';
    if (request || externalStop) {
      recommendation='stop';
      reasons.push('STOP takes precedence over context management.');
      steps.push(request ? `Follow context STOP instructions for R${request.id}; checkpoint, settle jobs and acknowledge it. Stay stopped until a human resumes work.` : 'Follow the configured stop-file instructions; do not restart work or remove the stop file.');
    } else {
      if (relation==='unknown') {
        reasons.push('Task relatedness is unknown; retain context until the agent assesses the next task.');
        steps.push('Report whether the next task is the same, related or unrelated before considering a context change.');
      }
      if (pressure==='unknown') {
        reasons.push('Context pressure is unknown; no need for a proactive context change is established.');
        steps.push('Report whether context pressure is low or high before considering a context change.');
      }
      if (jobs!=='idle') {
        reasons.push(jobs==='running'?'Tools or background jobs are reported running.':'Running-job status is unknown.');
        steps.push('Finish or safely settle your tools and waiters, then report --jobs idle before a reset.');
      }
      if (input.unsaved || checkpoint?.state!=='current') {
        reasons.push(input.unsaved?'The agent reports unsaved discoveries.':!checkpoint?'No recovery checkpoint has been saved.':'The recovery checkpoint needs refreshing.');
        if (checkpoint && checkpoint.state!=='current') reasons.push(...checkpoint.reasons);
        steps.push('Review current state and save checkpoint current, next and notes, including constraints, discoveries, files, tests and unresolved questions.');
      }
      if (unread) {
        reasons.push(`${unread} unread message(s) need inspection.`);
        steps.push('Read inbox, handle relevant updates, then refresh the checkpoint.');
      }
      if (!reasons.length) {
        if (relation==='unrelated' && active===0) {
          recommendation='fresh';reasons.push('Next work is reported unrelated, no owned or targeted tasks are doing/blocked/in review, and the checkpoint is current.');
          steps.push('Ask the human whether to start a fresh provider conversation for the unrelated work. This hint does not authorize replacing or ending a live session. If the human chooses a fresh conversation, reload Sassato context and checkpoint, then verify files.');
        } else if (relation==='unrelated' && active>0) {
          reasons.push('Owned or targeted work is still doing, blocked or in review; settle or hand it off before starting an unrelated session.');
        } else if (pressure==='high' && (relation==='same' || relation==='related')) {
          recommendation='compact';reasons.push('Context pressure is reported high and the current reasoning remains relevant.');
          steps.push('Native auto-compaction remains the default. As an optional hint for the human, provider-native compaction may help retain relevant reasoning; the human decides whether to invoke it. Reload Sassato context after compaction.');
        } else {
          reasons.push('Work can continue with the reported context pressure and task relationship.');
        }
      }
    }
    return {
      workspace:s.workspace,role,advisory:true,recommendation,reasons,next_steps:steps,
      reported:{relation,pressure,jobs,unsaved:!!input.unsaved},
      checkpoint:checkpoint?{id:checkpoint.id,state:checkpoint.state,saved_at:checkpoint.saved_at,wip_version:checkpoint.wip_version}:null,
      active_tasks:active,unread_messages:unread,
      limitations:'No provider telemetry or process inspection. Current means saved-state freshness only; verify files and unsaved reasoning. Shared facts are excluded because Sassato does not track which facts a role has read. Advice neither executes a reset nor grants permission. Continue can mean checkpoint or settle jobs first; it does not authorize new work.'
    };
  });
}

export function renderAdvice(advice: Row): string {
  return [`Context advice: ${advice.recommendation} (advisory only)`,...advice.reasons.map((reason:string)=>`- ${reason}`),...advice.next_steps.map((step:string)=>`Next: ${step}`),advice.limitations].join('\n');
}
