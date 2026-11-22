import { fixtureConfig } from './fixtures/team.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Store } from '../dist/storage.js';
import { initWorkspace, backupDatabase, restoreDatabase } from '../dist/admin.js';
import { answerQuestion } from '../dist/tasks.js';
import { setWorkspaceSettings } from '../dist/workspace-settings.js';
import { proposeRule, retireRule, withdrawRule, getRule, listRules, diffRules, ruleSet, rulesExportPath, exportRules, decideRuleProposal, RULE_MAX } from '../dist/rules.js';

const bin = resolve('bin/sassato.js');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sassato-rules-')), path = join(dir, 'state.db'), s = new Store(path, 'a', { create: true });
  initWorkspace(s, 'team', fixtureConfig); s.use('team');
  s.actor = 'human'; setWorkspaceSettings(s, { rule_relays: ['lead'] });
  t.after(() => { if (s.db.isOpen) s.close(); rmSync(dir, { recursive: true, force: true }); });
  return { s, dir, path };
}
const code = n => error => error.code === n;
const as = (s, role, fn) => { const before = s.actor; s.actor = role; try { return fn(); } finally { s.actor = before; } };
const cli = (path, ...args) => spawnSync(process.execPath, [bin, '--db', path, '--workspace', 'team', ...args], { encoding: 'utf8' });

test('a proposal asks the human; a relayed approval puts the rule in force and exports the set', t => {
  const { s, path } = fixture(t);
  const p = as(s, 'c', () => proposeRule(s, 'decisions.example', 'Say hello first.\nThen work.', { kind: 'always' }));
  assert.equal(p.status, 'pending'); assert.match(p.id, /^P\d+$/); assert.equal(p.base_version, 0);
  assert.equal(ruleSet(s).rules.length, 0, 'nothing is in force before the answer');
  const answered = as(s, 'human', () => answerQuestion(s, p.question_id, 'approve: fine', { relayedBy: 'lead' }));
  assert.equal(answered.rule.status, 'approved'); assert.equal(answered.task_status, 'done');
  const set = ruleSet(s); assert.equal(set.set_version, 1); assert.deepEqual(set.rules.map(r => [r.key, r.version]), [['decisions.example', 1]]);
  const exported = JSON.parse(readFileSync(rulesExportPath(path, 'team'), 'utf8'));
  assert.equal(exported.set_version, 1); assert.equal(exported.digest, set.digest);
  assert.equal(getRule(s, 'decisions.example').relayed_by, 'lead');
  assert.equal(listRules(s).rules[0].line, 'Say hello first.');
});

test('a relay not named in rule_relays is refused and nothing changes; an agent cannot answer', t => {
  const { s } = fixture(t);
  const p = as(s, 'c', () => proposeRule(s, 'decisions.example', 'Text'));
  assert.throws(() => as(s, 'human', () => answerQuestion(s, p.question_id, 'approve', { relayedBy: 'c' })), code(3));
  assert.throws(() => as(s, 'c', () => answerQuestion(s, p.question_id, 'approve')));
  assert.equal(getRule(s, p.id).status, 'pending'); assert.equal(ruleSet(s).rules.length, 0);
  as(s, 'human', () => answerQuestion(s, p.question_id, 'approve'));
  assert.throws(() => as(s, 'human', () => answerQuestion(s, p.question_id, 'approve')), 'a second answer is refused');
  assert.equal(ruleSet(s).set_version, 1);
});

test('the decision cannot be called around the question: an agent, or an unanswered question, is refused', t => {
  const { s } = fixture(t);
  const p = as(s, 'c', () => proposeRule(s, 'decisions.example', 'Text'));
  const q = Number(p.question_id.slice(1));
  assert.throws(() => as(s, 'c', () => s.tx(() => decideRuleProposal(s, q, 'approve', 'c'))), code(3));
  assert.throws(() => as(s, 'human', () => s.tx(() => decideRuleProposal(s, q, 'approve', 'human'))), code(4));
  assert.equal(ruleSet(s).rules.length, 0);
});

