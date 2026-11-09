import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage.js';
import * as tasks from '../dist/tasks.js';
import { requestStop, resumeWork } from '../dist/control.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sassato-tasks-'));
  const path = join(dir, 'state.db');
  const s = new Store(path, undefined, { create: true });
  const at = new Date().toISOString();
  s.run('INSERT INTO workspaces(name,created_at) VALUES(?,?)', 'work', at);
  for (const [role, kind, provider] of [['a','agent','claude'], ['b','agent','claude'], ['c','agent','codex'], ['human','human',null]]) {
    s.run('INSERT INTO roles(workspace_id,name,kind,provider) VALUES(1,?,?,?)', role, kind, provider);
  }
  s.use('work'); s.actor = 'a';
  t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  return { s, path };
}
function as(s, actor, fn) { const before = s.actor; s.actor = actor; try { return fn(); } finally { s.actor = before; } }
function expectCode(fn, code) { assert.throws(fn, e => e.code === code); }
function count(s, table) { return s.get(`SELECT count(*) AS n FROM ${table}`).n; }

// Separate process contention is covered by the CLI concurrency suite.
test('claim is exclusive, leased, owner-only, and stale claims are never stolen', t => {
  const { s } = fixture(t), task = tasks.addTask(s, { title: 'Implement coordinator' });
  assert.equal(tasks.listTasks(s, { available: true })[0].id, task.id);
  const claimed = tasks.takeTask(s, task.id);
  assert.equal(claimed.owner, 'a'); assert.equal(claimed.status, 'doing');
  assert.ok(Date.parse(claimed.lease_until) > Date.now() + 3.9 * 3_600_000);
  expectCode(() => tasks.takeTask(s, task.id), 4);
  as(s, 'b', () => {
    expectCode(() => tasks.takeTask(s, task.id), 4);
    expectCode(() => tasks.noteTask(s, task.id, 'Overwrite'), 3);
    expectCode(() => tasks.doneTask(s, task.id), 3);
  });
  s.run('UPDATE tasks SET lease_until=? WHERE id=?', '2000-01-01T00:00:00.000Z', Number(task.id.slice(1)));
  assert.equal(tasks.showTask(s, task.id).stale, true);
  as(s, 'c', () => expectCode(() => tasks.takeTask(s, task.id), 4));
  assert.equal(tasks.renewTask(s, task.id).stale, false);
  const history = tasks.showTask(s, task.id).history;
  assert.equal(history.filter(e => e.action === 'claimed').length, 1);
});

test('assigned and directed work remains available only to its role', t => {
  const { s } = fixture(t);
  const owned = tasks.addTask(s, { title: 'Owned by B', owner: 'b' });
  const directed = tasks.addTask(s, { title: 'For C', forRole: 'c' });
  assert.deepEqual(tasks.listTasks(s, { available: true }), []);
  expectCode(() => tasks.takeTask(s, owned.id), 4);
  expectCode(() => tasks.takeTask(s, directed.id), 3);
  as(s, 'b', () => assert.equal(tasks.takeTask(s, owned.id).owner, 'b'));
  as(s, 'c', () => assert.equal(tasks.takeTask(s, directed.id).owner, 'c'));
});

test('human-only items cannot be claimed, reassigned or downgraded by agents', t => {
  const { s } = fixture(t), task = tasks.addTask(s, { title: 'Publish package', humanOnly: true });
  assert.equal(task.for_role, 'human');
  expectCode(() => tasks.takeTask(s, task.id), 3);
  expectCode(() => tasks.updateTask(s, task.id, { version: task.version, humanOnly: false }), 3);
  expectCode(() => tasks.handoffTask(s, task.id, 'b', 'Run this instead'), 3);
  expectCode(() => tasks.addTask(s, { title: 'Invalid human work', humanOnly: true, owner: 'a' }), 3);
  assert.equal(tasks.humanQueue(s)[0].id, task.id);
  as(s, 'human', () => {
    tasks.takeTask(s, task.id);
    assert.equal(tasks.doneTask(s, task.id).status, 'done');
  });
});

