// The Codex round (T1193): once per Codex version, a throwaway probe role goes through what a watched role does
// (start, wake on mail, a long turn, stop) in a scratch database, with a hidden terminal in place of the window.
// launch --watched starts it after the real roles, detached, so a launch is never slower. A pass is recorded in the
// real database and later launches skip the round; a fail mails the escalation role and records no pass.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
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
  const codex = resolveExecutable('codex', true);
  const probe = spawnSync(codex, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  check(!probe.error && probe.status === 0, 'Cannot read the Codex version', 3);
  const { version } = checkCodexVersion(String(probe.stdout));
  if (!options.force && roundPassed(real, version)) return { version, status: 'skipped', reason: 'A round already passed on this version' };
  const model = options.model ?? String(real.get("SELECT model FROM roles WHERE workspace_id=? AND kind='agent' AND provider='codex' AND model IS NOT NULL ORDER BY name LIMIT 1", real.ws)?.model ?? '');
  check(model, 'No Codex role names a model; give --model', 3);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(launchDirectory(real.path, real.workspace), 'codex-round', `${version}-${stamp}`), cwd = join(dir, 'cwd'), tools = join(dir, 'bin');
  for (const d of [dirname(dir), dir, cwd, tools]) mkdirSync(d, { recursive: true, mode: 0o700 });
  // The probe runs this build's sassato on the scratch database only.
  symlinkSync(bin, join(tools, 'sas')); symlinkSync(bin, join(tools, 'sassato'));
  const db = join(cwd, 'round.db');
  const scratch = new Store(db, 'human', { create: true });
  const saved = { db: process.env.SASSATO_DB, workspace: process.env.SASSATO_WORKSPACE, role: process.env.SASSATO_ROLE, path: process.env.PATH };
  let step = 'setup', result: Row = { version, model, dir, status: 'failed' };
  try {
    initWorkspace(scratch, WORKSPACE, { roles: [{ name: 'human', kind: 'human' }, { name: PROBE, provider: 'codex', working_dir: cwd, model, sandbox_mode: 'workspace-write', approval_policy: 'never' }] });
    scratch.use(WORKSPACE);
    // Everything started from here (the server, the hidden terminal, the watcher) inherits the scratch identity.
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

    const ask = (body: string) => Number(String(send(scratch, [PROBE], body).id).replace(/^M/, ''));
    const done = (message: number) => scratch.get("SELECT 1 FROM receipts WHERE workspace_id=? AND recipient=? AND message_id=? AND state='done'", scratch.ws, PROBE, message) ? true : undefined;

    step = 'wake on mail';
    const first = ask(`Round check: acknowledge this mail with sas ack M{id} --as ${PROBE} --workspace ${WORKSPACE}, nothing else.`);
    check(await until(() => done(first), timing.wakeMs), `M${first} was not acknowledged within ${timing.wakeMs / 1000} seconds`, 4);

    step = 'long turn';
    const second = ask(`Round check: run the shell command sleep ${timing.sleepSeconds} in the foreground, wait for it to end, then acknowledge this mail with sas ack M{id} --as ${PROBE} --workspace ${WORKSPACE}.`);
    check(await until(() => done(second) ?? (alive(watcher) ? undefined : false), timing.longMs) === true,
      alive(watcher) ? `M${second} was not acknowledged within ${timing.longMs / 1000} seconds` : 'The watcher stopped during the long turn', 4);

    step = 'stop';
    const stopped = await stop(scratch, [PROBE], { timeout: Math.ceil(timing.stopMs / 1000) });
    check(stopped.complete, `The probe did not report stopped within ${timing.stopMs / 1000} seconds`, 4);
    await closeRecorded(scratch, PROBE);
    check(await until(() => alive(watcher) ? undefined : true, 30_000), 'The watcher did not exit after the window and server closed', 4);
    result = { version, model, dir, status: 'passed', thread };
  } catch (error) {
    result = { ...result, step, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await closeRecorded(scratch, PROBE).catch(() => false);
    await sweep(dir);
    scratch.close();
    for (const [key, value] of [['SASSATO_DB', saved.db], ['SASSATO_WORKSPACE', saved.workspace], ['SASSATO_ROLE', saved.role], ['PATH', saved.path]] as const)
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  real.event('codex-round', version, String(result.status), { model, step: result.step, reason: result.reason, dir });
  if (result.status === 'passed') { if (!options.keep) rmSync(dir, { recursive: true, force: true }); return result; }
  const to = notifyRole(real);
  if (to) send(real, [to], `Codex round failed on ${version} at step "${result.step}": ${result.reason}. Logs: ${dir}. The roles started as usual; the next launch --watched tries again.`, { urgent: true });
  return result;
}

/** Stops whatever still runs from the round's folder (its server, terminal and watcher all name it), so a failure at
 * any step leaves nothing behind. The folder is new for each round, so nothing else names it. */
async function sweep(dir: string) {
  const mine = () => readdirSync('/proc').filter(pid => /^\d+$/.test(pid) && Number(pid) !== process.pid).map(Number)
    .filter(pid => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').some(arg => arg.includes(dir)); } catch { return false; } });
  const signal = (name: NodeJS.Signals) => { for (const pid of mine()) try { process.kill(pid, name); } catch { /* gone */ } };
  signal('SIGTERM');
  if (!await until(() => mine().length ? undefined : true, 10_000)) signal('SIGKILL');
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
