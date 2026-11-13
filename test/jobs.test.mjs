import { fixtureConfig } from './fixtures/team.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { admit, enqueue, needOf, releaseStale, jobStats, REFUSED } from '../dist/jobs.js';

const bin = resolve('bin/sassato.js');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sassato-jobs-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'state.db'), s = new Store(db, 'human', { create: true });
  initWorkspace(s, 'team', fixtureConfig); s.close();
  const meminfo = join(dir, 'meminfo');
  const memory = (availableMb, totalMb = 20_000) => writeFileSync(meminfo, `MemTotal: ${totalMb * 1024} kB\nMemAvailable: ${availableMb * 1024} kB\n`);
  memory(16_000);
  const store = role => { const x = new Store(db, role); x.use('team'); t.after(() => { try { x.close(); } catch {} }); return x; };
  const env = { ...process.env, SASSATO_ROLE: '', SASSATO_WORKSPACE: '', SASSATO_DB: '', SASSATO_JOB_MEMINFO: meminfo, SASSATO_JOB_CORES: '8', SASSATO_JOB_RESERVE_MB: '3072' };
  const cli = (role, args) => spawnSync(process.execPath, [bin, '--db', db, '--workspace', 'team', '--as', role, ...args], { encoding: 'utf8', env });
  return { db, memory, store, cli, env, m: (availableMb, totalMb = 20_000) => ({ availableMb, totalMb, cores: 8, reserveMb: 3072 }) };
}
// A waiting job owned by a process that is alive (this test's own).
const ask = (s, kind, m) => enqueue(s, kind, ['true'], m);
const set = (s, id, fields) => { for (const [k, v] of Object.entries(fields)) s.run(`UPDATE jobs SET ${k}=? WHERE id=?`, v, id); };

test('a job starts when the memory left after running jobs and the reserve covers its need', t => {
  const f = fixture(t), s = f.store('a');
  const gate = ask(s, 'gate', f.m(16_000));
  assert.deepEqual(admit(s, gate, f.m(16_000)), { start: true });
  set(s, gate, { status: 'running', started_at: new Date().toISOString(), current_mb: 1000 });
  // The gate may still grow by 6144-1000 MB: 16000-5144-3072 = 7784 MB of room.
  const bench = ask(f.store('c'), 'benchmark', f.m(16_000));
  const d = admit(s, bench, f.m(16_000));
  assert.equal(d.start, false); assert.match(d.reason, /cores/); // a gate takes every core
  set(s, gate, { cpu_need: 4 });
  assert.deepEqual(admit(s, bench, f.m(16_000)), { start: true });
  const low = admit(s, bench, f.m(9_000)); // 9000-5144-3072 = 784 MB
  assert.equal(low.start, false); assert.match(low.reason, /needs 3072 MB; 9000 MB is available, running jobs may grow by 5144 MB/);
});

test('a later small job never starts ahead of a waiting large one, and turns go by role', t => {
  const f = fixture(t), a = f.store('a'), c = f.store('c');
  const gate = ask(a, 'gate', f.m(5_000));
  const small = ask(c, 'other', f.m(5_000));
  assert.match(admit(c, small, f.m(5_000)).reason, new RegExp(`J${gate} \\(gate, a\\) goes first`));
  // Role a has started a job since the oldest waiting one asked: c's job now goes first.
  const earlier = ask(a, 'other', f.m(5_000));
  set(a, earlier, { status: 'done', started_at: new Date(Date.now() + 1000).toISOString() });
  assert.deepEqual(admit(c, small, f.m(16_000)), { start: true });
});

test('a need the machine can never meet is refused at once', t => {
  const f = fixture(t), s = f.store('a');
  const gate = ask(s, 'gate', f.m(8_000, 8_000));
  const d = admit(s, gate, f.m(8_000, 8_000));
  assert.equal(d.never, true); assert.match(d.reason, /machine has 8000 MB/);
});