test('an export never replaces a newer set, nor another set at the same version', async t => {
  const { s, dir, path } = fixture(t);
  const copy = join(dir, 'copy.db'); await backupDatabase(s, copy);
  const p = as(s, 'c', () => proposeRule(s, 'decisions.example', 'Text'));
  as(s, 'human', () => answerQuestion(s, p.question_id, 'approve'));
  const old = new Store(copy, 'c'); old.use('team');
  try { assert.throws(() => old.tx(() => exportRules(old)), code(4)); } finally { old.close(); }
  assert.equal(JSON.parse(readFileSync(rulesExportPath(path, 'team'), 'utf8')).set_version, 1);
  const cliCopy = cli(copy, 'rule', 'export', '--as', 'c'); assert.equal(cliCopy.status, 4, cliCopy.stderr);
  s.close(); writeFileSync(rulesExportPath(path, 'team'), 'not json');
  assert.equal(cli(path, 'rule', 'export', '--as', 'c').status, 4, 'an unreadable export is not replaced silently');
  assert.notEqual(cli(path, 'rule', 'export', '--force', '--as', 'c').status, 0, 'only a human forces');
  assert.equal(cli(path, 'rule', 'export', '--force', '--as', 'human').status, 0);
  assert.equal(JSON.parse(readFileSync(rulesExportPath(path, 'team'), 'utf8')).set_version, 1);
});

test('an answer other than approve or reject is refused; reject records it and changes no rule', t => {
  const { s } = fixture(t);
  const p = as(s, 'c', () => proposeRule(s, 'decisions.example', 'Text'));
  assert.throws(() => as(s, 'human', () => answerQuestion(s, p.question_id, 'maybe later')));
  as(s, 'human', () => answerQuestion(s, p.question_id, 'reject: not now'));
  assert.equal(getRule(s, p.id).status, 'rejected'); assert.equal(ruleSet(s).rules.length, 0);
});

test('a stale proposal is refused at approval, its answer kept; retire and withdraw keep history', t => {
  const { s } = fixture(t);
  const first = as(s, 'c', () => proposeRule(s, 'decisions.example', 'One'));
  const second = as(s, 'b', () => proposeRule(s, 'decisions.example', 'Two'));
  as(s, 'human', () => answerQuestion(s, first.question_id, 'approve'));
  const late = as(s, 'human', () => answerQuestion(s, second.question_id, 'approve'));
  assert.equal(late.rule.status, 'refused'); assert.match(late.rule.decision, /moved from version 0 to 1/);
  assert.equal(getRule(s, 'decisions.example').text, 'One');
  const change = as(s, 'b', () => proposeRule(s, 'decisions.example', 'Two'));
  assert.equal(change.base_version, 1);
  assert.throws(() => as(s, 'c', () => withdrawRule(s, change.id, 'not mine')), 'only its proposer or a human withdraws');
  assert.equal(as(s, 'b', () => withdrawRule(s, change.id, 'overtaken')).status, 'withdrawn');
  const retire = as(s, 'c', () => retireRule(s, 'decisions.example', 'No longer needed'));
  as(s, 'human', () => answerQuestion(s, retire.question_id, 'approve'));
  const rule = getRule(s, 'decisions.example');
  assert.equal(rule.in_force, false); assert.equal(rule.version, 2); assert.equal(rule.history.length, 1);
  assert.equal(ruleSet(s).rules.length, 0);
  const diff = diffRules(s, 1); assert.equal(diff.changes.length, 1); assert.equal(diff.changes[0].previous_text, 'One');
  assert.throws(() => as(s, 'c', () => retireRule(s, 'decisions.example', 'again')), code(3));
});

test('caps, the key form, the scope and the secret scan refuse a proposal', t => {
  const { s } = fixture(t);
  as(s, 'c', () => {
    assert.throws(() => proposeRule(s, 'decisions.long', 'x'.repeat(RULE_MAX.always + 1)));
    assert.doesNotThrow(() => proposeRule(s, 'decisions.step', 'x'.repeat(RULE_MAX.always + 1), { kind: 'step' }));
    assert.throws(() => proposeRule(s, 'Bad Key', 'x'));
    assert.throws(() => proposeRule(s, 'decisions.scope', 'x', { scope: 'nobody' }));
    assert.throws(() => proposeRule(s, 'decisions.secret', 'Use key sk-ant-api03-' + 'A'.repeat(90)));
  });
  assert.equal(listRules(s, { pending: true }).pending.length, 1);
});

test('rule proposals and versions cannot be changed or deleted', t => {
  const { s } = fixture(t);
  const p = as(s, 'c', () => proposeRule(s, 'decisions.example', 'Text'));
  as(s, 'human', () => answerQuestion(s, p.question_id, 'approve'));
  assert.throws(() => s.db.exec("UPDATE rule_proposals SET text='Other'"), /cannot be changed/);
  assert.throws(() => s.db.exec('DELETE FROM rule_proposals'));
  assert.throws(() => s.db.exec("UPDATE rule_versions SET text='Other'"));
  assert.throws(() => s.db.exec('DELETE FROM rule_versions'));
});

