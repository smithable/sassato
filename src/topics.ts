import { type Store, type Row } from './storage.js';
import { check, text, safe, id, now } from './errors.js';
import { cancelPending, change, human, isTopic, pendingHandoff, taskView, terminal, writable } from './tasks.js';

// A topic (T1419) is a task of kind 'topic': a shared page for planning, research and decisions.
// It is never offered, taken or woken for as work; any role notes and links it, and it closes only
// into named follow-ups (work tasks or facts) or with a reason a human acknowledged. docs/topics.md.

const TOPIC_DAYS = 30;
const linkView = (row: Row): Row => ({ id: `L${row.id}`, target: row.target, type: linkType(row.target), label: row.label, follow_up: Boolean(row.follow_up), added_by: row.added_by, created_at: row.created_at });
function linkType(target: string): string {
  if (/^T\d+$/.test(target)) return 'task';
  if (/^H\d+$/.test(target)) return 'question';
  if (/^https?:\/\//.test(target) || /^[\w.-]+\/[\w.-]+#\d+$/.test(target)) return 'pull-request';
  return target.startsWith('fact:') ? 'fact' : 'path';
}
function topic(s: Store, task: string): Row {
  const row = s.task(task);
  check(isTopic(row), `T${row.id} is not a topic: see sas topics`, 4);
  return row;
}
function open(row: Row): void { check(!terminal(row), `T${row.id} is closed: reopen it to change it`, 4); }
function fact(s: Store, key: string): Row {
  const row = s.get('SELECT id,key,expires_at FROM facts WHERE workspace_id=? AND key=?', s.ws, key);
  check(row, `Fact not found: ${key}`, 3);
  check(!row.expires_at || row.expires_at >= now(), `Fact ${key} has expired`, 4);
  return row;
}
// A link names a task, a question, a fact (fact:KEY), a pull request or a repository path.
function target(s: Store, value: string): string {
  text(value, 'link', 500); check(!/\s/.test(value), 'A link has no spaces: a task, a question, fact:KEY, a pull request or a path');
  const type = linkType(value);
  if (type === 'task') s.task(value);
  if (type === 'question') check(s.get('SELECT 1 FROM questions WHERE workspace_id=? AND id=?', s.ws, id(value, 'H')), `Question not found: ${value}`, 3);
  if (type === 'fact') fact(s, value.slice(5));
  return value;
}
function insertLink(s: Store, row: Row, value: string, label: string, followUp: boolean, actor: string, at: string): Row {
  const n = s.run('INSERT INTO topic_links(workspace_id,topic_id,target,label,follow_up,added_by,created_at) VALUES(?,?,?,?,?,?,?)', s.ws, row.id, value, label, followUp ? 1 : 0, actor, at).lastInsertRowid;
  return linkView(s.get('SELECT * FROM topic_links WHERE workspace_id=? AND id=?', s.ws, n)!);
}

export interface AddTopicOptions { title: string; body?: string; keeper?: string; links?: string[] }
export function addTopic(s: Store, options: AddTopicOptions): Row {
  return s.tx(() => {
    const actor = s.requireActor(), at = now(), keeper = options.keeper ?? actor;
    text(options.title, 'title', 500); safe(options.body ?? '');
    if (options.body !== undefined) check(options.body.length <= 100_000 && !options.body.includes('\0'), 'Body must be at most 100000 characters without NUL');
    s.role(keeper);
    const links = (options.links ?? []).map(link => target(s, link));
    const n = s.run("INSERT INTO tasks(workspace_id,title,body,kind,for_role,creator,created_at,updated_at) VALUES(?,?,?,'topic',?,?,?,?)", s.ws, options.title, options.body ?? '', keeper, actor, at, at).lastInsertRowid;
    const row = s.task(`T${n}`);
    // Not 'created': a new topic wakes nobody, its keeper either.
    s.event('task', `T${n}`, 'topic-created', taskView(row));
    s.index('task', `T${n}`, row.title, row.body, { role: keeper, status: row.status, updated_at: at });
    for (const link of links) insertLink(s, row, link, '', false, actor, at);
    return showTopic(s, `T${n}`);
  });
}

/** An open task becomes a topic and keeps its id, notes and questions; the converter keeps it. */
export function topicFrom(s: Store, task: string): Row {
  return s.tx(() => {
    const row = s.task(task), actor = writable(s, row);
    check(!isTopic(row), `T${row.id} is already a topic`, 4);
    check(!row.human_only, 'Human-only work cannot become a topic', 3);
    // A topic closes into follow-ups without a review, so work that requires one stays work.
    check(!row.review_required, `T${row.id} requires a review: only work without one becomes a topic`, 4);
    check(['open', 'doing', 'blocked'].includes(row.status), `T${row.id} is ${row.status}: only open, held or blocked work becomes a topic`, 4);
    check(!row.owner || row.owner === actor, `T${row.id} is held by ${row.owner}: only its holder converts it`, 3);
    check(!s.get('SELECT 1 FROM dependencies WHERE workspace_id=? AND (task_id=? OR depends_on=?) LIMIT 1', s.ws, row.id, row.id), `T${row.id} has dependencies: remove them first (sas unafter)`, 4);
    // As for release: no hand-over pending and no checkout bound to it.
    check(!pendingHandoff(s, row) && !s.get('SELECT 1 FROM checkout_bindings WHERE workspace_id=? AND task_id=? AND released_at IS NULL', s.ws, row.id), `T${row.id} has a pending hand-over or a bound checkout: settle it first`, 4);
    // Only its pending questions come along; any other open blocker is resolved first, by its own path.
    check(!s.get("SELECT 1 FROM blockers b WHERE b.workspace_id=? AND b.task_id=? AND b.status='open' AND NOT EXISTS(SELECT 1 FROM questions q WHERE q.workspace_id=b.workspace_id AND q.blocker_id=b.id AND q.status='pending')", s.ws, row.id), `T${row.id} has open blockers other than its questions: resolve them first`, 4);
    check(!s.get("SELECT 1 FROM topic_links WHERE workspace_id=? AND target=? AND follow_up=1 AND status='linked'", s.ws, `T${row.id}`), `T${row.id} is a topic's follow-up: it stays work`, 4);
    change(s, row, { kind: 'topic', status: 'open', owner: null, lease_until: null, for_role: actor, reviewed_by: null, review_note: null }, 'converted-to-topic');
    return showTopic(s, task);
  });
}

export function linkTopic(s: Store, task: string, value: string, label = ''): Row {
  return s.tx(() => {
    const row = topic(s, task), actor = s.requireActor(); open(row);
    if (label) text(label, 'label', 200);
    const link = insertLink(s, row, target(s, value), label, false, actor, now());
    change(s, row, {}, 'topic-linked', { link: link.id, target: value, label });
    return link;
  });
}
export function unlinkTopic(s: Store, task: string, linkId: string): Row {
  return s.tx(() => {
    const row = topic(s, task); open(row);
    const link = s.get("SELECT * FROM topic_links WHERE workspace_id=? AND id=? AND topic_id=? AND status='linked'", s.ws, id(linkId, 'L'), row.id);
    check(link, `${linkId} is not a link on T${row.id}`, 3);
    check(!link.follow_up, 'A follow-up is not removed', 4);
    s.run("UPDATE topic_links SET status='removed' WHERE workspace_id=? AND id=?", s.ws, link.id);
    change(s, row, {}, 'topic-unlinked', { link: `L${link.id}`, target: link.target });
    return { ...linkView(link), status: 'removed' };
  });
}

export interface CloseTopicOptions { into?: string[]; reason?: string; acknowledged?: string }
export function closeTopic(s: Store, task: string, options: CloseTopicOptions): Row {
  return s.tx(() => {
    const row = topic(s, task), actor = s.requireActor(), isHuman = human(s); open(row);
    check(isHuman || actor === row.for_role || actor === row.creator, `Only the keeper (${row.for_role}), the creator or a human closes T${row.id}`, 3);
    const into = options.into ?? [];
    check((into.length > 0) !== (options.reason !== undefined), 'Close with --into TASK|fact:KEY,… or with --reason TEXT, not both');
    const at = now();
    if (into.length) {
      for (const item of into) {
        if (/^T\d+$/.test(item)) {
          const work = s.task(item);
          check(!isTopic(work), `${item} is a topic: a topic closes into work or a fact`, 4);
          check(work.id !== row.id, 'A topic does not close into itself', 4);
          // A dropped task led to nothing, so closing into it would be a close without a result (T1435).
          check(work.status !== 'dropped', `${item} was dropped: close into a task that was not dropped, a fact, or with --reason`, 4);
        } else {
          check(item.startsWith('fact:'), `${item} is neither a task nor fact:KEY`);
          fact(s, item.slice(5));
        }
      }
      for (const item of into) insertLink(s, row, item, 'follow-up', true, actor, at);
      const note = `Closed into ${into.join(', ')}`, cancelled = cancelPending(s, row, actor, note, at);
      change(s, row, { status: 'done', completed_at: at }, 'topic-closed', { into, cancelled_questions: cancelled });
    } else {
      text(options.reason!, 'reason');
      if (options.acknowledged !== undefined) {
        const question = s.get('SELECT status,answered_by,answered_at FROM questions WHERE workspace_id=? AND id=? AND task_id=?', s.ws, id(options.acknowledged, 'H'), row.id);
        check(question, `${options.acknowledged} is not a question on T${row.id}`, 3);
        check(question.status === 'answered', `${options.acknowledged} is not answered yet`, 4);
        // A reopened topic needs a fresh answer: one from before the reopening does not count.
        const reopened = s.get("SELECT max(created_at) AS at FROM events WHERE workspace_id=? AND entity='task' AND entity_id=? AND action='reopened'", s.ws, `T${row.id}`)?.at;
        check(!reopened || question.answered_at > reopened, `${options.acknowledged} was answered before T${row.id} was reopened: ask again`, 4);
        check(s.get("SELECT 1 FROM roles WHERE workspace_id=? AND name=? AND kind='human'", s.ws, question.answered_by), `${options.acknowledged} was not answered by a human`, 3);
      } else check(isHuman, 'Closing without follow-ups needs a human: --acknowledged H… (an answered question on this topic), or a human role', 3);
      const cancelled = cancelPending(s, row, actor, options.reason!, at);
      change(s, row, { status: 'dropped', completed_at: at }, 'topic-closed', { reason: options.reason, acknowledged: options.acknowledged ?? null, cancelled_questions: cancelled });
    }
    return showTopic(s, task);
  });
}

export function topicLinks(s: Store, row: Row): Row[] {
  return s.all("SELECT * FROM topic_links WHERE workspace_id=? AND topic_id=? AND status='linked' ORDER BY id", s.ws, row.id).map(link => {
    const view = linkView(link);
    if (view.type !== 'task') return view;
    const task = s.get('SELECT status,owner,title FROM tasks WHERE workspace_id=? AND id=?', s.ws, id(link.target, 'T'));
    return task ? { ...view, status: task.status, owner: task.owner, title: task.title } : view;
  });
}
const pendingQuestions = (s: Store, row: Row): string[] =>
  s.all("SELECT id FROM questions WHERE workspace_id=? AND task_id=? AND status='pending' ORDER BY id", s.ws, row.id).map(q => `H${q.id}`);
function lastEvent(s: Store, row: Row): string {
  return s.get("SELECT max(created_at) AS at FROM events WHERE workspace_id=? AND entity='task' AND entity_id=?", s.ws, `T${row.id}`)?.at ?? row.updated_at;
}
export function showTopic(s: Store, task: string): Row {
  const row = topic(s, task);
  return { ...taskView(row), links: topicLinks(s, row), pending_questions: pendingQuestions(s, row) };
}

export function listTopics(s: Store, options: { all?: boolean } = {}): Row[] {
  return s.snapshot(() => {
    const at = Date.now();
    const rows = s.all(`SELECT * FROM tasks WHERE workspace_id=? AND kind='topic'${options.all ? '' : " AND status='open'"} ORDER BY id`, s.ws);
    return rows.map(row => {
      const last = lastEvent(s, row), links = topicLinks(s, row);
      return { id: `T${row.id}`, title: row.title, status: row.status, keeper: row.for_role, quiet_days: Math.floor((at - Date.parse(last)) / 86_400_000), last_event_at: last,
        pending_questions: pendingQuestions(s, row), tasks: links.filter(l => l.type === 'task').map(l => ({ id: l.target, status: l.status ?? null, follow_up: l.follow_up })), links: links.length };
    });
  });
}
export function renderTopics(rows: Row[]): string {
  if (!rows.length) return 'No open topics.';
  return rows.map(r => {
    const parts = [`${r.id} · ${r.title}`, `keeper ${r.keeper}`, `${r.quiet_days}d quiet`];
    if (r.status !== 'open') parts.push(r.status);
    if (r.pending_questions.length) parts.push(`asks ${r.pending_questions.join(', ')}`);
    if (r.tasks.length) parts.push(r.tasks.map((t: Row) => `${t.id} ${t.status ?? '?'}${t.follow_up ? ' (follow-up)' : ''}`).join(', '));
    return parts.join(' · ');
  }).join('\n');
}
/** The open topics a quiet-topics prune lists: no event for TOPIC_DAYS. */
export function quietTopics(s: Store): Row[] {
  return listTopics(s).filter(r => r.quiet_days >= TOPIC_DAYS);
}
export { TOPIC_DAYS };

/** The brief's counts: open topics and the questions pending on them. */
export function topicCounts(s: Store): { topics_open: number; topics_questions: number } {
  const row = s.get("SELECT count(*) AS n,(SELECT count(*) FROM questions q JOIN tasks t ON t.workspace_id=q.workspace_id AND t.id=q.task_id WHERE q.workspace_id=? AND q.status='pending' AND t.kind='topic' AND t.status='open') AS q FROM tasks WHERE workspace_id=? AND kind='topic' AND status='open'", s.ws, s.ws)!;
  return { topics_open: Number(row.n), topics_questions: Number(row.q) };
}
/** Topics the role keeps or has noted that another role changed after the cursor: one row each. */
export function changedTopics(s: Store, actor: string, since: number, limit: number): Row[] {
  return s.all(`SELECT t.id,t.title,e.actor,e.action FROM tasks t JOIN events e ON e.workspace_id=t.workspace_id AND e.entity='task' AND e.entity_id='T'||t.id
    WHERE t.workspace_id=? AND t.kind='topic' AND e.id=(SELECT max(x.id) FROM events x WHERE x.workspace_id=t.workspace_id AND x.entity='task' AND x.entity_id='T'||t.id AND x.id>? AND x.actor<>?)
    AND (t.for_role=? OR EXISTS(SELECT 1 FROM events n WHERE n.workspace_id=t.workspace_id AND n.entity='task' AND n.entity_id='T'||t.id AND n.action='note' AND n.actor=?))
    ORDER BY e.id LIMIT ?`, s.ws, since, actor, actor, actor, limit)
    .map(r => ({ id: `T${r.id}`, title: r.title, change: `${r.action === 'note' ? 'new note' : r.action.replace(/^topic-/, '')} by ${r.actor}` }));
}
