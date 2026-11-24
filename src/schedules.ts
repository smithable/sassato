import { type Store, type Row } from './storage.js';
import { check, text, safe, id, now, integer } from './errors.js';
import { addTask, human } from './tasks.js';

// Recurring and scheduled tasks (T1423), the first step of docs/recurring-tasks.md. A schedule (C…)
// is a task template and a time rule. A tick turns what has come due into one ordinary task per
// schedule, coalescing missed times into one range; while that task is still open, later times are
// recorded against it and nobody is woken again. Preview, list and show have no side effects.

export type Rule =
  | { kind: 'once'; at: string }
  | { kind: 'daily'; at: string; tz: string }
  | { kind: 'weekly'; days: string[]; at: string; tz: string }
  | { kind: 'interval'; minutes: number; anchor: string };
export interface RuleOptions { once?: string; daily?: boolean; weekly?: string; at?: string; tz?: string; every?: string | number; anchor?: string }
export interface ScheduleOptions extends RuleOptions { title: string; body?: string; forRole?: string; humanOnly?: boolean }
export interface EditOptions extends RuleOptions { expect: string | number; title?: string; body?: string; forRole?: string | null; humanOnly?: boolean }

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MIN = 60_000, DAY = 86_400_000, HISTORY = 50;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const iso = (t: number): string => new Date(t).toISOString();

// A zone's offset at an instant: its wall clock read as UTC, less the instant.
function offset(tz: string, t: number): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(t)).map(part => [part.type, part.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - (t - (((t % 1000) + 1000) % 1000));
}

// The instant a zone's clock shows `wall` (a civil time as UTC milliseconds): in a repeated
// fall-back hour the first of the two; in a spring-forward gap the first instant after the gap.
function instant(tz: string, wall: number): number {
  const a = wall - offset(tz, wall - DAY), b = wall - offset(tz, wall + DAY);
  const valid = [a, b].filter(t => t + offset(tz, t) === wall);
  if (valid.length) return Math.min(...valid);
  let lo = Math.min(a, b), hi = Math.max(a, b);
  const before = offset(tz, lo);
  while (hi - lo > MIN) { const mid = lo + Math.max(MIN, Math.floor((hi - lo) / 2 / MIN) * MIN); if (offset(tz, mid) === before) lo = mid; else hi = mid; }
  return hi;
}

/** The first due instant strictly after `after`, or null when the rule has no more. */
export function nextDue(rule: Rule, after: number): number | null {
  if (rule.kind === 'once') { const t = Date.parse(rule.at); return t > after ? t : null; }
  if (rule.kind === 'interval') {
    const anchor = Date.parse(rule.anchor), step = rule.minutes * MIN;
    return after < anchor ? anchor : anchor + (Math.floor((after - anchor) / step) + 1) * step;
  }
  const [hh, mm] = rule.at.split(':').map(Number), local = new Date(after + offset(rule.tz, after));
  for (let i = -1; i <= 8; i++) {
    const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + i);
    if (rule.kind === 'weekly' && !rule.days.includes(DAYS[new Date(day).getUTCDay()]!)) continue;
    const t = instant(rule.tz, day + hh! * 3_600_000 + mm! * MIN);
    if (t > after) return t;
  }
  throw new Error('unreachable: a weekly rule has at least one day');
}

/** A due instant as its zone shows it: `2027-01-04 09:00 Europe/Helsinki`. */
export function civil(rule: Rule, at: string): string {
  const tz = rule.kind === 'daily' || rule.kind === 'weekly' ? rule.tz : 'UTC', t = Date.parse(at);
  return `${new Date(t + offset(tz, t)).toISOString().slice(0, 16).replace('T', ' ')} ${tz}`;
}

function strictInstant(value: string, label: string): string {
  const [y, m, d] = value.slice(0, 10).split('-').map(Number), day = new Date(0); day.setUTCFullYear(y!, m! - 1, d!);
  check(INSTANT.test(value) && Number.isFinite(Date.parse(value)) && day.getUTCMonth() === m! - 1 && day.getUTCDate() === d,
    `${label} needs an ISO instant with Z or an offset, such as 2027-01-15T12:00:00Z`);
  return iso(Date.parse(value));
}

