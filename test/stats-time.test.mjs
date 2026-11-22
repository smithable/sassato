import { fixtureConfig } from './fixtures/team.mjs';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { addTask, takeTask, noteTask } from '../dist/tasks.js';
import { idleReason } from '../dist/wake.js';
import { timeTable, formatTimeTable } from '../dist/stats-time.js';

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
  assert.deepEqual(b.waiting, [{ what: 'on fable', minutes: 45 }, { what: 'nothing named', minutes: 20 }], 'a waiter never ended runs to now');
  assert.equal(b.not_running_minutes, 720 - 95);
  assert.deepEqual(b.nudges, { sent: 1, answered: 1, escalated: 0, reasons: ['waiting for a review'] });
  const text = formatTimeTable(day);
  assert.match(text, /b: working 30m · waiting 1h05 · not running 10h25/);
  assert.match(text, /nudges: 1 sent, 1 answered, 0 escalated; reasons: "waiting for a review"/);
  assert.match(text, /Working means a write of the role's own in the 15 minutes before/);
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
  assert.match(cli('--day', '2026-11-21', '--since', '2026-11-20').stderr, /--day or --since/);
});
