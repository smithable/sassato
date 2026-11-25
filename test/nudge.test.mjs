import { fixtureConfig } from './fixtures/team.mjs';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { send, inbox } from '../dist/coordination.js';
import { waitForWork } from '../dist/mail-wait.js';
import { addTask, takeTask, noteTask, blockTask } from '../dist/tasks.js';
import { setWorkspaceSettings, setRoleNudge, workspaceSettings } from '../dist/workspace-settings.js';
import { saveNotificationProgress } from '../dist/notification-progress.js';
import { idleReason, wake } from '../dist/wake.js';

// T1253: virtual time. Date is mocked, so stored event times and the wait's clock move together, and
// each sleep moves both on at once: fifteen quiet minutes take milliseconds.
function fixture(t) {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-22T10:00:00Z') });
  t.after(() => mock.timers.reset());
  const dir = mkdtempSync(join(tmpdir(), 'sassato-nudge-')), path = join(dir, 'state.db');
  const s = new Store(path, 'human', { create: true }); initWorkspace(s, 'team', fixtureConfig); s.use('team');
  t.after(() => { if (s.db.isOpen) s.close(); rmSync(dir, { recursive: true, force: true }); });
  const clock = { now: () => Date.now(), monotonic: () => Date.now(), sleep: async (ms) => { mock.timers.tick(Math.max(ms, 1)); await new Promise(setImmediate); } };
  // The actor stays set until an awaited wait has finished, so the waiter's own writes are its role's.
  const as = (role, fn) => {
    const before = s.actor; s.actor = role;
    let result;
    try { result = fn(); } catch (error) { s.actor = before; throw error; }
    if (result instanceof Promise) return result.finally(() => { s.actor = before; });
    s.actor = before; return result;
  };
  const latest = () => Number(s.get('SELECT coalesce(max(id),0) n FROM events WHERE workspace_id=?', s.ws).n);
  const wait = (role, timeout = 3600) => as(role, () => waitForWork(s, { settle: 0, timeout, since: latest(), nudge: true, clock, stopFile: join(dir, 'stop') }));
  const nudges = (role, action = 'sent') => s.all("SELECT detail FROM events WHERE workspace_id=? AND entity='nudge' AND entity_id=? AND action=? ORDER BY id", s.ws, role, action).map((e) => JSON.parse(e.detail));
  return { s, dir, path, clock, as, latest, wait, nudges };
}

test('a quiet agent is nudged twice, then the escalation role gets one mail and the nudges stop', async (t) => {
  const f = fixture(t);
  setWorkspaceSettings(f.s, { nudge_escalate: 'lead' });
  f.as('b', () => noteTask(f.s, f.as('b', () => takeTask(f.s, addTask(f.s, { title: 'Held' }).id)).id, 'started'));
  const start = Date.now();
  const first = await f.wait('b');
  assert.equal(first.reason, 'nudge');
  assert.ok(Date.now() - start >= 15 * 60_000, 'not before fifteen minutes');
  assert.equal(first.nudge.count, 1);
  assert.match(first.nudge.text, /No write from you for 15 minutes \(nudge 1 of 2\)/);
  assert.match(first.nudge.text, /sassato idle-reason "why" --as b --workspace team/);
  assert.match(first.nudge.text, /Ready for you: T\d+/, 'its doing task is named');
  const between = Date.now();
  const second = await f.wait('b');
  assert.equal(second.nudge.count, 2, 'a re-armed waiter keeps the count');
  assert.ok(Date.now() - between >= 15 * 60_000, 'the second nudge waits its own interval');
  assert.equal(f.s.get("SELECT actor FROM events WHERE entity='nudge' ORDER BY id DESC LIMIT 1").actor, 'b');
  assert.equal((await f.wait('b', 3000)).reason, 'timeout', 'the third interval mails the escalation role and does not wake b');
  assert.equal(f.nudges('b', 'escalated').length, 1);
  const mail = f.as('lead', () => inbox(f.s, { peek: true }));
  assert.equal(mail.length, 1);
  assert.match(mail[0].body, /^b has written nothing for 45 minutes and answered neither of two nudges/);
  assert.equal(mail[0].urgent, false);
  assert.equal((await f.wait('b', 3000)).reason, 'timeout', 'no more nudges until b writes');
  assert.equal(f.nudges('b').length, 2);
});

