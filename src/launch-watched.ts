// One command for watched Codex roles (T1193): for each role it checks the role's settings on a short-lived app
// server, starts the role's app server hidden (no tab, log in the state folder), opens the role's window as the only
// visible tab, registers it, and then hands every started role to one background process that watches them all.
// It asks nothing: the settings check replaces the /status question. A window or server already open is refused
// with its pid; --close-stale closes only what an earlier run of this command started.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { check, name } from './errors.js';
import { processIdentity, providerProcess, registerSession } from './coordination.js';
import { acquireLaunchLock, planLaunch, resolveExecutable } from './launch.js';
import { launchDirectory, launchLockPath } from './launch-admission.js';
import { closeEnrollment, launchWatch, watchStatus, WINDOW_SETTINGS } from './launch-watch.js';
import { Store, type Row } from './storage.js';

export interface WatchedOptions {
  all?: boolean; closeStale?: boolean; dryRun?: boolean; codexHome?: string; distro?: string;
  /** Opens the visible window; Windows Terminal unless a test gives its own. */
  openWindow?: (codex: string, args: string[], cwd: string, role: string) => void;
  /** Starts the one background watcher; a detached sassato unless a test gives its own. */
  startWatcher?: (roles: string[]) => number | undefined;
  /** How long to wait for a socket, a window or the settings answer. */
  waitMs?: number;
}
interface Started { role: string; thread: string; endpoint: string; server: { pid: number; identity: string }; window: { pid: number; identity: string }; started_at: string }

const sandboxes: Record<string, string> = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };
const stateDir = (s: Store) => join(launchDirectory(s.path, s.workspace), 'watched');
const statePath = (s: Store, role: string) => join(stateDir(s), `${name(role)}.json`);

const recorded = (p: unknown): p is { pid: number; identity: string } =>
  !!p && typeof p === 'object' && Number.isSafeInteger((p as Row).pid) && (p as Row).pid > 1 && typeof (p as Row).identity === 'string' && (p as Row).identity !== '';
/** The record an earlier run wrote, or null when there is none or it is not one this command wrote. */
function readState(s: Store, role: string): Started | null {
  let state: Row;
  try { state = JSON.parse(readFileSync(statePath(s, role), 'utf8')); } catch { return null; }
  const valid = state && typeof state === 'object' && state.role === role && typeof state.thread === 'string' && typeof state.endpoint === 'string'
    && state.endpoint.startsWith('unix://') && recorded(state.server) && recorded(state.window);
  return valid ? state as Started : null;
}
function writeState(s: Store, state: Started) {
  const path = statePath(s, state.role), temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  renameSync(temp, path);
}
const commandLine = (pid: number) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return null; } };
/** Live processes (not this one) whose arguments hold `needle` as consecutive arguments. */
/** The visible window's arguments. It never asks to update on start: a question in a tab stalls the role (F313). */
/** The watched window's arguments after the executable; the watcher's check accepts exactly these. */
export const windowArgs = (endpoint: string, thread: string) => [...WINDOW_SETTINGS, '--remote', endpoint, 'resume', thread];

function processesWith(needle: string[]): number[] {
  const found: number[] = [];
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid === process.pid) continue;
    const args = commandLine(pid);
    if (args && args.some((_, i) => needle.every((part, j) => args[i + j] === part))) found.push(pid);
  }
  return found;
}
/** True while the recorded process is the very one started (same pid and start time). */
const alive = (p?: { pid: number; identity: string }) => !!p && processIdentity(p.pid) === p.identity;
const since = (pid: number) => {
  try { return new Date(Date.now() - (Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000 - Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]) * 10)).toISOString().slice(0, 16).replace('T', ' '); }
  catch { return 'an unknown time'; }
};