test('a kind asks for its highest of five measured runs of its version plus a fifth, else plus half', t => {
  const f = fixture(t), s = f.store('a');
  assert.deepEqual(needOf(s, 'evolution', 8), { mb: 4096, cpus: 2, margin: 0, measured: null });
  assert.deepEqual(needOf(s, 'something-new', 8), { mb: 2048, cpus: 1, margin: 0, measured: null });
  const run = (version, peak, cpu) => { const id = enqueue(s, 'evolution', ['true'], f.m(16_000), process.pid, { version }); set(s, id, { status: 'done', exit_code: 0, peak_mb: peak, cpu_s: cpu, wall_s: 100 }); };
  run('v1', 1000, 100); run('v1', 2500, 200); run('v1', 1200, 50);
  assert.deepEqual(needOf(s, 'evolution', 8, { version: 'v1' }), { mb: 3000, cpus: 2.4, margin: 1.2, measured: 2500 });
  // A new version with fewer than two runs: the latest five of any version, plus half.
  assert.equal(needOf(s, 'evolution', 8, { version: 'v2' }).mb, 3750);
  run('v2', 800, 10);
  assert.equal(needOf(s, 'evolution', 8, { version: 'v2' }).mb, 3750);
  run('v2', 900, 10);
  assert.equal(needOf(s, 'evolution', 8, { version: 'v2' }).mb, 1080);
  // The session's estimate raises the need, never lowers it.
  assert.equal(needOf(s, 'evolution', 8, { version: 'v2', load: 'more' }).mb, 1350);
  assert.equal(needOf(s, 'evolution', 8, { version: 'v2', load: 'less' }).mb, 1080);
  assert.equal(needOf(s, 'evolution', 8, { version: 'v2', mem: 5000 }).mb, 5000);
  assert.equal(needOf(s, 'evolution', 8, { version: 'v2', mem: 100 }).mb, 1080);
  // A run still going that passed the need counts at once.
  const going = enqueue(s, 'evolution', ['true'], f.m(16_000), process.pid, { version: 'v2' });
  set(s, going, { status: 'running', peak_mb: 2000, current_mb: 2000 });
  assert.equal(needOf(s, 'evolution', 8, { version: 'v2' }).mb, 2400);
  assert.match(f.cli('a', ['job', 'run', '--kind', 'other', '--load', 'lots', '--', 'true']).stderr, /--load takes more, same or less/);
});

test('a running job past its need claims its present use plus a fifth', t => {
  const f = fixture(t), s = f.store('a');
  const big = ask(s, 'benchmark', f.m(16_000)); // needs 3072
  set(s, big, { status: 'running', started_at: new Date().toISOString(), current_mb: 5000 });
  const next = ask(f.store('c'), 'other', f.m(16_000)); // needs 2048
  // 9000 available, the running job may grow by 1000 more (6000 - 5000), 3072 kept: 4928 of room.
  assert.deepEqual(admit(s, next, f.m(9_000)), { start: true });
  assert.match(admit(s, next, f.m(6_000)).reason, /running jobs may grow by 1000 MB/);
});

test('a job whose owner is gone is released', t => {
  const f = fixture(t), s = f.store('a');
  const child = spawnSync('true'); assert.equal(child.status, 0);
  const id = enqueue(s, 'benchmark', ['true'], f.m(16_000), child.pid); // the owner has exited
  set(s, id, { status: 'running' });
  assert.equal(releaseStale(s).length, 1);
  assert.equal(s.get('SELECT status FROM jobs WHERE id=?', id).status, 'released');
});

test('job run runs the command, keeps its exit status and measures its memory', { timeout: 60_000 }, t => {
  const f = fixture(t);
  for (const scope of ['0', undefined]) {
    if (scope === undefined && spawnSync('systemd-run', ['--user', '--scope', '-q', 'true']).status !== 0) continue;
    f.env.SASSATO_JOB_SCOPE = scope ?? '';
    const r = f.cli('c', ['job', 'run', '--kind', 'benchmark', '--', process.execPath, '-e', 'const b=Buffer.alloc(200*1024*1024,1);setTimeout(()=>process.exit(b[0]+2),3000)']);
    assert.equal(r.status, 3, r.stderr);
  }
  const stats = JSON.parse(f.cli('c', ['job', 'stats', '--json']).stdout);
  const bench = stats.find(k => k.kind === 'benchmark');
  assert.ok(bench.runs >= 1);
  assert.ok(bench.peak_mb >= 150, `peak ${bench.peak_mb} MB`);
  assert.equal(bench.failed, bench.runs);
});

test('job run --no-wait is refused while there is no room, and says why', t => {
  const f = fixture(t);
  f.memory(4_000);
  const r = f.cli('a', ['job', 'run', '--kind', 'gate', '--no-wait', '--', 'true']);
  assert.equal(r.status, REFUSED);
  assert.match(r.stderr, /not started: gate needs 6144 MB; 4000 MB is available/);
  const list = JSON.parse(f.cli('a', ['job', 'list', '--json']).stdout);
  assert.equal(list.jobs.length, 0); assert.equal(list.room_mb, 4000 - 3072);
});

