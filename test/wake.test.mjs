import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { send, inbox } from '../dist/coordination.js';
import { addTask, noteTask } from '../dist/tasks.js';
import { requestStop } from '../dist/control.js';
import { getNotificationProgress, saveNotificationProgress } from '../dist/notification-progress.js';
import { setWorkspaceSettings } from '../dist/workspace-settings.js';
import { wake, wakeText } from '../dist/wake.js';
import { fixtureConfig } from './fixtures/team.mjs';

// T977: sas wake, one call per wake.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sassato-wake-')), path = join(dir, 'state.db');
  const s = new Store(path, 'human', { create: true }); initWorkspace(s, 'team', fixtureConfig); s.use('team');
  const b = new Store(path, 'b'); b.use('team');
  t.after(() => { b.close(); s.close(); rmSync(dir, { recursive: true, force: true }); });
  const latest = () => Number(s.get('SELECT coalesce(max(id),0) n FROM events WHERE workspace_id=?', s.ws).n);
  saveNotificationProgress(b, { cursor: latest(), expected_version: 0 });
  return { s, b, dir, stopFile: join(dir, 'stop'), latest };
}
const as = (s, actor, fn) => { const old = s.actor; s.actor = actor; try { return fn(); } finally { s.actor = old; } };
// As the CLI does: print the text, then save the cursor (commit) and print its line.
const quick = async (f, more = {}) => {
  const out = await wake(f.b, { stopFile: f.stopFile, timeout: 3, settle: 1, settleMax: 2, ...more });
  const saved = out.commit?.();
  return { ...out, saved: saved?.saved ?? false, text: out.text + (saved ? `\n${saved.line}` : '') };
};

test('a wake prints each entry in full, saves the cursor and ends with the re-arm command', async t => {
  const f = fixture(t);
  const long = 'Please merge PR 42.\nSecond line with detail.';
  const m = as(f.s, 'a', () => send(f.s, ['b'], long, { urgent: true }));
  const out = await quick(f);
  assert.equal(out.saved, true);
  assert.match(out.text, new RegExp(`${m.id} · from a · urgent`));
  assert.match(out.text, /Please merge PR 42\.\n {4}Second line with detail\./);
  assert.match(out.text, new RegExp(`sassato wake --since ${out.result.cursor} --as b --workspace team --stop-file \\S+ --ack ${m.id}`));
  assert.equal(getNotificationProgress(f.b).cursor, out.result.cursor);
  // The save names the mail the printed wake listed (T1241), so stats can tell it from mail never listed.
  const saved = f.b.get("SELECT detail FROM events WHERE workspace_id=? AND entity='notification-progress' ORDER BY id DESC LIMIT 1", f.b.ws);
  assert.deepEqual(JSON.parse(saved.detail).delivered, [m.id]);
});

test('--ack acknowledges before waiting, and a quiet wake is one line', async t => {
  const f = fixture(t);
  const m = as(f.s, 'a', () => send(f.s, ['b'], 'Urgent once', { urgent: true }));
  const first = await quick(f);
  const second = await quick(f, { ack: [m.id], timeout: 1 });
  assert.deepEqual(second.acknowledged, [m.id]);
  assert.equal(second.text.split('\n').length, 3);
  assert.match(second.text, /^Acknowledged M\d+\.\nNothing new for b · cursor \d+ · re-arm: sassato wake --since \d+ --as b --workspace team --stop-file \S+\nCursor \d+ saved\.$/);
  assert.ok(second.result.cursor >= first.result.cursor);
});

test('a task entry carries its state, brief and latest note, and long text is cut with a marked tail', async t => {
  const f = fixture(t);
  const task = as(f.s, 'a', () => addTask(f.s, { title: 'Fix the gate', forRole: 'b', body: 'Brief: the gate fails on X.' }));
  as(f.s, 'a', () => noteTask(f.s, task.id, 'Started on it, then handed over.'));
  const out = await quick(f);
  assert.match(out.text, new RegExp(`${task.id} "Fix the gate" · open · owner - · for b · version \\d+`));
  assert.match(out.text, /Brief: the gate fails on X\./);
  assert.match(out.text, /Note \(a\): Started on it, then handed over\./);
  assert.equal(out.text.split(`  ${task.id} · from`).length, 2, 'a task woken twice prints once');
  assert.match(wakeText('x'.repeat(20), 'M9', 10), /^x{10}… \[cut at 10 characters; read it all: sassato show M9\]$/);
});

