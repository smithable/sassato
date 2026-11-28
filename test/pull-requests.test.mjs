import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { setWorkspaceSettings } from '../dist/workspace-settings.js';
import * as tasks from '../dist/tasks.js';
import { context } from '../dist/coordination.js';
import { saveNotificationProgress } from '../dist/notification-progress.js';
import { wake } from '../dist/wake.js';
import { pullRefs, pullName, readReferences } from '../dist/pull-requests.js';

const cli = resolve('bin/sassato.js');
const repositories = { app: 'example/app', tools: 'example/tools' };
const named = text => pullRefs(text, repositories).map(pullName);

test('pull requests are read from URLs, owner/repo, a short name, or a bare number beside one repository', () => {
  assert.deepEqual(named('See https://github.com/other/thing/pull/7.'), ['other/thing#7']);
  assert.deepEqual(named('other/thing#8 and app#9, app PR #10, tools pull request #11'), ['other/thing#8', 'example/app#9', 'example/app#10', 'example/tools#11']);
  assert.deepEqual(named('The app change: merge #12 (and PR#13).'), ['example/app#12', 'example/app#13']);
  // No repository, or two, leaves a bare number alone; so does an unknown short name.
  assert.deepEqual(named('merge #12'), []);
  assert.deepEqual(named('app and tools both: see #12'), []);
  assert.deepEqual(named('app-cloud#12'), []);
  assert.deepEqual(named('constructor#12 in app'), []);
  assert.deepEqual(named('https://github.com/other/thing/pull/12abc and /pull/12345678'), []);
  // A number with no repository is remembered, so it is never counted as merged.
  assert.equal(readReferences('app#12 and elsewhere#13', repositories).unresolved, true);
  assert.equal(readReferences('app#12', repositories).unresolved, false);
});

// A gh that answers from a table: PR number to state. Anything else exits 1, as for an issue.
function fixture(t, states) {
  const dir = mkdtempSync(join(tmpdir(), 'sassato-pulls-')), db = join(dir, 'state.db'), calls = join(dir, 'calls');
  const s = new Store(db, undefined, { create: true });
  initWorkspace(s, 'team', undefined, ['alice']); s.actor = 'alice';
  setWorkspaceSettings(s, { pull_repositories: repositories }); s.actor = 'builder';
  t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, args[2] + '\\n');
const state = ${JSON.stringify(states)}[args[2]];
if (!state) process.exit(1);
console.log(JSON.stringify({ state, mergedAt: state === 'MERGED' ? '2026-01-02T03:04:05Z' : null, closedAt: state === 'OPEN' ? null : '2026-01-02T03:04:05Z' }));
`);
  chmodSync(join(dir, 'gh'), 0o755);
  const run = (args, path = dir) => spawnSync(process.execPath, [cli, '--db', db, '--workspace', 'team', '--as', 'builder', ...args], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, PATH: path, SASSATO_ROLE: '', SASSATO_WORKSPACE: '', SASSATO_DB: '' }
  });
  return { s, dir, run, asked: () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [] };
}
const pending = s => s.all("SELECT * FROM questions WHERE status='pending'").length;

test('ask-human makes its other refusals before it looks any pull request up', t => {
  const f = fixture(t, { 12: 'MERGED' });
  const mine = tasks.addTask(f.s, { title: 'Move app#12', owner: 'builder' }), theirs = tasks.addTask(f.s, { title: 'Held app#12', owner: 'alice' });
  const options = Array.from({ length: 21 }, (_, n) => `choice ${n}`).join('|');
  for (const [args, message] of [
    [[theirs.id, 'Ship it?'], /Only the owner/],
    [[mine.id, 'Ship it?', '--options', options], /At most 20 options/],
    [[mine.id, 'Ship it?', '--seen', 'H999'], /Question H999 not found/],
    [['--new', 'About app#12', 'Ship it?', '--for', 'nobody'], /nobody/],
    [['--new', `About app#12 ${'x'.repeat(500)}`, 'Ship it?'], /title/i]
  ]) {
    const out = f.run(['ask-human', ...args]);
    assert.notEqual(out.status, 0, String(message));
    assert.match(out.stderr, message);
  }
  assert.deepEqual(f.asked(), []);
  assert.equal(pending(f.s), 0);
});