export function parseRule(o: RuleOptions, at: number): Rule {
  const given = [o.once !== undefined, Boolean(o.daily), o.weekly !== undefined, o.every !== undefined].filter(Boolean).length;
  check(given === 1, 'Give exactly one of --once INSTANT, --daily, --weekly DAYS or --every MINUTES');
  if (o.once !== undefined || o.every !== undefined) check(o.at === undefined && o.tz === undefined, '--at and --tz go with --daily or --weekly');
  check(o.every !== undefined || o.anchor === undefined, '--anchor goes with --every');
  if (o.once !== undefined) {
    const when = strictInstant(o.once, '--once');
    check(Date.parse(when) > at, '--once is in the past', 4);
    return { kind: 'once', at: when };
  }
  if (o.every !== undefined) {
    const minutes = integer(Number(o.every), 'interval minutes', 1, 525_600);
    return { kind: 'interval', minutes, anchor: o.anchor === undefined ? iso(Math.floor(at / MIN) * MIN) : strictInstant(o.anchor, '--anchor') };
  }
  check(typeof o.at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(o.at), '--at needs a local time HH:MM');
  check(typeof o.tz === 'string' && o.tz.length > 0, '--tz needs a time zone, such as Europe/Helsinki');
  try { new Intl.DateTimeFormat('en-US', { timeZone: o.tz }); } catch { check(false, `Unknown time zone: ${o.tz}`); }
  if (o.daily) return { kind: 'daily', at: o.at!, tz: o.tz! };
  const days = o.weekly!.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
  check(days.length > 0 && days.every(d => DAYS.includes(d)) && new Set(days).size === days.length, '--weekly needs days such as mon,thu');
  return { kind: 'weekly', days: DAYS.filter(d => days.includes(d)), at: o.at!, tz: o.tz! };
}

export function describe(rule: Rule): string {
  if (rule.kind === 'once') return `once at ${rule.at}`;
  if (rule.kind === 'interval') return `every ${rule.minutes} minutes from ${rule.anchor}`;
  return `${rule.kind === 'daily' ? 'daily' : `weekly on ${rule.days.join(',')}`} at ${rule.at} ${rule.tz}`;
}

const scheduleRow = (s: Store, schedule: string): Row => {
  const row = s.get('SELECT * FROM schedules WHERE workspace_id=? AND id=?', s.ws, id(schedule, 'C'));
  check(row, `No schedule ${schedule}`, 3);
  return row;
};
const ruleOf = (row: Row): Rule => JSON.parse(row.rule) as Rule;

function view(row: Row): Row {
  const rule = ruleOf(row), next = row.state === 'active' ? row.next_due : null;
  return {
    id: `C${row.id}`, title: row.title, body: row.body, for_role: row.for_role, human_only: Boolean(row.human_only),
    rule, rule_text: describe(rule), state: row.state, state_reason: row.state_reason, revision: row.revision,
    next_due: next, next_due_local: next ? civil(rule, next) : null,
    created_by: row.created_by, updated_by: row.updated_by, created_at: row.created_at, updated_at: row.updated_at,
  };
}
const occurrenceView = (row: Row): Row => ({
  due_at: row.due_at, last_due_at: row.last_due_at, slots: row.slots, label: row.label, revision: row.revision, status: row.status,
  task: row.task_id ? `T${row.task_id}` : null, task_status: row.task_status ?? null, created_at: row.created_at,
});

function template(s: Store, o: { title?: string; body?: string; forRole?: string | null; humanOnly?: boolean }, current?: Row): void {
  if (o.title !== undefined) text(o.title, 'title', 400);
  if (o.body !== undefined) { safe(o.body); check(o.body.length <= 50_000 && !o.body.includes('\0'), 'Body must be at most 50000 characters without NUL'); }
  const role = o.forRole === undefined ? current?.for_role : o.forRole, humanOnly = o.humanOnly ?? Boolean(current?.human_only);
  if (role) check(!humanOnly || s.role(role).kind === 'human', 'Human-only items must be for a human', 3);
  if (o.forRole) s.role(o.forRole);
}

function slotsUntil(rule: Rule, first: number, until: number): { last: number; slots: number; next: number | null } {
  if (rule.kind === 'interval') {
    const step = rule.minutes * MIN, slots = Math.floor((until - first) / step) + 1, last = first + (slots - 1) * step;
    return { last, slots, next: last + step };
  }
  let last = first, slots = 1, next = nextDue(rule, first);
  while (next !== null && next <= until) { last = next; slots++; next = nextDue(rule, next); }
  return { last, slots, next };
}

