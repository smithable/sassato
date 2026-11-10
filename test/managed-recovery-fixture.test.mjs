import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, inspectFixture, handoffFixture, verifyFixture } from '../scripts/managed-recovery-fixture.mjs';
import { Store } from '../dist/storage.js';
import { requestStop } from '../dist/control.js';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'sassato-managed-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, fixture: createFixture(root, 'codex') };
}

test('real recovery fixture preserves claimed work and replays notifications from durable progress', async t => {
  const { root } = setup(t);
  const before = inspectFixture(root);
  assert.equal(before.task.owner, 'builder');
  assert.equal(before.task.status, 'doing');
  assert.equal(before.checkpoint.evidence.reported.jobs[0].state, 'running');
  const next = handoffFixture(root, 0);
  assert.ok(next.expected_recovery_tokens.includes(before.task.id));
  const after = inspectFixture(root);
  assert.deepEqual(after.task, before.task);
  assert.equal(after.checkpoint.state, 'stale'); // New receipt demands current-state reconciliation.
  assert.equal(after.inbox[0].state, 'unread');
  assert.deepEqual(after.notification_progress, before.notification_progress);
  assert.ok(Object.values(await verifyFixture(root)).every(Boolean));
  assert.throws(() => handoffFixture(root, 0), /cannot be retried/);
});

test('unsettled job and STOP both prevent fixture replacement preparation', t => {
  const { root, fixture } = setup(t);
  const before = inspectFixture(root);
  for (const exit of [null, 1, -15]) assert.throws(() => handoffFixture(root, exit), /must finish/);
  assert.equal(inspectFixture(root).checkpoint.id, before.checkpoint.id);
  const s = new Store(fixture.database, 'operator');
  try { s.use('recovery-probe'); requestStop(s, ['builder']); } finally { s.close(); }
  assert.throws(() => handoffFixture(root, 0), /STOP blocks/);
  assert.equal(inspectFixture(root).checkpoint.id, before.checkpoint.id);
});

test('independent verifier detects task, progress and file mutations', async t => {
  for (const mutation of ['task', 'progress', 'file', 'unrelated-file', 'role']) {
    const { root, fixture } = setup(t);
    handoffFixture(root, 0);
    if (mutation === 'file') writeFileSync(join(fixture.directory, 'dirty.txt'), 'changed\n');
    else if (mutation === 'unrelated-file') writeFileSync(join(fixture.directory, 'unexpected.txt'), 'unexpected\n');
    else {
      const s = new Store(fixture.database, 'builder');
      try {
        s.use('recovery-probe');
        if (mutation === 'task') s.run("UPDATE tasks SET owner='reviewer' WHERE id=1");
        else if (mutation === 'role') s.run("UPDATE roles SET model='unexpected' WHERE name='builder'");
        else s.event('notification-progress', 'builder', 'saved', { format: 1, cursor: 0, version: 2 });
      } finally { s.close(); }
    }
    await assert.rejects(verifyFixture(root));
  }
});

test('fixture will not reuse an existing directory and never leaks instruction marker into prompt', t => {
  const { root, fixture } = setup(t);
  assert.throws(() => createFixture(root, 'codex'));
  assert.ok(!fixture.initial_prompt.includes(fixture.instruction_marker));
  assert.ok(readFileSync(join(fixture.directory, 'AGENTS.md'), 'utf8').includes(fixture.instruction_marker));
  const next = handoffFixture(root, 0);
  assert.ok(!next.recovery_prompt.includes(fixture.instruction_marker));
});
