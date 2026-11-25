import { fixtureConfig } from './fixtures/team.mjs';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { addTask, takeTask, noteTask, blockTask } from '../dist/tasks.js';
import { idleReason } from '../dist/wake.js';
import { timeTable, formatTimeTable, causeOf } from '../dist/stats-time.js';

process.env.TZ = 'UTC';
const MIN = 60_000;

function fixture(t) {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-22T10:00:00Z') });
  t.after(() => mock.timers.reset());
  const dir = mkdtempSync(join(tmpdir(), 'sassato-time-')), path = join(dir, 'state.db');
  const s = new Store(path, 'human', { create: true }); initWorkspace(s, 'team', fixtureConfig); s.use('team');
  t.after(() => { if (s.db.isOpen) s.close(); rmSync(dir, { recursive: true, force: true }); });
  const as = (role, fn) => { const before = s.actor; s.actor = role; try { return fn(); } finally { s.actor = before; } };
  const at = (hhmm) => mock.timers.tick(Date.parse(`2026-11-22T${hhmm}:00Z`) - Date.now());
  const event = (role, entity, id, action, detail) => as(role, () => s.tx(() => s.event(entity, id, action, detail)));
  return { s, dir, path, as, at, event };
}

test("a role's day sums to the day: working per held task, waiting per what for, not running; its nudges", (t) => {
  const f = fixture(t);
  const task = f.as('b', () => takeTask(f.s, f.as('a', () => addTask(f.s, { title: 'Held', forRole: 'b' })).id));
  f.at('10:15'); f.event('b', 'waiter', 'b', 'armed', { waiting_for: `${task.id} on fable`, expect_minutes: null });
  f.event('b', 'checkpoint', 'b', 'saved', {});
  f.at('11:00'); f.event('b', 'waiter', 'b', 'ended', { reason: 'mail' });
  f.as('b', () => noteTask(f.s, task.id, 'more'));
  f.at('11:30'); f.event('b', 'nudge', 'b', 'sent', { minutes: 15, count: 1 });
  f.at('11:35'); f.as('b', () => idleReason(f.s, 'waiting for a review'));
  f.at('11:40'); f.event('b', 'waiter', 'b', 'armed', { waiting_for: null });
  const day = timeTable(f.s, { day: '2026-11-22', role: 'b', now: new Date('2026-11-22T12:00:00Z') });
  const b = day.roles[0];
  assert.equal(b.working_minutes + b.waiting_minutes + b.not_running_minutes, 12 * 60, 'the minutes sum to the part of the day gone');
  assert.equal(b.working_minutes, 30, 'two writes, fifteen minutes each; the checkpoint and the idle reason are not work');
  assert.deepEqual(b.working, [{ what: task.id, minutes: 30 }]);
  assert.deepEqual(b.waiting, [{ what: 'nothing named', minutes: 45 }, { what: 'waiting for a review', minutes: 20 }],
    'an old waiter that named a block with no blocker row names nothing; one with no text takes the idle reason given since the waiter before; a waiter never ended runs to now');
  assert.deepEqual(b.waiting_by_cause, [{ what: 'nothing named', minutes: 45 }, { what: 'review', minutes: 20 }]);
  assert.equal(b.not_running_minutes, 720 - 95);
  assert.deepEqual(b.nudges, { sent: 1, answered: 1, escalated: 0, reasons: ['waiting for a review'] });
  const text = formatTimeTable(day);
  assert.match(text, /b: working 30m · waiting 1h05 · not running 10h25/);
  assert.match(text, /waiting by cause: nothing named 45m, review 20m/);
  assert.match(text, /nudges: 1 sent, 1 answered, 0 escalated; reasons: "waiting for a review"/);
  assert.match(text, /Working means a write of the role's own in the 15 minutes before/);
});

test('only whole minutes count; a repeat claim keeps its start and another role\'s claim ends the hold; a nudge answered after midnight counts', (t) => {
  const f = fixture(t);
  const id = f.as('a', () => addTask(f.s, { title: 'Shared', forRole: 'b' })).id;
  f.as('b', () => takeTask(f.s, id));
  f.at('10:20'); f.event('a', 'task', id, 'claimed', {});
  f.at('10:40'); f.event('b', 'fact', 'k', 'set', {});
  f.at('23:59'); f.event('b', 'nudge', 'b', 'sent', { minutes: 15, count: 1 });
  const day = timeTable(f.s, { day: '2026-11-22', role: 'b', now: new Date('2026-11-23T00:01:00Z') });
  const b = day.roles[0];
  assert.equal(b.working_minutes + b.waiting_minutes + b.not_running_minutes, 1440);
  assert.deepEqual(b.working, [{ what: id, minutes: 15 }, { what: 'no task', minutes: 15 }], "after a's claim, b's write is not on the task");
  assert.equal(b.nudges.answered, 0);
  mock.timers.tick(2 * 60_000); f.as('b', () => idleReason(f.s, 'night'));
  assert.equal(timeTable(f.s, { day: '2026-11-22', role: 'b', now: new Date('2026-11-23T00:05:00Z') }).roles[0].nudges.answered, 1);
  const partial = timeTable(f.s, { day: '2026-11-22', role: 'b', now: new Date('2026-11-22T12:00:30Z') }).roles[0];
  assert.equal(partial.working_minutes + partial.waiting_minutes + partial.not_running_minutes, 720, 'a part minute is not counted');
});

test('working wins over a waiter in the background; a session end closes a waiter that never ended', (t) => {
  const f = fixture(t);
  f.event('c', 'waiter', 'c', 'armed', { waiting_for: 'CI on #70' });
  f.at('10:05'); f.event('c', 'fact', 'k', 'set', {});
  f.at('10:30'); f.event('c', 'session', 'S1', 'ended', { role: 'c' });
  const c = timeTable(f.s, { day: '2026-11-22', role: 'c', now: new Date('2026-11-22T11:00:00Z') }).roles[0];
  assert.equal(c.working_minutes, 15);
  assert.deepEqual(c.working, [{ what: 'no task', minutes: 15 }]);
  assert.deepEqual(c.waiting, [{ what: 'CI on #70', minutes: 15 }], '10:00-10:05 and 10:20-10:30');
  assert.equal(c.not_running_minutes, 11 * 60 - 30);
});

test('the CLI takes --day, refuses a bad day and --day with --since, and lists every agent role', (t) => {
  const f = fixture(t);
  f.s.close();
  const cli = (...args) => spawnSync(process.execPath, [resolve('bin/sassato.js'), 'stats', ...args, '--db', f.path, '--as', 'human', '--workspace', 'team'], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } });
  const out = cli('--day', '2026-11-21');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^Time on 2026-11-21/);
  assert.match(out.stdout, /\na: working 0m · waiting 0m · not running 24h00/);
  assert.equal(cli('--day', '22 Nov').status, 2);
  assert.match(cli('--day', '2026-02-30').stderr, /Use --day with a date/, 'a date that does not exist is refused, not moved');
  assert.match(cli('--day', '2099-01-01').stderr, /has not begun/);
  assert.match(cli('--day', '2026-11-21', '--since', '2026-11-20').stderr, /--day or --since/);
});

