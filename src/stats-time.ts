import { type Row, type Store } from './storage.js';
import { check, name } from './errors.js';
import { OWN_WRITE } from './mail-wait.js';

/**
 * Where each role's time went on one day (T1253), from events alone, minute by minute, summing to the day:
 * working (a write of its own in the 15 minutes before; per task it held), waiting in a waiter (per what the
 * waiter was armed for), or not running. Working wins over a waiter running in the background. With the
 * nudges of that day: sent, answered (an idle reason or a take before the next one), escalated, and the reasons.
 */
export type TimeOptions = { day: string; role?: string; now?: Date };
const MINUTE = 60_000, WORKING_MINUTES = 15;

type Span = { from: number; to: number; what: string };

export function timeTable(s: Store, options: TimeOptions): Row {
  // The day in the machine's own time zone; a date that does not exist (2026-02-30) is refused, not moved.
  const local = /^(\d{4})-(\d{2})-(\d{2})$/.exec(options.day), first = local ? new Date(+local[1], +local[2] - 1, +local[3]) : undefined;
  check(!!first && first.getFullYear() === +local![1] && first.getMonth() === +local![2] - 1 && first.getDate() === +local![3], 'Use --day with a date, such as 2026-11-22', 2);
  const start = first!.getTime(), dayEnd = new Date(start + 36 * 3600_000).setHours(0, 0, 0, 0);
  const now = (options.now ?? new Date()).getTime(), end = Math.min(dayEnd, now);
  check(start < now, `${options.day} has not begun`, 2);
  const role = options.role === undefined ? undefined : name(options.role);
  if (role !== undefined) s.role(role);
  const iso = (t: number) => new Date(t).toISOString();
  return s.snapshot(() => {
    const roles = role ? [role] : s.all("SELECT name FROM roles WHERE workspace_id=? AND kind='agent' ORDER BY name", s.ws).map(r => String(r.name));
    const rows = roles.map(r => {
      const writes = s.all(`SELECT entity,entity_id,action,detail,created_at FROM events WHERE workspace_id=? AND actor=? AND ${OWN_WRITE}
        AND entity!='idle' AND created_at>=? AND created_at<? ORDER BY id`, s.ws, r, iso(start - WORKING_MINUTES * MINUTE), iso(end));
      // The task held at each moment: from the role's own claim to its completion, drop, hand-over, release, submission or another's claim.
      const held = heldTasks(s, r, iso(end));
      const waiters = waiterSpans(s, r, start, end);
      const minutes: Record<string, number> = {}, working: Record<string, number> = {}, waiting: Record<string, number> = {};
      let w = 0, sp = 0, lastWrite: { at: number; task: string } | undefined;
      for (let t = start; t + MINUTE <= end; t += MINUTE) {
        while (w < writes.length && Date.parse(writes[w].created_at) <= t) {
          const at = Date.parse(writes[w].created_at);
          lastWrite = { at, task: writtenTask(writes[w]) ?? heldAt(held, at) ?? 'no task' };
          w++;
        }
        while (sp < waiters.length && waiters[sp].to <= t) sp++;
        if (lastWrite && t - lastWrite.at < WORKING_MINUTES * MINUTE) { working[lastWrite.task] = (working[lastWrite.task] ?? 0) + 1; minutes.working = (minutes.working ?? 0) + 1; }
        else if (sp < waiters.length && waiters[sp].from <= t) { waiting[waiters[sp].what] = (waiting[waiters[sp].what] ?? 0) + 1; minutes.waiting = (minutes.waiting ?? 0) + 1; }
        else minutes.not_running = (minutes.not_running ?? 0) + 1;
      }
      return { role: r, working_minutes: minutes.working ?? 0, waiting_minutes: minutes.waiting ?? 0, not_running_minutes: minutes.not_running ?? 0,
        working: sorted(working), waiting: sorted(waiting), nudges: nudges(s, r, iso(start), iso(end)) };
    });
    return { day: options.day, from: iso(start), to: iso(end), roles: rows,
      working_means: `a write of the role's own in the ${WORKING_MINUTES} minutes before (not a checkpoint, a read, an idle reason or a waiter); time in a waiter running in the background while it writes counts as working`,
      not_stored: [
        'work with no write for 15 minutes (one long tool call, a long edit) counts as waiting or not running',
        "a waiter that never ended (its session died) is counted as waiting until the role's next waiter, its session's end, or now",
        "an ended event is taken as the end of the role's latest waiter, which it is not if an old waiter exits after a new one armed",
        'idle with ready work is in stats without --day (before a wake)',
      ] };
  });
}

