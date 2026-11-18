// sas wake (T977): one call per wake. It acknowledges the mail a role handled since the last wake, waits
// like `wait`, then prints what the role needs to act without a second read (STOP, each digest entry with
// its full text, mail still waiting for an acknowledgement), saves the notification cursor with the
// expected-version check, and ends with the exact command to re-arm. Saving at wake time means the role
// attests that it has read the entries, not that it has finished them: unfinished work stays on its tasks
// (a note, a block), and urgent mail keeps coming back until it is acknowledged.
import type { Row, Store } from './storage.js';
import { waitWithManagedObservation } from './managed-wait.js';
import { getNotificationProgress, saveNotificationProgress } from './notification-progress.js';
import { acknowledgeMany } from './coordination.js';
import type { WaitOptions, WaitResult } from './mail-wait.js';
import { DIGEST_GROUPS, type DigestEntry } from './wait-digest.js';
import { AppError, check } from './errors.js';

export const WAKE_TEXT_LIMIT = 1500;
export interface WakeOptions extends WaitOptions { ack?: string[] }
export interface WakeOutcome { text: string; result: WaitResult; saved: boolean; acknowledged: string[] }

/** Text as written, with control characters other than newlines removed and a marked cut. */
export function wakeText(value: unknown, id: string, limit = WAKE_TEXT_LIMIT): string {
  const text = String(value ?? '').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit).join('')}… [cut at ${limit} characters; read it all: sassato show ${id}]`;
}
const indent = (text: string): string => text.split('\n').map((line) => `    ${line}`).join('\n');

function latestNote(s: Store, task: string): Row | undefined {
  const event = s.get("SELECT actor,detail FROM events WHERE workspace_id=? AND entity='task' AND entity_id=? AND action='note' ORDER BY id DESC LIMIT 1", s.ws, task);
  if (!event) return undefined;
  try { return { actor: event.actor, note: JSON.parse(event.detail).note }; } catch { return undefined; }
}

/** What an entry says in full: a message's body, a task's state, brief and latest note, an answer. */
function detail(s: Store, entry: DigestEntry): string {
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
    if (['task-assigned', 'task-ready', 'open-work'].includes(entry.kind) && t.body) lines.push(wakeText(t.body, taskId, 800));
    if (entry.kind.startsWith('review-') && t.review_note) lines.push(`Review: ${wakeText(t.review_note, taskId, 800)}`);
    const note = latestNote(s, taskId);
    if (note) lines.push(`Latest note (${note.actor}): ${wakeText(note.note, taskId, 500)}`);
    return lines.join('\n');
  }
  return entry.summary;
}

/** Urgent and needs-reply mail the role has not acknowledged, newest first, bounded. */
function waiting(s: Store, actor: string, shown: Set<string>): Row[] {
  return s.all(`SELECT m.id,m.sender,m.body,m.urgent,m.reply FROM receipts r JOIN messages m ON m.workspace_id=r.workspace_id AND m.id=r.message_id
    WHERE r.workspace_id=? AND r.recipient=? AND r.state IN ('unread','read') AND (m.urgent=1 OR m.reply=1) AND m.sender!=?
    ORDER BY m.id DESC LIMIT 20`, s.ws, actor, actor).filter((m) => !shown.has(`M${m.id}`));
}

export async function wake(s: Store, options: WakeOptions = {}): Promise<WakeOutcome> {
  const actor = s.requireActor();
  const acknowledged = options.ack?.length ? acknowledgeMany(s, options.ack).map((row) => String(row.message_id)) : [];
  const before = getNotificationProgress(s);
  const since = options.since ?? before?.cursor;
  check(since !== undefined, `No saved notification progress for ${actor}. Read sassato context --as ${actor} --workspace ${s.workspace}, then wake with --since CURSOR.`, 4);
  const result = await waitWithManagedObservation(s, { ...options, since });
  const rearm = (ack: string[]) => `sassato wake --since ${result.cursor} --as ${actor} --workspace ${s.workspace}${ack.length ? ` --ack ${ack.join(',')}` : ''}`;
  const lines: string[] = [];
  if (acknowledged.length) lines.push(`Acknowledged ${acknowledged.join(', ')}.`);
  if (result.reason === 'stop') {
    const stop = result.stop!;
    lines.push(stop.file ? `STOP: the stop file ${stop.file} exists. Finish or stop the current step, checkpoint, and do not re-arm.`
      : `STOP ${stop.id} for ${actor}. Finish or stop the current step, checkpoint, run sassato stopped ${stop.id} --as ${actor} --workspace ${s.workspace}, and do not re-arm.`);
    lines.push(`Cursor ${result.cursor} not saved (a stop keeps it for the next start).`);
    return { text: lines.join('\n'), result, saved: false, acknowledged };
  }
  let saved = true, savedNote = 'saved';
  try { saveNotificationProgress(s, { cursor: result.cursor, expected_version: before?.version ?? 0 }); }
  catch (error) {
    if (!(error instanceof AppError) || error.code !== 4) throw error;
    saved = false;
    savedNote = `NOT saved: ${error.message}. Another waiter or session saved progress for ${actor}; read sassato progress show before re-arming`;
  }
  const entries = result.digest?.entries ?? [];
  const shown = new Set(entries.map((entry) => entry.id));
  const left = waiting(s, actor, shown);
  if (!entries.length && !left.length && result.reason === 'timeout') {
    lines.push(`Nothing new for ${actor} · cursor ${result.cursor} ${savedNote} · re-arm: ${rearm([])}`);
    return { text: lines.join('\n'), result, saved, acknowledged };
  }
  lines.push(`Wake for ${actor}: ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}${result.digest ? ` (${result.digest.flush})` : ''} · cursor ${result.cursor} ${savedNote}`);
  if (!result.digest && result.reason !== 'timeout') lines.push(`${result.reason}${result.task ? ` ${result.task}` : ''}${result.message ? ` ${result.message.id} from ${result.message.sender}:\n${indent(wakeText(result.message.summary, result.message.id))}` : ''}`);
  for (const group of DIGEST_GROUPS) {
    // One record woken twice for the same reason (created, then handed over) is printed once, with both senders.
    const inGroup = new Map<string, { entry: DigestEntry; from: string[] }>();
    for (const entry of entries.filter((e) => e.group === group)) {
      const key = `${entry.id}:${entry.kind}`, seen = inGroup.get(key);
      if (seen) { if (!seen.from.includes(entry.from)) seen.from.push(entry.from); } else inGroup.set(key, { entry, from: [entry.from] });
    }
    if (!inGroup.size) continue;
    lines.push(`${group}:`);
    for (const { entry, from } of inGroup.values()) {
      lines.push(`  ${entry.id} · from ${from.join(', ')} · ${entry.kind}${entry.task && entry.task !== entry.id ? ` · ${entry.task}` : ''}`);
      lines.push(indent(detail(s, entry)));
    }
  }
  if (left.length) {
    lines.push('still to acknowledge:');
    for (const m of left) lines.push(`  M${m.id} · from ${m.sender} · ${m.urgent ? 'urgent' : 'needs-reply'}\n${indent(wakeText(m.body, `M${m.id}`, 400))}`);
  }
  if (result.digest?.has_more) lines.push('More notifications remain: handle these, then re-arm at once for the rest.');
  const toAck = [...new Set([...entries.filter((e) => /^M\d+$/.test(e.id) && ['urgent', 'reply-needed'].includes(e.kind)).map((e) => e.id), ...left.map((m) => `M${m.id}`)])];
  lines.push(`Then: handle these, put your writes and one checkpoint in one command, and re-arm in the same response: ${rearm(toAck)}`);
  if (toAck.length) lines.push(`(--ack ${toAck.join(',')} acknowledges that mail when the waiter starts; leave out any you have not handled.)`);
  return { text: lines.join('\n'), result, saved, acknowledged };
}
