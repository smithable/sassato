import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { send, inbox } from '../dist/coordination.js';
import { addTask, noteTask } from '../dist/tasks.js';
import { requestStop } from '../dist/control.js';
import { getNotificationProgress, saveNotificationProgress } from '../dist/notification-progress.js';
import { setWorkspaceSettings } from '../dist/workspace-settings.js';
import { wake, wakeText } from '../dist/wake.js';
import { fixtureConfig } from './fixtures/team.mjs';

// T977: sas wake, one call per wake.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sassato-wake-')), path = join(dir, 'state.db');
  const s = new Store(path, 'human', { create: true }); initWorkspace(s, 'team', fixtureConfig); s.use('team');
  const b = new Store(path, 'b'); b.use('team');
  t.after(() => { b.close(); s.close(); rmSync(dir, { recursive: true, force: true }); });
  const latest = () => Number(s.get('SELECT coalesce(max(id),0) n FROM events WHERE workspace_id=?', s.ws).n);
  saveNotificationProgress(b, { cursor: latest(), expected_version: 0 });
  return { s, b, dir, stopFile: join(dir, 'stop'), latest };
}
const as = (s, actor, fn) => { const old = s.actor; s.actor = actor; try { return fn(); } finally { s.actor = old; } };
const quick = (f, more = {}) => wake(f.b, { stopFile: f.stopFile, timeout: 3, settle: 1, settleMax: 2, ...more });

test('a wake prints each entry in full, saves the cursor and ends with the re-arm command', async t => {
  const f = fixture(t);
  const long = 'Please merge PR 42.\nSecond line with detail.';
  const m = as(f.s, 'a', () => send(f.s, ['b'], long, { urgent: true }));
  const out = await quick(f);
  assert.equal(out.saved, true);
  assert.match(out.text, new RegExp(`${m.id} · from a · urgent`));
  assert.match(out.text, /Please merge PR 42\.\n {4}Second line with detail\./);
  assert.match(out.text, new RegExp(`sassato wake --since ${out.result.cursor} --as b --workspace team --ack ${m.id}`));
  assert.equal(getNotificationProgress(f.b).cursor, out.result.cursor);
});

test('--ack acknowledges before waiting, and a quiet wake is one line', async t => {
  const f = fixture(t);
  const m = as(f.s, 'a', () => send(f.s, ['b'], 'Urgent once', { urgent: true }));
  const first = await quick(f);
  const second = await quick(f, { ack: [m.id], timeout: 1 });
  assert.deepEqual(second.acknowledged, [m.id]);
  assert.equal(second.text.split('\n').length, 2);
  assert.match(second.text, /^Acknowledged M\d+\.\nNothing new for b · cursor \d+ saved · re-arm: sassato wake --since \d+ --as b --workspace team$/);
  assert.ok(second.result.cursor >= first.result.cursor);
});

test('a task entry carries its state, brief and latest note, and long text is cut with a marked tail', async t => {
  const f = fixture(t);
  const task = as(f.s, 'a', () => addTask(f.s, { title: 'Fix the gate', forRole: 'b', body: 'Brief: the gate fails on X.' }));
  as(f.s, 'a', () => noteTask(f.s, task.id, 'Started on it, then handed over.'));
  const out = await quick(f);
  assert.match(out.text, new RegExp(`${task.id} "Fix the gate" · open · owner - · for b · version \\d+`));
  assert.match(out.text, /Brief: the gate fails on X\./);
  assert.match(out.text, /Latest note \(a\): Started on it, then handed over\./);
  assert.equal(out.text.split(`  ${task.id} · from`).length, 2, 'a task woken twice prints once');
  assert.match(wakeText('x'.repeat(20), 'M9', 10), /^x{10}… \[cut at 10 characters; read it all: sassato show M9\]$/);
});

test('the cursor is not saved when progress moved during the wait', async t => {
  const f = fixture(t);
  const other = new Store(join(f.dir, 'state.db'), 'b'); other.use('team'); t.after(() => other.close());
  const timer = setTimeout(() => { as(f.s, 'a', () => send(f.s, ['human'], 'bump')); const p = getNotificationProgress(other); saveNotificationProgress(other, { cursor: f.latest(), expected_version: p.version }); }, 200);
  t.after(() => clearTimeout(timer));
  const before = getNotificationProgress(f.b).version;
  const out = await quick(f, { timeout: 1 });
  assert.equal(out.saved, false);
  assert.match(out.text, /NOT saved/);
  assert.ok(getNotificationProgress(f.b).version > before);
});

test('a stop is reported, nothing is saved, and no re-arm is offered', async t => {
  const f = fixture(t);
  const before = getNotificationProgress(f.b);
  writeFileSync(f.stopFile, '');
  const out = await quick(f);
  assert.equal(out.saved, false);
  assert.match(out.text, /^STOP: the stop file .* exists\..*do not re-arm\./);
  assert.doesNotMatch(out.text, /sassato wake --since/);
  assert.equal(getNotificationProgress(f.b).version, before.version);
  rmSync(f.stopFile);
  as(f.s, 'human', () => requestStop(f.s, ['b'], {}));
  const stopped = await quick(f);
  assert.match(stopped.text, /STOP R\d+ for b\..*sassato stopped R\d+ --as b --workspace team/);
});

test('digest_skip leaves out the kinds a role never acts on', async t => {
  const f = fixture(t);
  as(f.s, 'human', () => setWorkspaceSettings(f.s, { digest_skip: { b: ['mail'] } }));
  assert.throws(() => as(f.s, 'human', () => setWorkspaceSettings(f.s, { digest_skip: { b: ['urgent'] } })), /must list kinds among/);
  as(f.s, 'a', () => send(f.s, ['b'], 'Ordinary mail only'));
  const quiet = await quick(f, { timeout: 1 });
  assert.match(quiet.text, /^Nothing new for b/);
  as(f.s, 'a', () => send(f.s, ['b'], 'Urgent still wakes', { urgent: true }));
  const woken = await quick(f);
  assert.match(woken.text, /Urgent still wakes/);
});

test('inbox lists newest first', t => {
  const f = fixture(t);
  const first = as(f.s, 'a', () => send(f.s, ['b'], 'older'));
  const second = as(f.s, 'a', () => send(f.s, ['b'], 'newer'));
  const rows = inbox(f.b, { peek: true, state: 'unread' });
  assert.deepEqual(rows.map(r => r.id), [second.id, first.id]);
});
