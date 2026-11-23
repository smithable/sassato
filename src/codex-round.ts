// The Codex round (T1193): once per Codex version, a throwaway probe role goes through what a watched role does
// (start, wake on mail, a long turn, stop) in a scratch database, with a hidden terminal in place of the window.
// launch --watched starts it after the real roles, detached, so a launch is never slower. A pass is recorded in the
// real database and later launches skip the round; a fail mails the escalation role and records no pass.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { check, name } from './errors.js';
import { endSession, registerSession, send } from './coordination.js';
import { bootstrapPrompt, resolveExecutable } from './launch.js';
import { launchDirectory } from './launch-admission.js';
import { closeRecorded, launchWatched } from './launch-watched.js';
import { initWorkspace } from './admin.js';
import { saveNotificationProgress } from './notification-progress.js';
import { stop } from './stop.js';
import { checkCodexVersion, workspaceSettings } from './workspace-settings.js';
import { Store, type Row } from './storage.js';

const PROBE = 'probe', WORKSPACE = 'round';
const bin = fileURLToPath(new URL('../bin/sassato.js', import.meta.url));
const helper = fileURLToPath(new URL('../bin/codex-round-term.py', import.meta.url));

export interface RoundTiming { seedMs: number; startMs: number; wakeMs: number; longMs: number; stopMs: number; sleepSeconds: number }
export const ROUND_TIMING: RoundTiming = { seedMs: 180_000, startMs: 60_000, wakeMs: 180_000, longMs: 300_000, stopMs: 120_000, sleepSeconds: 90 };
export interface RoundOptions { force?: boolean; model?: string; timing?: Partial<RoundTiming>; keep?: boolean }

/** Whether a round already passed on this Codex version. */
export function roundPassed(s: Store, version: string): boolean {
  return !!s.get("SELECT 1 FROM events WHERE workspace_id=? AND entity='codex-round' AND entity_id=? AND action='passed' LIMIT 1", s.ws, version);
}

/** After this many failures on a version, launch --watched skips its round until codex round --force (T1286). */
export const ROUND_TRIES = 2;
/** How many rounds failed on this version. */
export function roundFailures(s: Store, version: string): number {
  return Number(s.get("SELECT count(*) AS n FROM events WHERE workspace_id=? AND entity='codex-round' AND entity_id=? AND action='failed'", s.ws, version)?.n ?? 0);
}
function skipReason(s: Store, version: string): string | undefined {
  if (roundPassed(s, version)) return 'A round already passed on this version';
  const failed = roundFailures(s, version);
  if (failed >= ROUND_TRIES) return `The round failed ${failed} times on this version; it is skipped until codex round --force`;
}
/** The installed Codex version, or undefined when it cannot be read within the time given. */
export function installedCodexVersion(timeoutMs = 30_000): string | undefined {
  try {
    const probe = spawnSync(resolveExecutable('codex', true), ['--version'], { encoding: 'utf8', timeout: timeoutMs });
    return !probe.error && probe.status === 0 ? checkCodexVersion(String(probe.stdout)).version : undefined;
  } catch { return undefined; }
}
/** For launch --watched's output: the installed version's failures, when they hold its round back. */
export function roundHeldBack(s: Store, version: string | undefined): { version: string; failures: number } | null {
  if (!version || roundPassed(s, version)) return null;
  const failures = roundFailures(s, version);
  return failures >= ROUND_TRIES ? { version, failures } : null;
}

/** Which role hears of a failed round: the nudge's escalation role, else the default human. */
function notifyRole(s: Store): string | null {
  const settings = workspaceSettings(s);
  return settings.nudge_escalate ?? settings.default_human ?? null;
}

async function until<T>(read: () => T | undefined, waitMs: number): Promise<T | undefined> {
  for (const end = Date.now() + waitMs; Date.now() < end; await delay(500)) { const value = read(); if (value !== undefined) return value; }
  return read();
}
const alive = (pid: number | undefined) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