test('an idle reason answers the nudge; only a change for the role starts the count again', async (t) => {
  const f = fixture(t);
  assert.equal((await f.wait('b')).reason, 'nudge');
  const answer = f.as('b', () => idleReason(f.s, 'waiting for a review on T1'));
  assert.match(answer.event, /^E\d+$/);
  assert.equal((await f.wait('b', 3000)).reason, 'timeout', 'answered: no nudge without a change');
  f.as('a', () => send(f.s, ['c'], 'mail for someone else'));
  assert.equal((await f.wait('b', 3000)).reason, 'timeout', 'mail to another role is no change for b');
  f.as('a', () => send(f.s, ['b'], 'ordinary mail for b'));
  const again = await f.wait('b');
  assert.equal(again.reason, 'nudge', 'mail to it is a change');
  assert.equal(again.nudge.count, 1, 'the count starts again after the change');
  assert.match(again.nudge.text, /Nothing is ready for you: ask whoever assigns work for work in one line/);
});

test('taking a task after a nudge answers it, and a task made for the role is a change', async (t) => {
  const f = fixture(t);
  const task = f.as('a', () => addTask(f.s, { title: 'For b', forRole: 'b' }));
  const nudge = await f.wait('b');
  assert.deepEqual(nudge.tasks, [task.id]);
  f.as('b', () => takeTask(f.s, task.id));
  assert.equal((await f.wait('b', 3000)).reason, 'timeout');
  f.as('a', () => addTask(f.s, { title: 'Another for b', forRole: 'b' }));
  assert.equal((await f.wait('b')).reason, 'nudge');
});

test('no nudge when the setting is 0, for a human, or for a plain wait', async (t) => {
  const f = fixture(t);
  assert.equal((await f.as('b', () => waitForWork(f.s, { settle: 0, timeout: 3000, since: f.latest(), clock: f.clock }))).reason, 'timeout', 'only wake asks for the nudge');
  assert.equal((await f.wait('human', 3000)).reason, 'timeout');
  setWorkspaceSettings(f.s, { nudge_minutes: 0 });
  assert.equal((await f.wait('b', 3000)).reason, 'timeout');
  assert.throws(() => setWorkspaceSettings(f.s, { nudge_minutes: 2000 }), /nudge_minutes/);
  setWorkspaceSettings(f.s, { nudge_minutes: 5 });
  const short = await f.wait('b');
  assert.match(short.nudge.text, /for 5 minutes/);
});

test('wake records the waiter armed and ended, says what it waits for, and names ready work on a long wait', async (t) => {
  const f = fixture(t);
  const held = f.as('b', () => takeTask(f.s, addTask(f.s, { title: 'Held' }).id));
  f.as('b', () => blockTask(f.s, held.id, { kind: 'agent', waitingOn: 'a', body: 'review' }));
  const ready = f.as('a', () => addTask(f.s, { title: 'Ready for b', forRole: 'b' }));
  f.as('b', () => saveNotificationProgress(f.s, { cursor: f.latest(), expected_version: 0 }));
  const notices = [];
  setWorkspaceSettings(f.s, { nudge_minutes: 0 });
  const out = await f.as('b', () => wake(f.s, { settle: 0, timeout: 1, clock: f.clock, stopFile: join(f.dir, 'stop'), expectMinutes: 30, armNotice: (line) => notices.push(line) }));
  assert.equal(out.result.reason, 'timeout');
  assert.deepEqual(notices, [`Waiting is not idle: ${ready.id} is ready for you while this wait (about 30 minutes) runs.`]);
  const events = f.s.all("SELECT action,detail FROM events WHERE workspace_id=? AND entity='waiter' AND entity_id='b' ORDER BY id", f.s.ws).map((e) => ({ action: e.action, ...JSON.parse(e.detail) }));
  assert.deepEqual(events.map((e) => e.action), ['armed', 'ended']);
  assert.equal(events[0].waiting_for, `${held.id} on a`);
  assert.equal(events[0].expect_minutes, 30);
  assert.equal(events[1].reason, 'timeout');
  await f.as('b', () => wake(f.s, { settle: 0, timeout: 1, clock: f.clock, stopFile: join(f.dir, 'stop'), waitingFor: 'CI on #70' }));
  const again = JSON.parse(f.s.get("SELECT detail FROM events WHERE workspace_id=? AND entity='waiter' AND action='armed' ORDER BY id DESC LIMIT 1", f.s.ws).detail);
  assert.equal(again.waiting_for, 'CI on #70');
  assert.equal(again.expect_minutes, null);
  assert.equal(f.s.get("SELECT count(*) n FROM documents WHERE type='event' AND entity_id IN (SELECT 'E'||id FROM events WHERE entity='waiter')").n, 0, 'waiter events stay out of search');
});