/** The role's server settings as `-c` overrides, and what a fresh thread must report back. */
function settings(s: Store, role: string) {
  const config = s.role(role);
  check(config.provider === 'codex' && config.kind === 'agent', `${role} is not a Codex agent role`, 3);
  check(config.model && config.sandbox_mode && config.approval_policy, `Set a model, sandbox and approval policy for ${role} first (role set)`, 3);
  check(sandboxes[config.sandbox_mode], `Unknown sandbox mode for ${role}: ${config.sandbox_mode}`, 3);
  const args = ['-c', `model=${JSON.stringify(config.model)}`, '-c', `sandbox_mode=${JSON.stringify(config.sandbox_mode)}`, '-c', `approval_policy=${JSON.stringify(config.approval_policy)}`];
  if (config.reasoning_effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(config.reasoning_effort)}`);
  return { args, want: { model: config.model, sandbox: sandboxes[config.sandbox_mode], approval: config.approval_policy, effort: config.reasoning_effort ?? null } };
}

/**
 * Starts the app server with the role's settings on stdio, opens a throwaway (ephemeral) thread with no overrides,
 * and compares what that thread reports with the role's settings: what the window, resumed with no overrides on a
 * server started with the same arguments, will run with. No model is called.
 */
export async function checkSettings(codex: string, serverArgs: string[], want: Row, cwd: string, waitMs = 20_000): Promise<void> {
  const child = spawn(codex, ['app-server', ...serverArgs], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
  const answer = new Promise<Row>((done, fail) => {
    let buffer = '';
    const timer = setTimeout(() => fail(new Error(`Codex did not report the thread's settings within ${waitMs / 1000} seconds`)), waitMs);
    child.on('error', error => { clearTimeout(timer); fail(error); });
    child.on('exit', () => { clearTimeout(timer); fail(new Error('Codex app server exited before reporting the thread settings')); });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let message: Row; try { message = JSON.parse(line); } catch { continue; }
        // Notifications and the server's own requests carry a method; only answers to our two requests count.
        if (!message || typeof message !== 'object' || 'method' in message) continue;
        if (message.error && (message.id === 1 || message.id === 2)) { clearTimeout(timer); fail(new Error(`Codex refused the settings check: ${message.error.message ?? 'no reason given'}`)); continue; }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: { ephemeral: true, cwd } })}\n`);
        } else if (message.id === 2) { clearTimeout(timer); message.result && typeof message.result === 'object' ? done(message.result) : fail(new Error('Codex answered the settings check without a thread')); }
      }
    });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'sassato-settings-check', version: '1' } } })}\n`);
  try {
    const got = await answer;
    const seen: Row = { model: got.model, sandbox: got.sandbox?.type, approval: got.approvalPolicy, effort: got.reasoningEffort ?? null };
    for (const key of ['model', 'sandbox', 'approval', 'effort'] as const) {
      if (key === 'effort' && want.effort === null) continue;
      check(seen[key] === want[key], `Codex would run with ${key} ${seen[key] ?? 'unset'}, not ${want[key]}: settings mismatch, nothing started`, 4);
    }
  } finally { child.kill(); }
}

/** Closes the window and app server an earlier launch --watched recorded for the role, if any (the Codex round, T1193). */
export async function closeRecorded(s: Store, role: string): Promise<string | false> {
  const state = readState(s, role);
  return state ? clearEarlier(s, role, state.thread, state.endpoint, true) : false;
}

async function until<T>(read: () => T | undefined, waitMs: number): Promise<T | undefined> {
  for (const end = Date.now() + waitMs; Date.now() < end; await delay(200)) { const value = read(); if (value !== undefined) return value; }
  return read();
}
async function stopProcess(p: { pid: number; identity: string }) {
  if (!alive(p)) return;
  process.kill(p.pid, 'SIGTERM');
  // Waits until the pid is gone, not only exited: a process not yet reaped still holds it, and planning the launch
  // again would find a registered pid it cannot verify.
  const gone = () => { try { const stat = readFileSync(`/proc/${p.pid}/stat`, 'utf8'); return !p.identity.endsWith(`:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`); } catch { return true; } };
  await until(() => gone() ? true : undefined, 5_000);
  check(!alive(p), `Process ${p.pid} did not stop; close it by hand`, 4);
}