test('the cursor is not saved when progress moved during the wait', async t => {
  const f = fixture(t);
  const other = new Store(join(f.dir, 'state.db'), 'b'); other.use('team'); t.after(() => other.close());
  const timer = setTimeout(() => { as(f.s, 'a', () => send(f.s, ['human'], 'bump')); const p = getNotificationProgress(other); saveNotificationProgress(other, { cursor: f.latest(), expected_version: p.version }); }, 200);
  t.after(() => clearTimeout(timer));
  const before = getNotificationProgress(f.b).version;
  const out = await quick(f, { timeout: 1 });
  assert.equal(out.saved, false);
  assert.match(out.text, /NOT saved/);
  assert.ok(getNotificationProgress(f.b).version > before);
});

test('a stop is reported, nothing is saved, and no re-arm is offered', async t => {
  const f = fixture(t);
  const before = getNotificationProgress(f.b);
  writeFileSync(f.stopFile, '');
  const out = await quick(f);
  assert.equal(out.saved, false);
  assert.match(out.text, /^STOP: the stop file .* exists\..*do not re-arm\./);
  assert.doesNotMatch(out.text, /sassato wake --since/);
  assert.equal(getNotificationProgress(f.b).version, before.version);
  rmSync(f.stopFile);
  as(f.s, 'human', () => requestStop(f.s, ['b'], {}));
  const stopped = await quick(f);
  assert.match(stopped.text, /STOP R\d+ for b\..*sassato stopped R\d+ --as b --workspace team/);
});

test('digest_skip leaves out the kinds a role never acts on', async t => {
  const f = fixture(t);
  as(f.s, 'human', () => setWorkspaceSettings(f.s, { digest_skip: { b: ['mail'] } }));
  assert.throws(() => as(f.s, 'human', () => setWorkspaceSettings(f.s, { digest_skip: { b: ['urgent'] } })), /must list kinds among/);
  as(f.s, 'a', () => send(f.s, ['b'], 'Ordinary mail only'));
  const quiet = await quick(f, { timeout: 1 });
  assert.match(quiet.text, /^Nothing new for b/);
  as(f.s, 'a', () => send(f.s, ['b'], 'Urgent still wakes', { urgent: true }));
  const woken = await quick(f);
  assert.match(woken.text, /Urgent still wakes/);
});

test('inbox lists newest first', t => {
  const f = fixture(t);
  const first = as(f.s, 'a', () => send(f.s, ['b'], 'older'));
  const second = as(f.s, 'a', () => send(f.s, ['b'], 'newer'));
  const rows = inbox(f.b, { peek: true, state: 'unread' });
  assert.deepEqual(rows.map(r => r.id), [second.id, first.id]);
});

test('a --since past the saved cursor is refused, and wake needs saved progress', async t => {
  const f = fixture(t);
  const saved = getNotificationProgress(f.b).cursor;
  as(f.s, 'a', () => send(f.s, ['human'], 'events after the cursor'));
  await assert.rejects(quick(f, { since: saved + 1 }), /past the saved cursor/);
  const fresh = new Store(join(f.dir, 'state.db'), 'a'); fresh.use('team'); t.after(() => fresh.close());
  await assert.rejects(wake(fresh, { stopFile: f.stopFile, timeout: 1 }), /No saved notification progress/);
  const m = as(f.s, 'a', () => send(f.s, ['b'], 'Not to be acknowledged by a refused wake', { urgent: true }));
  await assert.rejects(quick(f, { since: saved + 5, ack: [m.id] }), /past the saved cursor/);
  assert.equal(inbox(f.b, { peek: true, state: 'unread' }).some((r) => r.id === m.id), true, 'a refused wake acknowledges nothing');
});

