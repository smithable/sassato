// Heavy jobs on a shared machine (T753): a job asks before it starts, waits its turn while the
// machine has no room for it, and its memory and CPU are measured, so the next run of its kind
// asks for what it really used. Jobs are machine-wide: every workspace in this database counts.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { availableParallelism, constants } from 'node:os';
import { basename } from 'node:path';
import type { Row, Store } from './storage.js';
import { check, name, now, safe } from './errors.js';
import { processIdentity } from './coordination.js';

const MB = 1024 * 1024;
/** Until a kind has been measured: what it may need (MB) and how many cores it keeps busy. */
export const DEFAULTS: Record<string, { mb: number; cpus: number | 'all' }> = {
  gate: { mb: 6144, cpus: 'all' },
  evolution: { mb: 4096, cpus: 2 },
  benchmark: { mb: 3072, cpus: 1 },
  'container-tests': { mb: 4096, cpus: 4 },
  other: { mb: 2048, cpus: 1 },
};
/** Memory kept free for everything that is not a job (the sessions, editors, the desktop). */
export const RESERVE_MB = 3072;
/** A refused or never-fitting job exits 75 (EX_TEMPFAIL), as scripts/gate.sh does. */
export const REFUSED = 75;
const SAMPLE_MS = 2000;

export interface Machine { availableMb: number; totalMb: number; cores: number; reserveMb: number }
export function machine(): Machine {
  check(process.platform === 'linux' || process.env.SASSATO_JOB_MEMINFO, 'Jobs need Linux: memory is read from /proc/meminfo');
  // SASSATO_JOB_MEMINFO points at a meminfo-shaped file, for tests.
  const info = readFileSync(process.env.SASSATO_JOB_MEMINFO ?? '/proc/meminfo', 'utf8');
  const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(info)?.[1] ?? 0);
  const reserve = process.env.SASSATO_JOB_RESERVE_MB;
  return {
    availableMb: Math.floor(kb('MemAvailable') / 1024),
    totalMb: Math.floor(kb('MemTotal') / 1024),
    cores: Number(process.env.SASSATO_JOB_CORES) || availableParallelism(),
    reserveMb: reserve === undefined ? RESERVE_MB : Number(reserve),
  };
}

export interface Estimate { version?: string; load?: 'more' | 'same' | 'less'; mem?: number }
export interface Need { mb: number; cpus: number; margin: number; measured: number | null }
/**
 * What a kind asks for. Measured runs of the same version, when there are two or more: their
 * highest peak of the last five plus a fifth. Fewer: the latest five of any version plus half,
 * until the new version has been measured twice. Nothing measured: the kind's default. A peak
 * counts as soon as it is seen, also of a run still going. The session's estimate may raise the
 * need ('more' takes the half margin, --mem a floor), never lower it; 'less' is only recorded.
 */
export function needOf(s: Store, kind: string, cores: number, estimate: Estimate = {}): Need {
  const measured = "kind=? AND peak_mb IS NOT NULL AND status IN ('done','running','released')";
  const same = s.all(`SELECT peak_mb,cpu_s,wall_s FROM jobs WHERE ${measured} AND version IS ? ORDER BY id DESC LIMIT 5`, kind, estimate.version ?? null);
  const runs = same.length >= 2 ? same : s.all(`SELECT peak_mb,cpu_s,wall_s FROM jobs WHERE ${measured} ORDER BY id DESC LIMIT 5`, kind);
  const fallback = DEFAULTS[kind] ?? DEFAULTS.other;
  const cpusDefault = fallback.cpus === 'all' ? cores : fallback.cpus;
  const margin = same.length >= 2 && estimate.load !== 'more' ? 1.2 : 1.5;
  const peak = runs.length ? Math.max(...runs.map(r => r.peak_mb)) : null;
  let mb = peak === null ? fallback.mb : Math.ceil(peak * margin);
  if (peak === null && estimate.load === 'more') mb = Math.ceil(mb * 1.5 / 1.2);
  if (estimate.mem !== undefined) mb = Math.max(mb, estimate.mem);
  const loads = runs.filter(r => r.wall_s > 0 && r.cpu_s !== null).map(r => r.cpu_s / r.wall_s);
  const cpus = loads.length ? Math.min(cores, Math.max(0.5, Math.round(Math.max(...loads) * 1.2 * 10) / 10)) : cpusDefault;
  return { mb, cpus, margin: peak === null ? 0 : margin, measured: peak };
}

