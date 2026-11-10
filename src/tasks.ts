import { type Store, type Row, type Param } from './storage.js';
import { check, text, safe, integer, id, now } from './errors.js';
import { assertWorkAllowed } from './control.js';
import { humanRole } from './humans.js';

export const STATUSES = ['open', 'doing', 'blocked', 'review', 'done', 'dropped'] as const;
export type TaskStatus = typeof STATUSES[number];
const terminal = (row: Row): boolean => row.status === 'done' || row.status === 'dropped';
const human = (s: Store): boolean => s.role(s.requireActor()).kind === 'human';
const taskId = (row: Row): string => `T${row.id}`;
const taskView = (row: Row): Row => ({ ...row, id: taskId(row), human_only: Boolean(row.human_only), review_required: Boolean(row.review_required), stale: Boolean(row.lease_until && row.lease_until < now() && !terminal(row)) });
const blockerView = (row: Row): Row => ({ ...row, id: `B${row.id}`, task_id: `T${row.task_id}` });
const questionView = (row: Row): Row => ({ ...row, id: `H${row.id}`, task_id: `T${row.task_id}`, blocker_id: `B${row.blocker_id}`, options: JSON.parse(row.options) });
const unownedEditor = (row: Row, actor: string): boolean => !row.owner && (row.creator === actor || (!row.human_only && row.for_role === actor));
function writable(s: Store, row: Row): string {
  const actor = s.requireActor();
  check(human(s) || row.owner === actor || unownedEditor(row, actor), 'Only the owner, an unowned task\'s creator or target, or a human role may modify this task', 3);
  return actor;
}
function active(row: Row): void { check(!terminal(row), 'Task is closed; reopen it before changing work state', 4); }
function executable(s: Store, row: Row): void { check(!row.human_only || human(s), 'Human-only work cannot be claimed or completed by an agent', 3); }
function indexTask(s: Store, row: Row): void { s.index('task', taskId(row), row.title, row.body, { role: row.owner ?? row.for_role, status: row.status, updated_at: row.updated_at }); }
function change(s: Store, row: Row, patch: Row, action: string, detail: Row = {}): Row {
  safe(patch); safe(detail);
  const values = { ...patch, version: row.version + 1, updated_at: now() };
  const keys = Object.keys(values);
  // Keys only come from the module's fixed patches, never from user input.
  const result = s.run(`UPDATE tasks SET ${keys.map(k => `${k}=?`).join(',')} WHERE workspace_id=? AND id=? AND version=?`, ...Object.values(values) as Param[], s.ws, row.id, row.version);
  check(result.changes === 1, 'Task changed; reload it and retry', 4);
  const after = s.task(taskId(row));
  const before = Object.fromEntries(keys.map(k => [k, row[k]]));
  s.event('task', taskId(row), action, { before, after: values, ...detail });
  indexTask(s, after); return taskView(after);
}
function blocking(s: Store, row: Row): Row[] {
  const explicit = s.all('SELECT * FROM blockers WHERE workspace_id=? AND task_id=? AND status=? ORDER BY id', s.ws, row.id, 'open').map(blockerView);
  const dependencies = s.all('SELECT t.id,t.title,t.status,t.owner FROM dependencies d JOIN tasks t ON t.workspace_id=d.workspace_id AND t.id=d.depends_on WHERE d.workspace_id=? AND d.task_id=? AND t.status!=? ORDER BY t.id', s.ws, row.id, 'done').map(r => ({ id: `D${row.id}-${r.id}`, kind: 'dependency', task_id: taskId(row), waiting_on: `T${r.id}`, body: r.title, status: 'open', dependency_status: r.status, owner: r.owner }));
  return [...explicit, ...dependencies];
}
function unblocked(s: Store, row: Row): void {
  const reasons = blocking(s, row); check(reasons.length === 0, `Task has unresolved blockers: ${reasons.map(r => r.id).join(', ')}`, 4);
}
function notify(s: Store, recipients: string[], body: string, task: Row): void {
  const at = now(), sender = s.requireActor(); text(body);
  const to = [...new Set(recipients)].filter(r => r !== sender);
  if (!to.length) return;
  for (const recipient of to) s.role(recipient);
  const n = s.run('INSERT INTO messages(workspace_id,sender,body,task_id,created_at) VALUES(?,?,?,?,?)', s.ws, sender, body, task.id, at).lastInsertRowid;
  for (const recipient of to) s.run('INSERT INTO receipts(workspace_id,message_id,recipient) VALUES(?,?,?)', s.ws, n, recipient);
  s.index('message', `M${n}`, `${sender} → ${to.join(', ')}`, body, { role: sender, updated_at: at });
  s.event('message', `M${n}`, 'sent', { recipients: to, task_id: taskId(task), body });
}
function lease(hours = 4): string { return new Date(Date.now() + integer(hours, 'lease hours', 1, 168) * 3_600_000).toISOString(); }
function priority(value = 0): number { return integer(value, 'priority', 0, 100); }

