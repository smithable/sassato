// Feedback record (T1113): one line any role writes when it sees a workflow mistake, wasted tokens,
// something untested or something sampleusers could test. It never wakes anyone and is never work;
// a human, or a role a human named in feedback_closers, closes each one as a task, a fact or a stated no.
import { type Store, type Row } from './storage.js';
import { check, id, integer, name, now, text } from './errors.js';
import { workspaceSettings } from './workspace-settings.js';

export const FEEDBACK_KINDS = ['workflow','tokens','untested','sampleusers','sassato'] as const;
export type FeedbackKind = typeof FEEDBACK_KINDS[number];
const FEEDBACK_MAX = 500;

function publicFeedback(row: Row): Row {
  return {...row,id:`K${row.id}`,task_id:row.task_id===null?null:`T${row.task_id}`,open:row.closed_at===null};
}
function kind(value: string): FeedbackKind {
  check((FEEDBACK_KINDS as readonly string[]).includes(value),`Feedback kind must be one of: ${FEEDBACK_KINDS.join(', ')}`);
  return value as FeedbackKind;
}
export function canCloseFeedback(s: Store, actor: string): boolean {
  return s.role(actor).kind === 'human' || workspaceSettings(s).feedback_closers.includes(actor);
}

export function addFeedback(s: Store, kindName: string, body: string, options: {re?: string} = {}): Row {
  const actor = s.requireActor(), k = kind(kindName);
  const line = text(body,'feedback',FEEDBACK_MAX);
  check(!/[\r\n]/.test(line),'Feedback is one line; put the detail in a task when it needs more');
  return s.tx(() => {
    const task = options.re === undefined ? null : s.task(options.re).id;
    const at = now();
    const n = Number(s.run('INSERT INTO feedback(workspace_id,kind,body,task_id,author,created_at) VALUES(?,?,?,?,?,?)',s.ws,k,line,task,actor,at).lastInsertRowid);
    const row = s.get('SELECT * FROM feedback WHERE workspace_id=? AND id=?',s.ws,n)!;
    s.index('feedback',`K${n}`,`${k}: ${line}`,line,{role:actor,status:'open',updated_at:at});
    s.event('feedback',`K${n}`,'added',{kind:k,task:task===null?null:`T${task}`});
    return publicFeedback(row);
  });
}

export interface FeedbackListOptions { kind?: string; author?: string; all?: boolean; limit?: number; after?: string }
export function listFeedback(s: Store, options: FeedbackListOptions = {}): {items: Row[]; has_more: boolean; next_after: string | null} {
  const filters = ['workspace_id=?'], params: (string|number)[] = [s.ws];
  if (!options.all) filters.push('closed_at IS NULL');
  if (options.kind !== undefined) {filters.push('kind=?');params.push(kind(options.kind));}
  if (options.author !== undefined) {filters.push('author=?');params.push(name(options.author));}
  if (options.after !== undefined) {filters.push('id>?');params.push(id(options.after,'K'));}
  const count = integer(options.limit ?? 50,'limit',1,200);
  const rows = s.all(`SELECT * FROM feedback WHERE ${filters.join(' AND ')} ORDER BY id LIMIT ?`,...params,count+1);
  const items = rows.slice(0,count).map(publicFeedback);
  return {items,has_more:rows.length>count,next_after:rows.length>count?items[items.length-1].id:null};
}

export interface FeedbackCloseOptions { task?: string; fact?: string; dropped?: string }
export function closeFeedback(s: Store, feedbackId: string, options: FeedbackCloseOptions): Row {
  const actor = s.requireActor();
  check(canCloseFeedback(s,actor),'Only a human, or a role a human named with workspace set --feedback-closers, closes feedback',3);
  const given = [options.task,options.fact,options.dropped].filter(v=>v!==undefined);
  check(given.length===1,'Close feedback with exactly one of --task T1, --fact KEY or --dropped REASON');
  const n = id(feedbackId,'K');
  return s.tx(() => {
    const old = s.get('SELECT * FROM feedback WHERE workspace_id=? AND id=?',s.ws,n);
    check(old,`${feedbackId} not found in this workspace`,3);
    check(old.closed_at===null,`${feedbackId} is already closed (${old.outcome}: ${old.outcome_ref})`,4);
    let outcome: string, ref: string;
    if (options.task !== undefined) {outcome='task';ref=`T${s.task(options.task).id}`;}
    else if (options.fact !== undefined) {
      outcome='fact';ref=text(options.fact,'fact key',200);
      check(s.get('SELECT 1 FROM facts WHERE workspace_id=? AND key=?',s.ws,ref),`Fact ${ref} not found; set it first`,3);
    } else {outcome='dropped';ref=text(options.dropped,'reason',FEEDBACK_MAX);}
    const at = now();
    s.run('UPDATE feedback SET closed_by=?,closed_at=?,outcome=?,outcome_ref=? WHERE workspace_id=? AND id=?',actor,at,outcome,ref,s.ws,n);
    s.index('feedback',feedbackId,`${old.kind}: ${old.body}`,`${old.body}\nClosed: ${outcome} ${ref}`,{role:old.author,status:'closed',updated_at:at});
    s.event('feedback',feedbackId,'closed',{outcome,ref});
    return publicFeedback(s.get('SELECT * FROM feedback WHERE workspace_id=? AND id=?',s.ws,n)!);
  });
}

/** The open count for a role that closes feedback; nothing for anyone else (context, T1113). */
export function feedbackSummary(s: Store, actor: string): Row | undefined {
  if (!canCloseFeedback(s,actor)) return undefined;
  const row = s.get('SELECT count(*) AS n,min(created_at) AS oldest FROM feedback WHERE workspace_id=? AND closed_at IS NULL',s.ws)!;
  if (!row.n) return undefined;
  const days = Math.max(0,Math.floor((Date.now()-Date.parse(row.oldest))/86_400_000));
  return {id:'feedback',open:Number(row.n),oldest_days:days,read:'sassato feedback list'};
}