/** A running job's claim on memory: its need, or its present use plus a fifth once it has passed it. */
const claimOf = (row: Row) => Math.max(row.need_mb, Math.ceil((row.current_mb ?? 0) * 1.2));
const growthOf = (running: Row[]) => running.reduce((n, r) => n + Math.max(0, claimOf(r) - (r.current_mb ?? 0)), 0);

/** Whether the job's owning `sassato job run` process is still the one that asked. */
function ownerAlive(row: Row): boolean {
  return !!row.process_start && processIdentity(Number(row.pid)) === row.process_start;
}

/** Jobs whose owner is gone are released, so a killed run never holds the machine. */
export function releaseStale(s: Store): Row[] {
  const gone = s.all("SELECT * FROM jobs WHERE status IN ('waiting','running')").filter(row => !ownerAlive(row));
  for (const row of gone) {
    const orphans = row.cgroup ? leftInCgroup(row.cgroup) : [];
    s.run("UPDATE jobs SET status='released',reason=?,orphans=?,ended_at=? WHERE id=?",
      'its sassato job run process is gone', orphans.length ? JSON.stringify(orphans) : null, now(), row.id);
  }
  return gone;
}

export type Decision = { start: true } | { start: false; reason: string; never?: boolean };

/**
 * The admission rule. Waiting jobs go in turn (the role with the fewest starts since the oldest
 * waiting job asked goes first, then by arrival), and a later job never starts ahead of one that
 * waits, so a large job cannot be starved by a stream of small ones. The first in turn starts when
 * the memory available now, minus what running jobs may still grow to, minus the reserve, covers
 * its need, and the running jobs' cores plus its own stay within the machine's (a job alone may
 * use them all).
 */
export function admit(s: Store, jobId: number, m: Machine): Decision {
  const job = s.get('SELECT * FROM jobs WHERE id=?', jobId);
  check(job, `Job J${jobId} not found`, 3);
  if (job.need_mb + m.reserveMb > m.totalMb)
    return { start: false, never: true, reason: `${job.kind} needs ${job.need_mb} MB and ${m.reserveMb} MB stays free, but the machine has ${m.totalMb} MB` };
  const waiting = s.all("SELECT * FROM jobs WHERE status='waiting' ORDER BY id");
  const since = waiting[0]?.created_at ?? job.created_at;
  const turns = (row: Row) => s.get('SELECT count(*) n FROM jobs WHERE workspace_id=? AND role=? AND started_at>=?', row.workspace_id, row.role, since)!.n;
  const order = waiting.map(row => ({ row, turns: turns(row) })).sort((a, b) => a.turns - b.turns || a.row.id - b.row.id);
  const first = order[0]?.row;
  if (first && first.id !== jobId) return { start: false, reason: `J${first.id} (${first.kind}, ${first.role}) goes first` };
  const running = s.all("SELECT * FROM jobs WHERE status='running'");
  const growth = growthOf(running);
  const room = m.availableMb - growth - m.reserveMb;
  if (job.need_mb > room)
    return { start: false, reason: `${job.kind} needs ${job.need_mb} MB; ${m.availableMb} MB is available, running jobs may grow by ${growth} MB and ${m.reserveMb} MB stays free` };
  const busy = running.reduce((n, r) => n + r.cpu_need, 0);
  if (running.length && busy + job.cpu_need > m.cores)
    return { start: false, reason: `${job.kind} needs ${job.cpu_need} cores; running jobs use ${busy} of ${m.cores}` };
  return { start: true };
}