export interface AddTaskOptions { title: string; body?: string; owner?: string; forRole?: string; priority?: number; humanOnly?: boolean; reviewRequired?: boolean }
export function addTask(s: Store, options: AddTaskOptions): Row {
  return s.tx(() => {
    const actor = s.requireActor(), at = now();
    text(options.title, 'title', 500); safe(options.body ?? '');
    if (options.body !== undefined) check(typeof options.body === 'string' && options.body.length <= 100_000 && !options.body.includes('\0'), 'Body must be at most 100000 characters without NUL');
    if (options.owner) s.role(options.owner);
    const target = options.forRole ?? (options.humanOnly ? humanRole(s, options.owner) : null);
    if (target) s.role(target);
    check(!options.humanOnly || !options.owner || s.role(options.owner).kind === 'human', 'Human-only items can only be assigned to a human', 3);
    check(!options.humanOnly || !target || s.role(target).kind === 'human', 'Human-only items must be for a human', 3);
    const n = s.run('INSERT INTO tasks(workspace_id,title,body,owner,priority,human_only,for_role,creator,review_required,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', s.ws, options.title, options.body ?? '', options.owner ?? null, priority(options.priority), options.humanOnly ? 1 : 0, target, actor, options.reviewRequired ? 1 : 0, at, at).lastInsertRowid;
    const row = s.task(`T${n}`); s.event('task', `T${n}`, 'created', taskView(row)); indexTask(s, row); return taskView(row);
  });
}
export interface ListTaskOptions { status?: string; owner?: string; forRole?: string; available?: boolean; limit?: number; after?: string }
function queryTasks(s: Store, options: ListTaskOptions, fetchLimit: number): Row[] {
  const clauses = ['t.workspace_id=?'], params: Param[] = [s.ws];
  if (options.status && options.status !== 'all') {
    const statuses = options.status.split(','); check(statuses.every(v => STATUSES.includes(v as TaskStatus)), 'Invalid task status');
    clauses.push(`t.status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses);
  } else if (!options.status) clauses.push("t.status NOT IN ('done','dropped')");
  if (options.owner) { s.role(options.owner); clauses.push('t.owner=?'); params.push(options.owner); }
  if (options.forRole) { s.role(options.forRole); clauses.push('t.for_role=?'); params.push(options.forRole); }
  if (options.after) { const cursor = s.task(options.after); clauses.push('(t.priority<? OR (t.priority=? AND t.id>?))'); params.push(cursor.priority, cursor.priority, cursor.id); }
  if (options.available) {
    const actor = s.requireActor();
    clauses.push("t.status='open'", '(t.owner IS NULL OR t.owner=?)', '(t.for_role IS NULL OR t.for_role=?)'); params.push(actor, actor);
    if (!human(s)) clauses.push('t.human_only=0');
    clauses.push("NOT EXISTS (SELECT 1 FROM blockers b WHERE b.workspace_id=t.workspace_id AND b.task_id=t.id AND b.status='open')", "NOT EXISTS (SELECT 1 FROM dependencies d JOIN tasks p ON p.workspace_id=d.workspace_id AND p.id=d.depends_on WHERE d.workspace_id=t.workspace_id AND d.task_id=t.id AND p.status!='done')");
  }
  params.push(fetchLimit);
  return s.all(`SELECT t.* FROM tasks t WHERE ${clauses.join(' AND ')} ORDER BY t.priority DESC,t.id LIMIT ?`, ...params).map(taskView);
}
export function listTasks(s: Store, options: ListTaskOptions = {}): Row[] {
  const limit = integer(options.limit ?? 50, 'limit', 1, 1000);
  return s.snapshot(() => queryTasks(s, options, limit));
}
export interface TaskPage { items: Row[]; has_more: boolean; next_after: string | null }
export function listTaskPage(s: Store, options: ListTaskOptions = {}): TaskPage {
  const limit = integer(options.limit ?? 50, 'limit', 1, 1000);
  return s.snapshot(() => {
    const rows = queryTasks(s, options, limit + 1), items = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return { items, has_more: hasMore, next_after: hasMore ? items[items.length - 1].id as string : null };
  });
}
export function showTask(s: Store, task: string, options: { historyLimit?: number; beforeEvent?: number } = {}): Row {
  return s.snapshot(() => {
    const row = s.task(task), limit = integer(options.historyLimit ?? 100, 'history limit', 1, 1000);
    const history = s.all('SELECT * FROM events WHERE workspace_id=? AND entity=? AND entity_id=? AND id<? ORDER BY id DESC LIMIT ?', s.ws, 'task', task, integer(options.beforeEvent ?? Number.MAX_SAFE_INTEGER, 'before event', 1), limit).map(r => ({ ...r, id: `E${r.id}`, detail: JSON.parse(r.detail) }));
    return { ...taskView(row), blockers: blocking(s, row), dependencies: s.all('SELECT t.* FROM dependencies d JOIN tasks t ON t.workspace_id=d.workspace_id AND t.id=d.depends_on WHERE d.workspace_id=? AND d.task_id=? ORDER BY t.id', s.ws, row.id).map(taskView), questions: s.all('SELECT * FROM questions WHERE workspace_id=? AND task_id=? ORDER BY id', s.ws, row.id).map(questionView), history };
  });
}
export function takeTask(s: Store, task: string, options: { hours?: number } = {}): Row {
  return s.tx(() => {
    const row = s.task(task), actor = s.requireActor(); assertWorkAllowed(s, actor); executable(s, row);
    check(row.status === 'open', 'Task is not open for claiming', 4);
    check(!row.owner || row.owner === actor, 'Task is assigned to another role', 4);
    check(!row.for_role || row.for_role === actor, `Task is for ${row.for_role}`, 3);
    unblocked(s, row);
    return change(s, row, { owner: actor, status: 'doing', lease_until: lease(options.hours), reviewed_by: null, review_note: null }, 'claimed');
  });
}
export function renewTask(s: Store, task: string, options: { hours?: number } = {}): Row {
  return s.tx(() => {
    const row = s.task(task); writable(s, row); executable(s, row); active(row);
    check(row.owner && row.lease_until, 'Task has no claim to renew', 4);
    return change(s, row, { lease_until: lease(options.hours) }, 'renewed');
  });
}
export function noteTask(s: Store, task: string, note: string): Row {
  return s.tx(() => { const row = s.task(task); writable(s, row); text(note, 'note'); return change(s, row, {}, 'note', { note }); });
}
export interface UpdateTaskOptions { version: number; title?: string; body?: string; priority?: number; forRole?: string | null; humanOnly?: boolean; reviewRequired?: boolean }
export function updateTask(s: Store, task: string, options: UpdateTaskOptions): Row {
  return s.tx(() => {
    const row = s.task(task); writable(s, row); active(row);
    check(row.version === integer(options.version, 'version', 1), 'Task changed; reload it and retry with its current version', 4);
    const patch: Row = {};
    if (options.title !== undefined) patch.title = text(options.title, 'title', 500);
    if (options.body !== undefined) { check(typeof options.body === 'string' && options.body.length <= 100_000 && !options.body.includes('\0'), 'Body must be at most 100000 characters without NUL'); safe(options.body); patch.body = options.body; }
    if (options.priority !== undefined) patch.priority = priority(options.priority);
    if (options.forRole !== undefined) { if (options.forRole !== null) s.role(options.forRole); patch.for_role = options.forRole; }
    if (options.humanOnly !== undefined) {
      check(options.humanOnly || !row.human_only || human(s), 'Only a human may remove human-only classification', 3);
      check(!options.humanOnly || row.status === 'open', 'Release work before making it human-only', 4);
      patch.human_only = options.humanOnly ? 1 : 0;
      if (options.humanOnly) { patch.owner = null; patch.lease_until = null; patch.for_role = humanRole(s, options.forRole ?? (row.for_role && s.role(row.for_role).kind === 'human' ? row.for_role : undefined)); }
    }
    if (options.reviewRequired !== undefined) { check(options.reviewRequired || !row.review_required || human(s), 'Only a human may remove a required review', 3); patch.review_required = options.reviewRequired ? 1 : 0; }
    const target = patch.for_role !== undefined ? patch.for_role : row.for_role;
    const onlyHuman = patch.human_only ?? row.human_only;
    check(!onlyHuman || !target || s.role(target).kind === 'human', 'Human-only items must be for a human', 3);
    check(Object.keys(patch).length > 0, 'No task changes provided');
    return change(s, row, { ...patch, reviewed_by: null, review_note: null }, 'updated');
  });
}
export function handoffTask(s: Store, task: string, to: string, note: string): Row {
  return s.tx(() => {
    const row = s.task(task); writable(s, row); active(row); text(note, 'handoff summary');
    const target = s.role(to); check(!row.human_only || target.kind === 'human', 'Human-only work cannot be handed to an agent', 3);
    check(to !== row.owner, 'Task already belongs to this role', 4);
    const result = change(s, row, { owner: to, for_role: to, lease_until: null, status: blocking(s, row).some(b => b.kind !== 'dependency') ? 'blocked' : 'open', reviewed_by: null, review_note: null }, 'handed-off', { note });
    notify(s, [to], `${task} handed to you: ${note}`, row); return result;
  });
}
export function releaseTask(s: Store, task: string, note: string): Row {
  return s.tx(() => { const row = s.task(task); writable(s, row); active(row); text(note, 'release reason'); return change(s, row, { owner: null, lease_until: null, status: blocking(s, row).some(b => b.kind !== 'dependency') ? 'blocked' : 'open', reviewed_by: null, review_note: null }, 'released', { note }); });
}
export function submitTask(s: Store, task: string, note: string): Row {
  return s.tx(() => {
    const row = s.task(task); writable(s, row); executable(s, row); text(note, 'submission summary');
    check(row.status === 'doing', 'Only doing work can be submitted for review', 4); unblocked(s, row);
    return change(s, row, { status: 'review', lease_until: null, reviewed_by: null, review_note: null }, 'submitted', { note });
  });
}
export function reviewTask(s: Store, task: string, options: { approve: boolean; note: string; expected_version: number }): Row {
  return s.tx(() => {
    const row = s.task(task), actor = s.requireActor(); text(options.note, 'review explanation');
    const expected = integer(options.expected_version, 'expected version', 1);
    check(row.version === expected, 'Task changed; reload it and review the current version', 4);
    check(row.status === 'review', 'Task is not awaiting review', 4);
    check(human(s) || actor !== row.owner, 'The owner cannot approve or reject their own review', 3);
    if (options.approve) { unblocked(s, row); return change(s, row, { reviewed_by: actor, review_note: options.note }, 'review-approved', { note: options.note }); }
    const result = change(s, row, { status: 'doing', lease_until: row.owner ? lease() : null, reviewed_by: null, review_note: options.note }, 'review-rejected', { note: options.note });
    if (row.owner) notify(s, [row.owner], `${task} review rejected: ${options.note}`, row); return result;
  });
}
function completeTask(s: Store, row: Row, options: { ref?: string }, allowOpen: boolean): Row {
  writable(s, row); executable(s, row);
  check(row.status === 'doing' || row.status === 'review' || (allowOpen && row.status === 'open' && !row.lease_until), 'Claim the task before completing it, or reconcile eligible imported/human-only work', 4);
  unblocked(s, row);
  check(!row.review_required || row.reviewed_by, 'This task needs an approved review before completion', 4);
  if (options.ref !== undefined) text(options.ref, 'reference', 1000);
  return change(s, row, { status: 'done', lease_until: null, completed_at: now() }, 'completed', { ref: options.ref ?? null });
}
export function doneTask(s: Store, task: string, options: { ref?: string } = {}): Row {
  return s.tx(() => {
    const row = s.task(task), actor = s.requireActor(), isHuman = human(s);
    // Imported status is historical: an authorized editor may reconcile finished work without
    // manufacturing a new claim. Ordinary open agent work still requires take.
    const imported = s.get("SELECT 1 FROM events WHERE workspace_id=? AND entity='task' AND entity_id=? AND action='imported' LIMIT 1", s.ws, task);
    const allowOpen = Boolean((imported && (isHuman || row.owner === actor || unownedEditor(row, actor))) || (row.human_only && isHuman));
    return completeTask(s, row, options, allowOpen);
  });
}
export function dropTask(s: Store, task: string, note: string): Row {
  return s.tx(() => {
    const row = s.task(task), actor = writable(s, row); active(row); text(note, 'drop reason');
    const normalizedTask = taskId(row);
    const at = now(), cancelled: string[] = [];
    for (const question of s.all("SELECT q.*,b.waiting_on,b.body AS blocker_body FROM questions q JOIN blockers b ON b.workspace_id=q.workspace_id AND b.id=q.blocker_id WHERE q.workspace_id=? AND q.task_id=? AND q.status='pending' ORDER BY q.id", s.ws, row.id)) {
      const questionId = `H${question.id}`, blockerId = `B${question.blocker_id}`;
      s.run("UPDATE questions SET status='cancelled',cancelled_at=?,cancelled_by=?,cancel_reason=? WHERE workspace_id=? AND id=?", at, actor, note, s.ws, question.id);
      s.run("UPDATE blockers SET status='resolved',resolved_at=? WHERE workspace_id=? AND id=? AND status='open'", at, s.ws, question.blocker_id);
      s.index('blocker', blockerId, `${normalizedTask} waits on ${question.waiting_on}`, question.blocker_body, { role: question.waiting_on, status: 'resolved', updated_at: at });
      s.index('question', questionId, question.question, JSON.stringify({ options: JSON.parse(question.options), recommendation: question.recommendation, command: question.command, cancel_reason: note }), { role: question.waiting_on, status: 'cancelled', updated_at: at });
      s.event('question', questionId, 'cancelled', { task: normalizedTask, blocker: blockerId, reason: note });
      cancelled.push(questionId);
    }
    return change(s, row, { status: 'dropped', lease_until: null, completed_at: at }, 'dropped', { note, cancelled_questions: cancelled });
  });
}
export function reopenTask(s: Store, task: string, note: string): Row {
  return s.tx(() => {
    const row = s.task(task); writable(s, row); check(terminal(row), 'Task is already open', 4); text(note, 'reopen reason');
    return change(s, row, { status: blocking(s, row).some(b => b.kind !== 'dependency') ? 'blocked' : 'open', lease_until: null, completed_at: null, reviewed_by: null, review_note: null }, 'reopened', { note });
  });
}
export function addDependency(s: Store, task: string, after: string): Row {
  return s.tx(() => {
    const row = s.task(task), dependency = s.task(after); writable(s, row); active(row);
    check(row.id !== dependency.id, 'A task cannot depend on itself', 4);
    const cycle = s.get('WITH RECURSIVE ancestors(id) AS (SELECT depends_on FROM dependencies WHERE workspace_id=? AND task_id=? UNION SELECT d.depends_on FROM dependencies d JOIN ancestors a ON d.task_id=a.id WHERE d.workspace_id=?) SELECT 1 FROM ancestors WHERE id=? LIMIT 1', s.ws, dependency.id, s.ws, row.id);
    check(!cycle, 'Dependency would create a cycle', 4);
    const inserted = s.run('INSERT OR IGNORE INTO dependencies(workspace_id,task_id,depends_on) VALUES(?,?,?)', s.ws, row.id, dependency.id);
    check(inserted.changes === 1, 'Dependency already exists', 4);
    return change(s, row, { reviewed_by: null, review_note: null }, 'dependency-added', { depends_on: after });
  });
}
export function removeDependency(s: Store, task: string, after: string): Row {
  return s.tx(() => {
    const row = s.task(task), dependency = s.task(after); writable(s, row); active(row);
    check(s.run('DELETE FROM dependencies WHERE workspace_id=? AND task_id=? AND depends_on=?', s.ws, row.id, dependency.id).changes === 1, 'Dependency does not exist', 4);
    return change(s, row, { reviewed_by: null, review_note: null }, 'dependency-removed', { depends_on: after });
  });
}
export interface BlockOptions { kind: string; waitingOn: string; body: string }
export function blockTask(s: Store, task: string, options: BlockOptions): Row {
  return s.tx(() => {
    const row = s.task(task), actor = writable(s, row); active(row);
    check(['agent', 'human', 'external', 'other'].includes(options.kind), 'Blocker kind must be agent, human, external or other; use after for dependencies');
    text(options.waitingOn, 'waiting on', 500); text(options.body, 'blocker');
    if (options.kind === 'agent' || options.kind === 'human') {
      const role = s.role(options.waitingOn);
      check(role.kind === options.kind, `Waiting role must be ${options.kind}`);
    }
    const at = now(), n = s.run('INSERT INTO blockers(workspace_id,task_id,kind,waiting_on,body,created_by,created_at) VALUES(?,?,?,?,?,?,?)', s.ws, row.id, options.kind, options.waitingOn, options.body, actor, at).lastInsertRowid;
    s.index('blocker', `B${n}`, `${task} waits on ${options.waitingOn}`, options.body, { role: options.waitingOn, status: 'open', updated_at: at });
    change(s, row, { status: 'blocked', reviewed_by: null, review_note: null }, 'blocked', { blocker: `B${n}`, ...options });
    return blockerView(s.get('SELECT * FROM blockers WHERE workspace_id=? AND id=?', s.ws, n)!);
  });
}
function restoredState(s: Store, task: Row, at: string): Row {
  // Existing transition events retain the status before the first blocker. Skip
  // additional blockers; release/handoff/reopen deliberately start a new open phase.
  const transition = s.get(`SELECT action,detail FROM events WHERE workspace_id=? AND entity='task' AND entity_id=?
    AND json_extract(detail,'$.after.status')='blocked'
    AND (json_extract(detail,'$.before.status')!='blocked' OR action IN ('released','handed-off','reopened'))
    ORDER BY id DESC LIMIT 1`, s.ws, taskId(task));
  const before = transition && !['released', 'handed-off', 'reopened'].includes(transition.action)
    ? JSON.parse(transition.detail).before.status : transition ? 'open' : null;
  if (before === 'review') return { status: 'review', lease_until: null, reviewed_by: null, review_note: null };
  // Imports predating transition history may only have their retained claim.
  const claimed = task.owner && task.lease_until && task.lease_until > at;
  return (before === 'doing' || before === null) && claimed
    ? { status: 'doing' } : { status: 'open', lease_until: null };
}
function resolve(s: Store, blocker: Row, note: string): Row {
  check(blocker.status === 'open', 'Blocker is already resolved', 4);
  const at = now();
  s.run('UPDATE blockers SET status=?,resolved_at=? WHERE workspace_id=? AND id=?', 'resolved', at, s.ws, blocker.id);
  s.index('blocker', `B${blocker.id}`, `T${blocker.task_id} waits on ${blocker.waiting_on}`, blocker.body, { role: blocker.waiting_on, status: 'resolved', updated_at: at });
  const task = s.task(`T${blocker.task_id}`);
  const remaining = s.get("SELECT 1 FROM blockers WHERE workspace_id=? AND task_id=? AND status='open' LIMIT 1", s.ws, task.id);
  const patch = task.status === 'blocked' && !remaining ? restoredState(s, task, at) : {};
  change(s, task, patch, 'blocker-resolved', { blocker: `B${blocker.id}`, note });
  return blockerView({ ...blocker, status: 'resolved', resolved_at: at });
}
export function resolveBlocker(s: Store, blockerId: string, note: string): Row {
  return s.tx(() => {
    text(note, 'resolution');
    const blocker = s.get('SELECT * FROM blockers WHERE workspace_id=? AND id=?', s.ws, id(blockerId, 'B')); check(blocker, 'Blocker not found in this workspace', 3);
    const task = s.task(`T${blocker.task_id}`), actor = s.requireActor();
    check(human(s) || task.owner === actor || unownedEditor(task, actor) || blocker.waiting_on === actor, 'Only a task editor, waiting role or a human can resolve this blocker', 3);
    check(!s.get("SELECT 1 FROM questions WHERE workspace_id=? AND blocker_id=? AND status='pending'", s.ws, blocker.id), 'Answer the linked human question instead of resolving its blocker directly', 4);
    return resolve(s, blocker, note);
  });
}
export function listBlockers(s: Store, options: { task?: string; chain?: string; open?: boolean; limit?: number } = {}): Row[] {
  const limit = integer(options.limit ?? 100, 'limit', 1, 1000);
  if (options.chain) {
    const row = s.task(options.chain);
    const related = s.all(`WITH RECURSIVE chain(id) AS (SELECT ? UNION SELECT d.depends_on FROM dependencies d JOIN chain c ON d.task_id=c.id JOIN tasks p ON p.workspace_id=d.workspace_id AND p.id=d.depends_on WHERE d.workspace_id=? AND p.status!='done') SELECT t.* FROM tasks t JOIN chain c ON t.id=c.id WHERE t.workspace_id=? ORDER BY t.id LIMIT ?`, row.id, s.ws, s.ws, limit);
    return related.flatMap(r => blocking(s, r).map(b => ({ ...b, root: b.kind !== 'dependency' || !blocking(s, s.task(b.waiting_on)).length }))).slice(0, limit);
  }
  if (options.task) {
    const row = s.task(options.task);
    if (options.open !== false) return blocking(s, row).slice(0, limit);
    return s.all('SELECT * FROM blockers WHERE workspace_id=? AND task_id=? ORDER BY id LIMIT ?', s.ws, row.id, limit).map(blockerView);
  }
  const explicit = s.all(`SELECT * FROM blockers WHERE workspace_id=? ${options.open === false ? '' : "AND status='open'"} ORDER BY id LIMIT ?`, s.ws, limit).map(blockerView);
  const dependencies = s.all("SELECT d.task_id,p.id,p.title,p.status,p.owner FROM dependencies d JOIN tasks p ON p.workspace_id=d.workspace_id AND p.id=d.depends_on JOIN tasks t ON t.workspace_id=d.workspace_id AND t.id=d.task_id WHERE d.workspace_id=? AND p.status!='done' AND t.status NOT IN ('done','dropped') ORDER BY d.task_id,p.id LIMIT ?", s.ws, limit).map(r => ({ id: `D${r.task_id}-${r.id}`, kind: 'dependency', task_id: `T${r.task_id}`, waiting_on: `T${r.id}`, body: r.title, status: 'open', dependency_status: r.status, owner: r.owner }));
  return [...explicit, ...dependencies].slice(0, limit);
}
export interface AskOptions { question: string; options?: string[]; recommendation?: string; command?: string; forRole?: string }
export function askHuman(s: Store, task: string, options: AskOptions): Row {
  return s.tx(() => {
    const row = s.task(task), actor = writable(s, row); active(row); text(options.question, 'question');
    const choices = options.options ?? []; check(Array.isArray(choices) && choices.length <= 20, 'At most 20 options are allowed'); for (const choice of choices) text(choice, 'option', 2000);
    if (options.recommendation !== undefined) text(options.recommendation, 'recommendation', 5000);
    if (options.command !== undefined) text(options.command, 'command', 10_000);
    const recipient = humanRole(s, options.forRole);
    const blocker = blockTask(s, task, { kind: 'human', waitingOn: recipient, body: options.question });
    const at = now(), n = s.run('INSERT INTO questions(workspace_id,task_id,blocker_id,asked_by,question,options,recommendation,command,created_at) VALUES(?,?,?,?,?,?,?,?,?)', s.ws, row.id, id(blocker.id, 'B'), actor, options.question, JSON.stringify(choices), options.recommendation ?? null, options.command ?? null, at).lastInsertRowid;
    const question = s.get('SELECT * FROM questions WHERE workspace_id=? AND id=?', s.ws, n)!;
    s.index('question', `H${n}`, options.question, JSON.stringify({ options: choices, recommendation: options.recommendation, command: options.command }), { role: recipient, status: 'pending', updated_at: at });
    s.event('task', task, 'human-question', questionView(question));
    s.event('question', `H${n}`, 'asked', { task, question: options.question });
    notify(s, [recipient], `${task} / H${n}: ${options.question}`, row);
    return { ...questionView(question), for_role: recipient };
  });
}
export function answerQuestion(s: Store, questionOrTask: string, answer: string, options: { close?: boolean; relayedBy?: string } = {}): Row {
  return s.tx(() => {
    const actor = s.requireHuman(); text(answer, 'answer');
    if (options.relayedBy !== undefined) s.role(options.relayedBy);
    const attribution = options.relayedBy === undefined ? {} : { relayed_by: options.relayedBy };
    let question: Row | undefined;
    if (questionOrTask.startsWith('T')) {
      const row = s.task(questionOrTask), questions = s.all("SELECT * FROM questions WHERE workspace_id=? AND task_id=? AND status='pending' ORDER BY id", s.ws, row.id);
      check(questions.length === 1, questions.length ? 'This task has several pending questions; answer a specific H<number>' : 'No pending question for this task', 4); question = questions[0];
    } else question = s.get('SELECT * FROM questions WHERE workspace_id=? AND id=?', s.ws, id(questionOrTask, 'H'));
    check(question, 'Question not found in this workspace', 3); check(question.status === 'pending', `Question is ${question.status}; ask a new question if needed`, 4);
    active(s.task(`T${question.task_id}`));
    const at = now(), choices = JSON.parse(question.options) as string[];
    let recorded = answer;
    if (/^[1-9][0-9]*$/.test(answer) && choices.length) { const choice = integer(answer, 'option number', 1, choices.length); recorded = `${choice}: ${choices[choice - 1]}`; }
    s.run('UPDATE questions SET status=?,answer=?,answered_by=?,answered_at=? WHERE workspace_id=? AND id=?', 'answered', recorded, actor, at, s.ws, question.id);
    const blocker = s.get('SELECT * FROM blockers WHERE workspace_id=? AND id=?', s.ws, question.blocker_id)!;
    resolve(s, blocker, `H${question.id}: ${recorded}`);
    const row = s.task(`T${question.task_id}`);
    s.index('question', `H${question.id}`, question.question, JSON.stringify({ options: choices, recommendation: question.recommendation, command: question.command, answer: recorded }), { role: blocker.waiting_on, status: 'answered', updated_at: at });
    s.event('task', taskId(row), 'human-answered', { question: `H${question.id}`, answer: recorded, answered_by: actor, ...attribution });
    s.event('question', `H${question.id}`, 'answered', { task: taskId(row), answer: recorded, answered_by: actor, ...attribution });
    // Explicit human closure shares this transaction: any remaining blocker or review
    // requirement rolls back the answer, blocker resolution, events and notification.
    if (options.close) completeTask(s, row, { ref: `H${question.id}` }, true);
    notify(s, [row.owner, question.asked_by].filter((r): r is string => Boolean(r)), `H${question.id} on ${taskId(row)} answered by ${actor}: ${recorded}${options.close ? ' Task closed.' : ''}`, row);
    const result = questionView({ ...question, status: 'answered', answer: recorded, answered_by: actor, answered_at: at, ...attribution });
    return options.close ? { ...result, task_status: 'done' } : result;
  });
}
export function humanQueue(s: Store, options: { limit?: number; forRole?: string } = {}): Row[] {
  const limit = integer(options.limit ?? 50, 'limit', 1, 1000);
  return s.snapshot(() => {
    const recipient = options.forRole === undefined ? null : humanRole(s, options.forRole);
    const questions = s.all("SELECT q.*,b.waiting_on AS for_role,t.title,t.owner,t.priority,t.human_only,t.status AS task_status FROM questions q JOIN tasks t ON t.workspace_id=q.workspace_id AND t.id=q.task_id JOIN blockers b ON b.workspace_id=q.workspace_id AND b.id=q.blocker_id WHERE q.workspace_id=? AND q.status='pending' AND t.status NOT IN ('done','dropped') AND (? IS NULL OR b.waiting_on=?) ORDER BY t.priority DESC,q.created_at,q.id LIMIT ?", s.ws, recipient, recipient, limit).map((q): Row => ({ ...questionView(q), kind: 'question' }));
    const tasks = s.all("SELECT t.* FROM tasks t WHERE t.workspace_id=? AND t.status NOT IN ('done','dropped') AND (t.human_only=1 OR EXISTS (SELECT 1 FROM roles r WHERE r.workspace_id=t.workspace_id AND r.kind='human' AND r.name IN (t.for_role,t.owner))) AND (? IS NULL OR t.for_role=? OR t.owner=?) AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.workspace_id=t.workspace_id AND q.task_id=t.id AND q.status='pending') ORDER BY t.priority DESC,t.created_at,t.id LIMIT ?", s.ws, recipient, recipient, recipient, limit).map((t): Row => ({ ...taskView(t), kind: 'task' }));
    return [...questions, ...tasks].sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).slice(0, limit);
  });
}