test('a session that starts or resumes gets the full interval from its start; a re-arm right after a wake keeps the count', async (t) => {
  const f = fixture(t);
  f.as('b', () => noteTask(f.s, f.as('b', () => takeTask(f.s, addTask(f.s, { title: 'Held' }).id)).id, 'yesterday'));
  f.as('b', () => saveNotificationProgress(f.s, { cursor: f.latest(), expected_version: 0 }));
  mock.timers.tick(10 * 3600_000);
  const rearm = () => f.as('b', () => wake(f.s, { settle: 0, timeout: 3600, clock: f.clock, stopFile: join(f.dir, 'stop') }));
  const started = Date.now();
  const first = await rearm();
  assert.equal(first.result.reason, 'nudge');
  assert.equal(first.result.nudge.count, 1);
  assert.ok(Date.now() - started >= 15 * 60_000, 'not at once after ten quiet hours: the start counts');
  const between = Date.now();
  const second = await rearm();
  assert.equal(second.result.nudge.count, 2, 'a re-arm right after a wake is no new start');
  assert.ok(Date.now() - between >= 15 * 60_000);
  // A waiter that never ended (its session died), then a new one hours later: a new start.
  f.as('b', () => f.s.tx(() => f.s.event('waiter', 'b', 'armed', {})));
  mock.timers.tick(5 * 3600_000);
  const resumed = Date.now();
  const third = await rearm();
  assert.equal(third.result.nudge.count, 1, 'the count starts again with the new session');
  assert.ok(Date.now() - resumed >= 15 * 60_000);
});

test('a waiter names what the role said, a job of its own, or a block that is not parked; a parked task never names it (T1534)', async (t) => {
  const f = fixture(t);
  setWorkspaceSettings(f.s, { nudge_minutes: 0 });
  const parked = f.as('b', () => takeTask(f.s, addTask(f.s, { title: 'Parked' }).id));
  f.as('b', () => blockTask(f.s, parked.id, { kind: 'other', waitingOn: 'lead', body: 'parked for the lead' }));
  f.as('b', () => saveNotificationProgress(f.s, { cursor: f.latest(), expected_version: 0 }));
  const arm = () => f.as('b', () => wake(f.s, { settle: 0, timeout: 1, clock: f.clock, stopFile: join(f.dir, 'stop') }));
  const last = () => JSON.parse(f.s.get("SELECT detail FROM events WHERE workspace_id=? AND entity='waiter' AND action='armed' ORDER BY id DESC LIMIT 1", f.s.ws).detail);
  await arm();
  assert.deepEqual([last().waiting_for, last().waiting_source], [null, null], 'a parked block is not a wait');
  f.as('b', () => idleReason(f.s, 'waiting for CI on #70'));
  await arm();
  assert.deepEqual([last().waiting_for, last().waiting_source], ['waiting for CI on #70', 'idle-reason']);
  await arm();
  assert.equal(last().waiting_for, null, 'an idle reason counts once, for the waiter after it');
  f.s.run(`INSERT INTO jobs(workspace_id,role,kind,command,status,need_mb,cpu_need,margin,pid,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    f.s.ws, 'b', 'gate', '["gate.sh"]', 'running', 1, 1, 1, 1, new Date().toISOString());
  await arm();
  assert.deepEqual([last().waiting_for, last().waiting_source], ['a gate job', 'job']);
  f.s.run("UPDATE jobs SET status='done' WHERE workspace_id=?", f.s.ws);
  const held = f.as('b', () => takeTask(f.s, addTask(f.s, { title: 'Held' }).id));
  f.as('b', () => blockTask(f.s, held.id, { kind: 'agent', waitingOn: 'a', body: 'review' }));
  await arm();
  assert.deepEqual([last().waiting_for, last().waiting_source], [`${held.id} on a`, 'block']);
});

test('a role a human turns the nudge off for is never nudged; on again, it is (T1539)', async (t) => {
  const f = fixture(t);
  assert.throws(() => f.as('a', () => setRoleNudge(f.s, 'b', 'off')), /human/, 'only a human sets it');
  assert.throws(() => setRoleNudge(f.s, 'b', 'maybe'), /on or off/);
  assert.throws(() => setRoleNudge(f.s, 'nobody', 'off'));
  assert.equal(setRoleNudge(f.s, 'b', 'off'), false);
  assert.deepEqual(workspaceSettings(f.s).nudge_off, ['b']);
  assert.equal((await f.wait('b', 3000)).reason, 'timeout');
  assert.deepEqual(f.nudges('b'), []);
  setWorkspaceSettings(f.s, { nudge_minutes: 10 });
  assert.deepEqual(workspaceSettings(f.s).nudge_off, ['b'], 'another settings change keeps it');
  assert.equal(setRoleNudge(f.s, 'b', 'on'), true);
  assert.deepEqual(workspaceSettings(f.s).nudge_off, []);
  assert.match((await f.wait('b')).nudge.text, /for 10 minutes/);
});
