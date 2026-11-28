import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import * as tasks from '../dist/tasks.js';

test('send --re tells the sender the task\'s status and the start of its last note', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sassato-send-')), db = join(dir, 'state.db');
  const s = new Store(db, undefined, { create: true });
  initWorkspace(s, 'team', undefined, ['alice']); s.actor = 'builder';
  t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  const run = (...args) => spawnSync(process.execPath, [resolve('bin/sassato.js'), '--db', db, '--workspace', 'team', '--as', 'builder', ...args], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, SASSATO_ROLE: '', SASSATO_WORKSPACE: '', SASSATO_DB: '' }
  });
  const task = tasks.addTask(s, { title: 'Paint the fence', owner: 'builder' });
  const first = run('send', 'alice', 'Please paint it', '--re', task.id);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, new RegExp(`${task.id} is \\w+; no notes`));
  tasks.noteTask(s, task.id, 'an older note');
  tasks.noteTask(s, task.id, `Painted\nyesterday ${'x'.repeat(300)}`);
  const second = run('send', 'alice', 'Please paint it', '--re', task.id);
  assert.equal(second.status, 0, second.stderr);
  const line = second.stderr.split('\n').find(l => l.includes('last note'));
  assert.match(line, /last note \(builder, \d{4}-\d{2}-\d{2}\): Painted yesterday x+…$/);
  assert.equal(line.split('): ')[1].length, 201);
  assert.doesNotMatch(run('send', 'alice', 'No task here').stderr, /last note|no notes/);
});