test('a role scoped rule is shown to that role only', t => {
  const { s } = fixture(t);
  for (const [key, scope] of [['decisions.all', 'all'], ['decisions.for-c', 'c']]) {
    const p = as(s, 'c', () => proposeRule(s, key, key, { scope }));
    as(s, 'human', () => answerQuestion(s, p.question_id, 'approve'));
  }
  assert.deepEqual(ruleSet(s, 'c').rules.map(r => r.key), ['decisions.all', 'decisions.for-c']);
  assert.deepEqual(ruleSet(s, 'b').rules.map(r => r.key), ['decisions.all']);
});

test('two approvals at once from two processes: exactly one rule version is made', async t => {
  const { s, path } = fixture(t);
  const first = as(s, 'c', () => proposeRule(s, 'decisions.race', 'One'));
  const second = as(s, 'b', () => proposeRule(s, 'decisions.race', 'Two'));
  s.close();
  const run = q => new Promise(done => { const c = spawn(process.execPath, [bin, '--db', path, '--workspace', 'team', 'answer', q, '1', '--as', 'human', '--json']); let out = ''; c.stdout.on('data', d => { out += d; }); c.on('close', status => done({ status, out })); });
  const results = await Promise.all([run(first.question_id), run(second.question_id)]);
  assert.deepEqual(results.map(r => r.status), [0, 0]);
  const r = new Store(path, 'human'); r.use('team');
  try {
    assert.equal(r.get('SELECT count(*) AS n FROM rule_versions').n, 1);
    assert.deepEqual(r.all('SELECT status FROM rule_proposals ORDER BY status').map(x => x.status), ['approved', 'refused']);
  } finally { r.close(); }
});

test('the CLI proposes from a file, lists, diffs and exports', t => {
  const { s, dir, path } = fixture(t); s.close();
  const file = join(dir, 'rule.txt'); writeFileSync(file, 'From a file.\n');
  const made = cli(path, 'rule', 'propose', 'decisions.file', '--file', file, '--as', 'c', '--json');
  assert.equal(made.status, 0, made.stderr); const p = JSON.parse(made.stdout);
  assert.equal(cli(path, 'answer', p.question_id, 'approve', '--as', 'human', '--relayed-by', 'c').status, 3);
  assert.equal(cli(path, 'answer', p.question_id, 'approve', '--as', 'human', '--relayed-by', 'lead').status, 0);
  const list = JSON.parse(cli(path, 'rule', 'list', '--as', 'c', '--json').stdout);
  assert.equal(list.rules[0].key, 'decisions.file');
  assert.equal(JSON.parse(cli(path, 'rule', 'diff', '0', '--as', 'c', '--json').stdout).changes.length, 1);
  assert.equal(cli(path, 'rule', 'export', '--as', 'c').status, 0);
  assert.equal(cli(path, 'rule', 'propose', 'decisions.x', '--as', 'c').status !== 0, true, 'no text is refused');
});

test('a restore whose rules are older than the export is refused unless a human forces it', async t => {
  const { s, dir, path } = fixture(t);
  const backup = join(dir, 'before.db'); await backupDatabase(s, backup); s.close();
  const w = new Store(path, 'c'); w.use('team');
  const p = proposeRule(w, 'decisions.example', 'Text'); w.actor = 'human'; answerQuestion(w, p.question_id, 'approve'); w.close();
  const target = join(dir, 'restored.db');
  await assert.rejects(restoreDatabase(backup, target), code(4));
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(target), false);
  const done = await restoreDatabase(backup, target, { force: true, actor: 'human' });
  assert.equal(done.older_rules_accepted[0].export_set_version, 1);
  assert.equal(JSON.parse(readFileSync(rulesExportPath(path, 'team'), 'utf8')).set_version, 0, 'the forced restore rewrites the export');
});

