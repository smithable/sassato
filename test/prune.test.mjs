import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA_VERSION } from '../dist/storage.js';
import { initWorkspace, search } from '../dist/admin.js';
import { setFact, facts, factHistory, context, renderContext } from '../dist/coordination.js';
import * as tasks from '../dist/tasks.js';
import { prune, renderPrune, cutTitle, saysMerged, closedSince, renderClosed, namesResult } from '../dist/prune.js';

const cli = resolve('bin/sassato.js');
const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const ahead = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sassato-prune-'));
  const db = join(dir, 'state.db'), s = new Store(db, undefined, { create: true });
  initWorkspace(s, 'team', undefined, ['alice']); s.actor = 'builder';
  t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  return { s, dir, db };
}
function raw(db, args, actor = 'builder') {
  return spawnSync(process.execPath, [cli, '--db', db, '--workspace', 'team', '--as', actor, ...args], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, SASSATO_ROLE: '', SASSATO_WORKSPACE: '', SASSATO_DB: '' },
  });
}
const ids = (rows) => rows.map((r) => r.id);

test('a fact expiry: a past date is refused, none clears it, a correction keeps a future one and must restate a past one', (t) => {
  const { s } = fixture(t);
  assert.throws(() => setFact(s, 'usage.week', { body: 'x', source: 'y', expires: '2020-01-01' }), /in the past/);
  assert.throws(() => setFact(s, 'usage.week', { body: 'x', source: 'y', expires: 'soon' }), /ISO date/);
  const until = ahead(3);
  let f = setFact(s, 'usage.week', { body: '40% used', source: 'dashboard', expires: until });
  assert.equal(f.expires_at, `${until}T23:59:59.999Z`); assert.equal(f.expired, false);
  f = setFact(s, 'usage.week', { body: '45% used', source: 'dashboard', expected_version: 1 });
  assert.equal(f.expires_at, `${until}T23:59:59.999Z`, 'a correction keeps a future expiry');
  f = setFact(s, 'usage.week', { body: '45% used', source: 'dashboard', expected_version: 2, expires: 'none' });
  assert.equal(f.expires_at, null);
  // Past its expiry: a correction must say what it wants.
  setFact(s, 'usage.week', { body: '50% used', source: 'dashboard', expected_version: 3, expires: ahead(1) });
  s.run("UPDATE facts SET expires_at=? WHERE key='usage.week'", ago(1));
  assert.throws(() => setFact(s, 'usage.week', { body: '10% used', source: 'dashboard', expected_version: 4 }), /expired at .*--expires DATE, or --expires none/);
  assert.equal(facts(s, { key: 'usage.week' })[0].version, 4, 'the refusal changed nothing');
  f = setFact(s, 'usage.week', { body: '10% used', source: 'dashboard', expected_version: 4, expires: ahead(7) });
  assert.equal(f.expired, false); assert.equal(f.version, 5);
});

test('an expired fact leaves the context and the brief, and stays readable and searchable, marked', (t) => {
  const { s } = fixture(t);
  const since = context(s).cursor;
  setFact(s, 'usage.month', { body: 'quota half used', source: 'dashboard', expires: ahead(2) });
  setFact(s, 'decisions.host', { body: 'host chosen', source: 'chat' });
  let full = context(s, { since: 0 });
  assert.deepEqual(full.sections.facts.map((r) => r.key).sort(), ['decisions.host', 'usage.month']);
  assert.equal(full.sections.facts.find((r) => r.key === 'usage.month').until, ahead(2));
  assert.match(renderContext(full), /until=\d{4}-\d{2}-\d{2}/);
  const brief = context(s, { since, brief: true });
  assert.equal(brief.sections.facts.find((r) => r.key === 'usage.month').until, ahead(2), 'the brief shows the expiry beside the fact');

  s.run("UPDATE facts SET expires_at=? WHERE key='usage.month'", ago(1));
  full = context(s, { since: 0 });
  assert.deepEqual(full.sections.facts.map((r) => r.key), ['decisions.host']);
  assert.deepEqual(context(s, { since, brief: true }).sections.facts.map((r) => r.key), ['decisions.host']);
  const read = facts(s, { key: 'usage.month' })[0];
  assert.equal(read.expired, true); assert.equal(read.body, 'quota half used');
  assert.equal(facts(s).find((r) => r.key === 'usage.month').expired, true);
  assert.equal(factHistory(s, 'usage.month').length > 0, true);
  const found = search(s, 'quota', { type: 'fact' });
  assert.equal(found.length, 1); assert.equal(found[0].expired, true);
  assert.equal(search(s, 'host', { type: 'fact' })[0].expired, false);
});