const sorted = (m: Record<string, number>) => Object.entries(m).sort(([, a], [, b]) => b - a).map(([what, minutes]) => ({ what, minutes }));

function heldTasks(s: Store, role: string, until: string): { task: string; from: number; to: number }[] {
  const out: { task: string; from: number; to: number }[] = [];
  const open = new Map<string, number>();
  for (const e of s.all(`SELECT entity_id,action,actor,detail,created_at FROM events WHERE workspace_id=? AND entity='task'
      AND action IN ('claimed','completed','dropped','handed-off','released','submitted') AND created_at<? ORDER BY id`, s.ws, until)) {
    const at = Date.parse(e.created_at);
    if (e.action === 'claimed' && e.actor === role) { if (!open.has(e.entity_id)) open.set(e.entity_id, at); }
    else if (open.has(e.entity_id)) { out.push({ task: e.entity_id, from: open.get(e.entity_id)!, to: at }); open.delete(e.entity_id); }
  }
  for (const [task, from] of open) out.push({ task, from, to: Infinity });
  return out;
}
/** The task a write is about: a task event's own, or the task a sent mail names (--re T, or a mirrored question's task). */
function writtenTask(e: Row): string | undefined {
  if (e.entity === 'task' && ['note', 'claimed', 'completed', 'blocked', 'submitted'].includes(e.action)) return e.entity_id;
  if (e.entity !== 'message' || e.action !== 'sent') return undefined;
  try { const d = JSON.parse(e.detail ?? '{}'); const t = d.task ?? d.task_id; return typeof t === 'string' && /^T\d+$/.test(t) ? t : undefined; } catch { return undefined; }
}
const heldAt = (held: { task: string; from: number; to: number }[], at: number) => held.filter(h => h.from <= at && at < h.to).sort((a, b) => b.from - a.from)[0]?.task;

/** Waiter spans: armed to ended; one never ended ends at the next arm, its session's end or replacement, or now. */
function waiterSpans(s: Store, role: string, start: number, end: number): Span[] {
  const events = s.all(`SELECT id,action,detail,created_at FROM events WHERE workspace_id=? AND entity='waiter' AND entity_id=? AND created_at<?
    AND id>=coalesce((SELECT max(id) FROM events WHERE workspace_id=? AND entity='waiter' AND entity_id=? AND action='armed' AND created_at<?),0) ORDER BY id`,
    s.ws, role, new Date(end).toISOString(), s.ws, role, new Date(start).toISOString());
  // A session's end closes the waiter armed before it (by event order, so one armed in the same millisecond after it is not).
  const sessionEnds = s.all(`SELECT id,created_at FROM events WHERE workspace_id=? AND entity='session' AND action IN ('ended','replaced')
    AND json_extract(detail,'$.role')=? AND created_at<? ORDER BY id`, s.ws, role, new Date(end).toISOString()).map(e => ({ id: Number(e.id), at: Date.parse(e.created_at) }));
  const spans: Span[] = [];
  let open: { id: number; from: number; what: string } | undefined;
  const close = (to: number) => { if (open) { const stop = Math.min(to, sessionEnds.find(x => x.id > open!.id)?.at ?? Infinity); if (stop > open.from) spans.push({ from: open.from, to: stop, what: open.what }); open = undefined; } };
  for (const e of events) {
    const at = Date.parse(e.created_at);
    if (e.action === 'armed') { close(at); open = { id: Number(e.id), from: at, what: waitingFor(e.detail) }; }
    else if (e.action === 'ended') close(at);
  }
  close(end);
  return spans.filter(x => x.to > start);
}