/** Enter a job as waiting; the caller's own process is its owner. */
export function enqueue(s: Store, kind: string, command: string[], m: Machine, owner = process.pid, estimate: Estimate = {}): number {
  const role = s.requireActor();
  name(kind);
  check(command.length > 0, 'Give the command after --, as in: sassato job run --kind benchmark -- node bench.mjs');
  check(estimate.load === undefined || ['more', 'same', 'less'].includes(estimate.load), '--load takes more, same or less');
  check(estimate.mem === undefined || (Number.isSafeInteger(estimate.mem) && estimate.mem > 0), '--mem takes megabytes as a whole number');
  if (estimate.version !== undefined) { check(estimate.version.length > 0 && estimate.version.length <= 200, '--job-version takes 1 to 200 characters'); safe(estimate.version); }
  const need = needOf(s, kind, m.cores, estimate);
  // The command line is kept for job list; one that looks like it holds a secret keeps its program only.
  let shown = command.join(' ').slice(0, 500);
  try { safe(shown); } catch { shown = `${basename(command[0])} …`; }
  return s.tx(() => s.run(
    "INSERT INTO jobs(workspace_id,role,kind,version,command,status,need_mb,cpu_need,margin,measured_mb,load_estimate,mem_estimate,pid,process_start,created_at) VALUES(?,?,?,?,?,'waiting',?,?,?,?,?,?,?,?,?)",
    s.ws, role, kind, estimate.version ?? null, shown, need.mb, need.cpus, need.margin, need.measured, estimate.load ?? null, estimate.mem ?? null, owner, processIdentity(owner), now()).lastInsertRowid);
}

let scopeWorks: boolean | undefined;
/** A systemd user scope per job gives exact peak memory and CPU; without one, /proc is sampled. */
function canScope(): boolean {
  if (process.env.SASSATO_JOB_SCOPE === '0' || process.platform !== 'linux') return false;
  scopeWorks ??= spawnSync('systemd-run', ['--user', '--scope', '-q', 'true'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
  return scopeWorks;
}

function readNumber(path: string): number | null {
  try { return Number(readFileSync(path, 'utf8').trim()); } catch { return null; }
}
function cgroupOf(pid: number): string | null {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').find(l => l.startsWith('0::'));
    return line ? `/sys/fs/cgroup${line.slice(3)}` : null;
  } catch { return null; }
}
function commandOf(pid: number): string {
  try { return basename(readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] || '?'); } catch { return '?'; }
}
function leftInCgroup(cgroup: string): { pid: number; command: string }[] {
  try {
    return readFileSync(`${cgroup}/cgroup.procs`, 'utf8').split('\n').filter(Boolean).map(Number).map(pid => ({ pid, command: commandOf(pid) }));
  } catch { return []; }
}
/** The fallback's view of a job: its process group and every descendant of its first process. */
function treeOf(root: number): number[] {
  const parent = new Map<number, number>(), group = new Map<number, number>();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      parent.set(Number(entry), Number(fields[1])); group.set(Number(entry), Number(fields[2]));
    } catch { /* gone between listing and reading */ }
  }
  const tree = new Set<number>([...group].filter(([, g]) => g === root).map(([pid]) => pid));
  for (const pid of parent.keys()) {
    for (let p = pid, hops = 0; p > 1 && hops < 64; p = parent.get(p) ?? 0, hops++) if (p === root) { tree.add(pid); break; }
  }
  return [...tree].filter(pid => existsSync(`/proc/${pid}`));
}
function sampleTree(pids: number[]): { mb: number; cpuS: number } {
  let bytes = 0, ticks = 0;
  for (const pid of pids) {
    try {
      bytes += Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * 4096;
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      ticks += Number(f[11]) + Number(f[12]);
    } catch { /* exited */ }
  }
  return { mb: Math.ceil(bytes / MB), cpuS: ticks / 100 };
}