test('a mail sent about a task counts under that task even when the role holds none (Fable M4156)', (t) => {
  const f = fixture(t);
  f.at('10:00'); f.event('b', 'message', 'M1', 'sent', { recipients: ['a'], task: 'T42' });
  f.at('10:30'); f.event('b', 'message', 'M2', 'sent', { recipients: ['a'], task: null });
  f.at('11:00'); f.event('b', 'message', 'M3', 'sent', { recipients: ['johan'], task_id: 'T43' });
  const b = timeTable(f.s, { day: '2026-11-22', role: 'b', now: new Date('2026-11-22T12:00:00Z') }).roles[0];
  assert.deepEqual(b.working, [{ what: 'T42', minutes: 15 }, { what: 'no task', minutes: 15 }, { what: 'T43', minutes: 15 }]);
});

test('an old waiter counts only blocks open when it armed and not parked; a new one is taken as stored; causes (T1534)', (t) => {
  const f = fixture(t);
  const reviewed = f.as('b', () => takeTask(f.s, addTask(f.s, { title: 'Reviewed' }).id));
  const parked = f.as('b', () => takeTask(f.s, addTask(f.s, { title: 'Parked' }).id));
  const asked = f.as('b', () => takeTask(f.s, addTask(f.s, { title: 'Asked' }).id));
  f.as('b', () => blockTask(f.s, reviewed.id, { kind: 'agent', waitingOn: 'a', body: 'review' }));
  f.as('b', () => blockTask(f.s, parked.id, { kind: 'other', waitingOn: 'lead', body: 'parked' }));
  f.at('10:10'); f.event('b', 'waiter', 'b', 'armed', { waiting_for: `${reviewed.id} on a, ${parked.id} on lead` });
  f.at('10:40'); f.event('b', 'waiter', 'b', 'ended', { reason: 'mail' });
  f.as('b', () => blockTask(f.s, asked.id, { kind: 'human', waitingOn: 'human', body: 'which?' }));
  f.at('10:45'); f.event('b', 'waiter', 'b', 'armed', { waiting_for: `${asked.id} on human` });
  f.at('11:00'); f.event('b', 'waiter', 'b', 'armed', { waiting_for: 'a gate job', waiting_source: 'job' });
  f.at('11:20'); f.event('b', 'waiter', 'b', 'armed', { waiting_for: 'merge lock held by a', waiting_source: 'idle-reason' });
  const b = timeTable(f.s, { day: '2026-11-22', role: 'b', now: new Date('2026-11-22T11:30:00Z') }).roles[0];
  // The blocks are b's own writes (10:00, 10:40), so working takes 10:10-10:15 and 10:45-10:55 from the waits.
  assert.deepEqual(b.waiting, [{ what: 'on a', minutes: 25 }, { what: 'a gate job', minutes: 20 }, { what: 'merge lock held by a', minutes: 10 }, { what: 'on human', minutes: 5 }]);
  assert.deepEqual(b.waiting_by_cause, [{ what: 'another role', minutes: 25 }, { what: 'gate', minutes: 20 }, { what: 'merge lock', minutes: 10 }, { what: 'a human', minutes: 5 }]);
});

test('causeOf reads a wait\'s words in order: merge lock, CI, gate, merge, review, a human', () => {
  assert.equal(causeOf('waiting on the merge lock'), 'merge lock');
  assert.equal(causeOf("CI's full check on #1409"), 'CI');
  assert.equal(causeOf('gate exit pending, then merge-green'), 'gate');
  assert.equal(causeOf('merge-green running for #12'), 'merge lock');
  assert.equal(causeOf("waiting for Fable's verdict"), 'review');
  assert.equal(causeOf('H222 waits on Johan', ['johan']), 'a human');
  assert.equal(causeOf('reading the logs'), undefined);
});