function record(s: Store, row: Row, first: number, last: number, slots: number, status: string, task: number | null, at: string): Row {
  const rule = ruleOf(row), label = slots > 1 ? `${civil(rule, iso(first))} to ${civil(rule, iso(last))} (${slots} times)` : civil(rule, iso(first));
  s.run('INSERT INTO occurrences(workspace_id,schedule_id,due_at,last_due_at,slots,label,revision,status,task_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    s.ws, row.id, iso(first), iso(last), slots, label, row.revision, status, task, at);
  const result = { schedule: `C${row.id}`, due_at: iso(first), last_due_at: iso(last), slots, label, status, task: task ? `T${task}` : null };
  s.event('schedule', `C${row.id}`, status, result);
  return result;
}

// Unticked due times the schedule will not issue (a pause, an edit) are recorded, never silently lost.
function settleOverdue(s: Store, row: Row, status: 'skipped' | 'superseded', at: string): void {
  const t = Date.parse(at);
  if (!row.next_due || Date.parse(row.next_due) > t) return;
  const { last, slots } = slotsUntil(ruleOf(row), Date.parse(row.next_due), t);
  record(s, row, Date.parse(row.next_due), last, slots, status, null, at);
}

// The next due time after now, never one a recorded occurrence already covers (a clock set back).
function nextFrom(s: Store, row: Row, rule: Rule, at: string): string | null {
  const covered = s.get('SELECT MAX(last_due_at) AS t FROM occurrences WHERE workspace_id=? AND schedule_id=?', s.ws, row.id)?.t;
  const next = nextDue(rule, Math.max(Date.parse(at), covered ? Date.parse(covered) : -Infinity));
  return next === null ? null : iso(next);
}

function changed(s: Store, row: Row, patch: Row, action: string, detail: Row = {}): Row {
  const keys = Object.keys(patch);
  s.run(`UPDATE schedules SET ${keys.map(k => `${k}=?`).join(',')} WHERE workspace_id=? AND id=?`, ...keys.map(k => patch[k]), s.ws, row.id);
  const next = scheduleRow(s, `C${row.id}`);
  s.event('schedule', `C${row.id}`, action, { ...detail, schedule: view(next) });
  return view(next);
}

function expectRevision(row: Row, expect: string | number): void {
  check(row.revision === integer(Number(expect), 'expected revision', 1), `C${row.id} changed (revision ${row.revision}); reload it and retry with --expect ${row.revision}`, 4);
}

/** A human adds a schedule, active at once; an agent proposes one in an ordinary task. */
export function addSchedule(s: Store, o: ScheduleOptions): Row {
  return s.tx(() => {
    const actor = s.requireActor(), at = now();
    check(human(s), 'Only a human adds a schedule; propose one in a task', 3);
    text(o.title, 'title', 400); template(s, o);
    const rule = parseRule(o, Date.parse(at)), next = nextDue(rule, Date.parse(at));
    const n = s.run('INSERT INTO schedules(workspace_id,title,body,for_role,human_only,rule,state,next_due,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      s.ws, o.title, o.body ?? '', o.forRole ?? null, o.humanOnly ? 1 : 0, JSON.stringify(rule), 'active', next === null ? null : iso(next), actor, actor, at, at).lastInsertRowid;
    const row = scheduleRow(s, `C${n}`);
    s.event('schedule', `C${n}`, 'created', view(row));
    return view(row);
  });
}

/** Template edits and rule changes take effect from now; due times left unticked are recorded as superseded. */
export function editSchedule(s: Store, schedule: string, o: EditOptions): Row {
  return s.tx(() => {
    const row = scheduleRow(s, schedule), actor = s.requireActor(), at = now();
    check(human(s), 'Only a human changes a schedule; propose a change in a task', 3);
    check(row.state !== 'archived', `C${row.id} is archived`, 4);
    expectRevision(row, o.expect); template(s, o, row);
    const patch: Row = { revision: row.revision + 1, updated_by: actor, updated_at: at };
    if (o.title !== undefined) patch.title = o.title;
    if (o.body !== undefined) patch.body = o.body;
    if (o.forRole !== undefined) patch.for_role = o.forRole;
    if (o.humanOnly !== undefined) patch.human_only = o.humanOnly ? 1 : 0;
    const ruleChanged = [o.once, o.daily, o.weekly, o.every, o.at, o.tz, o.anchor].some(v => v !== undefined && v !== false);
    const rule = ruleChanged ? parseRule(o, Date.parse(at)) : ruleOf(row);
    if (ruleChanged) patch.rule = JSON.stringify(rule);
    check(Object.keys(patch).length > 3, 'Nothing to change');
    // Every edit applies from now: a due time not yet ticked is recorded under the old revision, not issued under the new one.
    settleOverdue(s, row, row.state === 'active' ? 'superseded' : 'skipped', at);
    if (ruleChanged || (row.next_due && Date.parse(row.next_due) <= Date.parse(at))) patch.next_due = nextFrom(s, row, rule, at);
    return changed(s, row, patch, 'edited');
  });
}

/** Any role may pause: stopping work is always safe. The reason is kept. */
export function pauseSchedule(s: Store, schedule: string, o: { expect: string | number; reason: string }): Row {
  return s.tx(() => {
    const row = scheduleRow(s, schedule), actor = s.requireActor(), at = now();
    check(row.state === 'active', `C${row.id} is ${row.state}`, 4);
    expectRevision(row, o.expect); text(o.reason, 'reason', 1000);
    return changed(s, row, { state: 'paused', state_reason: o.reason, revision: row.revision + 1, updated_by: actor, updated_at: at }, 'paused');
  });
}

/** A human resumes a schedule from the next future due time; the paused times are recorded as skipped. */
export function resumeSchedule(s: Store, schedule: string, o: { expect: string | number }): Row {
  return s.tx(() => {
    const row = scheduleRow(s, schedule), actor = s.requireActor(), at = now();
    check(human(s), 'Only a human resumes a schedule', 3);
    check(row.state === 'paused', `C${row.id} is ${row.state}`, 4);
    expectRevision(row, o.expect);
    settleOverdue(s, row, 'skipped', at);
    return changed(s, row, { state: 'active', state_reason: '', next_due: nextFrom(s, row, ruleOf(row), at), revision: row.revision + 1, updated_by: actor, updated_at: at }, 'resumed');
  });
}

/** A human archives a schedule. Its history and issued tasks stay. */
export function archiveSchedule(s: Store, schedule: string, o: { expect: string | number; reason: string }): Row {
  return s.tx(() => {
    const row = scheduleRow(s, schedule), actor = s.requireActor(), at = now();
    check(human(s), 'Only a human archives a schedule', 3);
    check(row.state !== 'archived', `C${row.id} is already archived`, 4);
    expectRevision(row, o.expect); text(o.reason, 'reason', 1000);
    settleOverdue(s, row, 'skipped', at);
    return changed(s, row, { state: 'archived', state_reason: o.reason, next_due: null, revision: row.revision + 1, updated_by: actor, updated_at: at }, 'archived');
  });
}

/** The next due instants, with their local time; read-only. A paused schedule previews from now. */
export function previewSchedule(s: Store, schedule: string, count = 5): Row {
  return s.snapshot(() => {
    const row = scheduleRow(s, schedule), rule = ruleOf(row), n = integer(count, 'count', 1, 100);
    const due: Row[] = [];
    let next = row.state === 'active' && row.next_due ? Date.parse(row.next_due) : row.state === 'archived' ? null : nextDue(rule, Date.now());
    while (next !== null && due.length < n) { due.push({ due_at: iso(next), local: civil(rule, iso(next)) }); next = nextDue(rule, next); }
    return { ...view(row), preview: due };
  });
}

/**
 * Issues what has come due, in one write transaction: for each active schedule due by now, one
 * ordinary task for the whole missed range, or, while its last task is still open, a coalesced
 * record against that task and no new wake. A schedule whose role is stopped is left due. A second
 * tick finds nothing due; a clock set back finds the cursor ahead of it.
 */
export function tickSchedules(s: Store): Row {
  return s.tx(() => {
    const actor = s.requireActor(), at = now(), t = Date.parse(at);
    const issued: Row[] = [], coalesced: Row[] = [], deferred: Row[] = [];
    for (const row of s.all("SELECT * FROM schedules WHERE workspace_id=? AND state='active' AND next_due IS NOT NULL AND next_due<=? ORDER BY next_due,id", s.ws, at)) {
      if (row.for_role && s.get('SELECT 1 FROM stop_requests WHERE workspace_id=? AND role=? AND cleared_at IS NULL', s.ws, row.for_role)) {
        deferred.push({ schedule: `C${row.id}`, due_at: row.next_due, reason: `${row.for_role} is stopped` }); continue;
      }
      // Each schedule in its own savepoint: one that cannot issue (its role changed kind) is left due, the rest go on.
      s.db.exec('SAVEPOINT schedule_tick');
      try {
        const rule = ruleOf(row), first = Date.parse(row.next_due), { last, slots, next } = slotsUntil(rule, first, t);
        // Coalesce only into an open task for the same audience; a template now for someone else gets its own task.
        const prior = s.get("SELECT o.task_id FROM occurrences o JOIN tasks t ON t.workspace_id=o.workspace_id AND t.id=o.task_id WHERE o.workspace_id=? AND o.schedule_id=? AND o.status='issued' AND t.status NOT IN ('done','dropped') AND t.for_role IS ? AND t.human_only=? ORDER BY o.id DESC LIMIT 1", s.ws, row.id, row.for_role ?? null, row.human_only);
        let result: Row, into: Row[];
        if (prior) { result = record(s, row, first, last, slots, 'coalesced', prior.task_id, at); into = coalesced; }
        else {
          const when = slots > 1 ? `${civil(rule, iso(first))} to ${civil(rule, iso(last))}, ${slots} due times` : civil(rule, iso(first));
          const task = addTask(s, {
            title: `${row.title} (due ${civil(rule, iso(last))})`,
            body: `${row.body ? `${row.body}\n\n` : ''}From schedule C${row.id} (revision ${row.revision}): due ${when}.`,
            forRole: row.for_role ?? undefined, humanOnly: Boolean(row.human_only),
          });
          result = record(s, row, first, last, slots, 'issued', Number(String(task.id).slice(1)), at); into = issued;
        }
        s.run('UPDATE schedules SET next_due=? WHERE workspace_id=? AND id=?', next === null ? null : iso(next), s.ws, row.id);
        s.db.exec('RELEASE schedule_tick');
        into.push(result);
      } catch (error) {
        s.db.exec('ROLLBACK TO schedule_tick'); s.db.exec('RELEASE schedule_tick');
        deferred.push({ schedule: `C${row.id}`, due_at: row.next_due, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    s.run('INSERT INTO schedule_ticks(workspace_id,last_tick_at,last_actor) VALUES(?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET last_tick_at=excluded.last_tick_at,last_actor=excluded.last_actor', s.ws, at, actor);
    return { at, issued, coalesced, deferred };
  });
}

export function listSchedules(s: Store, o: { all?: boolean; due?: boolean } = {}): Row {
  return s.snapshot(() => {
    const at = now(), tick = s.get('SELECT last_tick_at,last_actor FROM schedule_ticks WHERE workspace_id=?', s.ws);
    const rows = s.all(`SELECT * FROM schedules WHERE workspace_id=? ${o.all ? '' : "AND state!='archived'"} ${o.due ? "AND state='active' AND next_due IS NOT NULL AND next_due<=?" : ''} ORDER BY id`, ...(o.due ? [s.ws, at] : [s.ws]));
    const overdue = Number(s.get("SELECT count(*) n FROM schedules WHERE workspace_id=? AND state='active' AND next_due IS NOT NULL AND next_due<=?", s.ws, at)!.n);
    const schedules = rows.map(row => {
      const last = s.get('SELECT o.*,t.status AS task_status FROM occurrences o LEFT JOIN tasks t ON t.workspace_id=o.workspace_id AND t.id=o.task_id WHERE o.workspace_id=? AND o.schedule_id=? ORDER BY o.id DESC LIMIT 1', s.ws, row.id);
      return { ...view(row), last: last ? occurrenceView(last) : null };
    });
    return { last_tick_at: tick?.last_tick_at ?? null, last_tick_by: tick?.last_actor ?? null, overdue, schedules };
  });
}

export function showSchedule(s: Store, schedule: string, limit = HISTORY): Row {
  return s.snapshot(() => {
    const row = scheduleRow(s, schedule), n = integer(limit, 'limit', 1, 1000);
    const history = s.all('SELECT o.*,t.status AS task_status FROM occurrences o LEFT JOIN tasks t ON t.workspace_id=o.workspace_id AND t.id=o.task_id WHERE o.workspace_id=? AND o.schedule_id=? ORDER BY o.id DESC LIMIT ?', s.ws, row.id, n);
    return { ...view(row), history: history.map(occurrenceView) };
  });
}

export function renderSchedules(data: Row): string {
  const lines = (data.schedules as Row[]).map(r => {
    const next = r.state === 'active' ? (r.next_due ? `next ${r.next_due_local}` : 'finished') : `${r.state}${r.state_reason ? `: ${r.state_reason}` : ''}`;
    const last = r.last ? `; last ${r.last.label} ${r.last.status}${r.last.task ? ` ${r.last.task} (${r.last.task_status})` : ''}` : '';
    return `${r.id} r${r.revision} · ${r.title} · ${r.for_role ?? 'anyone'} · ${r.rule_text} · ${next}${last}`;
  });
  const head = `Last tick: ${data.last_tick_at ?? 'never'}${data.last_tick_by ? ` by ${data.last_tick_by}` : ''}; ${data.overdue} overdue.`;
  return [head, ...(lines.length ? lines : ['No schedules.'])].join('\n');
}