export interface RunOptions { kind: string; wait: boolean; command: string[]; estimate?: Estimate; log?: (line: string) => void }

/** Ask, wait if told to, run, measure, release. Resolves to the exit status to leave with. */
export async function runJob(s: Store, options: RunOptions): Promise<number> {
  const log = options.log ?? ((line: string) => process.stderr.write(`sassato: ${line}\n`));
  const id = enqueue(s, options.kind, options.command, machine(), process.pid, options.estimate);
  let said = '';
  for (;;) {
    const decision = s.tx(() => { releaseStale(s); return admit(s, id, machine()); });
    if (decision.start) break;
    if (decision.never || !options.wait) {
      s.tx(() => s.run("UPDATE jobs SET status='refused',reason=?,ended_at=? WHERE id=?", decision.reason, now(), id));
      log(`J${id} not started: ${decision.reason}`);
      return REFUSED;
    }
    if (decision.reason !== said) log(`J${id} waits: ${decision.reason}`);
    said = decision.reason;
    await new Promise(done => setTimeout(done, SAMPLE_MS));
  }
  const started = Date.now();
  s.tx(() => s.run("UPDATE jobs SET status='running',started_at=? WHERE id=?", now(), id));
  if (said) log(`J${id} starts`);

  const scoped = canScope();
  const unit = `sassato-job-${id}-${process.pid}`;
  const child: ChildProcess = scoped
    ? spawn('systemd-run', ['--user', '--scope', '-q', `--unit=${unit}`, '--', ...options.command], { stdio: 'inherit' })
    : spawn(options.command[0], options.command.slice(1), { stdio: 'inherit', detached: true });
  // Without a scope the job is its own process group: a signal goes to the whole group, as a terminal would send it.
  const forward = (signal: NodeJS.Signals) => () => { try { if (scoped || !child.pid) child.kill(signal); else process.kill(-child.pid, signal); } catch { /* already gone */ } };
  const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(signal => [signal, forward(signal)] as const);
  for (const [signal, handler] of handlers) process.on(signal, handler);

  let cgroup: string | null = null, peak = 0, current = 0, cpu = 0, written = 0, tree: number[] = [];
  const sample = () => {
    if (scoped) {
      if (!cgroup && child.pid) { const found = cgroupOf(child.pid); if (found?.endsWith(`/${unit}.scope`)) { cgroup = found; s.tx(() => s.run('UPDATE jobs SET cgroup=? WHERE id=?', cgroup, id)); } }
      if (!cgroup) return;
      const now_ = readNumber(`${cgroup}/memory.current`), high = readNumber(`${cgroup}/memory.peak`);
      if (now_ !== null) current = Math.ceil(now_ / MB);
      peak = Math.max(peak, current, high === null ? 0 : Math.ceil(high / MB));
      const usage = /usage_usec (\d+)/.exec((() => { try { return readFileSync(`${cgroup}/cpu.stat`, 'utf8'); } catch { return ''; } })())?.[1];
      if (usage) cpu = Math.max(cpu, Number(usage) / 1e6);
    } else if (child.pid) {
      tree = treeOf(child.pid);
      const seen = sampleTree(tree);
      current = seen.mb; peak = Math.max(peak, seen.mb); cpu = Math.max(cpu, seen.cpuS);
    }
    if (Date.now() - written >= 5000) { written = Date.now(); s.tx(() => s.run('UPDATE jobs SET current_mb=?,peak_mb=? WHERE id=?', current, peak, id)); }
  };
  const timer = setInterval(sample, SAMPLE_MS);
  const status = await new Promise<number>(done => {
    child.on('error', error => { log(`J${id} could not start ${options.command[0]}: ${error.message}`); done(127); });
    child.on('exit', (code, signal) => done(code ?? 128 + (signal ? constants.signals[signal] : 0)));
    setTimeout(sample, 200);
  });
  clearInterval(timer);
  sample();
  for (const [signal, handler] of handlers) process.off(signal, handler);
  // What the job leaves behind is named, never killed: the owner decides.
  const orphans = scoped ? (cgroup ? leftInCgroup(cgroup) : []) : (child.pid ? treeOf(child.pid) : []).map(pid => ({ pid, command: commandOf(pid) }));
  if (orphans.length) log(`J${id} left ${orphans.length} process${orphans.length === 1 ? '' : 'es'} running: ${orphans.map(o => `${o.pid} (${o.command})`).join(', ')}`);
  s.tx(() => s.run("UPDATE jobs SET status='done',exit_code=?,current_mb=0,peak_mb=?,cpu_s=?,wall_s=?,orphans=?,ended_at=? WHERE id=?",
    status, peak || null, Math.round(cpu * 10) / 10, Math.round((Date.now() - started) / 100) / 10, orphans.length ? JSON.stringify(orphans) : null, now(), id));
  return status;
}

