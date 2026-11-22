import { type Row, type Store } from './storage.js';
import { check, name } from './errors.js';

/**
 * A read-only report from what sassato already stores (T1241): how long mail stayed unread, urgent
 * mail left unacknowledged, mail the role's saved cursor passed while it was still unread, time idle
 * with ready work, and how long review requests and questions to a human waited. No new tables;
 * what cannot be computed from the records is named in `not_stored`.
 */
export type StatsOptions = { since?: string; role?: string; now?: Date };

const MINUTE = 60_000;
const URGENT_ACK_MINUTES = 30;
const PASSED_MINUTES = 30;
const NAMED = 5;

type Wait = { minutes: number; open: boolean };
const classOf = (m: Row): 'now' | 'urgent' | 'needs-reply' | 'ordinary' =>
  m.immediate ? 'now' : m.urgent ? 'urgent' : m.reply ? 'needs-reply' : 'ordinary';
const minutes = (from: string | number, to: string | number) => Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / MINUTE));
function summary(waits: Wait[]) {
  const sorted = waits.map(w => w.minutes).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
  return { count: waits.length, open: waits.filter(w => w.open).length, median_minutes: median, longest_minutes: sorted.at(-1) ?? null };
}

export function stats(s: Store, options: StatsOptions = {}): Row {
  const now = (options.now ?? new Date()).toISOString();
  check(options.since === undefined || !Number.isNaN(Date.parse(options.since)), 'Use --since with a date, such as 2026-11-22', 2);
  const since = options.since === undefined ? '' : new Date(options.since).toISOString();
  const role = options.role === undefined ? undefined : name(options.role);
  if (role !== undefined) s.role(role);
  return s.snapshot(() => {
    // Mail: one row per receipt, with the message's class and its 'sent' event id (the cursor position).
    const mail = s.all(`SELECT m.id, m.sender, m.created_at, m.urgent, m.reply, m.immediate, r.recipient, r.read_at, r.done_at,
        (SELECT e.id FROM events e WHERE e.workspace_id=m.workspace_id AND e.entity='message' AND e.action='sent' AND e.entity_id='M'||m.id) AS event_id
      FROM messages m JOIN receipts r ON r.workspace_id=m.workspace_id AND r.message_id=m.id
      JOIN roles ro ON ro.workspace_id=r.workspace_id AND ro.name=r.recipient AND ro.kind='agent'
      WHERE m.workspace_id=? AND m.created_at>=? ${role ? 'AND r.recipient=?' : ''} ORDER BY m.id`, ...[s.ws, since, ...(role ? [role] : [])]);
    const byRole = new Map<string, Record<string, Wait[]>>();
    const unread: Row[] = [];
    for (const m of mail) {
      const wait = { minutes: minutes(m.created_at, m.read_at ?? now), open: m.read_at === null };
      const classes = byRole.get(m.recipient) ?? {};
      (classes[classOf(m)] ??= []).push(wait);
      byRole.set(m.recipient, classes);
      unread.push({ message: `M${m.id}`, from: m.sender, to: m.recipient, class: classOf(m), ...wait });
    }
    const unreadByRole = [...byRole].sort(([a], [b]) => a.localeCompare(b)).map(([recipient, classes]) => ({
      role: recipient, ...Object.fromEntries(Object.entries(classes).map(([k, waits]) => [k, summary(waits)])),
    }));
    const longestUnread = unread.sort((a, b) => b.minutes - a.minutes).slice(0, NAMED);

    const urgentLate = mail.filter(m => (m.urgent || m.immediate) && minutes(m.created_at, m.done_at ?? now) > URGENT_ACK_MINUTES)
      .map(m => ({ message: `M${m.id}`, to: m.recipient, minutes: minutes(m.created_at, m.done_at ?? now), open: m.done_at === null }))
      .sort((a, b) => b.minutes - a.minutes);

    // The T1233 symptom: a cursor the role saved reached past the message while it stayed unread for
    // 30 minutes or more after. Which mail a digest listed is not stored, so listed-but-ignored mail
    // shows here too.
    const saves = s.all(`SELECT entity_id AS role, created_at, json_extract(detail,'$.cursor') AS cursor FROM events
      WHERE workspace_id=? AND entity='notification-progress' AND action='saved' ORDER BY id`, s.ws);
    const savesByRole = new Map<string, Row[]>();
    for (const save of saves) savesByRole.set(save.role, [...(savesByRole.get(save.role) ?? []), save]);
    const passed: Row[] = [];
    for (const m of mail) {
      if (m.event_id === null) continue;
      const save = (savesByRole.get(m.recipient) ?? []).find(x => Number(x.cursor) >= Number(m.event_id) && x.created_at >= m.created_at);
      if (!save || (m.read_at !== null && m.read_at <= save.created_at)) continue;
      const after = minutes(save.created_at, m.read_at ?? now);
      if (after >= PASSED_MINUTES) passed.push({ message: `M${m.id}`, to: m.recipient, class: classOf(m), unread_minutes_after: after, open: m.read_at === null });
    }
    passed.sort((a, b) => b.unread_minutes_after - a.unread_minutes_after);

    // Idle with ready work: each wake for the role's own work records since when it was idle with it.
    const idle = new Map<string, Map<number, Wait>>();
    for (const row of s.all(`SELECT entity_id AS role, json_extract(detail,'$.idle_delivery.since') AS since_ms,
        json_extract(detail,'$.idle_delivery.delivered') AS delivered_ms FROM events
      WHERE workspace_id=? AND entity='notification-progress' AND action='saved' AND created_at>=?
        AND json_extract(detail,'$.idle_delivery.kind')='own-work' ${role ? 'AND entity_id=?' : ''}`, ...[s.ws, since, ...(role ? [role] : [])])) {
      const spells = idle.get(row.role) ?? new Map<number, Wait>();
      spells.set(Number(row.since_ms), { minutes: minutes(Number(row.since_ms), Number(row.delivered_ms)), open: false });
      idle.set(row.role, spells);
    }
    const idleWithWork = [...idle].sort(([a], [b]) => a.localeCompare(b)).map(([r, spells]) => ({ role: r, ...summary([...spells.values()]) }));

    // Review requests: from each submit to the next verdict on that task.
    const reviewEvents = s.all(`SELECT entity_id AS task, actor, action, created_at FROM events WHERE workspace_id=? AND entity='task'
      AND action IN ('submitted','review-approved','review-rejected') AND created_at>=? ORDER BY id`, s.ws, since);
    const asked = new Map<string, Row>();
    const reviews: Row[] = [];
    for (const e of reviewEvents) {
      if (e.action === 'submitted') { asked.set(e.task, e); continue; }
      const submit = asked.get(e.task);
      if (!submit) continue;
      asked.delete(e.task);
      if (!role || submit.actor === role || e.actor === role) reviews.push({ task: e.task, author: submit.actor, reviewer: e.actor, minutes: minutes(submit.created_at, e.created_at), open: false });
    }
    for (const submit of asked.values()) if (!role || submit.actor === role) reviews.push({ task: submit.task, author: submit.actor, reviewer: null, minutes: minutes(submit.created_at, now), open: true });
    reviews.sort((a, b) => b.minutes - a.minutes);

    const questions = s.all(`SELECT id, task_id, asked_by, created_at, answered_at, status FROM questions
      WHERE workspace_id=? AND created_at>=? AND status IN ('pending','answered') ${role ? 'AND asked_by=?' : ''} ORDER BY id`, ...[s.ws, since, ...(role ? [role] : [])])
      .map(q => ({ question: `H${q.id}`, task: `T${q.task_id}`, asked_by: q.asked_by, minutes: minutes(q.created_at, q.answered_at ?? now), open: q.status === 'pending' }))
      .sort((a, b) => b.minutes - a.minutes);

    return {
      since: since || null, role: role ?? null, generated_at: now,
      mail_unread: { by_role: unreadByRole, longest: longestUnread },
      urgent_unacknowledged: { threshold_minutes: URGENT_ACK_MINUTES, count: urgentLate.length, longest: urgentLate.slice(0, NAMED) },
      passed_unread: { threshold_minutes: PASSED_MINUTES, count: passed.length, by_role: countBy(passed, 'to'), longest: passed.slice(0, NAMED) },
      idle_with_work: idleWithWork,
      reviews: { ...summary(reviews as Wait[]), longest: reviews.slice(0, NAMED) },
      human_questions: { ...summary(questions as Wait[]), longest: questions.slice(0, NAMED) },
      not_stored: [
        'refused writes (take, note, done refused by sassato): a refusal writes nothing, so it cannot be counted',
        'which mail a wake digest listed: only the saved cursor is kept, so listed-but-ignored mail and never-listed mail look the same in passed_unread',
        'how long a role was idle with work before its first own-work wake after a restart, and idle time with no wake at all (a waiter not armed)',
      ],
    };
  });
}

