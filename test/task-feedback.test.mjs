import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage.js';
import * as tasks from '../dist/tasks.js';

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sassato-task-feedback-'));
  const s = new Store(join(directory, 'state.db'), 'author', { create: true });
  s.run('INSERT INTO workspaces(name,created_at) VALUES(?,?)', 'work', new Date().toISOString());
  for (const [name, kind] of [['author', 'agent'], ['target', 'agent'], ['other', 'agent'], ['human', 'human']]) {
    s.run('INSERT INTO roles(workspace_id,name,kind) VALUES(1,?,?)', name, kind);
  }
  s.use('work');
  t.after(() => { s.close(); rmSync(directory, { recursive: true, force: true }); });
  return s;
}
function as(s, actor, fn) {
  const previous = s.actor; s.actor = actor;
  try { return fn(); } finally { s.actor = previous; }
}
const block = (s, task) => tasks.blockTask(s, task, { kind: 'external', waitingOn: 'fixture', body: 'Wait for fixture' });
const rejects = (fn, code) => assert.throws(fn, error => error.code === code);

test('last resolved blocker restores review across fresh database handles and requires renewed approval', t => {
  const s = setup(t), task = tasks.addTask(s, { title: 'Review resumed', reviewRequired: true });
  tasks.takeTask(s, task.id);
  const submitted = tasks.submitTask(s, task.id, 'Ready');
  as(s, 'other', () => tasks.reviewTask(s, task.id, { approve: true, note: 'Checked', expected_version: submitted.version }));
  const first = block(s, task.id), second = block(s, task.id);
  tasks.resolveBlocker(s, first.id, 'One complete');
  assert.equal(s.task(task.id).status, 'blocked');
  const fresh = new Store(s.path, 'author'); fresh.use('work');
  try {
    tasks.resolveBlocker(fresh, second.id, 'All complete');
    const restored = tasks.showTask(fresh, task.id);
    assert.equal(restored.status, 'review');
    assert.equal(restored.lease_until, null);
    assert.equal(restored.reviewed_by, null);
    rejects(() => tasks.doneTask(fresh, task.id), 4);
    as(fresh, 'other', () => tasks.reviewTask(fresh, task.id, { approve: true, note: 'Rechecked', expected_version: restored.version }));
    assert.equal(tasks.doneTask(fresh, task.id).status, 'done');
  } finally { fresh.close(); }
});

test('resolving a claimed task preserves a valid lease and clears an expired lease', t => {
  const s = setup(t);
  for (const expired of [false, true]) {
    const task = tasks.addTask(s, { title: `Claim expired: ${expired}` });
    const claimed = tasks.takeTask(s, task.id), blocker = block(s, task.id);
    if (expired) s.run('UPDATE tasks SET lease_until=? WHERE id=?', '2000-01-01T00:00:00.000Z', Number(task.id.slice(1)));
    tasks.resolveBlocker(s, blocker.id, 'Ready');
    const restored = tasks.showTask(s, task.id);
    assert.equal(restored.status, expired ? 'open' : 'doing');
    assert.equal(restored.lease_until, expired ? null : claimed.lease_until);
    assert.equal(restored.owner, 'author', 'An expired claim never transfers ownership');
    as(s, 'other', () => rejects(() => tasks.takeTask(s, task.id), 4));
  }
});

test('release, handoff and reopening during a block do not resurrect the former review phase', t => {
  const s = setup(t);
  for (const action of ['release', 'handoff', 'reopen']) {
    const task = tasks.addTask(s, { title: `${action} while blocked` });
    tasks.takeTask(s, task.id); tasks.submitTask(s, task.id, 'Ready');
    const first = block(s, task.id);
    if (action === 'release') tasks.releaseTask(s, task.id, 'Available');
    if (action === 'handoff') tasks.handoffTask(s, task.id, 'target', 'Continue');
    if (action === 'reopen') { tasks.dropTask(s, task.id, 'Cancelled'); tasks.reopenTask(s, task.id, 'Needed'); }
    as(s, 'human', () => {
      const second = block(s, task.id);
      tasks.resolveBlocker(s, first.id, 'First ready'); tasks.resolveBlocker(s, second.id, 'Second ready');
    });
    assert.equal(s.task(task.id).status, 'open'); assert.equal(s.task(task.id).lease_until, null);
  }
});