test('kinds that can concern a role\'s own work cannot be skipped', t => {
  const f = fixture(t);
  for (const kind of ['task-ready', 'dependency-dropped', 'urgent', 'review-submitted'])
    assert.throws(() => as(f.s, 'human', () => setWorkspaceSettings(f.s, { digest_skip: { b: [kind] } })), /must list kinds among/);
});

test('nothing is saved until the caller commits, after printing', async t => {
  const f = fixture(t);
  as(f.s, 'a', () => send(f.s, ['b'], 'Deliver me first', { urgent: true }));
  const before = getNotificationProgress(f.b);
  const out = await wake(f.b, { stopFile: f.stopFile, timeout: 3, settle: 1, settleMax: 2 });
  assert.equal(getNotificationProgress(f.b).version, before.version, 'not saved before commit');
  assert.equal(out.commit().saved, true);
  assert.equal(getNotificationProgress(f.b).cursor, out.result.cursor);
});

test('the re-arm keeps the idle wake it was given', async t => {
  const f = fixture(t);
  const out = await quick(f, { timeout: 1, idleMinutes: 50 });
  assert.match(out.text, /re-arm: sassato wake --since \d+ --idle-minutes 50 --as b --workspace team/);
});

import { enrollPendingWake, closePendingWake, stagePendingWake } from '../dist/pending-wake.js';
import { registerSession } from '../dist/coordination.js';
import { waitForWork } from '../dist/mail-wait.js';
import { resumeWork } from '../dist/control.js';
import { spawnSync } from 'node:child_process';