test('optimistic edits preserve history and update FTS in the same transaction', t => {
  const { s } = fixture(t), task = tasks.addTask(s, { title: 'Original title', body: 'oldbodyword' });
  const updated = tasks.updateTask(s, task.id, { version: task.version, body: 'replacementsearchword' });
  assert.equal(updated.version, task.version + 1);
  expectCode(() => tasks.updateTask(s, task.id, { version: task.version, title: 'stale overwrite' }), 4);
  const matches = query => s.all("SELECT d.entity_id FROM search JOIN documents d ON d.id=search.rowid WHERE search MATCH ? AND d.type='task'", query);
  assert.equal(matches('oldbodyword').length, 0);
  assert.equal(matches('replacementsearchword')[0].entity_id, task.id);
  assert.throws(() => s.run('DELETE FROM events WHERE workspace_id=1'), /append-only/);
  assert.throws(() => s.run("UPDATE events SET action='changed' WHERE workspace_id=1"), /append-only/);
  const history = tasks.showTask(s, task.id).history;
  assert.equal(history[0].detail.before.body, 'oldbodyword');
  assert.equal(history[0].detail.after.body, 'replacementsearchword');
  assert.equal(history.length, 2);
});

test('Human answer resolves only its question blocker, retains audit, and notifies owner', t => {
  const { s } = fixture(t), task = tasks.addTask(s, { title: 'Configure shipping', priority: 7 });
  tasks.takeTask(s, task.id);
  const external = tasks.blockTask(s, task.id, { kind: 'external', waitingOn: 'delivery vendor', body: 'Waiting for vendor contract' });
  const question = tasks.askHuman(s, task.id, { question: 'Which region?', options: ['North', 'South'], recommendation: 'North', command: 'echo inert metadata' });
  assert.equal(tasks.listBlockers(s, { task: task.id }).length, 2);
  expectCode(() => tasks.answerQuestion(s, question.id, '1'), 3);
  expectCode(() => tasks.resolveBlocker(s, question.blocker_id, 'Pretend answered'), 4);
  const queue = tasks.humanQueue(s); assert.equal(queue[0].question, 'Which region?'); assert.equal(queue[0].command, 'echo inert metadata');
  as(s, 'human', () => assert.equal(tasks.answerQuestion(s, task.id, '2').answer, '2: South'));
  assert.equal(tasks.showTask(s, task.id).status, 'blocked');
  assert.deepEqual(tasks.listBlockers(s, { task: task.id }).map(b => b.id), [external.id]);
  const receipt = s.get("SELECT r.state,m.body FROM receipts r JOIN messages m ON m.id=r.message_id WHERE r.recipient='a' ORDER BY m.id DESC LIMIT 1");
  assert.equal(receipt.state, 'unread'); assert.match(receipt.body, /2: South/);
  assert.equal(s.get("SELECT action FROM events WHERE entity='question' AND entity_id=? ORDER BY id DESC", question.id).action, 'answered');
  as(s, 'human', () => expectCode(() => tasks.answerQuestion(s, question.id, '1'), 4));
  tasks.resolveBlocker(s, external.id, 'Contract received');
  assert.equal(tasks.showTask(s, task.id).status, 'doing');
  assert.equal(tasks.doneTask(s, task.id).status, 'done');
});

test('ambiguous task answers require an explicit question id and invalid choices roll back', t => {
  const { s } = fixture(t), task = tasks.addTask(s, { title: 'Several decisions' });
  const first = tasks.askHuman(s, task.id, { question: 'Choice one?', options: ['A', 'B'] });
  const second = tasks.askHuman(s, task.id, { question: 'Choice two?' });
  as(s, 'human', () => {
    expectCode(() => tasks.answerQuestion(s, task.id, 'A'), 4);
    expectCode(() => tasks.answerQuestion(s, first.id, '3'), 2);
    assert.equal(s.get('SELECT status FROM questions WHERE id=?', Number(first.id.slice(1))).status, 'pending');
    tasks.answerQuestion(s, first.id, '1');
    tasks.answerQuestion(s, second.id, 'Proceed');
  });
  const row = tasks.showTask(s, task.id);
  assert.equal(row.status, 'open'); assert.equal(row.owner, null); assert.equal(row.questions.length, 2);
});