export async function codexRound(real: Store, options: RoundOptions = {}): Promise<Row> {
  real.requireHuman();
  const timing = { ...ROUND_TIMING, ...options.timing };
  let version = 'unknown', result: Row, release = () => {};
  // Every failure from here on is recorded and mailed, also one before the probe exists (T1193, Astra).
  try {
    try {
      const codex = resolveExecutable('codex', true);
      const probe = spawnSync(codex, ['--version'], { encoding: 'utf8', timeout: 30_000 });
      check(!probe.error && probe.status === 0, 'Cannot read the Codex version', 3);
      version = checkCodexVersion(String(probe.stdout)).version;
      let skip = options.force ? undefined : skipReason(real, version);
      if (skip) return { version, status: 'skipped', reason: skip };
      const claim = claimRound(real, version);
      if (!claim) return { version, status: 'skipped', reason: 'Another round on this version is running' };
      release = claim;
      // A round that passed, or failed for the last time, while this one waited for the claim is not repeated.
      skip = options.force ? undefined : skipReason(real, version);
      if (skip) return { version, status: 'skipped', reason: skip };
      result = await runRound(real, codex, version, options, timing);
    } catch (error) {
      result = { version, status: 'failed', step: 'setup', reason: error instanceof Error ? error.message : String(error) };
    }
    // The claim is held until the result is recorded, so a waiting round sees the pass.
    real.event('codex-round', version, String(result.status), { model: result.model, step: result.step, reason: result.reason, dir: result.dir });
    if (result.status === 'passed') { if (!options.keep) rmSync(String(result.dir), { recursive: true, force: true }); return result; }
    const to = notifyRole(real), failed = roundFailures(real, version);
    // The same order as skipReason, so the mail says what the next launch does.
    const next = version === 'unknown' ? 'The Codex version could not be read, so each launch --watched tries again.'
      : roundPassed(real, version) ? 'A round passed on this version before, so launch --watched does not run it again.'
      : failed >= ROUND_TRIES ? `It has failed ${failed} times on this version, so launch --watched skips it until codex round --force.`
      : 'The next launch --watched tries once more.';
    if (to) send(real, [to], `Codex round failed on ${version} at step "${result.step}": ${result.reason}.${result.dir ? ` Logs: ${result.dir}.` : ''} The roles started as usual. ${next}`, { urgent: true });
    return result;
  } finally { release(); }
}

/** One round per version at a time on the machine: an exclusive transaction on a small lock database beside the round
 * folders. SQLite's lock is the kernel's, so it is let go when the holder ends, however it ends, and no stale claim is
 * ever taken over by hand. Returns the release, or null while another round holds it. */