test('a restore counts every export: a workspace the backup lacks, an unreadable export, another set at the same version', async t => {
  const { s, dir, path } = fixture(t);
  const backup = join(dir, 'before.db'); await backupDatabase(s, backup);
  const p = as(s, 'c', () => proposeRule(s, 'decisions.example', 'One'));
  as(s, 'human', () => answerQuestion(s, p.question_id, 'approve')); s.close();
  const exportPath = rulesExportPath(path, 'team'), kept = readFileSync(exportPath, 'utf8');
  writeFileSync(rulesExportPath(path, 'other'), JSON.stringify({ set_version: 1, digest: 'x' }));
  rmSync(exportPath);
  await assert.rejects(restoreDatabase(backup, join(dir, 'a.db')), /other/);
  writeFileSync(rulesExportPath(path, 'other'), 'not json');
  await assert.rejects(restoreDatabase(backup, join(dir, 'b.db')), /unreadable/);
  rmSync(rulesExportPath(path, 'other'));
  writeFileSync(exportPath, JSON.stringify({ ...JSON.parse(kept), set_version: 0 }));
  await assert.rejects(restoreDatabase(backup, join(dir, 'c.db')), code(4));
  writeFileSync(exportPath, kept);
  assert.equal((await restoreDatabase(path, join(dir, 'd.db'))).older_rules_accepted, undefined, 'a current copy restores');
  writeFileSync(rulesExportPath(path, 'other'), JSON.stringify({ set_version: 1, digest: 'x' }));
  await restoreDatabase(backup, join(dir, 'e.db'), { force: true, actor: 'human' });
  assert.equal(existsSync(rulesExportPath(path, 'other')), false, 'a forced restore drops the export of a workspace it lacks');
  assert.equal(JSON.parse(readFileSync(exportPath, 'utf8')).set_version, 0);
  for (const name of ['a.db', 'b.db', 'c.db']) assert.equal(existsSync(join(dir, name)), false);
});

test('the brief prints the rules in full; a session records reading them before it takes work', async t => {
  const { s, path } = fixture(t);
  const { registerSession, context, renderContext } = await import('../dist/coordination.js');
  const { addTask, takeTask } = await import('../dist/tasks.js');
  const { recordRulesLoaded } = await import('../dist/rules.js');
  const [first, second] = as(s, 'human', () => [addTask(s, { title: 'one', forRole: 'c' }), addTask(s, { title: 'two', forRole: 'c' })]);
  as(s, 'c', () => registerSession(s, { provider: 'claude', external_id: 'one' }));
  as(s, 'c', () => takeTask(s, first.id));
  const approve = (key, body, kind, scope) => { const p = as(s, 'a', () => proposeRule(s, key, body, { kind, scope })); as(s, 'human', () => answerQuestion(s, p.question_id, 'approve')); };
  approve('decisions.hello', 'Say hello first.\n\n  Then work.', 'always');
  approve('steps.merge', 'Before a merge: read the gate skill.\nMore.', 'step');
  approve('decisions.b-only', 'Only for b.', 'always', 'b');
  const brief = () => as(s, 'c', () => renderContext(context(s, { brief: true })));
  const text = brief(), sum = as(s, 'c', () => ruleSet(s, 'c')).digest;
  assert.match(text, /Rules in force for c: set 3 .* 1 always, 1 for a step/);
  assert.ok(text.includes('Say hello first.\n\n  Then work.'), 'an always rule keeps its lines');
  assert.match(text, /step steps\.merge \(version 1\): Before a merge: read the gate skill\. · in full: sas rule get steps\.merge/);
  assert.ok(!text.includes('Only for b.'), "another role's rule is not shown");
  assert.ok(text.includes(`sas rule loaded 3 ${sum.slice(0, 12)} --workspace team --as c`));
  assert.throws(() => as(s, 'c', () => takeTask(s, second.id)), code(3), 'no task before the record');
  assert.throws(() => as(s, 'c', () => recordRulesLoaded(s, 2, sum)), code(4), 'an older set is not recorded');
  assert.throws(() => as(s, 'c', () => recordRulesLoaded(s, 3, sum.slice(0, 8))), code(4), 'a short digest is not enough');
  assert.equal(cli(path, 'rule', 'loaded', '3', 'f'.repeat(12), '--as', 'c').status, 4);
  assert.throws(() => as(s, 'b', () => recordRulesLoaded(s, 3, sum)), code(3), 'only a registered session records');
  assert.equal(as(s, 'c', () => recordRulesLoaded(s, 3, sum.slice(0, 12))).set_version, 3);
  assert.match(brief(), /This session recorded reading set 3\./);
  assert.equal(as(s, 'c', () => takeTask(s, second.id)).status, 'doing');
  const cursor = as(s, 'c', () => context(s, { brief: true })).cursor;
  assert.ok(!as(s, 'c', () => renderContext(context(s, { brief: true, since: cursor }))).includes('Rules:'), 'a wake says nothing while the set is the one read');
  approve('decisions.later', 'Later.', 'always');
  assert.match(as(s, 'c', () => renderContext(context(s, { brief: true, since: cursor }))), /Rules: set 4 is in force and this session read 3; read them all: sas context --brief/);
});