test('review gate enforces independent approval, rejection explanation and edits invalidate approval', t => {
  const { s } = fixture(t), task = tasks.addTask(s, { title: 'Critical change', reviewRequired: true });
  tasks.takeTask(s, task.id);
  expectCode(() => tasks.doneTask(s, task.id), 4);
  expectCode(() => tasks.updateTask(s, task.id, { version: tasks.showTask(s, task.id).version, reviewRequired: false }), 3);
  tasks.submitTask(s, task.id, 'Tests pass');
  expectCode(() => tasks.reviewTask(s, task.id, { approve: true, note: 'Self-review' }), 3);
  as(s, 'b', () => tasks.reviewTask(s, task.id, { approve: false, note: 'Fix race' }));
  assert.equal(tasks.showTask(s, task.id).status, 'doing');
  assert.equal(tasks.showTask(s, task.id).review_note, 'Fix race');
  tasks.submitTask(s, task.id, 'Race fixed');
  as(s, 'c', () => tasks.reviewTask(s, task.id, { approve: true, note: 'Verified' }));
  const reviewed = tasks.showTask(s, task.id);
  tasks.updateTask(s, task.id, { version: reviewed.version, body: 'new scope' });
  expectCode(() => tasks.doneTask(s, task.id), 4);
  as(s, 'c', () => tasks.reviewTask(s, task.id, { approve: true, note: 'New scope checked' }));
  assert.equal(tasks.doneTask(s, task.id, { ref: 'repo#42' }).status, 'done');
  assert.ok(tasks.showTask(s, task.id).history.some(e => e.action === 'review-rejected' && e.detail.note === 'Fix race'));
});

test('dependencies reject cycles, show root causes, clear on completion and block completion', t => {
  const { s } = fixture(t);
  const root = tasks.addTask(s, { title: 'Root dependency' }), middle = tasks.addTask(s, { title: 'Middle dependency' }), end = tasks.addTask(s, { title: 'Final delivery' });
  tasks.addDependency(s, middle.id, root.id); tasks.addDependency(s, end.id, middle.id);
  expectCode(() => tasks.addDependency(s, root.id, end.id), 4);
  expectCode(() => tasks.addDependency(s, root.id, root.id), 4);
  expectCode(() => tasks.takeTask(s, middle.id), 4);
  const chain = tasks.listBlockers(s, { chain: end.id });
  assert.ok(chain.some(b => b.waiting_on === root.id && b.root));
  assert.ok(chain.some(b => b.waiting_on === middle.id && !b.root));
  assert.ok(tasks.listBlockers(s).some(b => b.kind === 'dependency'));
  tasks.takeTask(s, root.id); tasks.doneTask(s, root.id);
  assert.equal(tasks.listBlockers(s, { task: middle.id }).length, 0);
  tasks.takeTask(s, middle.id); tasks.doneTask(s, middle.id);
  assert.deepEqual(tasks.listBlockers(s, { chain: end.id }), []);
  tasks.takeTask(s, end.id);
  const late = tasks.addTask(s, { title: 'Late dependency' }); tasks.addDependency(s, end.id, late.id);
  expectCode(() => tasks.doneTask(s, end.id), 4);
  tasks.removeDependency(s, end.id, late.id);
  assert.equal(tasks.doneTask(s, end.id).status, 'done');
});

test('handoff records summary, notifies successor and prevents former owner writes', t => {
  const { s } = fixture(t), task = tasks.addTask(s, { title: 'Handoff workflow' });
  tasks.takeTask(s, task.id);
  const handed = tasks.handoffTask(s, task.id, 'c', 'Branch feature-x; tests pass; next review');
  assert.equal(handed.owner, 'c'); assert.equal(handed.status, 'open'); assert.equal(handed.lease_until, null);
  expectCode(() => tasks.noteTask(s, task.id, 'Former owner write'), 3);
  as(s, 'c', () => {
    tasks.takeTask(s, task.id); tasks.noteTask(s, task.id, 'Recovered without transcript');
    tasks.releaseTask(s, task.id, 'Paused');
  });
  const released = tasks.showTask(s, task.id); assert.equal(released.owner, null); assert.equal(released.for_role, 'c');
  assert.equal(s.get("SELECT state FROM receipts WHERE recipient='c'").state, 'unread');
});

test('workspace isolation prevents cross-workspace task, dependency, question and blocker access', t => {
  const { s } = fixture(t), first = tasks.addTask(s, { title: 'Workspace one' });
  const question = tasks.askHuman(s, first.id, { question: 'Approve?' });
  s.run('INSERT INTO workspaces(name,created_at) VALUES(?,?)', 'other', new Date().toISOString());
  s.run("INSERT INTO roles(workspace_id,name,kind) VALUES(2,'a','agent'),(2,'human','human')"); s.use('other');
  const second = tasks.addTask(s, { title: 'Workspace two' });
  expectCode(() => tasks.showTask(s, first.id), 3); expectCode(() => tasks.addDependency(s, second.id, first.id), 3);
  expectCode(() => tasks.resolveBlocker(s, question.blocker_id, 'not ours'), 3);
  as(s, 'human', () => expectCode(() => tasks.answerQuestion(s, question.id, 'yes'), 3));
  assert.deepEqual(tasks.listTasks(s).map(r => r.id), [second.id]);
});