test('prune lists each rule\'s case, leaves the near miss out, and writes nothing', (t) => {
  // History is append-only, so the old records are made 10 days back on a mocked clock.
  mock.timers.enable({ apis: ['Date'], now: Date.now() - 10 * DAY }); t.after(() => mock.timers.reset());
  const { s } = fixture(t);
  // quiet-review: in review 10 days; the near miss went to review today.
  const quiet = tasks.addTask(s, { title: 'Old review' }); tasks.takeTask(s, quiet.id); tasks.submitTask(s, quiet.id, 'ready');
  setFact(s, 'usage.week', { body: 'x', source: 'y', expires: ahead(1) });
  setFact(s, 'decisions.gone', { body: 'Withdrawn', source: 'y', expires: ahead(1) });
  mock.timers.tick(DAY);
  const qt = tasks.addTask(s, { title: 'Pick a host' });
  const oldQ = tasks.askHuman(s, qt.id, { question: 'Which host?' });
  mock.timers.tick(9 * DAY);
  const fresh = tasks.addTask(s, { title: 'Fresh review' }); tasks.takeTask(s, fresh.id); tasks.submitTask(s, fresh.id, 'ready');
  // names-merged-pr: its last note says merged #12; the near miss has a later event after the note.
  const merged = tasks.addTask(s, { title: 'Merged work' }); tasks.takeTask(s, merged.id); tasks.noteTask(s, merged.id, 'PR #12 merged at abc123');
  const later = tasks.addTask(s, { title: 'Merged then more' }); tasks.takeTask(s, later.id); tasks.noteTask(s, later.id, 'PR #13 merged'); tasks.noteTask(s, later.id, 'found another bug');
  const unmerged = tasks.addTask(s, { title: 'Opened only' }); tasks.takeTask(s, unmerged.id); tasks.noteTask(s, unmerged.id, 'PR #14 opened');
  const notYet = tasks.addTask(s, { title: 'Not yet' }); tasks.takeTask(s, notYet.id); tasks.noteTask(s, notYet.id, 'PR #15 has not merged');
  const submitted = tasks.addTask(s, { title: 'Submitted merged' }); tasks.takeTask(s, submitted.id); tasks.submitTask(s, submitted.id, 'PR #16 merged at def456');
  // old-questions: one 9 days old (above), one today.
  const qt2 = tasks.addTask(s, { title: 'Pick a name' }); tasks.askHuman(s, qt2.id, { question: 'Which name?' });
  // same-title: two open tasks that differ in case, prefix and punctuation; a done one does not count.
  const a = tasks.addTask(s, { title: 'Low: Fix the login page.' }), b = tasks.addTask(s, { title: 'fix the LOGIN page' });
  const c = tasks.addTask(s, { title: 'Fix the login pages' });
  // facts
  setFact(s, 'usage.snapshot-2020-05-01', { body: 'old numbers', source: 'y' });
  setFact(s, `usage.snapshot-${ahead(0)}`, { body: 'today', source: 'y' });
  setFact(s, `usage.edge-${new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10)}`, { body: 'seven days', source: 'y' });
  setFact(s, 'usage.build-12020-05-01', { body: 'not a date', source: 'y' });
  setFact(s, 'decisions.old', { body: 'Superseded by decisions.new', source: 'y' });
  setFact(s, 'decisions.kept', { body: 'Not superseded', source: 'y', checked_at: ago(40).slice(0, 10) });

  const events = s.get('SELECT count(*) n FROM events').n;
  const listing = prune(s);
  assert.equal(s.get('SELECT count(*) n FROM events').n, events, 'prune writes no event');
  const sec = listing.sections;
  assert.deepEqual(Object.keys(sec), ['quiet-review', 'quiet-topics', 'names-merged-pr', 'old-questions', 'same-title', 'expired-facts', 'dated-facts', 'marked-facts']);
  // The question's task is blocked on it and quiet for 9 days, so it is listed too.
  assert.deepEqual(ids(sec['quiet-review']), [quiet.id, qt.id]);
  assert.deepEqual(ids(sec['names-merged-pr']).sort(), [merged.id, submitted.id].sort());
  assert.deepEqual(ids(sec['old-questions']), [oldQ.id]);
  assert.deepEqual(ids(sec['same-title']).sort(), [a.id, b.id].sort());
  assert.match(sec['same-title'].find((r) => r.id === a.id).rule, new RegExp(`same title as ${b.id}$`));
  assert.ok(!ids(sec['same-title']).includes(c.id));
  assert.deepEqual(sec['expired-facts'].map((r) => r.key).sort(), ['decisions.gone', 'usage.week']);
  assert.deepEqual(sec['dated-facts'].map((r) => r.key), ['usage.snapshot-2020-05-01', `usage.edge-${new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10)}`]);
  assert.deepEqual(sec['marked-facts'].map((r) => r.key), ['decisions.old']);

  // unchecked-facts is asked for by name only.
  const unchecked = prune(s, { sections: 'unchecked-facts' }).sections;
  assert.deepEqual(Object.keys(unchecked), ['unchecked-facts']);
  assert.deepEqual(unchecked['unchecked-facts'].map((r) => r.key), ['decisions.kept']);
  // --days narrows: at 12 days the 10-day review and the 9-day question are not quiet yet.
  const narrow = prune(s, { days: 12, sections: 'quiet-review,old-questions' }).sections;
  assert.deepEqual([narrow['quiet-review'].length, narrow['old-questions'].length], [0, 0]);
  assert.throws(() => prune(s, { sections: 'nope' }), /--section takes/);
  assert.throws(() => prune(s, { days: 0 }), /days/);

  const text = renderPrune(listing);
  // A long title gives way; the rule and the other id stay.
  const long = tasks.addTask(s, { title: `Same ${'very '.repeat(40)}long title` }), twin = tasks.addTask(s, { title: `same ${'very '.repeat(40)}long title!` });
  const lines = renderPrune(prune(s, { sections: 'same-title' }), 100).split('\n');
  assert.ok(lines.some((l) => l.startsWith(`${long.id} `) && l.endsWith(`same title as ${twin.id}`) && l.length <= 100), lines.join('\n'));
  assert.throws(() => renderPrune(listing, 0), /line length/);
  assert.match(text, /^Prune listing \(read-only; quiet age 7 days\)/);
  assert.match(text, new RegExp(`${quiet.id} · 10d · builder · Old review · review, nothing recorded for 7\\+ days`));
  assert.match(text, /usage\.week · x · until \d{4}-\d{2}-\d{2} · past its expiry/);
});

