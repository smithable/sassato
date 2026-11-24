// A read-only listing of what may be closed, dropped or corrected (T1415, docs/prune.md). Each section is one
// rule, so a line says why it is there. Nothing is changed: a session judges the list and closes under the usual rules.
import type { Row, Store } from './storage.js';
import { check, integer, now } from './errors.js';
import { contextLine } from './context-brief.js';
import { factUntil } from './coordination.js';
import { humanQueue } from './tasks.js';
import { TOPIC_DAYS } from './topics.js';

export const PRUNE_SECTIONS = ['quiet-review','quiet-topics','names-merged-pr','old-questions','same-title','expired-facts','dated-facts','marked-facts','unchecked-facts'] as const;
// unchecked-facts is asked for by name: most decisions are older than a month by nature and would bury the rest.
const DEFAULT_SECTIONS = PRUNE_SECTIONS.filter((section) => section !== 'unchecked-facts');
const DAY = 86_400_000;
const days = (at: string, from: number) => Math.floor((from - Date.parse(at)) / DAY);
const open = "t.status NOT IN ('done','dropped')";
const clip = (value: unknown, max = 120) => { const v = String(value ?? '').replace(/\s+/g, ' ').trim(); return v.length > max ? `${v.slice(0, max - 1)}…` : v; };
// Titles match once the case, a leading "Low:" or "Feedback (…):" and the punctuation are gone.
export const cutTitle = (title: string) => title.toLowerCase().replace(/^\s*(low|feedback(\s*\([^)]*\))?)\s*:\s*/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// A note that names a pull request and says it merged, not one that says it has not or will.
export const saysMerged = (note: string) => /(#\d+|\/pull\/\d+)/.test(note) && /\bmerged\b/i.test(note)
  && !/\b(not|never|once|until|when|after|before|if|unmerged)\b[^.;]{0,40}\bmerged\b|n't[^.;]{0,40}\bmerged\b/i.test(note);
export interface PruneData { days: number; sections: Record<string, Row[]> }

// Every task closed since a time, with what it led to (T1447): its last note, drop reason or done reference.
// A result names a merged pull request or another task; a row with neither is marked for the daily read.
export const namesResult = (note: string, self: string) => saysMerged(note) || [...note.matchAll(/\bT(\d+)\b/g)].some((m) => `T${m[1]}` !== self);
export interface ClosedData { since: string; items: Row[]; has_more: boolean }
export function closedSince(s: Store, options: { since: string; owner?: string; forRole?: string; limit?: number }): ClosedData {
  check(Number.isFinite(Date.parse(options.since)), 'Use --closed-since with a date or a time, such as 2026-11-24 or 2026-11-24T06:00:00Z', 2);
  const since = new Date(options.since).toISOString(), limit = integer(options.limit ?? 1000, 'limit', 1, 5000);
  return s.snapshot(() => {
    if (options.owner) s.role(options.owner);
    if (options.forRole) s.role(options.forRole);
    const rows = s.all(`SELECT t.id,t.title,t.status,t.owner,t.for_role,t.completed_at FROM tasks t WHERE t.workspace_id=? AND t.kind='work' AND t.status IN ('done','dropped') AND t.completed_at>=?${options.owner ? ' AND t.owner=?' : ''}${options.forRole ? ' AND t.for_role=?' : ''} ORDER BY t.completed_at,t.id LIMIT ?`,
      s.ws, since, ...(options.owner ? [options.owner] : []), ...(options.forRole ? [options.forRole] : []), limit + 1);
    const items = rows.slice(0, limit).map((r) => {
      const self = `T${r.id}`;
      const texts = s.all("SELECT action,detail FROM events WHERE workspace_id=? AND entity='task' AND entity_id=? AND action IN ('note','dropped','completed') ORDER BY id DESC LIMIT 20", s.ws, self)
        .map((e) => { const d = JSON.parse(e.detail); return String((e.action === 'completed' ? d.ref : d.note) ?? '').trim(); }).filter(Boolean);
      const result = texts[0] ?? '';
      return { id: self, status: r.status, closed_at: r.completed_at, holder: r.owner ?? r.for_role ?? null, title: clip(r.title), result: clip(result, 400), names_result: namesResult(result, self) };
    });
    return { since, items, has_more: rows.length > limit };
  });
}
export function renderClosed(data: ClosedData, lineLength = 160): string {
  integer(lineLength, 'line length', 60, 1000);
  const without = data.items.filter((r) => !r.names_result).length;
  const lines = [`Closed since ${data.since}: ${data.items.length} task(s), ${without} naming no result (no merged pull request, no task).`];
  for (const r of data.items) {
    const head = `${r.names_result ? '  ' : '! '}${r.id} · ${r.status} ${String(r.closed_at).slice(0, 16).replace('T', ' ')}${r.holder ? ` · ${r.holder}` : ''} · ${r.title} → `;
    const text = r.result || '(no note)', room = Math.max(lineLength - head.length, 20);
    lines.push(head + (text.length > room ? `${text.slice(0, room - 1)}…` : text));
  }
  if (data.has_more) lines.push('More closed tasks exist: raise --limit or narrow --closed-since.');
  return lines.join('\n');
}
export function prune(s: Store, options: { days?: number; sections?: string } = {}): PruneData {
  const quiet = integer(options.days ?? 7, 'days', 1, 3650);
  const wanted = options.sections === undefined ? [...DEFAULT_SECTIONS] : options.sections.split(',');
  check(wanted.length > 0 && wanted.every((x) => (PRUNE_SECTIONS as readonly string[]).includes(x)), `--section takes ${PRUNE_SECTIONS.join(', ')}`);
  return s.snapshot(() => {
    const at = Date.now(), cutoff = new Date(at - quiet * DAY).toISOString(), stamp = now();
    const lastEvent = "(SELECT max(e.created_at) FROM events e WHERE e.workspace_id=t.workspace_id AND e.entity='task' AND e.entity_id='T'||t.id)";
    const task = (r: Row, rule: string, since: string): Row => ({ id: `T${r.id}`, age_days: days(since, at), since, holder: r.owner ?? r.for_role ?? null, text: clip(r.title), rule });
    const fact = (r: Row, rule: string, since: string): Row => ({ id: `F${r.id}`, key: r.key, age_days: days(since, at), since, until: factUntil(r.expires_at), text: clip(r.body), rule });
    const rules: Record<string, () => Row[]> = {
      'quiet-review': () => s.all(`SELECT t.id,t.title,t.owner,t.for_role,t.status,coalesce(${lastEvent},t.updated_at) AS last FROM tasks t WHERE t.workspace_id=? AND t.kind='work' AND t.status IN ('review','blocked') AND coalesce(${lastEvent},t.updated_at)<?`, s.ws, cutoff)
        .map((r) => task(r, `${r.status}, nothing recorded for ${quiet}+ days`, r.last)),
      // Topics move slowly: a fixed 30 days, not --days; the keeper closes it into work or with a reason.
      'quiet-topics': () => s.all(`SELECT t.id,t.title,t.owner,t.for_role,coalesce(${lastEvent},t.updated_at) AS last FROM tasks t WHERE t.workspace_id=? AND t.kind='topic' AND t.status='open' AND coalesce(${lastEvent},t.updated_at)<?`, s.ws, new Date(at - TOPIC_DAYS * DAY).toISOString())
        .map((r) => task(r, `open topic, nothing recorded for ${TOPIC_DAYS}+ days: close it into work or with a reason`, r.last)),
      'names-merged-pr': () => s.all(`SELECT t.id,t.title,t.owner,t.for_role,e.created_at,json_extract(e.detail,'$.note') AS note FROM tasks t JOIN events e ON e.workspace_id=t.workspace_id AND e.entity='task' AND e.entity_id='T'||t.id WHERE t.workspace_id=? AND t.kind='work' AND ${open} AND e.id=(SELECT max(x.id) FROM events x WHERE x.workspace_id=t.workspace_id AND x.entity='task' AND x.entity_id='T'||t.id) AND e.action IN ('note','submitted')`, s.ws)
        .filter((r) => saysMerged(r.note ?? ''))
        .map((r) => ({ ...task(r, 'its last note says a pull request merged', r.created_at), note: clip(r.note) })),
      'old-questions': () => humanQueue(s).filter((r) => r.kind === 'question' && r.age_days >= quiet)
        .map((r) => ({ id: r.id, age_days: r.age_days, since: r.created_at, holder: r.for_role, task: r.task_id, text: clip(r.question), rule: `pending ${quiet}+ days` })),
      'same-title': () => {
        const groups = new Map<string, Row[]>();
        for (const r of s.all(`SELECT t.id,t.title,t.owner,t.for_role,t.created_at FROM tasks t WHERE t.workspace_id=? AND ${open} ORDER BY t.id`, s.ws)) {
          const key = cutTitle(r.title); if (key) groups.set(key, [...(groups.get(key) ?? []), r]);
        }
        return [...groups.values()].filter((g) => g.length > 1).flatMap((g) => g.map((r) => ({ ...task(r, `same title as ${g.filter((o) => o !== r).map((o) => `T${o.id}`).join(', ')}`, r.created_at) })));
      },
      'expired-facts': () => s.all('SELECT * FROM facts WHERE workspace_id=? AND expires_at<?', s.ws, stamp).map((r) => fact(r, 'past its expiry', r.expires_at)),
      // The newest date in the key counts: a key naming a range that ends recently is current.
      'dated-facts': () => s.all('SELECT * FROM facts WHERE workspace_id=? AND (expires_at IS NULL OR expires_at>=?)', s.ws, stamp)
        .map((r) => ({ r, dated: (String(r.key).match(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g) ?? []).filter((d) => Number.isFinite(Date.parse(d))).sort().pop() }))
        .filter(({ dated }) => dated !== undefined && dated <= cutoff.slice(0, 10)).map(({ r, dated }) => fact(r, `its key names ${dated}`, `${dated}T00:00:00.000Z`)),
      'marked-facts': () => s.all('SELECT * FROM facts WHERE workspace_id=? AND (expires_at IS NULL OR expires_at>=?)', s.ws, stamp).filter((r) => /^\s*(duplicate|superseded|withdrawn)\b/i.test(r.body))
        .map((r) => fact(r, 'its text marks it duplicate, superseded or withdrawn', r.updated_at)),
      'unchecked-facts': () => s.all('SELECT * FROM facts WHERE workspace_id=? AND checked_at<? AND (expires_at IS NULL OR expires_at>=?)', s.ws, new Date(at - 30 * DAY).toISOString(), stamp)
        .map((r) => fact(r, 'not checked for 30+ days', r.checked_at)),
    };
    const sections: Record<string, Row[]> = {};
    for (const name of wanted) sections[name] = rules[name]().sort((a, b) => String(a.since).localeCompare(String(b.since)) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
    return { days: quiet, sections };
  });
}
export function renderPrune(data: PruneData, lineLength = 160): string {
  integer(lineLength, 'line length', 60, 1000);
  const lines = [`Prune listing (read-only; quiet age ${data.days} days). Nothing was changed: close under the usual rules.`];
  for (const [name, rows] of Object.entries(data.sections)) {
    lines.push(`${name} (${rows.length}):`);
    for (const r of rows) {
      const who = r.holder ? ` · ${r.holder}` : r.key ? ` · ${r.key}` : '';
      // The text gives way first, so the rule (and a same-title's other ids) always shows.
      const head = `${r.id}${r.task ? ` on ${r.task}` : ''} · ${r.age_days}d${who} · `, tail = `${r.until ? ` · until ${r.until}` : ''} · ${r.rule}`;
      const room = Math.max(lineLength - head.length - tail.length, 12);
      const text = contextLine(r.text, 1000);
      lines.push(head + (text.length > room ? `${text.slice(0, room - 1)}…` : text) + tail);
    }
  }
  return lines.join('\n');
}
