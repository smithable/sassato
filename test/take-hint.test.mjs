import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { addTask, takeTask, updateTask } from '../dist/tasks.js';

// T972: a refusal names who can pass the task on and the command they run.
test('take and note of another role\'s task say how to get it', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sassato-take-hint-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = new Store(join(dir, 'state.db'), 'builder', { create: true }); initWorkspace(s, 'demo'); t.after(() => s.close());
  const task = addTask(s, { title: 'For the builder', forRole: 'builder' });
  s.actor = 'reviewer';
  assert.throws(() => takeTask(s, task.id), /Task is for builder\. Ask builder to retarget it to you \(sassato update T\d+ --for reviewer --expect 1\), then take it\./);
  s.actor = 'builder';
  const moved = updateTask(s, task.id, { version: task.version, forRole: 'reviewer' });
  s.actor = 'reviewer';
  assert.equal(takeTask(s, moved.id).owner, 'reviewer');
  s.actor = 'builder';
  const held = addTask(s, { title: 'Held' }); takeTask(s, held.id);
  s.actor = 'reviewer';
  assert.throws(() => updateTask(s, held.id, { version: 2, title: 'x' }), /It is held by builder: ask builder to hand it over \(sassato handoff T\d+ reviewer SUMMARY\), or a human\./);
});