const shown = (row: Row) => ({
  id: `J${row.id}`, kind: row.kind, role: row.role, status: ownerAlive(row) ? row.status : `${row.status} (owner gone)`,
  need_mb: row.need_mb, cpu_need: row.cpu_need, current_mb: row.current_mb, peak_mb: row.peak_mb,
  since: row.started_at ?? row.created_at, command: row.command,
});
/** Running and waiting jobs on this machine, and the room left for the next one. */
export function listJobs(s: Store): Row {
  const m = machine();
  const open = s.all("SELECT * FROM jobs WHERE status IN ('running','waiting') ORDER BY status DESC,id");
  const growth = growthOf(open.filter(r => r.status === 'running'));
  return { jobs: open.map(shown), available_mb: m.availableMb, room_mb: m.availableMb - growth - m.reserveMb, reserve_mb: m.reserveMb, cores: m.cores };
}

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
/**
 * Per kind and version: finished runs, their memory, CPU and time, what the next run will ask for,
 * and how good the needs were (the peak as a share of the need it asked for, and how many passed it).
 */
export function jobStats(s: Store): Row[] {
  const cores = machine().cores;
  const groups = s.all('SELECT kind,version,min(id) first FROM jobs GROUP BY kind,version ORDER BY kind,first');
  return groups.map(({ kind, version }) => {
    const all = s.all('SELECT * FROM jobs WHERE kind=? AND version IS ?', kind, version);
    const runs = all.filter(r => r.status === 'done');
    const peaks = runs.map(r => r.peak_mb).filter(v => v !== null);
    const measured = runs.filter(r => r.peak_mb !== null && r.need_mb > 0);
    const need = needOf(s, kind, cores, version === null ? {} : { version });
    return {
      kind, version, runs: runs.length, failed: runs.filter(r => r.exit_code !== 0).length,
      median_peak_mb: median(peaks), peak_mb: peaks.length ? Math.max(...peaks) : null,
      median_cpu_s: median(runs.map(r => r.cpu_s).filter(v => v !== null)), median_wall_s: median(runs.map(r => r.wall_s).filter(v => v !== null)),
      median_peak_of_need: median(measured.map(r => Math.round(r.peak_mb / r.need_mb * 100) / 100)),
      over_need: measured.filter(r => r.peak_mb > r.need_mb).length,
      estimates: { more: runs.filter(r => r.load_estimate === 'more').length, same: runs.filter(r => r.load_estimate === 'same').length, less: runs.filter(r => r.load_estimate === 'less').length, mem: runs.filter(r => r.mem_estimate !== null).length },
      next_need_mb: need.mb, next_cpus: need.cpus,
      refused: all.filter(r => r.status === 'refused').length, released: all.filter(r => r.status === 'released').length,
    };
  });
}
