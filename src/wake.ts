// sas wake (T977): one call per wake. It acknowledges the mail a role handled since the last wake, waits
// like `wait`, then prints what the role needs to act without a second read (STOP, each digest entry with
// its full text, mail still waiting for an acknowledgement), saves the notification cursor with the
// expected-version check, and ends with the exact command to re-arm. Saving at wake time means the role
// attests that it has read the entries, not that it has finished them: unfinished work stays on its tasks
// (a note, a block), and urgent mail keeps coming back until it is acknowledged.
import { activeStop } from './control.js';
import { readPendingWake, workerStop } from './pending-wake.js';
import type { Row, Store } from './storage.js';
import { waitWithManagedObservation } from './managed-wait.js';
import { getNotificationProgress, saveNotificationProgress } from './notification-progress.js';
import { acknowledgeMany } from './coordination.js';
import { idleOpenWork, unchangedIdleText, type WaitOptions, type WaitResult } from './mail-wait.js';
import { DIGEST_GROUPS, scoreExplanation, type DigestEntry } from './wait-digest.js';
import { AppError, check, integer, text } from './errors.js';
import { workspaceSettings } from './workspace-settings.js';

export const WAKE_TEXT_LIMIT = 1500;
export interface WakeOptions extends WaitOptions {
  pending?: boolean; ack?: string[];
  /** What the wait is for and how long it should take (T1253); without it, the role's open blocks. */
  waitingFor?: string; expectMinutes?: number;
  /** Told at once, before the wait, when a long wait leaves ready work (waiting is not idle). */
  armNotice?: (line: string) => void;
}
export interface WakeOutcome { text: string; result: WaitResult; acknowledged: string[]; delivered?: string[]; commit?: () => { saved: boolean; line: string } }

