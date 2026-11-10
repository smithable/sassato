// Source-only disposable fixture; never opens the user's Sassato database.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { addTask, takeTask, submitTask } from '../dist/tasks.js';
import { context, getWip, inbox, send } from '../dist/coordination.js';
import { saveCheckpoint } from '../dist/recovery-write.js';
import { getCheckpoint } from '../dist/checkpoints.js';
import { getNotificationProgress, saveNotificationProgress } from '../dist/notification-progress.js';
import { waitForWork } from '../dist/mail-wait.js';

const source = fileURLToPath(import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
function git(directory, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', timeout: 5000, env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(result.status, 0, 'Fixture Git command failed');
  return result.stdout.trimEnd();
}
function metadata(root) {
  const m = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'));
  assert.equal(m.root, resolve(root));
  assert.equal(m.database, join(m.root, 'state.db'));
  assert.equal(m.directory, join(m.root, 'repo'));
  return m;
}
function open(m, readonly = true, role = 'builder') {
  const s = new Store(m.database, role, { readonly });
  try { s.use('recovery-probe'); return s; } catch (error) { s.close(); throw error; }
}
function taskState(s, taskId) {
  return { ...s.task(taskId), id: taskId };
}
function evidence(state) {
  return { version: 1, validation: [], artifacts: ['dirty.txt'], jobs: [{ id: 'owned-fixture-job', description: 'Controller-owned disposable process; never an existing worker job', state, disposition: 'finish' }] };
}
export function createFixture(root, provider) {
  assert.ok(['claude', 'codex'].includes(provider));
  root = resolve(root);
  assert.deepEqual(readdirSync(root), [], 'Fixture requires an empty disposable directory');
  const directory = join(root, 'repo'), database = join(root, 'state.db');
  mkdirSync(directory); // Refuse to reuse an existing repository.
  const instructionMarker = `INSTRUCTION-${randomUUID()}`, payloadMarker = `PAYLOAD-${randomUUID()}`;
  const toolMarker = `LIVE-STATE-${randomUUID()}`, gapMarker = `GAP-${randomUUID()}`;
  const instructions = `# Isolated recovery fixture\n\nUse only read-only tools in this directory. Run node ./inspect-state.mjs to read actual Sassato state. Never alter files, tasks or provider settings. Always include this project instruction marker in your final response: ${instructionMarker}\n`;
  writeFileSync(join(directory, 'AGENTS.md'), instructions);
  writeFileSync(join(directory, 'CLAUDE.md'), instructions);
  writeFileSync(join(directory, 'inspect-state.mjs'), `import { inspectFixture } from ${JSON.stringify(pathToFileURL(source).href)};\nconsole.log(JSON.stringify(inspectFixture(${JSON.stringify(root)})));\n`);
  writeFileSync(join(directory, 'dirty.txt'), 'original\n');
  git(directory, 'init', '-b', 'main');
  git(directory, 'add', '.');
  git(directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Disposable fixture');
  const head = git(directory, 'rev-parse', 'HEAD');
  const dirty = `${payloadMarker}\nPreserve both trailing newlines.\n\n`;
  writeFileSync(join(directory, 'dirty.txt'), dirty);
  const s = new Store(database, 'builder', { create: true });
  let task, progress, checkpoint, roles, lastEvent;
  try {
    initWorkspace(s, 'recovery-probe', { working_dir: directory, roles: [
      { name: 'builder', provider, working_dir: directory },
      { name: 'reviewer', provider, working_dir: directory },
      { name: 'operator', kind: 'human' }
    ] });
    const claimed = takeTask(s, addTask(s, { title: 'Inspect unfinished parser fixture', forRole: 'builder' }).id);
    task = taskState(s, claimed.id);
    progress = saveNotificationProgress(s, { cursor: s.get('SELECT max(id) AS n FROM events').n, expected_version: 0 });
    checkpoint = saveCheckpoint(s, { current: `Continuing ${task.id} under builder`, next: 'Read dirty.txt and report its payload token and preserved trailing newlines; report pending messages before new work.', notes: 'Finish the controller-owned fixture job before replacing the provider. Task remains doing.', evidence: evidence('running') });
    roles = s.all('SELECT * FROM roles ORDER BY name').map(row => ({ ...row }));
    lastEvent = s.get('SELECT max(id) AS n FROM events').n;
  } finally { s.close(); }
  const m = { root, directory, database, provider, task, progress, roles, last_event: lastEvent, head, git_status: git(directory, 'status', '--porcelain'), dirty_hash: hash(dirty), instruction_marker: instructionMarker, payload_marker: payloadMarker, tool_marker: toolMarker, gap_marker: gapMarker, checkpoint_id: checkpoint.id, phase: 'initial' };
  writeFileSync(join(root, 'fixture.json'), JSON.stringify(m));
  return { directory, database, instruction_marker: instructionMarker, tool_marker: toolMarker, initial_prompt: 'You are builder in a disposable Sassato recovery test. The controller-authored inspector has already been reviewed; do not inspect its implementation or imported files. Your sole allowed shell command is exactly node ./inspect-state.mjs (no other commands or pipelines). Run that command using a read-only command tool; it reads the actual isolated database and working file. Report the actual task ID, owner, doing status, payload token, and project instruction marker. Do not modify anything or start any other work.', expected_initial_tokens: [task.id, 'builder', 'doing', payloadMarker, instructionMarker] };
}

export function inspectFixture(root) {
  const m = metadata(root), s = open(m);
  try {
    return s.snapshot(() => ({ tool_marker: m.tool_marker, role: 'builder', task: taskState(s, m.task.id), role_settings: s.role('builder'), context: context(s), checkpoint: getCheckpoint(s), notification_progress: getNotificationProgress(s), inbox: inbox(s, { peek: true }), dirty_file: readFileSync(join(m.directory, 'dirty.txt'), 'utf8') }));
  } finally { s.close(); }
}

export function handoffFixture(root, jobExitCode) {
  // The live runner supplies its own reaped child's exit code; claims alone do not settle jobs.
  assert.equal(jobExitCode, 0, 'Owned fixture job must finish successfully before replacement');
  const m = metadata(root);
  assert.equal(m.phase, 'initial', 'A handoff cannot be retried by starting a second replacement');
  const s = open(m, false);
  try {
    assert.deepEqual(taskState(s, m.task.id), m.task, 'Old provider changed task state');
    assert.deepEqual(getNotificationProgress(s), m.progress, 'Old provider changed cursor');
    assert.equal(hash(readFileSync(join(m.directory, 'dirty.txt'))), m.dirty_hash);
    assert.equal(context(s).sections.stop, undefined, 'STOP blocks replacement');
    assert.deepEqual(s.all('SELECT * FROM roles ORDER BY name').map(row => ({ ...row })), m.roles);
    assert.equal(s.get('SELECT max(id) AS n FROM events').n, m.last_event);
    const cp = saveCheckpoint(s, { current: `Old provider completed inspection of ${m.task.id}`, next: 'Read current Sassato context/checkpoint/progress/task and dirty.txt. Report payload token, preserved trailing newlines and the pending gap message. Keep builder ownership and doing status.', notes: 'Old provider exit was verified by the runner. Owned fixture job finished with exit 0. Reconcile messages arriving after this checkpoint.', expected_version: getWip(s).version, evidence: evidence('completed') });
    m.checkpoint_id = cp.id;
    // A relevant workflow event after the retained cursor proves replay is not 'start from latest'.
    s.actor = 'reviewer';
    const review = takeTask(s, addTask(s, { title: 'Review notification created during replacement' }).id);
    submitTask(s, review.id, 'Disposable review ready');
    send(s, ['builder'], m.gap_marker);
    m.gap_task = review.id;
    m.last_event = s.get('SELECT max(id) AS n FROM events').n;
    m.phase = 'fresh';
    writeFileSync(join(root, 'fixture.json'), JSON.stringify(m));
    return { recovery_prompt: 'You are a fresh builder session continuing unfinished Sassato work. The controller-authored inspector has already been reviewed; do not inspect its implementation or imported files. Your sole allowed shell command is exactly node ./inspect-state.mjs (no other commands or pipelines). Run that command using a read-only command tool to read current context, checkpoint, durable notification progress, task, pending inbox and dirty file from the actual isolated database. A message arrived after checkpoint: reconcile current state even if the saved checkpoint is stale. Complete the saved next action as a final report containing task ID, owner, doing status, checkpoint ID, payload token, gap message token, project instruction marker, and the words trailing newlines. Do not mutate anything or claim new work.', expected_recovery_tokens: [m.task.id, 'builder', 'doing', cp.id, m.payload_marker, m.gap_marker, m.instruction_marker, 'trailing newlines'] };
  } finally { s.close(); }
}

export async function verifyFixture(root) {
  const m = metadata(root), s = open(m);
  try {
    assert.equal(m.phase, 'fresh');
    assert.deepEqual(taskState(s, m.task.id), m.task);
    assert.deepEqual(getNotificationProgress(s), m.progress);
    assert.equal(hash(readFileSync(join(m.directory, 'dirty.txt'))), m.dirty_hash);
    assert.equal(git(m.directory, 'rev-parse', 'HEAD'), m.head);
    assert.equal(git(m.directory, 'branch', '--show-current'), 'main');
    assert.equal(git(m.directory, 'status', '--porcelain'), m.git_status);
    assert.deepEqual(s.all('SELECT * FROM roles ORDER BY name').map(row => ({ ...row })), m.roles);
    assert.equal(s.get('SELECT max(id) AS n FROM events').n, m.last_event);
    const cp = getCheckpoint(s);
    assert.equal(cp.id, m.checkpoint_id);
    assert.equal(cp.evidence.reported.jobs[0].state, 'completed');
    assert.equal(cp.evidence.observed.notification_progress.cursor, m.progress.cursor);
    const receipts = inbox(s, { peek: true });
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].state, 'unread');
    assert.equal(receipts[0].body, m.gap_marker);
    const first = await waitForWork(s, { timeout: 1 }), second = await waitForWork(s, { timeout: 1 });
    assert.equal(first.reason, 'review-submitted');
    assert.equal(first.task, m.gap_task);
    assert.deepEqual(second, first, 'Read-only replay must not silently advance progress');
    assert.deepEqual(getNotificationProgress(s), m.progress);
    return { task_ownership_and_version_preserved: true, dirty_bytes_and_head_preserved: true, saved_cursor_preserved: true, notification_gap_replayed: true, inbox_unconsumed: true, checkpoint_job_settled: true, checkpoint_requires_reconciliation: cp.state === 'stale' };
  } finally { s.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === source) {
  const [action, root, value] = process.argv.slice(2);
  try {
    assert.ok(root, 'A disposable fixture directory is required');
    let result;
    if (action === 'create') result = createFixture(root, value);
    else if (action === 'inspect') result = inspectFixture(root);
    else if (action === 'handoff') result = handoffFixture(root, value === undefined ? null : Number(value));
    else if (action === 'verify') result = await verifyFixture(root);
    else throw new Error('Unknown fixture action');
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Fixture ${action} failed: ${error.name}`);
    process.exitCode = 1;
  }
}