function countBy(rows: Row[], key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[row[key]] = (out[row[key]] ?? 0) + 1;
  return out;
}

const span = (m: number | null) => m === null ? '-' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`;
const open = (row: Row) => row.open ? ' (still open)' : '';

/** One screen of text. */
export function formatStats(r: Row): string {
  const lines = [`Stats${r.role ? ` for ${r.role}` : ''}${r.since ? ` since ${String(r.since).slice(0, 10)}` : ''}.`, '', 'Mail unread (count · median · longest; open = still unread):'];
  for (const row of r.mail_unread.by_role) {
    const parts = ['now', 'urgent', 'needs-reply', 'ordinary'].filter(k => row[k]).map(k => `${k} ${row[k].count} · ${span(row[k].median_minutes)} · ${span(row[k].longest_minutes)}${row[k].open ? ` · ${row[k].open} open` : ''}`);
    lines.push(`  ${row.role}: ${parts.join('; ')}`);
  }
  if (!r.mail_unread.by_role.length) lines.push('  none');
  for (const m of r.mail_unread.longest) lines.push(`  longest: ${m.message} ${m.class} ${m.from}→${m.to} ${span(m.minutes)}${open(m)}`);
  lines.push('', `Urgent mail not acknowledged within ${r.urgent_unacknowledged.threshold_minutes} minutes: ${r.urgent_unacknowledged.count}`);
  for (const m of r.urgent_unacknowledged.longest) lines.push(`  ${m.message} to ${m.to}: ${span(m.minutes)}${open(m)}`);
  lines.push('', `Mail a saved cursor passed while it stayed unread ${r.passed_unread.threshold_minutes}+ minutes: ${r.passed_unread.count}${r.passed_unread.count ? ` (${Object.entries(r.passed_unread.by_role).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
  for (const m of r.passed_unread.longest) lines.push(`  ${m.message} ${m.class} to ${m.to}: unread ${span(m.unread_minutes_after)} after${open(m)}`);
  lines.push('', 'Idle with ready work before a wake (spells · median · longest):');
  for (const row of r.idle_with_work) lines.push(`  ${row.role}: ${row.count} · ${span(row.median_minutes)} · ${span(row.longest_minutes)}`);
  if (!r.idle_with_work.length) lines.push('  none');
  for (const [title, key, who] of [['Review requests', 'reviews', (x: Row) => `${x.task} by ${x.author}${x.reviewer ? `, read by ${x.reviewer}` : ''}`], ['Questions to a human', 'human_questions', (x: Row) => `${x.question} on ${x.task} from ${x.asked_by}`]] as const) {
    const w = r[key];
    lines.push('', `${title}: ${w.count} · median ${span(w.median_minutes)} · longest ${span(w.longest_minutes)}${w.open ? ` · ${w.open} open` : ''}`);
    for (const x of w.longest) lines.push(`  ${who(x)}: ${span(x.minutes)}${open(x)}`);
  }
  lines.push('', 'Not stored, so not counted:', ...r.not_stored.map((x: string) => `  ${x}`));
  return lines.join('\n');
}