/** Text as written, with control characters other than newlines removed and a marked cut. */
export function wakeText(value: unknown, id: string, limit = WAKE_TEXT_LIMIT): string {
  const text = String(value ?? '').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit).join('')}… [cut at ${limit} characters; read it all: sassato show ${id}]`;
}
const indent = (text: string): string => text.split('\n').map((line) => `    ${line}`).join('\n');

/** The task's notes written since the role's last wake (the last three), else its latest one. */
function notesSince(s: Store, task: string, since: number, until: number): Row[] {
  const read = (rows: Row[]) => rows.flatMap((e) => { try { return [{ actor: e.actor, note: JSON.parse(e.detail).note }]; } catch { return []; } }).reverse();
  const recent = s.all("SELECT actor,detail FROM events WHERE workspace_id=? AND entity='task' AND entity_id=? AND action='note' AND id>? AND id<=? ORDER BY id DESC LIMIT 3", s.ws, task, since, until);
  return read(recent.length ? recent : s.all("SELECT actor,detail FROM events WHERE workspace_id=? AND entity='task' AND entity_id=? AND action='note' AND id<=? ORDER BY id DESC LIMIT 1", s.ws, task, until));
}

/** What an entry says in full: a message's body, a task's state, brief and latest note, an answer. */
function detail(s: Store, entry: DigestEntry, since: number, until: number): string {
  if (/^M\d+$/.test(entry.id)) {
    const message = s.get('SELECT body FROM messages WHERE workspace_id=? AND id=?', s.ws, Number(entry.id.slice(1)));
    return message ? wakeText(message.body, entry.id) : entry.summary;
  }
  if (/^H\d+$/.test(entry.id)) {
    const q = s.get('SELECT question,answer FROM questions WHERE workspace_id=? AND id=?', s.ws, Number(entry.id.slice(1)));
    return q ? `Q: ${wakeText(q.question, entry.id, 600)}\nA: ${wakeText(q.answer, entry.id)}` : entry.summary;
  }
  const taskId = entry.task ?? (/^T\d+$/.test(entry.id) ? entry.id : undefined);
  if (taskId) {
    const t = s.get('SELECT * FROM tasks WHERE workspace_id=? AND id=?', s.ws, Number(taskId.slice(1)));
    if (!t) return entry.summary;
    const lines = [`${taskId} "${wakeText(t.title, taskId, 200)}" · ${t.status} · owner ${t.owner ?? '-'} · for ${t.for_role ?? '-'} · version ${t.version}`];
    if (['task-assigned', 'task-ready', 'open-work', 'spare-work'].includes(entry.kind) && t.body) lines.push(wakeText(t.body, taskId, 800));
    if (entry.kind.startsWith('review-') && t.review_note) lines.push(`Review: ${wakeText(t.review_note, taskId, 800)}`);
    for (const note of notesSince(s, taskId, since, until)) lines.push(`Note (${note.actor}): ${wakeText(note.note, taskId, 500)}`);
    return lines.join('\n');
  }
  return entry.summary;
}

/** Urgent and needs-reply mail the role has not acknowledged, newest first, bounded. */
function waiting(s: Store, actor: string, shown: Set<string>): { rows: Row[]; more: number } {
  const all = s.all(`SELECT m.id,m.sender,m.urgent,m.reply FROM receipts r JOIN messages m ON m.workspace_id=r.workspace_id AND m.id=r.message_id
    WHERE r.workspace_id=? AND r.recipient=? AND r.state IN ('unread','read') AND (m.urgent=1 OR m.reply=1) AND m.sender!=?
    ORDER BY m.id DESC`, s.ws, actor, actor).filter((m) => !shown.has(`M${m.id}`));
  const rows = all.slice(0, 20).map((m) => ({ ...m, body: s.get('SELECT body FROM messages WHERE workspace_id=? AND id=?', s.ws, m.id)?.body }));
  return { rows, more: Math.max(0, all.length - 20) };
}

export async function wake(s: Store, options: WakeOptions = {}): Promise<WakeOutcome> {
  const actor = s.requireActor();
  if (options.pending) {
    check(Object.entries(options).every(([key,value]) => key==='pending' || key==='armNotice' || value===undefined),
      '--pending cannot be combined with acknowledgement or wait options');
    return s.tx(() => {
      const stop = workerStop(s,process.env.CODEX_THREAD_ID);
      if (stop) return formatWake(s,options,0,stop,[]);
      const pending = readPendingWake(s,process.env.CODEX_THREAD_ID);
      const output = formatWake(s,options,pending.progress.cursor,pending.result,[]);
      return {...output,commit:()=>pending.commit(output.delivered??[])};
    });
  }
  const before = getNotificationProgress(s);
  check(before !== null, `No saved notification progress for ${actor}. Reconcile as the start text says (sassato context --as ${actor} --workspace ${s.workspace}), save it with sassato progress save --cursor N --expect 0, then wake.`, 4);
  const since = options.since ?? before.cursor;
  // A --since past the saved cursor would skip the events between them; an earlier one replays them.
  check(since <= before.cursor, `--since ${since} is past the saved cursor ${before.cursor}; that would skip events. Use --since ${before.cursor} or leave it out.`, 4);
  const waitingFor = options.waitingFor !== undefined ? text(options.waitingFor, 'what the wait is for', 300) : openBlocks(s, actor);
  const expect = options.expectMinutes === undefined ? null : integer(options.expectMinutes, 'expected minutes', 0, 10_080);
  const acknowledged = options.ack?.length ? acknowledgeMany(s, options.ack).map((row) => String(row.message_id)) : [];
  // The waiter's own events (T1253) give the time table its waiting spans; they are bookkeeping, never activity.
  s.tx(() => s.event('waiter', actor, 'armed', { since, idle_minutes: options.idleMinutes ?? null, waiting_for: waitingFor || null, expect_minutes: expect }));
  let result;
  try {
    if (expect !== null && expect >= 10 && options.armNotice) {
      const ready = idleOpenWork(s, actor).slice(0, 3);
      if (ready.length) options.armNotice(`Waiting is not idle: ${ready.join(', ')} ${ready.length > 1 ? 'are' : 'is'} ready for you while this wait (about ${expect} minutes) runs.`);
    }
    const { waitingFor: _w, expectMinutes: _e, armNotice: _a, ...wait } = options;
    result = await waitWithManagedObservation(s, { ...wait, since, nudge: true });
  } catch (error) {
    // A waiter that failed is not left looking armed.
    try { s.tx(() => s.event('waiter', actor, 'ended', { reason: 'error', cursor: null })); } catch { /* keep the original error */ }
    throw error;
  }
  s.tx(() => s.event('waiter', actor, 'ended', { reason: result.reason, cursor: result.cursor }));
  return formatWake(s,options,since,result,acknowledged,before.version);
}

/** The role's open blocks, as what its wait is for when it does not say. */
function openBlocks(s: Store, actor: string): string {
  return s.all(`SELECT b.task_id,b.kind,b.waiting_on FROM blockers b JOIN tasks t ON t.workspace_id=b.workspace_id AND t.id=b.task_id
    WHERE b.workspace_id=? AND b.status='open' AND t.owner=? AND t.status NOT IN ('done','dropped') ORDER BY b.id DESC LIMIT 5`, s.ws, actor)
    .map((b) => `T${b.task_id} on ${b.waiting_on ?? b.kind}`).join(', ');
}

/** The answer to a nudge (T1253): why the role is not writing. Until something changes for it, no new nudge. */
export function idleReason(s: Store, reason: string): Row {
  const actor = s.requireActor(), why = text(reason, 'idle reason', 500);
  return s.tx(() => ({ event: `E${s.event('idle', actor, 'reason', { reason: why })}`, role: actor, reason: why,
    next: 'No new nudge until something changes for you: mail, a task assigned or made ready, a block resolved.' }));
}

function formatWake(s: Store, options: WakeOptions, since: number, result: WaitResult,
  acknowledged: string[], version?: number): WakeOutcome {
  const actor=s.requireActor();
  const quote = (value: string) => /^[\w./~:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
  const stopFlag = options.stopFile ? ` --stop-file ${quote(options.stopFile)}` : '';
  const idleFlag = options.idleMinutes!==undefined && workspaceSettings(s).wake_mode!=='scored' ? ` --idle-minutes ${options.idleMinutes}` : '';
  const rearm = (ack: string[]) => `sassato wake --since ${result.cursor}${idleFlag} --as ${actor} --workspace ${s.workspace}${stopFlag}${ack.length ? ` --ack ${ack.join(',')}` : ''}`;
  const lines: string[] = [];
  if (acknowledged.length) lines.push(`Acknowledged ${acknowledged.join(', ')}.`);
  if (result.reason === 'stop') {
    const stop = result.stop!;
    lines.push(stop.file ? `STOP: the stop file ${stop.file} exists. Finish or stop the current step, checkpoint, and do not re-arm.`
      : `STOP ${stop.id} for ${actor}. Finish or stop the current step, checkpoint, run sassato stopped ${stop.id} --as ${actor} --workspace ${s.workspace}, and do not re-arm.`);
    lines.push(`Cursor ${result.cursor} not saved (a stop keeps it for the next start).`);
    return { text: lines.join('\n'), result, acknowledged };
  }
  // Everything is built first and the cursor saved last, so nothing is saved that was not ready to print.
  const entries = result.digest?.entries ?? [];
  const shown = new Set([...entries.map((entry) => entry.id), ...(result.message ? [String(result.message.id)] : [])]);
  const { rows: left, more: leftMore } = waiting(s, actor, shown);
  const delivered = [...[...shown].map((id) => (/^\d+$/.test(id) ? `M${id}` : id)), ...left.map((m) => `M${m.id}`)].filter((id) => /^M\d+$/.test(id));
  const quiet = !entries.length && !left.length && result.reason === 'timeout';
  const idle=result.idle??result.scored?.idle;
  const unchanged=unchangedIdleText(idle);
  const idleOnly=unchanged&&!left.length&&!result.digest?.has_more&&entries.every(entry=>entry.unchanged)&&
    (result.reason===idle?.kind||result.reason==='digest');
  const body: string[] = [];
  if (!result.digest && result.reason !== 'timeout') body.push(unchanged??(result.nudge?`nudge: ${result.nudge.text}`:undefined)??`${result.reason}${result.task ? ` ${result.task}` : ''}${result.message ? ` ${result.message.id} from ${result.message.sender}:\n${indent(wakeText(result.message.summary, result.message.id))}` : ''}`);
  if(options.pending && !result.digest && result.tasks && !unchanged) {
    for(const task of result.tasks) body.push(indent(detail(s,{id:task,task,from:actor,kind:result.reason,group:'other',summary:task},since,result.cursor)));
  }
  if(result.digest?.score)body.push(scoreExplanation(result.digest.score));
  for (const group of result.digest?.score?['scored']:DIGEST_GROUPS) {
    // One record woken twice for the same reason (created, then handed over) is printed once, with both senders.
    const inGroup = new Map<string, { entry: DigestEntry; from: string[] }>();
    for (const entry of entries.filter((e) => group==='scored' || e.group === group)) {
      const key = `${entry.id}:${entry.kind}`, seen = inGroup.get(key);
      if (seen) { if (!seen.from.includes(entry.from)) seen.from.push(entry.from); } else inGroup.set(key, { entry, from: [entry.from] });
    }
    if (!inGroup.size) continue;
    if(group!=='scored')body.push(`${group}:`);
    for (const { entry, from } of inGroup.values()) {
      body.push(`  ${entry.id} · from ${from.join(', ')} · ${entry.kind}${entry.task && entry.task !== entry.id ? ` · ${entry.task}` : ''}`);
      if(entry.unchanged)body.push(indent(entry.summary));
      else if((options.pending||result.scored) && entry.tasks?.length) {
        for(const task of entry.tasks) body.push(indent(detail(s,{...entry,id:task,task},since,result.cursor)));
      } else body.push(indent(detail(s, entry, since, result.cursor)));
    }
  }
  if (left.length) {
    body.push('still to acknowledge:');
    for (const m of left) body.push(`  M${m.id} · from ${m.sender} · ${m.urgent ? 'urgent' : 'needs-reply'}\n${indent(wakeText(m.body, `M${m.id}`, 400))}`);
    if (leftMore) body.push(`  … and ${leftMore} older; list them: sassato inbox --as ${actor} --workspace ${s.workspace}`);
  }
  if (result.digest?.has_more) body.push('More notifications remain: handle these, then re-arm at once for the rest.');
  const direct = result.message && (result.reason === 'urgent' || result.reason === 'reply-needed') ? [String(result.message.id)] : [];
  const toAck = [...new Set([...direct, ...entries.filter((e) => /^M\d+$/.test(e.id) && (Boolean(result.scored) || ['urgent', 'reply-needed'].includes(e.kind))).map((e) => e.id), ...left.map((m) => `M${m.id}`)])];

  // The cursor is saved by commit(), which the caller runs after the text has been delivered (printed), so a
  // wake whose output never reached the session saves nothing.
  const commit = version===undefined || (result.mode==='scored' && result.reason==='timeout') ? undefined : (): { saved: boolean; line: string } => {
    try {
      const saved=s.tx(()=>{
        if(activeStop(s,[actor],options.stopFile))return false;
        saveNotificationProgress(s,{cursor:result.cursor,expected_version:version,scored:result.scored,idle:result.idle,delivered});
        return true;
      });
      return saved?{saved,line:`Cursor ${result.cursor} saved.`}:
        {saved,line:'STOP requested during delivery; cursor preserved. Checkpoint and do not start work.'};
    }
    catch (error) {
      if (!(error instanceof AppError) || error.code !== 4) throw error;
      return { saved: false, line: `Cursor ${result.cursor} NOT saved: ${error.message}. Another waiter or session saved progress for ${actor}: do not re-arm from this cursor; read sassato progress show --as ${actor} --workspace ${s.workspace} and wake from the saved one.` };
    }
  };
  if (quiet) {
    lines.push(`Nothing new for ${actor} · cursor ${result.cursor} · re-arm: ${rearm([])}`);
    return { text: lines.join('\n'), result, acknowledged, delivered, commit };
  }
  if(idleOnly){
    lines.push(`nothing new: re-arm only · ${unchanged} · ${options.pending?'The launcher owns the waiter.':rearm([])}`);
    return {text:lines.join('\n'),result,acknowledged,delivered,commit};
  }
  lines.push(`Wake for ${actor}: ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}${result.digest ? ` (${result.digest.flush})` : ''} · cursor ${result.cursor}`, ...body);
  if (options.pending) {
    lines.push('Handle this digest and checkpoint. The launcher owns the waiter.');
    if (toAck.length) lines.push(`Acknowledge handled mail with sassato ack ${toAck.join(' ')} --as ${actor} --workspace ${s.workspace}.`);
    return {text:lines.join('\n'),result,acknowledged,delivered};
  }
  lines.push(`Then: handle these, put your writes and one checkpoint in one command, and re-arm in the same response: ${rearm(toAck)}`);
  if (toAck.length) lines.push(`(--ack ${toAck.join(',')} acknowledges that mail when the waiter starts; leave out any you have not handled.)`);
  return { text: lines.join('\n'), result, acknowledged, delivered, commit };
}