test('legacy blocked tasks without a transition history only resume a live retained claim', t => {
  const s = setup(t);
  for (const valid of [false, true]) {
    const task = tasks.addTask(s, { title: `Legacy ${valid}`, owner: 'author' });
    s.run("UPDATE tasks SET status='blocked',lease_until=? WHERE id=?", valid ? '2099-01-01T00:00:00.000Z' : '2000-01-01T00:00:00.000Z', Number(task.id.slice(1)));
    const blocker = block(s, task.id);
    tasks.resolveBlocker(s, blocker.id, 'Legacy wait complete');
    assert.equal(s.task(task.id).status, valid ? 'doing' : 'open');
  }
});

test('unowned targets may edit and note work without claiming; ownership still excludes other roles', t => {
  const s = setup(t), task = tasks.addTask(s, { title: 'Directed task', forRole: 'target' });
  as(s, 'other', () => {
    rejects(() => tasks.noteTask(s, task.id, 'Unrelated'), 3);
    rejects(() => tasks.updateTask(s, task.id, { version: task.version, title: 'Unrelated' }), 3);
    rejects(() => tasks.takeTask(s, task.id), 3);
  });
  rejects(() => tasks.takeTask(s, task.id), 3, 'The creator cannot steal directed work');
  as(s, 'target', () => {
    const noted = tasks.noteTask(s, task.id, 'I can handle this');
    const updated = tasks.updateTask(s, task.id, { version: noted.version, title: 'Useful task title' });
    assert.equal(updated.owner, null); assert.equal(updated.status, 'open');
    rejects(() => tasks.updateTask(s, task.id, { version: noted.version, title: 'Stale title' }), 4);
    rejects(() => tasks.doneTask(s, task.id), 4, 'Ordinary work still needs a claim');
    assert.equal(tasks.takeTask(s, task.id).owner, 'target');
  });
  rejects(() => tasks.noteTask(s, task.id, 'Creator no longer owns the edit'), 3);
});

test('unowned imported work can be reconciled by its target or creator without bypassing human or review gates', t => {
  const s = setup(t);
  for (const actor of ['target', 'author']) {
    const task = tasks.addTask(s, { title: 'Imported finished task', forRole: 'target' });
    s.tx(() => s.event('task', task.id, 'imported', { source: 'fixture.md' }));
    as(s, actor, () => assert.equal(tasks.doneTask(s, task.id).status, 'done'));
  }
  const humanOnly = tasks.addTask(s, { title: 'Human decision', humanOnly: true });
  s.tx(() => s.event('task', humanOnly.id, 'imported', { source: 'fixture.md' }));
  rejects(() => tasks.doneTask(s, humanOnly.id), 3);
  const gated = tasks.addTask(s, { title: 'Review required', forRole: 'target', reviewRequired: true });
  s.tx(() => s.event('task', gated.id, 'imported', { source: 'fixture.md' }));
  as(s, 'target', () => rejects(() => tasks.doneTask(s, gated.id), 4));
});

test('unowned target can resolve its task blocker and drop obsolete work', t => {
  const s = setup(t), task = tasks.addTask(s, { title: 'Directed wait', forRole: 'target' });
  const blocker = block(s, task.id);
  as(s, 'target', () => {
    tasks.resolveBlocker(s, blocker.id, 'Ready');
    assert.equal(tasks.dropTask(s, task.id, 'No longer needed').status, 'dropped');
  });
});

test('relayed human answers retain human authority and audit the registered relay', t => {
  const s = setup(t), task = tasks.addTask(s, { title: 'Decision' });
  const question = tasks.askHuman(s, task.id, { question: 'Proceed?' });
  rejects(() => tasks.answerQuestion(s, question.id, 'yes', { relayedBy: 'human' }), 3);
  as(s, 'human', () => {
    rejects(() => tasks.answerQuestion(s, question.id, 'yes', { relayedBy: 'missing' }), 3);
    assert.equal(tasks.showTask(s, task.id).questions[0].status, 'pending');
    const result = tasks.answerQuestion(s, question.id, 'yes', { relayedBy: 'target' });
    assert.equal(result.answered_by, 'human'); assert.equal(result.relayed_by, 'target');
  });
  const answer = s.get("SELECT actor,detail FROM events WHERE entity='question' AND entity_id=? AND action='answered'", question.id);
  assert.equal(answer.actor, 'human');
  assert.equal(JSON.parse(answer.detail).relayed_by, 'target');
  assert.equal(JSON.parse(answer.detail).answered_by, 'human');
  assert.equal(tasks.showTask(s, task.id).questions[0].answered_by, 'human');
});