test('invalid secret input rolls back all related records and search documents', t => {
  const { s } = fixture(t), task = tasks.addTask(s, { title: 'No credentials' });
  const before = Object.fromEntries(['tasks','blockers','questions','messages','events','documents'].map(table => [table, count(s, table)]));
  const secret = 'sk-' + 'q'.repeat(30);
  expectCode(() => tasks.askHuman(s, task.id, { question: 'Use key?', command: `tool --key ${secret}` }), 2);
  expectCode(() => tasks.noteTask(s, task.id, secret), 2);
  for (const [table, n] of Object.entries(before)) assert.equal(count(s, table), n, table);
  assert.equal(tasks.showTask(s, task.id).status, 'open');
});

test('persisted state survives fresh database handles and paging keeps priority order', t => {
  const { s, path } = fixture(t);
  const low = tasks.addTask(s, { title: 'Low', priority: 1 }), high = tasks.addTask(s, { title: 'High', priority: 9 }), medium = tasks.addTask(s, { title: 'Medium', priority: 5 });
  const first = tasks.listTasks(s, { limit: 1 }); assert.equal(first[0].id, high.id);
  const next = tasks.listTasks(s, { after: first[0].id, limit: 1 }); assert.equal(next[0].id, medium.id);
  assert.equal(tasks.listTasks(s, { after: next[0].id })[0].id, low.id);
  tasks.takeTask(s, high.id); tasks.noteTask(s, high.id, 'Continue from recorded branch');
  const fresh = new Store(path, 'a'); fresh.use('work');
  try {
    assert.equal(tasks.showTask(fresh, high.id).owner, 'a');
    assert.ok(tasks.showTask(fresh, high.id).history.some(e => e.detail.note === 'Continue from recorded branch'));
    tasks.dropTask(fresh, high.id, 'Superseded');
    assert.equal(tasks.listTasks(fresh, { status: 'dropped' })[0].id, high.id);
    assert.equal(tasks.reopenTask(fresh, high.id, 'Needed again').status, 'open');
  } finally { fresh.close(); }
});


test('stop blocks new claims atomically while existing work can be saved, renewed and completed', t => {
  const { s } = fixture(t);
  const current = tasks.addTask(s, { title: 'Already running' });
  const pending = tasks.addTask(s, { title: 'Next task' });
  const other = tasks.addTask(s, { title: 'Other role next task' });
  tasks.takeTask(s, current.id);
  as(s, 'human', () => requestStop(s, ['a']));
  const before = tasks.showTask(s, pending.id);
  expectCode(() => tasks.takeTask(s, pending.id), 4);
  const after = tasks.showTask(s, pending.id);
  assert.equal(after.status, 'open'); assert.equal(after.owner, null);
  assert.equal(after.version, before.version); assert.equal(after.history.length, before.history.length);
  tasks.noteTask(s, current.id, 'Saved reboot-safe progress');
  tasks.renewTask(s, current.id);
  assert.equal(tasks.doneTask(s, current.id).status, 'done');
  as(s, 'b', () => assert.equal(tasks.takeTask(s, other.id).owner, 'b'));
  as(s, 'human', () => resumeWork(s, ['a']));
  assert.equal(tasks.takeTask(s, pending.id).status, 'doing');
});

test('stop still permits release and handoff, and applies to the original workspace only', t => {
  const { s } = fixture(t);
  const release = tasks.addTask(s, { title: 'Release me' });
  const handoff = tasks.addTask(s, { title: 'Hand off me' });
  tasks.takeTask(s, release.id); tasks.takeTask(s, handoff.id);
  as(s, 'human', () => requestStop(s, ['a']));
  assert.equal(tasks.releaseTask(s, release.id, 'Stopped safely').status, 'open');
  assert.equal(tasks.handoffTask(s, handoff.id, 'b', 'Branch saved; continue later').owner, 'b');
  expectCode(() => tasks.takeTask(s, release.id), 4);
  s.run('INSERT INTO workspaces(name,created_at) VALUES(?,?)', 'separate', new Date().toISOString());
  s.run("INSERT INTO roles(workspace_id,name,kind) VALUES(2,'a','agent'),(2,'human','human')");
  s.use('separate');
  const independent = tasks.addTask(s, { title: 'Other workspace claim' });
  assert.equal(tasks.takeTask(s, independent.id).status, 'doing');
});