function claimRound(real: Store, version: string): (() => void) | null {
  const folder = join(launchDirectory(real.path, real.workspace), 'codex-round');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const lock = new DatabaseSync(join(folder, `${version}.lock`));
  try { lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
  catch (error) { lock.close(); if (/locked|busy/i.test(String((error as Error).message))) return null; throw error; }
  return () => { try { lock.exec('ROLLBACK'); } catch { /* ended */ } lock.close(); };
}

async function runRound(real: Store, codex: string, version: string, options: RoundOptions, timing: RoundTiming): Promise<Row> {
  const model = options.model ?? String(real.get("SELECT model FROM roles WHERE workspace_id=? AND kind='agent' AND provider='codex' AND model IS NOT NULL ORDER BY name LIMIT 1", real.ws)?.model ?? '');
  check(model, 'No Codex role names a model; give --model', 3);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(launchDirectory(real.path, real.workspace), 'codex-round', `${version}-${stamp}`), cwd = join(dir, 'cwd'), tools = join(dir, 'bin');
  const db = join(cwd, 'round.db');
  let scratch: Store;
  let made = false;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 }); made = true;
    for (const d of [cwd, tools]) mkdirSync(d, { recursive: true, mode: 0o700 });
    // The probe runs this build's sassato on the scratch database only.
    symlinkSync(bin, join(tools, 'sas')); symlinkSync(bin, join(tools, 'sassato'));
    scratch = new Store(db, 'human', { create: true });
  } catch (error) { return { version, model, ...made ? { dir } : {}, status: 'failed', step: 'setup', reason: error instanceof Error ? error.message : String(error) }; }
  // The round runs alone in its own process (launch --watched starts one; codex round is one), so the scratch identity
  // is set in this process's environment, which the server, the hidden terminal and the watcher inherit.
  const saved = { db: process.env.SASSATO_DB, workspace: process.env.SASSATO_WORKSPACE, role: process.env.SASSATO_ROLE, path: process.env.PATH };
  let step = 'setup', result: Row = { version, model, dir, status: 'failed' };
  // The sessions of the round's processes are noted while they run, so the sweep finds an orphan whose parent ended.
  const sessions = new Set<number>(), sharedSessions = new Set<number>(), note = () => { roundProcesses(db, sessions, sharedSessions); };
  try {
    initWorkspace(scratch, WORKSPACE, { roles: [{ name: 'human', kind: 'human' }, { name: PROBE, provider: 'codex', working_dir: cwd, model, sandbox_mode: 'workspace-write', approval_policy: 'never' }] });
    scratch.use(WORKSPACE);
    Object.assign(process.env, { SASSATO_DB: db, SASSATO_WORKSPACE: WORKSPACE, PATH: `${tools}:${dirname(process.execPath)}:${saved.path ?? ''}` });
    delete process.env.SASSATO_ROLE;

    step = 'seed';
    const thread = await seed(codex, cwd, model, `${bootstrapPrompt(scratch, PROBE, 'codex', true)} This is a check of the tooling: reply ready and stop.`, join(dir, 'seed.log'), timing.seedMs);
    const worker = new Store(db, PROBE); worker.use(WORKSPACE);
    // A watcher enrolls only a role with saved notification progress; a new role starts at the beginning.
    try { registerSession(worker, { provider: 'codex', external_id: thread }); endSession(worker, thread); saveNotificationProgress(worker, { cursor: 0, expected_version: 0 }); } finally { worker.close(); }

    step = 'start';
    const term = join(dir, 'terminal.log');
    const started = await launchWatched(scratch, [PROBE], {
      waitMs: timing.startMs,
      openWindow: (exe, args, at) => {
        const child = spawn('python3', ['-I', '-B', helper, term], { cwd: at, detached: true, stdio: 'ignore', env: { ...process.env, TERM: 'xterm-256color', CODEX_ROUND_ARGV: JSON.stringify([exe, ...args]) } });
        child.on('error', () => {}); child.unref();
      },
    });
    check(started[0]?.status === 'started', `The probe did not start: ${started[0]?.warning ?? JSON.stringify(started[0])}`, 4);
    check(!started[0].warning, String(started[0].warning), 4);
    const watcher = Number(started[0].watcher);
    note();

    const ask = (body: string) => Number(String(send(scratch, [PROBE], body).id).replace(/^M/, ''));
    const doneAt = (message: number) => { const row = scratch.get("SELECT done_at FROM receipts WHERE workspace_id=? AND recipient=? AND message_id=? AND state='done'", scratch.ws, PROBE, message); return row ? Date.parse(String(row.done_at)) : undefined; };

    step = 'wake on mail';
    const first = ask(`Round check: acknowledge this mail with sas ack M{id} --as ${PROBE} --workspace ${WORKSPACE}, nothing else.`);
    check(await until(() => doneAt(first), timing.wakeMs), `M${first} was not acknowledged within ${timing.wakeMs / 1000} seconds`, 4);

    step = 'long turn';
    const askedAt = Date.now();
    const second = ask(`Round check: run the shell command sleep ${timing.sleepSeconds} in the foreground, wait for it to end, then acknowledge this mail with sas ack M{id} --as ${PROBE} --workspace ${WORKSPACE}.`);
    // The watcher must live through the turn, and the acknowledgement must come after the command could have ended.
    const acked = await until(() => alive(watcher) ? doneAt(second) : -1, timing.longMs);
    check(acked !== -1, 'The watcher stopped during the long turn', 4);
    check(acked !== undefined, `M${second} was not acknowledged within ${timing.longMs / 1000} seconds`, 4);
    check(acked! - askedAt >= timing.sleepSeconds * 1000 - 1000, `M${second} was acknowledged after ${Math.round((acked! - askedAt) / 1000)} seconds, before the ${timing.sleepSeconds} second command could end`, 4);

    note();
    step = 'stop';
    const stopped = await stop(scratch, [PROBE], { timeout: Math.ceil(timing.stopMs / 1000) });
    check(stopped.complete, `The probe did not report stopped within ${timing.stopMs / 1000} seconds`, 4);
    await closeRecorded(scratch, PROBE);
    check(await until(() => alive(watcher) ? undefined : true, 30_000), 'The watcher did not exit after the window and server closed', 4);
    result = { version, model, dir, status: 'passed', thread };
  } catch (error) {
    note();
    result = { ...result, step, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    for (const [key, value] of [['SASSATO_DB', saved.db], ['SASSATO_WORKSPACE', saved.workspace], ['SASSATO_ROLE', saved.role], ['PATH', saved.path]] as const)
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await closeRecorded(scratch, PROBE).catch(() => false);
    try { scratch.close(); } catch { /* recorded below if anything is left */ }
  }
  const left = await sweep(db, sessions, sharedSessions), problems = [
    ...left.own.length ? [`processes ${left.own.join(', ')} did not stop`] : [],
    ...left.shared.length ? [`Codex's shared daemon ${left.shared.join(', ')} was started by the round and carries its database; it was left running for the real sessions, restart it`] : [],
  ];
  if (problems.length && result.status === 'passed') result = { ...result, status: 'failed', step: 'cleanup' };
  if (problems.length) result = { ...result, reason: [result.reason, ...problems].filter(Boolean).join('; ') };
  return result;
}

