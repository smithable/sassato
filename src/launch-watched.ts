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
import { processIdentity, registerSession } from './coordination.js';
import { planLaunch, resolveExecutable } from './launch.js';
import { launchDirectory } from './launch-admission.js';
import { launchWatch } from './launch-watch.js';
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

function readState(s: Store, role: string): Started | null {
  try { return JSON.parse(readFileSync(statePath(s, role), 'utf8')); } catch { return null; }
}
function writeState(s: Store, state: Started) {
  const path = statePath(s, state.role), temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  renameSync(temp, path);
}
const commandLine = (pid: number) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return null; } };
/** Live processes (not this one) whose arguments hold `needle` as consecutive arguments. */
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
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: { ephemeral: true, cwd } })}\n`);
        } else if (message.id === 2) { clearTimeout(timer); message.error ? fail(new Error(`Codex refused a thread: ${message.error.message ?? 'no reason given'}`)) : done(message.result); }
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

async function until<T>(read: () => T | undefined, waitMs: number): Promise<T | undefined> {
  for (const end = Date.now() + waitMs; Date.now() < end; await delay(200)) { const value = read(); if (value !== undefined) return value; }
  return read();
}
async function stopProcess(p: { pid: number; identity: string }) {
  if (!alive(p)) return;
  process.kill(p.pid, 'SIGTERM');
  await until(() => alive(p) ? undefined : true, 5_000);
  check(!alive(p), `Process ${p.pid} did not stop; close it by hand`, 4);
}

function openWindowsTerminal(distro: string) {
  return (codex: string, args: string[], cwd: string, role: string) => {
    const argv = ['-w', '0', 'new-tab', '--title', role, 'wsl.exe', '-d', distro, '--cd', cwd, '--exec', codex, ...args];
    check(argv.every(a => !/[;\r\n\0"]/.test(a)), 'Windows Terminal arguments cannot contain semicolons, quotes or control characters');
    spawn('wt.exe', argv, { detached: true, stdio: 'ignore' }).unref();
  };
}

/** The refusal for a role with a window or server already open, or its removal when an earlier run started it. */
async function clearEarlier(s: Store, role: string, thread: string, endpoint: string, closeStale: boolean) {
  const earlier = readState(s, role);
  const ours = (pid: number) => !!earlier && [earlier.server, earlier.window].some(p => p.pid === pid && alive(p));
  const open = [...processesWith(['resume', thread]).map(pid => ({ pid, what: 'window' })), ...processesWith(['--listen', endpoint]).map(pid => ({ pid, what: 'app server' }))];
  if (!open.length) return false;
  const named = open.map(p => `${p.what} pid ${p.pid} (since ${since(p.pid)})`).join(', ');
  if (closeStale && open.every(p => ours(p.pid))) {
    for (const p of [earlier!.window, earlier!.server]) await stopProcess(p);
    return true;
  }
  const way = open.every(p => ours(p.pid)) ? ' An earlier sas launch --watched started it: add --close-stale to close it, or leave it running.'
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
  for (const role of selected) {
    // planLaunch refuses on STOP, a role that may not launch, and no saved session to resume.
    const planned = () => planLaunch(operator, [role], { watched: true, noPrompt: true, resume: true, codexHome: options.codexHome })[0];
    const first = planned();
    check(first.provider === 'codex', `${role} is not a Codex role`, 3);
    const thread = first.sessionId!, endpoint = `unix://${join(stateDir(operator), `${role}.sock`)}`;
    const { args, want } = settings(operator, role);
    // Closing an earlier window changes its registered session from running to stale, so plan again after it.
    const plan = await clearEarlier(operator, role, thread, endpoint, options.closeStale === true) ? planned() : first;
    check(plan.sessionId === thread, `${role}'s saved session changed while launching; run the command again`, 4);
    check(plan.status !== 'already-running', `${role} has a registered running session not started by this command; close it first`, 4);
    if (options.dryRun) { results.push({ role, thread, cwd: plan.cwd, server: [codex, 'app-server', ...args, '--listen', endpoint], window: [codex, '--remote', endpoint, 'resume', thread], status: 'ready' }); continue; }
    await checkSettings(codex, args, want, plan.cwd, waitMs);
    rmSync(endpoint.slice(7), { force: true });
    const log = openSync(join(stateDir(operator), `${role}-server.log`), 'a', 0o600);
    const server = spawn(codex, ['app-server', ...args, '--listen', endpoint], { cwd: plan.cwd, detached: true, stdio: ['ignore', log, log] });
    server.unref(); closeSync(log);
    const serverId = { pid: server.pid!, identity: processIdentity(server.pid!) ?? '' };
    const stopServer = () => stopProcess(serverId).catch(() => {});
    if (!await until(() => existsSync(endpoint.slice(7)) ? true : undefined, waitMs)) {
      await stopServer();
      check(false, `The app server for ${role} did not open its socket within ${waitMs / 1000} seconds; see ${join(stateDir(operator), `${role}-server.log`)}`, 4);
    }
    openWindow(codex, ['--remote', endpoint, 'resume', thread], plan.cwd, role);
    const windowPid = await until(() => processesWith(['--remote', endpoint, 'resume', thread])[0], waitMs);
    if (!windowPid) { await stopServer(); check(false, `The ${role} window did not start within ${waitMs / 1000} seconds; its server is stopped again`, 4); }
    const worker = new Store(operator.path, role);
    try { worker.use(operator.workspace); registerSession(worker, { provider: 'codex', external_id: thread, pid: windowPid, replace: true }); }
    finally { worker.close(); }
    writeState(operator, { role, thread, endpoint, server: serverId, window: { pid: windowPid!, identity: processIdentity(windowPid!) ?? '' }, started_at: new Date().toISOString() });
    operator.event('watch', role, 'launched', { thread, server: serverId.pid, window: windowPid });
    started.push(role);
    results.push({ role, thread, server: serverId.pid, window: windowPid, status: 'started' });
  }
  if (started.length) {
    const start = options.startWatcher ?? ((list: string[]) => {
      const log = openSync(join(stateDir(operator), 'watcher.log'), 'a', 0o600);
      const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
      const child = spawn(process.execPath, [cli, 'watch-roles', ...list, '--db', operator.path, '--workspace', operator.workspace, '--as', operator.actor!],
        { detached: true, stdio: ['ignore', log, log], env: { ...process.env, PATH: `${dirname(codex)}:${process.env.PATH ?? ''}` } });
      child.unref(); closeSync(log);
      return child.pid;
    });
    const watcher = start(started);
    for (const row of results) if (row.status === 'started') row.watcher = watcher;
  }
  return results;
}

/** The one background process: watches every role this command started, each with its own enrollment. */
export async function watchRoles(operator: Store, roles: string[]): Promise<Row[]> {
  operator.requireHuman();
  check(roles.length > 0, 'Name the roles to watch');
  const runs = roles.map(role => {
    const state = readState(operator, name(role));
    check(state, `No started window recorded for ${role}; start it with sas launch --watched`, 4);
    return launchWatch(operator, role, state!.endpoint, state!.thread).then(result => ({ role, result }), error => ({ role, error: String(error instanceof Error ? error.message : error) }));
  });
  return Promise.all(runs);
}