async function staged(t) {
  const f=fixture(t),thread='a5ae8567-d7ae-408a-9748-798fc3bac37a';
  const session=registerSession(f.b,{provider:'codex',external_id:thread});
  const binding={session:Number(session.id.slice(1)),thread};
  const epoch=enrollPendingWake(f.b,binding);
  const progress=getNotificationProgress(f.b);
  const mail=as(f.s,'a',()=>send(f.s,['b'],'Urgent sample',{urgent:true,now:true}));
  const result=await waitForWork(f.b,{since:progress.cursor});
  stagePendingWake(f.b,epoch,progress,result);
  return {...f,epoch,binding,progress,result,mail,thread};
}
function pendingCli(f,thread=f.thread,...args) {
  return spawnSync(process.execPath,['bin/sassato.js','wake','--pending','--db',f.b.path,'--as','b','--workspace','team',...args],
    {encoding:'utf8',env:{...process.env,CODEX_THREAD_ID:thread}});
}
test('pending CLI prints original digest, advances once and leaves mail unacknowledged',async t=>{
  const f=await staged(t);
  assert.throws(()=>stagePendingWake(f.b,f.epoch,f.progress,f.result),/already pending/);
  assert.equal(pendingCli(f,'different').status,4);
  assert.equal(pendingCli(f,f.thread,'--ack',f.mail.id).status,2);
  assert.deepEqual(getNotificationProgress(f.b),f.progress);
  const read=pendingCli(f,f.thread,'--json');
  assert.equal(read.status,0,read.stderr);
  assert.match(JSON.parse(read.stdout).text,/Urgent sample/);
  assert.doesNotMatch(read.stdout,/re-arm in the same response/);
  assert.equal(pendingCli(f).status,4);
  assert.equal(getNotificationProgress(f.b).cursor,f.result.cursor);
  assert.equal(inbox(f.b,{peek:true}).length,1);
  // The consumed wake's save names the mail it printed (T1241).
  const saved=f.b.get("SELECT detail FROM events WHERE workspace_id=? AND entity='notification-progress' ORDER BY id DESC LIMIT 1",f.b.ws);
  assert.deepEqual(JSON.parse(saved.detail).delivered,[f.mail.id]);
});
test('a consumed pending wake saves every mail it printed, the still-to-acknowledge list too (T1241)',async t=>{
  const f=await staged(t);
  const extra=as(f.s,'a',()=>send(f.s,['b'],'Answer when you can',{needsReply:true}));
  const read=pendingCli(f);
  assert.equal(read.status,0,read.stderr);
  assert.match(read.stdout,new RegExp(`still to acknowledge:\\n  ${extra.id}`));
  const saved=f.b.get("SELECT detail FROM events WHERE workspace_id=? AND entity='notification-progress' ORDER BY id DESC LIMIT 1",f.b.ws);
  assert.deepEqual(JSON.parse(saved.detail).delivered.sort(),[f.mail.id,extra.id].sort());
});
test('STOP supersedes pending work and resume requires a fresh enrollment',async t=>{
  const f=await staged(t);
  requestStop(f.s,['b']);
  assert.match(pendingCli(f).stdout,/^STOP R/);
  assert.deepEqual(getNotificationProgress(f.b),f.progress);
  resumeWork(f.s,['b']);
  assert.equal(pendingCli(f).status,4);
  closePendingWake(f.b,f.epoch);
  const next=enrollPendingWake(f.b,f.binding);
  assert.notEqual(next,f.epoch);
  assert.equal(pendingCli(f).status,4);
});
test('pending wakes refuse changed progress and superseded sessions',async t=>{
  const f=await staged(t);
  saveNotificationProgress(f.b,{cursor:f.latest(),expected_version:f.progress.version});
  assert.equal(pendingCli(f).status,4);
  closePendingWake(f.b,f.epoch);
  registerSession(f.b,{provider:'codex',external_id:'different',replace:true});
  assert.throws(()=>enrollPendingWake(f.b,f.binding),/binding changed/);
});
test('a competing receipt or STOP at commit cannot advance a pending digest twice',async t=>{
  const f=await staged(t);
  const {readPendingWake}=await import('../dist/pending-wake.js');
  const one=readPendingWake(f.b,f.thread),two=readPendingWake(f.b,f.thread);
  one.commit();
  assert.throws(()=>two.commit(),/consumed|replaced/);
  const progress=getNotificationProgress(f.b);
  const task=as(f.s,'a',()=>addTask(f.s,{title:'Later task',forRole:'b'}));
  const idle={role:'b',reason:'open-work',cursor:f.latest(),task:task.id,tasks:[task.id]};
  stagePendingWake(f.b,f.epoch,progress,idle);
  const pending=readPendingWake(f.b,f.thread);
  assert.deepEqual(pending.result.tasks,[task.id]);
  requestStop(f.s,['b']);
  assert.throws(()=>pending.commit(),/STOP/);
  assert.deepEqual(getNotificationProgress(f.b),progress);
});
test('a configured stop file observed on receipt closes its enrollment durably',async t=>{
  const f=await staged(t);
  setWorkspaceSettings(f.s,{stop_file:f.stopFile});
  writeFileSync(f.stopFile,'');
  assert.match(pendingCli(f).stdout,/STOP: the stop file/);
  rmSync(f.stopFile);
  assert.equal(pendingCli(f).status,4);
  assert.deepEqual(getNotificationProgress(f.b),f.progress);
});

test('a repeated --ack acknowledges every mail named; another option given twice keeps its last value (T1545)', (t) => {
  const f = fixture(t);
  const one = as(f.s, 'a', () => send(f.s, ['b'], 'first', { urgent: true })), two = as(f.s, 'a', () => send(f.s, ['b'], 'second', { urgent: true }));
  const cli = (...args) => spawnSync(process.execPath, ['bin/sassato.js', ...args, '--db', f.b.path, '--as', 'b', '--workspace', 'team'], { encoding: 'utf8' });
  const r = cli('wake', '--timeout', '1', '--settle', '0', '--stop-file', f.stopFile, '--ack', one.id, '--ack', two.id);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`Acknowledged ${one.id}, ${two.id}\\.`));
  assert.deepEqual(f.s.all('SELECT state FROM receipts WHERE message_id IN (?,?) ORDER BY message_id', ...[one.id, two.id].map((id) => Number(String(id).replace(/^M/, '')))).map((r) => r.state), ['done', 'done']);
  const twice = cli('inbox', '--limit', 'none', '--limit', '5', '--workspace', 'team');
  assert.equal(twice.status, 0, twice.stderr);
  assert.notEqual(cli('inbox', '--limit', 'none', '--workspace', 'team').status, 0, 'the first value alone is refused');
});