test('job run waits for room, then starts', { timeout: 30_000 }, async t => {
  const f = fixture(t);
  f.memory(4_000);
  const child = spawn(process.execPath, [bin, '--db', f.db, '--workspace', 'team', '--as', 'a', 'job', 'run', '--kind', 'other', '--', 'true'], { env: f.env });
  let err = ''; child.stderr.on('data', d => { err += d; });
  await new Promise(done => setTimeout(done, 2500));
  assert.match(err, /waits: other needs 2048 MB; 4000 MB is available/);
  assert.match(JSON.stringify(JSON.parse(f.cli('a', ['job', 'list', '--json']).stdout).jobs), /"status":"waiting"/);
  f.memory(16_000);
  const status = await new Promise(done => child.on('exit', done));
  assert.equal(status, 0, err);
  assert.match(err, /starts/);
});

test('job run names the processes a job leaves behind', { timeout: 30_000 }, t => {
  const f = fixture(t);
  f.env.SASSATO_JOB_SCOPE = '0';
  const r = f.cli('c', ['job', 'run', '--kind', 'other', '--', 'bash', '-c', 'sleep 20 >/dev/null 2>&1 & exit 0']);
  assert.equal(r.status, 0, r.stderr);
  const left = /left 1 process running: (\d+) \(sleep\)/.exec(r.stderr);
  assert.ok(left, r.stderr);
  process.kill(Number(left[1]));
  const s = f.store('c');
  assert.match(jobStats(s).length ? s.get('SELECT orphans FROM jobs').orphans : '', /sleep/);
});

test('job commands check their flags', t => {
  const f = fixture(t);
  assert.notEqual(f.cli('a', ['job', 'run', '--kind', 'gate', '--wait', '--no-wait', '--', 'true']).status, 0);
  assert.match(f.cli('a', ['job', 'run', '--kind', 'gate']).stderr, /Give the command after --/);
  assert.match(f.cli('a', ['job', 'run', '--', 'true']).stderr, /Missing --kind/);
});

test('runs that fail or are cut off early never lower the need, but a high peak of theirs raises it', t => {
  const f = fixture(t), s = f.store('a');
  const row = (fields) => { const id = enqueue(s, 'gate', ['true'], f.m(16_000)); set(s, id, fields); };
  row({ status: 'done', exit_code: 0, peak_mb: 5000, cpu_s: 10, wall_s: 10 });
  row({ status: 'done', exit_code: 0, peak_mb: 5000, cpu_s: 10, wall_s: 10 });
  for (let i = 0; i < 5; i++) row({ status: i % 2 ? 'released' : 'done', exit_code: i % 2 ? null : 1, peak_mb: 40 });
  assert.equal(needOf(s, 'gate', 8).mb, 6000);
  row({ status: 'done', exit_code: 1, peak_mb: 7000 });
  assert.equal(needOf(s, 'gate', 8).mb, 8400);
});

test('a command keeps its own flags after --, also ones sassato knows', t => {
  const f = fixture(t);
  const r = f.cli('c', ['job', 'run', '--kind', 'other', '--', 'printf', '%s|', '--json', '--as', 'x', '--wait', '--mem', '5', '--kind', 'y']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '--json|--as|x|--wait|--mem|5|--kind|y|');
});

test('a signal to job run reaches every process of the job', { timeout: 30_000 }, async t => {
  const f = fixture(t);
  for (const scope of ['0', '']) {
    if (scope === '' && spawnSync('systemd-run', ['--user', '--scope', '-q', 'true']).status !== 0) continue;
    const marker = `sassato-signal-test-${process.pid}-${scope || 'scope'}`;
    const child = spawn(process.execPath, [bin, '--db', f.db, '--workspace', 'team', '--as', 'a', 'job', 'run', '--kind', 'other', '--', 'bash', '-c', `exec -a ${marker} sleep 30 & exec -a ${marker} sleep 30`], { env: { ...f.env, SASSATO_JOB_SCOPE: scope }, stdio: 'ignore' });
    const alive = () => spawnSync('pgrep', ['-f', `^${marker}`]).status === 0;
    for (let i = 0; i < 50 && !alive(); i++) await new Promise(done => setTimeout(done, 100));
    assert.ok(alive(), 'the job started');
    await new Promise(done => setTimeout(done, 500));
    child.kill('SIGTERM');
    await new Promise(done => child.on('exit', done));
    for (let i = 0; i < 30 && alive(); i++) await new Promise(done => setTimeout(done, 100));
    assert.equal(alive(), false, `no process of the job is left (${scope ? 'process group' : 'scope'})`);
  }
});