test('saysMerged wants a pull request said to have merged', () => {
  for (const yes of ['PR #12 merged', 'merged https://github.com/o/r/pull/7 at abc', 'Merged #3.']) assert.ok(saysMerged(yes), yes);
  for (const no of ['PR #12 has not merged', "#12 isn't merged yet", 'close once #12 is merged', 'merged the branch', 'PR #4 unmerged', 'merge #4 when green']) assert.ok(!saysMerged(no), no);
});

test('cutTitle drops case, a Low or Feedback prefix and punctuation', () => {
  assert.equal(cutTitle('Feedback (workflow): Gate ran twice!'), 'gate ran twice');
  assert.equal(cutTitle('LOW:  the  thing.'), 'the thing');
  assert.equal(cutTitle('Lower the bar'), 'lower the bar');
});

test('the CLI sets an expiry and runs prune for an agent and a human, read-only', (t) => {
  const { s, db } = fixture(t);
  let r = raw(db, ['fact', 'set', 'usage.week', '40%', '--source', 'dashboard', '--expires', ahead(2), '--json']);
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).expires_at.slice(0, 10), ahead(2));
  r = raw(db, ['fact', 'set', 'usage.day', '1%', '--source', 'dashboard', '--expires', '2020-01-01']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /in the past/);
  for (const actor of ['builder', 'alice']) {
    r = raw(db, ['prune'], actor); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^Prune listing/);
  }
  r = raw(db, ['prune', '--section', 'expired-facts', '--json']); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).sections, { 'expired-facts': [] });
  r = raw(db, ['prune', 'extra']); assert.notEqual(r.status, 0);
  void s;
});