/** What a wait was for: the first open block's role or kind ('on fable'), else the text given, else nothing named. */
function waitingFor(detail: string): string {
  let said: unknown;
  try { said = JSON.parse(detail).waiting_for; } catch { said = null; }
  if (typeof said !== 'string' || !said) return 'nothing named';
  const block = /^T\d+ on (\S+?)(?:,|$)/.exec(said);
  return block ? `on ${block[1]}` : said.slice(0, 80);
}

function nudges(s: Store, role: string, from: string, to: string): Row {
  const events = s.all(`SELECT id,entity,action,detail,created_at FROM events WHERE workspace_id=? AND created_at>=? AND created_at<? AND (
      (entity='nudge' AND entity_id=?) OR (actor=? AND entity='idle' AND action='reason') OR (actor=? AND entity='task' AND action='claimed')) ORDER BY id`,
    s.ws, from, to, role, role, role);
  let sent = 0, answered = 0, escalated = 0, waiting = false;
  const reasons: string[] = [];
  for (const e of events) {
    if (e.entity === 'nudge' && e.action === 'sent') { sent++; waiting = true; }
    else if (e.entity === 'nudge' && e.action === 'escalated') { escalated++; waiting = false; }
    else if (e.entity === 'idle' || e.entity === 'task') {
      if (e.entity === 'idle') try { reasons.push(String(JSON.parse(e.detail).reason)); } catch { /* unreadable detail */ }
      if (waiting) { answered++; waiting = false; }
    }
  }
  // A nudge still open at the day's end counts as answered if the next thing after it is an answer (not another nudge).
  if (waiting) {
    const next = s.get(`SELECT entity FROM events WHERE workspace_id=? AND created_at>=? AND ((entity='nudge' AND entity_id=?)
      OR (actor=? AND entity='idle' AND action='reason') OR (actor=? AND entity='task' AND action='claimed')) ORDER BY id LIMIT 1`, s.ws, to, role, role, role);
    if (next && next.entity !== 'nudge') answered++;
  }
  return { sent, answered, escalated, reasons };
}

const span = (m: number) => m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;

/** One screen of text. */
export function formatTimeTable(r: Row): string {
  const lines = [`Time on ${r.day} (machine's time zone; ${String(r.from).slice(0, 16).replace('T', ' ')} to ${String(r.to).slice(0, 16).replace('T', ' ')} UTC):`, ''];
  for (const x of r.roles) {
    lines.push(`${x.role}: working ${span(x.working_minutes)} · waiting ${span(x.waiting_minutes)} · not running ${span(x.not_running_minutes)}`);
    if (x.working.length) lines.push(`  working: ${x.working.slice(0, 6).map((w: Row) => `${w.what} ${span(w.minutes)}`).join(', ')}`);
    if (x.waiting.length) lines.push(`  waiting: ${x.waiting.slice(0, 6).map((w: Row) => `${w.what} ${span(w.minutes)}`).join(', ')}`);
    const n = x.nudges;
    if (n.sent || n.escalated || n.reasons.length) lines.push(`  nudges: ${n.sent} sent, ${n.answered} answered, ${n.escalated} escalated${n.reasons.length ? `; reasons: ${n.reasons.map((t: string) => `"${t.slice(0, 80)}"`).join('; ')}` : ''}`);
  }
  lines.push('', `Working means ${r.working_means}. 'Not running' is not proof a session was down.`, 'Not stored, so not counted:', ...r.not_stored.map((x: string) => `  ${x}`));
  return lines.join('\n');
}