test('task pages expose continuation accurately with priority ties, filters and final empty pages', t => {
  const { s } = fixture(t);
  const low = tasks.addTask(s, { title: 'Low assigned', owner: 'a', priority: 1 });
  tasks.addTask(s, { title: 'Other owner', owner: 'b', priority: 100 });
  const firstHigh = tasks.addTask(s, { title: 'First high', owner: 'a', priority: 9 });
  const secondHigh = tasks.addTask(s, { title: 'Second high', owner: 'a', priority: 9 });
  const middle = tasks.addTask(s, { title: 'Middle assigned', owner: 'a', priority: 5 });
  const first = tasks.listTaskPage(s, { owner: 'a', limit: 2 });
  assert.deepEqual(first.items.map(row => row.id), [firstHigh.id, secondHigh.id]);
  assert.equal(first.has_more, true); assert.equal(first.next_after, secondHigh.id);
  const last = tasks.listTaskPage(s, { owner: 'a', limit: 2, after: first.next_after });
  assert.deepEqual(last.items.map(row => row.id), [middle.id, low.id]);
  assert.equal(last.has_more, false); assert.equal(last.next_after, null);
  assert.deepEqual(tasks.listTaskPage(s, { owner: 'a', after: low.id }), { items: [], has_more: false, next_after: null });
  assert.deepEqual(tasks.listTaskPage(s, { status: 'done' }), { items: [], has_more: false, next_after: null });
  assert.deepEqual(tasks.listTasks(s, { owner: 'a', limit: 2 }), first.items);
  expectCode(() => tasks.listTaskPage(s, { limit: 0 }), 2);
});

function importedTask(s, options) {
  const task = as(s, 'human', () => tasks.addTask(s, options));
  as(s, 'human', () => s.tx(() => s.event('task', task.id, 'imported', { source: 'fixture-backlog.md', line: 1 })));
  return task;
}

test('unclaimed imported work is reconcilable by its owner or a human, without opening a generic completion bypass', t => {
  const { s } = fixture(t);
  const assigned = importedTask(s, { title: 'Imported completed work', owner: 'a' });
  as(s, 'b', () => expectCode(() => tasks.doneTask(s, assigned.id), 3));
  assert.equal(tasks.doneTask(s, assigned.id, { ref: 'already merged repo#42' }).status, 'done');
  assert.equal(tasks.showTask(s, assigned.id).history.some(e => e.action === 'claimed'), false);
  const unowned = importedTask(s, { title: 'Unowned imported work' });
  expectCode(() => tasks.doneTask(s, unowned.id), 3);
  as(s, 'human', () => assert.equal(tasks.doneTask(s, unowned.id).status, 'done'));
  const humanOnly = tasks.addTask(s, { title: 'Human completed action', humanOnly: true });
  expectCode(() => tasks.doneTask(s, humanOnly.id), 3);
  as(s, 'human', () => assert.equal(tasks.doneTask(s, humanOnly.id).status, 'done'));
  const ordinary = tasks.addTask(s, { title: 'Ordinary agent work', owner: 'a' });
  expectCode(() => tasks.doneTask(s, ordinary.id), 4);
  as(s, 'human', () => expectCode(() => tasks.doneTask(s, ordinary.id), 4));
});

test('imported completion still respects blockers, dependencies, human-only classification and required review', t => {
  const { s } = fixture(t);
  const blocked = importedTask(s, { title: 'Blocked import', owner: 'a' });
  tasks.blockTask(s, blocked.id, { kind: 'external', waitingOn: 'vendor', body: 'Still pending' });
  expectCode(() => tasks.doneTask(s, blocked.id), 4);
  const dependency = tasks.addTask(s, { title: 'Prerequisite', owner: 'a' });
  const dependent = importedTask(s, { title: 'Dependent import', owner: 'a' });
  tasks.addDependency(s, dependent.id, dependency.id);
  expectCode(() => tasks.doneTask(s, dependent.id), 4);
  as(s, 'human', () => expectCode(() => tasks.doneTask(s, dependent.id), 4));
  const gated = importedTask(s, { title: 'Review-gated import', owner: 'a', reviewRequired: true });
  expectCode(() => tasks.doneTask(s, gated.id), 4);
  as(s, 'human', () => expectCode(() => tasks.doneTask(s, gated.id), 4));
  const humanOnly = importedTask(s, { title: 'Human-only import', humanOnly: true });
  expectCode(() => tasks.doneTask(s, humanOnly.id), 3);
  assert.equal(tasks.showTask(s, dependent.id).status, 'open');
  assert.equal(tasks.showTask(s, gated.id).status, 'open');
});