test('migration 16 adds the expiry and keeps every fact without one', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sassato-prune-mig-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.db');
  let s = new Store(path, undefined, { create: true }); initWorkspace(s, 'team', undefined, ['alice']); s.actor = 'builder';
  setFact(s, 'decisions.host', { body: 'host chosen', source: 'chat' }); s.close();
  const db = new DatabaseSync(path);
  db.exec("BEGIN; DROP TABLE schedule_ticks; DROP TABLE occurrences; DROP INDEX schedules_due; DROP TABLE schedules; DROP INDEX topic_links_topic; DROP TABLE topic_links; ALTER TABLE tasks DROP COLUMN kind; ALTER TABLE facts DROP COLUMN expires_at; DELETE FROM schema_migrations WHERE version>=16; PRAGMA user_version=15; COMMIT;");
  db.close();
  assert.throws(() => new Store(path, undefined, { readonly: true }), /migrat/);
  s = new Store(path); s.actor = 'builder'; s.use('team');
  t.after(() => s.close());
  assert.equal(s.get('PRAGMA user_version').user_version, SCHEMA_VERSION);
  const f = facts(s, { key: 'decisions.host' })[0];
  assert.equal(f.body, 'host chosen'); assert.equal(f.expires_at, null); assert.equal(f.expired, false);
});

test('tasks --closed-since: every task closed since a time, its result, and a mark on one naming none', (t) => {
  const { s, db } = fixture(t);
  const old = tasks.addTask(s, { title: 'Closed long ago' }); tasks.takeTask(s, old.id); tasks.doneTask(s, old.id);
  s.run("UPDATE tasks SET completed_at=? WHERE workspace_id=? AND id=?", ago(3), s.ws, Number(old.id.slice(1)));
  const since = ago(1);
  const merged = tasks.addTask(s, { title: 'Merged work' }); tasks.takeTask(s, merged.id); tasks.noteTask(s, merged.id, 'Merged as #12 at abc123'); tasks.doneTask(s, merged.id);
  const ref = tasks.addTask(s, { title: 'Done with a ref' }); tasks.takeTask(s, ref.id); tasks.noteTask(s, ref.id, 'PR #13 merged'); tasks.doneTask(s, ref.id, { ref: 'read only, nothing changed' });
  const follow = tasks.addTask(s, { title: 'Led to a task' }); tasks.dropTask(s, follow.id, 'duplicate; the work is T1');
  const self = tasks.addTask(s, { title: 'Names only itself' }); tasks.takeTask(s, self.id); tasks.noteTask(s, self.id, `${self.id}: looked, not merged yet`); tasks.doneTask(s, self.id);
  const bare = tasks.addTask(s, { title: 'No note at all' }); tasks.takeTask(s, bare.id); tasks.doneTask(s, bare.id);
  const openTask = tasks.addTask(s, { title: 'Still open' }); tasks.noteTask(s, openTask.id, 'Merged as #14');
  const data = closedSince(s, { since });
  assert.deepEqual(data.items.map((r) => [r.id, r.status, r.names_result]), [
    [merged.id, 'done', true], [ref.id, 'done', false], [follow.id, 'dropped', true], [self.id, 'done', false], [bare.id, 'done', false],
  ], 'the newest text is the result: a done reference after a merged note replaces it');
  assert.equal(data.items[1].result, 'read only, nothing changed');
  assert.equal(data.items[4].result, '');
  assert.equal(namesResult('Not merged: #15 waits', 'T9'), false);
  const text = renderClosed(data, 120);
  assert.match(text, /^Closed since .*: 5 task\(s\), 3 naming no result/);
  assert.match(text, new RegExp(`\\n! ${bare.id} · done .* · No note at all → \\(no note\\)`));
  assert.match(text, new RegExp(`\\n  ${merged.id} · done `));
  assert.deepEqual(closedSince(s, { since, limit: 2 }).has_more, true);
  assert.throws(() => closedSince(s, { since: 'yesterday' }), /--closed-since/);
  const r = raw(db, ['tasks', '--closed-since', since, '--json']);
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).items.length, 5);
  const mixed = raw(db, ['tasks', '--closed-since', since, '--status', 'done']);
  assert.equal(mixed.status, 2); assert.match(mixed.stderr, /takes --owner, --for, --limit and --line-length only/);
});