function openWindowsTerminal(distro: string) {
  return (codex: string, args: string[], cwd: string, role: string) => {
    const argv = ['-w', '0', 'new-tab', '--title', role, 'wsl.exe', '-d', distro, '--cd', cwd, '--exec', codex, ...args];
    check(argv.every(a => !/[;\r\n\0"]/.test(a)), 'Windows Terminal arguments cannot contain semicolons, quotes or control characters');
    // A failed start shows as no window within the wait, which stops the server again.
    const child = spawn('wt.exe', argv, { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); child.unref();
  };
}

/**
 * The refusal for a role with a window or server already open, or, with --close-stale, their closing when an earlier
 * run started every one of them. Only processes seen open now and matching the record (pid and start time) are
 * signalled. A dry run names what it would close and closes nothing. Returns what was (or would be) closed.
 */
async function clearEarlier(s: Store, role: string, thread: string, endpoint: string, closeStale: boolean, dryRun = false): Promise<string | false> {
  const state = readState(s, role);
  // A record counts only for this role's thread and endpoint; a window must match the recorded window, with the
  // arguments this command gives it (a window from a build before the update flag lacks the flag, so the match
  // is on its remote and thread), and a server the recorded server.
  const earlier = state && state.thread === thread && state.endpoint === endpoint ? state : null;
  const record = (p: { pid: number; what: string }) => {
    if (!earlier) return undefined;
    const mine = p.what === 'window' ? earlier.window : earlier.server;
    const shape = p.what === 'window' ? processesWith(windowArgs(endpoint, thread).slice(2)).includes(p.pid) : true;
    return mine.pid === p.pid && shape && alive(mine) ? mine : undefined;
  };
  const open = [...processesWith(['resume', thread]).map(pid => ({ pid, what: 'window' })), ...processesWith(['--listen', endpoint]).map(pid => ({ pid, what: 'app server' }))];
  if (!open.length) return false;
  const named = open.map(p => `${p.what} pid ${p.pid} (since ${since(p.pid)})`).join(', ');
  if (closeStale && open.every(p => record(p))) {
    if (!dryRun) for (const p of open) await stopProcess(record(p)!);
    return named;
  }
  const way = open.every(p => record(p)) ? ' An earlier sas launch --watched started it: add --close-stale to close it, or leave it running.'
    : ' This command did not start it, so it never closes it: close it by hand when its turn is done.';
  check(false, `${role} already has an open ${named}.${way}`, 4);
}

export async function launchWatched(operator: Store, roles: string[], options: WatchedOptions = {}): Promise<Row[]> {
  operator.requireHuman();
  check(!(options.all && roles.length), 'Choose roles or --all');
  const selected = options.all ? operator.all("SELECT name FROM roles WHERE workspace_id=? AND kind='agent' AND provider='codex' ORDER BY name", operator.ws).map(r => String(r.name)) : roles.map(r => name(r));
  check(selected.length > 0, 'Name at least one Codex role or use --all');
  const waitMs = options.waitMs ?? 30_000;
  const codex = resolveExecutable('codex', true);
  const distro = options.distro ?? process.env.WSL_DISTRO_NAME ?? '';
  const openWindow = options.openWindow ?? openWindowsTerminal(distro);
  if (!options.openWindow && !options.dryRun) check(distro, 'Run inside WSL (WSL_DISTRO_NAME is not set)', 3);
  mkdirSync(stateDir(operator), { recursive: true, mode: 0o700 });
  const results: Row[] = [], started: string[] = [];
  try {
  for (const role of selected) {
    // planLaunch refuses on STOP, a role that may not launch, and no saved session to resume.
    const planned = () => planLaunch(operator, [role], { watched: true, noPrompt: true, resume: true, codexHome: options.codexHome })[0];
    const first = planned();
    check(first.provider === 'codex', `${role} is not a Codex role`, 3);
    // Checked before any window is closed or started: a watcher refuses a role whose earlier enrollment is open (T1299).
    const enrollment = openEnrollment(operator, role, options.closeStale === true);
    const thread = first.sessionId!, endpoint = `unix://${join(stateDir(operator), `${role}.sock`)}`;
    const { args, want } = settings(operator, role);
    // Closing an earlier window changes its registered session from running to stale, so plan again after it.
    const closed = await clearEarlier(operator, role, thread, endpoint, options.closeStale === true, options.dryRun === true);
    const running = `${role} has a registered running session not started by this command; close it first`;
    if (options.dryRun) {
      check(closed || first.status !== 'already-running', running, 4);
      results.push({ role, thread, cwd: first.cwd, server: [codex, 'app-server', ...args, '--listen', endpoint], window: [codex, ...windowArgs(endpoint, thread)], ...(closed ? { would_close: closed } : {}), ...(enrollment ? { would_close_enrollment: enrollment } : {}), status: 'ready' });
      continue;
    }
    // The role's launch lock, held from here until its record is written, keeps two launches apart; the watcher
    // takes it next. An earlier watcher lets go of it once its window and server are gone.
    const release = await until(() => { try { return acquireLaunchLock(operator, role); } catch { return undefined; } }, closed ? waitMs : 0) ?? acquireLaunchLock(operator, role);
    try {
      // Checked again under the lock: another launch may have started the role meanwhile.
      await clearEarlier(operator, role, thread, endpoint, false);
      // Planned again under the lock: closing an earlier window turns its session stale, and another launch may have
      // registered or saved a session meanwhile.
      const plan = planned();
      check(plan.sessionId === thread, `${role}'s saved session changed while launching; run the command again`, 4);
      check(plan.status !== 'already-running', running, 4);
      // Under the lock no earlier watcher holds the enrollment, so --close-stale may close it.
      const epoch = openEnrollment(operator, role, options.closeStale === true);
      if (epoch) closeEnrollment(operator, role, epoch);
      const row = await startRole(operator, role, plan.cwd, thread, endpoint, codex, args, want, openWindow, waitMs);
      results.push(epoch ? { ...row, closed_enrollment: epoch } : row);
      started.push(role);
    } finally { release(); }
  }
  } finally {
    // Every role started gets its watcher, also when a later role failed.
    if (started.length) {
      const watcher = (options.startWatcher ?? startWatcher(operator, codex))(started);
      // The watcher holds each role's launch lock while it watches; a role it has not taken within the wait is unwatched.
      const unwatched = options.startWatcher ? [] : await enrolled(operator, started, watcher, waitMs);
      for (const row of results) if (row.status === 'started') {
        row.watcher = watcher;
        if (unwatched.includes(String(row.role))) row.warning = `No watcher took ${row.role} within ${waitMs / 1000} seconds; see ${join(stateDir(operator), 'watcher.log')}`;
      }
    }
  }
  return results;
}

/** The role's open enrollment, refused unless --close-stale may close it: never one with a wake still to deliver. */
function openEnrollment(operator: Store, role: string, closeStale: boolean): number | undefined {
  const { epoch, pending } = watchStatus(operator, role);
  if (!epoch) return undefined;
  const close = `sassato watch-close ${role} --epoch ${epoch} --workspace ${operator.workspace} --as ${operator.actor}`;
  check(pending === null, `${role} has an open waiter enrollment E${epoch} with a wake not yet delivered (event ${pending}); reconcile the role's inbox and progress, then ${close}`, 4);
  check(closeStale, `${role} has an open waiter enrollment E${epoch} from an earlier watcher; close it with ${close}, or launch with --close-stale`, 4);
  return Number(epoch);
}

async function enrolled(operator: Store, roles: string[], watcher: number | undefined, waitMs: number): Promise<string[]> {
  const holds = (role: string) => { try { return JSON.parse(readFileSync(launchLockPath(operator, role), 'utf8')).pid === watcher; } catch { return false; } };
  await until(() => roles.every(holds) ? true : undefined, watcher ? waitMs : 0);
  return roles.filter(role => !holds(role));
}

function startWatcher(operator: Store, codex: string) {
  return (list: string[]) => {
    const log = openSync(join(stateDir(operator), 'watcher.log'), 'a', 0o600);
    const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sassato.js');
    const child = spawn(process.execPath, [bin, 'watch-roles', ...list, '--db', operator.path, '--workspace', operator.workspace, '--as', operator.actor!],
      { detached: true, stdio: ['ignore', log, log], env: { ...process.env, PATH: `${dirname(codex)}:${process.env.PATH ?? ''}` } });
    child.on('error', () => {}); child.unref(); closeSync(log);
    return child.pid;
  };
}

/** Starts one role: settings check, hidden server, window, registration, record. Anything started is stopped again on failure. */
async function startRole(operator: Store, role: string, cwd: string, thread: string, endpoint: string, codex: string, args: string[], want: Row,
  openWindow: NonNullable<WatchedOptions['openWindow']>, waitMs: number): Promise<Row> {
    await checkSettings(codex, args, want, cwd, waitMs);
    const socket = endpoint.slice(7);
    rmSync(socket, { force: true });
    const logPath = join(stateDir(operator), `${role}-server.log`), log = openSync(logPath, 'a', 0o600);
    const server = spawn(codex, ['app-server', ...args, '--listen', endpoint], { cwd, detached: true, stdio: ['ignore', log, log] });
    server.on('error', () => {}); server.unref(); closeSync(log);
    check(server.pid, `Codex app server for ${role} could not start; see ${logPath}`, 4);
    const serverId = { pid: server.pid!, identity: processIdentity(server.pid!) ?? '' };
    let windowId: { pid: number; identity: string } | undefined;
    try {
      check(await until(() => existsSync(socket) && processesWith(['--listen', endpoint]).includes(serverId.pid) ? true : undefined, waitMs),
        `The app server for ${role} did not open its socket within ${waitMs / 1000} seconds; see ${logPath}`, 4);
      openWindow(codex, windowArgs(endpoint, thread), cwd, role);
      // A wrapper (env, node) is found before it runs Codex itself; registration needs Codex, so wait for it.
      const windowPid = await until(() => processesWith(windowArgs(endpoint, thread)).find(pid => providerProcess(pid, 'codex')), waitMs);
      check(windowPid, `The ${role} window did not start within ${waitMs / 1000} seconds`, 4);
      windowId = { pid: windowPid!, identity: processIdentity(windowPid!) ?? '' };
      const worker = new Store(operator.path, role);
      try { worker.use(operator.workspace); registerSession(worker, { provider: 'codex', external_id: thread, pid: windowPid, replace: true }); }
      finally { worker.close(); }
      writeState(operator, { role, thread, endpoint, server: serverId, window: windowId, started_at: new Date().toISOString() });
      operator.event('watch', role, 'launched', { thread, server: serverId.pid, window: windowId.pid });
    } catch (error) {
      for (const p of [windowId, serverId]) if (p) await stopProcess(p).catch(() => {});
      throw error;
    }
    return { role, thread, server: serverId.pid, window: windowId.pid, status: 'started' };
}

/** The one background process: watches every role this command started, each with its own enrollment. */
export async function watchRoles(operator: Store, roles: string[]): Promise<Row[]> {
  operator.requireHuman();
  check(roles.length > 0, 'Name the roles to watch');
  const runs = roles.map(role => {
    const state = readState(operator, name(role));
    check(state, `No started window recorded for ${role}; start it with sas launch --watched`, 4);
    // Each role's end is written when it happens: the result rows print only when every role's watch has ended (T1299).
    return launchWatch(operator, role, state!.endpoint, state!.thread).then(result => {
      console.error(`Stopped watching ${role}.`);
      return { role, result };
    }, error => {
      const message = String(error instanceof Error ? error.message : error);
      console.error(`Not watching ${role}: ${message}`);
      return { role, error: message };
    });
  });
  return Promise.all(runs);
}