/** The round's processes: every process started with the scratch database in its environment (the server, the hidden
 * terminal and the window, the watcher, the seed), every descendant of one (a command the probe ran), and every
 * process in a session one of them was in: `sessions` carries those across scans, so an orphan whose parent was
 * stopped is still found. This process's own session (a round run from a shell shares that shell's) never counts.
 * Nothing else has that database, which is new for each round. Codex's shared app-server daemon is never one, nor is
 * its session: real sessions may use it, so one the round happened to start is reported in `shared`, not stopped. */
export function roundProcesses(db: string, sessions = new Set<number>(), sharedSessions = new Set<number>()): { own: number[]; shared: number[] } {
  const pids = readdirSync('/proc').filter(pid => /^\d+$/.test(pid)).map(Number).filter(pid => pid !== process.pid);
  const marker = `SASSATO_DB=${db}`, parent = new Map<number, number>(), session = new Map<number, number>(), found = new Set<number>(), shared = new Set<number>();
  const stat = (pid: number) => { const text = readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = text.slice(text.lastIndexOf(')') + 2).split(' '); return { ppid: Number(fields[1]), sid: Number(fields[3]) }; };
  const mySession = stat(process.pid).sid;
  for (const pid of pids) {
    try { const { ppid, sid } = stat(pid); parent.set(pid, ppid); session.set(pid, sid); } catch { continue; }
    try { if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('/app-server-daemon/')) { shared.add(pid); continue; } } catch { continue; }
    try { if (readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(marker)) found.add(pid); } catch { /* gone or not ours */ }
  }
  // Sessions are seeded only from the processes carrying the database, never from a descendant found through them.
  for (const pid of found) { const sid = session.get(pid); if (sid) sessions.add(sid); }
  // A session the shared daemon was ever seen in stays excluded, also after the daemon ended.
  for (const pid of shared) { const sid = session.get(pid); if (sid) sharedSessions.add(sid); }
  const ours = (sid: number | undefined) => sid !== undefined && sid !== mySession && !sharedSessions.has(sid) && sessions.has(sid);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of parent) if (!found.has(pid) && !shared.has(pid) && (found.has(ppid) || ours(session.get(pid)))) { found.add(pid); grew = true; }
  }
  const sharedMine = [...shared].filter(pid => { try { return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(marker); } catch { return false; } });
  return { own: [...found], shared: sharedMine };
}

/** Stops the round's processes, so a failure at any step leaves nothing behind; returns what is still left. */
async function sweep(db: string, sessions: Set<number>, sharedSessions: Set<number>): Promise<{ own: number[]; shared: number[] }> {
  const own = () => roundProcesses(db, sessions, sharedSessions).own;
  const signal = (name: NodeJS.Signals) => { for (const pid of own()) try { process.kill(pid, name); } catch { /* gone */ } };
  signal('SIGTERM');
  if (!await until(() => own().length ? undefined : true, 10_000)) { signal('SIGKILL'); await until(() => own().length ? undefined : true, 5_000); }
  return roundProcesses(db, sessions, sharedSessions);
}

/** One short turn that leaves a saved thread whose first prompt is the probe's bootstrap; returns its id. */
async function seed(codex: string, cwd: string, model: string, prompt: string, logPath: string, waitMs: number): Promise<string> {
  const log = openSync(logPath, 'a', 0o600);
  try {
    const child = spawn(codex, ['exec', '--json', '--skip-git-repo-check', '-C', cwd, '-m', model, '-s', 'workspace-write', prompt], { cwd, stdio: ['ignore', 'pipe', log] });
    let out = '';
    child.stdout!.on('data', chunk => { out += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), waitMs);
    const code = await new Promise<number | null>(done => { child.once('exit', done); child.once('error', () => done(null)); });
    clearTimeout(timer);
    const thread = out.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } })
      .find(event => event?.type === 'thread.started' && typeof event.thread_id === 'string')?.thread_id;
    check(code === 0 && thread, `codex exec ended with ${code ?? 'a timeout'} and ${thread ? 'a' : 'no'} thread; see ${logPath}`, 4);
    return thread;
  } finally { closeSync(log); }
}

/** launch --watched's hook: the round as its own detached process, its output in codex-round.log. */
export function startRound(real: Store): number | undefined {
  const dir = launchDirectory(real.path, real.workspace);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = openSync(join(dir, 'codex-round.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [bin, 'codex', 'round', '--db', real.path, '--workspace', real.workspace, '--as', name(real.actor!)],
      { detached: true, stdio: ['ignore', log, log] });
    child.on('error', () => {}); child.unref();
    return child.pid;
  } finally { closeSync(log); }
}
