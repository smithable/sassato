import { fixtureConfig } from './fixtures/team.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { strings, booleans, allowed, globalFlags } from '../dist/cli.js';

test('every option a command allows is declared to the parser, which otherwise refuses it as unknown', () => {
  const declared = new Set([...strings, ...booleans]);
  const missing = Object.entries(allowed).flatMap(([command, keys]) => keys.filter((key) => !declared.has(key)).map((key) => `${command} --${key}`));
  assert.deepEqual(missing, []);
  assert.deepEqual(globalFlags.filter((key) => !declared.has(key)), []);
});

test('submit --reviewer is accepted from the command line', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sassato-options-')), db = join(dir, 'state.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const raw = (args) => spawnSync(process.execPath, [resolve('bin/sassato.js'), '--db', db, '--workspace', 'team', '--json', ...args], { encoding: 'utf8', env: { ...process.env, SASSATO_ROLE: '', SASSATO_WORKSPACE: '', SASSATO_DB: '' } });
  const run = (args) => { const r = raw(args); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  run(['init', '--config', fixtureConfig]);
  run(['role', 'set', 'codex', '--provider', 'codex', '--as', 'human']);
  const task = run(['add', 'Fix the parser', '--as', 'a', '--review-required']);
  run(['take', task.id, '--as', 'a']);
  // The value reaches submit: a reviewer who is no role is refused, and the task stays in doing.
  assert.notEqual(raw(['submit', task.id, 'Fixed', '--reviewer', 'nobody', '--as', 'a']).status, 0);
  assert.equal(run(['show', task.id]).status, 'doing');
  assert.equal(run(['submit', task.id, 'Fixed', '--reviewer', 'codex', '--as', 'a']).status, 'review');
});