test('explicit answer closure completes unclaimed work atomically while plain answer preserves it', t => {
  const { s } = fixture(t);
  const task = tasks.addTask(s, { title: 'A decision is all that remains', owner: 'a' });
  const question = tasks.askHuman(s, task.id, { question: 'Close this item?', options: ['Yes', 'No'] });
  expectCode(() => tasks.answerQuestion(s, question.id, '1', { close: true }), 3);
  const answered = as(s, 'human', () => tasks.answerQuestion(s, question.id, '1', { close: true }));
  assert.equal(answered.status, 'answered'); assert.equal(answered.task_status, 'done');
  const completed = tasks.showTask(s, task.id);
  assert.equal(completed.status, 'done'); assert.equal(completed.lease_until, null);
  assert.equal(completed.history.some(e => e.action === 'claimed'), false);
  assert.ok(completed.history.some(e => e.action === 'completed' && e.detail.ref === question.id));
  assert.equal(s.get("SELECT m.body FROM messages m JOIN receipts r ON r.message_id=m.id WHERE r.recipient='a' ORDER BY m.id DESC LIMIT 1").body.endsWith('Task closed.'), true);
  const normal = tasks.addTask(s, { title: 'Answer without closing', owner: 'a' });
  const nextQuestion = tasks.askHuman(s, normal.id, { question: 'What next?' });
  const plain = as(s, 'human', () => tasks.answerQuestion(s, nextQuestion.id, 'Continue'));
  assert.equal(plain.task_status, undefined); assert.equal(tasks.showTask(s, normal.id).status, 'open');
  const humanTask = tasks.addTask(s, { title: 'Human decision action', humanOnly: true });
  const humanQuestion = tasks.askHuman(s, humanTask.id, { question: 'Action finished?' });
  as(s, 'human', () => tasks.answerQuestion(s, humanQuestion.id, 'Finished', { close: true }));
  assert.equal(tasks.showTask(s, humanTask.id).status, 'done');
});

test('answer --close rolls back answer, resolution, history, search and mail when other requirements remain', t => {
  const { s } = fixture(t);
  for (const requirement of ['blocker', 'dependency', 'review']) {
    const task = tasks.addTask(s, { title: `Pending ${requirement}`, owner: 'a', reviewRequired: requirement === 'review' });
    if (requirement === 'blocker') tasks.blockTask(s, task.id, { kind: 'external', waitingOn: 'supplier', body: 'Await shipment' });
    if (requirement === 'dependency') {
      const dependency = tasks.addTask(s, { title: 'Unfinished prerequisite', owner: 'a' });
      tasks.addDependency(s, task.id, dependency.id);
    }
    const question = tasks.askHuman(s, task.id, { question: `Resolve ${requirement} decision?` });
    const beforeTask = tasks.showTask(s, task.id);
    const beforeCounts = Object.fromEntries(['events','messages','receipts','documents'].map(table => [table, count(s, table)]));
    as(s, 'human', () => expectCode(() => tasks.answerQuestion(s, question.id, 'Answer alone is insufficient', { close: true }), 4));
    const afterTask = tasks.showTask(s, task.id);
    assert.equal(afterTask.status, 'blocked'); assert.equal(afterTask.version, beforeTask.version);
    const unchanged = afterTask.questions.find(q => q.id === question.id);
    assert.equal(unchanged.status, 'pending'); assert.equal(unchanged.answer, null);
    assert.ok(afterTask.blockers.some(b => b.id === question.blocker_id));
    assert.equal(s.get("SELECT status FROM documents WHERE type='question' AND entity_id=?", question.id).status, 'pending');
    for (const [table, n] of Object.entries(beforeCounts)) assert.equal(count(s, table), n, `${requirement}: ${table}`);
  }
});