test('ask-human refuses once for a merged or closed pull request the task names, in its notes too', t => {
  const f = fixture(t, { 12: 'MERGED', 13: 'CLOSED' });
  const task = tasks.addTask(f.s, { title: 'Move the app change app#12', owner: 'builder' });
  tasks.noteTask(f.s, task.id, 'Replaced app#13');
  let out = f.run(['ask-human', task.id, 'Which way should it move?']);
  assert.equal(out.status, 4, out.stderr);
  assert.match(out.stderr, /example\/app#12: MERGED 2026-01-02/);
  assert.match(out.stderr, /example\/app#13: CLOSED 2026-01-02/);
  assert.match(out.stderr, /--seen-pr 13,12/);
  assert.equal(pending(f.s), 0);
  out = f.run(['ask-human', task.id, 'Which way should it move?', '--seen-pr', '12']);
  assert.equal(out.status, 4, 'every refused number has to be named');
  out = f.run(['ask-human', task.id, 'Which way should it move?', '--seen-pr', '12,13']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(pending(f.s), 1);
  assert.match(f.s.get("SELECT detail FROM events WHERE entity='question' AND action='asked'").detail, /"seen_pr":\["example\/app#13","example\/app#12"\]/);
});

test('an open pull request, an unknown number and a missing gh all record the question', t => {
  const f = fixture(t, { 12: 'OPEN', 3: 'MERGED' });
  let out = f.run(['ask-human', '--new', 'About app#12', 'Ship it now?']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /example\/app#12 is OPEN/);
  out = f.run(['ask-human', '--new', 'Odd one', 'What about tools#99?']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /state not checked for example\/tools#99/);
  out = f.run(['ask-human', '--new', 'Colour', 'Is issue #5 about green paint?']);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(f.asked(), ['12', '99'], 'a bare number with no repository named is not looked up');
  out = f.run(['ask-human', '--new', 'Later', 'And app#44 for the weekend?'], '/nonexistent');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /state not checked for example\/app#44/);
  assert.equal(pending(f.s), 4);
  // Two numbers gh does not know (issues) do not stop the merged one after them from being found.
  out = f.run(['ask-human', '--new', 'Several', 'About app#101, app#102 and app#3?']);
  assert.equal(out.status, 4, out.stdout + out.stderr);
});

test('an earlier look-alike question and a merged pull request are refused together', t => {
  const f = fixture(t, { 12: 'MERGED' });
  const question = 'Should the harbour lighthouse brochure use the blue lantern drawing?';
  assert.equal(f.run(['ask-human', '--new', 'Brochure cover', question]).status, 0);
  const out = f.run(['ask-human', '--new', 'Brochure cover for app#12', question]);
  assert.equal(out.status, 4, out.stdout + out.stderr);
  assert.match(out.stderr, /--seen H1 --seen-pr 12/);
});

test("a wake's open work says when every pull request it names is merged, and not when one is unknown", async t => {
  const f = fixture(t, { 12: 'MERGED' });
  const done = tasks.addTask(f.s, { title: 'Finish app#12', forRole: 'builder' });
  const unsure = tasks.addTask(f.s, { title: 'Finish app#12 and app#99', forRole: 'builder' });
  const elsewhere = tasks.addTask(f.s, { title: 'Finish app#12 and elsewhere#13', forRole: 'builder' });
  // The idle minute passes by the test's own clock; gh is the fixture's.
  const real = performance.now.bind(performance), path = process.env.PATH; let shift = 0;
  performance.now = () => real() + shift; process.env.PATH = f.dir;
  t.after(() => { performance.now = real; process.env.PATH = path; });
  saveNotificationProgress(f.s, { cursor: context(f.s).snapshot_cursor, expected_version: 0 });
  const timer = setTimeout(() => { shift += 61_000; }, 50); t.after(() => clearTimeout(timer));
  const out = await wake(f.s, { idleMinutes: 1, settle: 0, timeout: 60 });
  assert.equal(out.result.reason, 'open-work', out.text);
  assert.match(out.text, new RegExp(`${done.id}: Every pull request it names is merged: example/app#12 \\(2026-01-02\\)`));
  assert.doesNotMatch(out.text, new RegExp(`${unsure.id}: Every`));
  assert.doesNotMatch(out.text, new RegExp(`${elsewhere.id}: Every`));
});

test('the line is on a digest entry too, as a scored wake prints its idle work', async t => {
  const f = fixture(t, { 12: 'MERGED' }), path = process.env.PATH;
  process.env.PATH = f.dir; t.after(() => { process.env.PATH = path; });
  f.s.actor = 'alice'; setWorkspaceSettings(f.s, { wake_mode: 'scored', speed: 'fast' }); f.s.actor = 'builder';
  const task = tasks.addTask(f.s, { title: 'Finish app#12', forRole: 'builder' });
  saveNotificationProgress(f.s, { cursor: context(f.s).snapshot_cursor, expected_version: 0 });
  const base = Date.now() + 100; let elapsed = 0;
  const clock = { now: () => base + elapsed, monotonic: () => elapsed, sleep: async ms => { elapsed += Math.max(ms, 1_500_000); } };
  const out = await wake(f.s, { timeout: 1501, clock });
  assert.ok(out.result.digest, out.text);
  assert.match(out.text, new RegExp(`${task.id}[\\s\\S]*Every pull request it names is merged: example/app#12`));
});

test('with a default repository, a bare number in a text that names none is looked up and refused', t => {
  const f = fixture(t, { 1354: 'MERGED' });
  f.s.actor = 'alice'; setWorkspaceSettings(f.s, { pull_repositories: { ...repositories, '#': 'example/app' } }); f.s.actor = 'builder';
  const task = tasks.addTask(f.s, { title: 'Move the film work (#1354, approved last week)', owner: 'builder' });
  const out = f.run(['ask-human', task.id, 'How should it be moved?']);
  assert.equal(out.status, 4, out.stdout + out.stderr);
  assert.match(out.stderr, /example\/app#1354: MERGED/);
  // A configured name still wins over the default, which is for a text naming no repository.
  const set = { ...repositories, '#': 'example/app' }, read = text => pullRefs(text, set).map(pullName);
  assert.deepEqual(read('tools #12 and tools#13'), ['example/tools#12', 'example/tools#13']);
  assert.deepEqual(read('merge #12 in tools'), ['example/tools#12']);
  assert.deepEqual(read('see #12'), ['example/app#12']);
  // Two repositories named: which one a bare number means is unclear, so it is neither.
  assert.deepEqual(read('app and tools both: see #12'), []);
  assert.deepEqual(readReferences('app and tools both: see #12, tools#13', set), { refs: [{ repo: 'example/tools', number: 13 }], unresolved: true, unclear: [12] });
  assert.deepEqual(read('elsewhere#12'), []);
});

test('ask-human says which bare numbers it did not check when the text names several repositories', t => {
  const f = fixture(t, { 12: 'MERGED' });
  const task = tasks.addTask(f.s, { title: 'app and tools both: see #12', owner: 'builder' });
  const out = f.run(['ask-human', task.id, 'Ship it?']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stderr, /not checked for #12 \(the text names several repositories/);
  assert.deepEqual(f.asked(), []);
});
