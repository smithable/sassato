import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Store, type Row } from './storage.js';
import { check, id, name, now, text } from './errors.js';
import { processIdentity, sessionState } from './coordination.js';
import { workspaceSettings } from './workspace-settings.js';

export type StopState = 'acknowledged' | 'exited' | 'inactive' | 'waiting';
export interface StopRequest {
  id: string;
  workspace_id: number;
  role: string;
  requested_at: string;
  requested_by: string;
  acknowledged_at: string | null;
  cleared_at: string | null;
  state: StopState;
  session_id: string | null;
  session_state: ReturnType<typeof sessionState> | null;
  pid: number | null;
  process_start: string | null;
  pending_work: number;
  launcher_pending: boolean;
  waiting_reason?: string;
  human_action?: string;
}
export interface SelectionOptions { all?: boolean }
function selectedRoles(s: Store, selected: string[], options: SelectionOptions, requesting: boolean): string[] {
  check(!(options.all && selected.length), 'Choose named roles or --all');
  const selectedNames = selected.length ? selected.map(name) : requesting
    ? s.all("SELECT name FROM roles WHERE workspace_id=? AND kind='agent' ORDER BY name",s.ws).map(r=>r.name as string)
    : s.all('SELECT role FROM stop_requests WHERE workspace_id=? AND cleared_at IS NULL ORDER BY role',s.ws).map(r=>r.role as string);
  check(new Set(selectedNames).size === selectedNames.length, 'A role was selected twice');
  for (const role of selectedNames) {
    const config = s.role(role);
    if (requesting) check(config.kind === 'agent', `Stop requests apply to agent roles, not ${role}`);
  }
  return selectedNames;
}
function pendingLauncher(s: Store, role: string): boolean {
  if (s.path === ':memory:') return false;
  const path = join(`${s.path}.launch`,s.workspace,`${name(role)}.lock`);
  let lock: {pid?: unknown; identity?: unknown};
  try { lock = JSON.parse(readFileSync(path,'utf8')); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
  // A launcher owns this lock before spawning and until cleanup. Its provider may not yet
  // be in the session registry, so unreadable/unverifiable locks must not imply inactivity.
  if (!lock || !Number.isSafeInteger(lock.pid) || Number(lock.pid) < 1 || Number(lock.pid) > 2**31-1 ||
      typeof lock.identity !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]+$/i.test(lock.identity)) return true;
  const pid = Number(lock.pid), identity = processIdentity(pid);
  if (identity) return identity === lock.identity;
  try { process.kill(pid,0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function remoteQueuePending(s: Store, role: string, registration?: Row): boolean {
  // Match the registry's active-first selection, not an older verified PID that
  // still needs to stop. Explicit replacement retires the previous thread's hints.
  const current = registration ?? s.get('SELECT * FROM sessions WHERE workspace_id=? AND role=? ORDER BY (ended_at IS NULL) DESC,id DESC LIMIT 1',s.ws,role);
  if (!current) return false;
  const sessionId = `S${current.id}`;
  const queued = s.get(`SELECT id FROM events WHERE workspace_id=? AND entity='watch' AND entity_id=? AND action='queue-attempt'
    AND json_extract(detail,'$.session_id')=? AND json_extract(detail,'$.outcome') IN ('queued','unconfirmed')
    ORDER BY id DESC LIMIT 1`,s.ws,role,sessionId);
  if (!queued) return false;
  const ended = s.get("SELECT 1 FROM events WHERE workspace_id=? AND entity='session' AND entity_id=? AND action='ended' AND json_extract(detail,'$.role')=? AND id>? LIMIT 1",s.ws,sessionId,role,queued.id);
  const acknowledged = s.get("SELECT 1 FROM events WHERE workspace_id=? AND entity='stop' AND action='acknowledged' AND json_extract(detail,'$.role')=? AND id>? LIMIT 1",s.ws,role,queued.id);
  // Notification progress may be saved in the middle of a turn. It is not an
  // attestation that the provider and its jobs have stopped. Event IDs, rather
  // than wall-clock timestamps, order queue attempts and stop attestations.
  return !ended && !acknowledged;
}
function view(s: Store, row: Row): StopRequest {
  const history = s.all('SELECT * FROM sessions WHERE workspace_id=? AND role=? ORDER BY id DESC',s.ws,row.role);
  const evaluated = history.map(session => ({session,state:sessionState(session)}));
  // A newer exit record must not hide an older provider that still runs. Historical ended
  // no-PID hints are not exit evidence, but need not block a later verified session's exit.
  const running = evaluated.find(entry => entry.state === 'running');
  const uncertain = evaluated.find(entry => entry.state === 'unknown' && (!entry.session.ended_at || (entry.session.pid && entry.session.process_start)));
  const selected = running ?? uncertain ?? evaluated[0];
  const session = selected?.session;
  const currentState = selected?.state ?? null;
  const pending = Number(s.get("SELECT count(*) AS n FROM tasks WHERE workspace_id=? AND owner=? AND status IN ('doing','blocked','review')",s.ws,row.role)!.n);
  // An end marker alone does not prove exit: an identified PID must be verified gone/reused.
  const verifiedExit = !!session?.pid && !!session?.process_start && (currentState === 'stale' || currentState === 'ended');
  const launcherPending = pendingLauncher(s,row.role);
  // A current remote queue can outlive its terminal PID. Launcher exit alone
  // is not daemon-turn exit, but old registrations and known failed queues are
  // not evidence that the currently registered thread still has work.
  const registration=history.find(entry=>!entry.ended_at)??history[0];
  const remotePending=remoteQueuePending(s,row.role,registration);

  // Tasks survive sessions and are not evidence of a running worker. Unknown
  // registrations still require acknowledgement or verified exit.
  // An explicit end clears an unverified no-PID registration, not a live verified
  // process. A human must independently verify shutdown before using this escape.
  const endedWithoutPid = !!session?.ended_at && !session.pid && currentState === 'ended';
  const state: StopState = row.acknowledged_at&&!remotePending ? 'acknowledged' : launcherPending||remotePending ? 'waiting' : verifiedExit ? 'exited' : !session || endedWithoutPid ? 'inactive' : 'waiting';
  const unresolvedRegistration = state === 'waiting' && !launcherPending && session && (!session.pid||remotePending);
  return {
    id:`R${row.id}`,workspace_id:row.workspace_id,role:row.role,requested_at:row.requested_at,requested_by:row.requested_by,
    acknowledged_at:row.acknowledged_at,cleared_at:row.cleared_at,state,
    session_id:session ? `S${session.id}` : null,session_state:currentState,
    pid:session?.pid ?? null,process_start:session?.process_start ?? null,pending_work:pending,launcher_pending:launcherPending,
    ...(unresolvedRegistration ? {
      waiting_reason:remotePending?'A queued Codex turn may outlive its terminal; wait for worker acknowledgement or independently verify remote shutdown.':'Registered session has no PID; Sassato cannot verify that its provider has stopped.',
      human_action:`After independently verifying this role's provider and jobs have stopped, a human may run: sassato session end --for ${row.role} --as ${row.requested_by} --workspace ${s.workspace}`
    } : {})
  };
}
/** Request a durable cooperative checkpoint. Repeating an active request preserves its generation. */
export function requestStop(s: Store, selected: string[] = [], options: SelectionOptions = {}): StopRequest[] {
  return s.tx(() => {
    const actor = s.requireHuman(), roles = selectedRoles(s,selected,options,true), at = now();
    return roles.map(role => {
      const existing = s.get('SELECT * FROM stop_requests WHERE workspace_id=? AND role=? AND cleared_at IS NULL',s.ws,role);
      if (existing) return view(s,existing);
      const n = s.run('INSERT INTO stop_requests(workspace_id,role,requested_at,requested_by) VALUES(?,?,?,?)',s.ws,role,at,actor).lastInsertRowid;
      s.event('stop',`R${n}`,'requested',{role});
      return view(s,s.get('SELECT * FROM stop_requests WHERE workspace_id=? AND id=?',s.ws,n)!);
    });
  });
}
/** Active requests only. A missing captured request ID means it was cleared, not acknowledged. */
export function stopStatus(s: Store, selected: string[] = []): StopRequest[] {
  return s.snapshot(() => {
    const roles = selectedRoles(s,selected,{},false);
    return roles.flatMap(role => {
      const row = s.get('SELECT * FROM stop_requests WHERE workspace_id=? AND role=? AND cleared_at IS NULL',s.ws,role);
      return row ? [view(s,row)] : [];
    });
  });
}
/** Scriptable stop intent includes acknowledged requests until a human resumes work. */
export function activeStop(s:Store,selected:string[]=[],stopFile?:string):boolean {
  const active=stopStatus(s,selected).length>0;
  const path=stopFile??workspaceSettings(s).stop_file;
  if(active)return true;
  if(path!==null)try{statSync(text(path,'stop file',4096));return true;}catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  }
  return false;
}
/** A role confirms it has saved a resumable checkpoint; it must name this exact active generation. */
export function acknowledgeStop(s: Store, requestId: string): StopRequest {
  const requestNumber = id(requestId,'R');
  return s.tx(() => {
    const actor = s.requireActor();
    const request = s.get('SELECT * FROM stop_requests WHERE workspace_id=? AND id=? AND cleared_at IS NULL',s.ws,requestNumber);
    check(request, 'Stop request is absent, cleared or belongs to another workspace',4);
    check(request.role === actor, 'Only the requested role may acknowledge its stop',3);
    // A queue accepted after the previous acknowledgement can start a new remote
    // turn. Permit a fresh attestation for that same active STOP generation.
    if (!request.acknowledged_at || remoteQueuePending(s,actor)) {
      const at = now();
      s.run('UPDATE stop_requests SET acknowledged_at=? WHERE workspace_id=? AND id=?',at,s.ws,requestNumber);
      s.event('stop',requestId,'acknowledged',{role:actor});
    }
    return view(s,s.get('SELECT * FROM stop_requests WHERE workspace_id=? AND id=?',s.ws,requestNumber)!);
  });
}
/** Clear stop intent without starting a provider or changing its tasks. */
export function resumeWork(s: Store, selected: string[] = [], options: SelectionOptions = {}): StopRequest[] {
  return s.tx(() => {
    s.requireHuman();
    const roles = selectedRoles(s,selected,options,false), at = now();
    return roles.flatMap(role => {
      const request = s.get('SELECT * FROM stop_requests WHERE workspace_id=? AND role=? AND cleared_at IS NULL',s.ws,role);
      if (!request) return [];
      s.run('UPDATE stop_requests SET cleared_at=? WHERE workspace_id=? AND id=?',at,s.ws,request.id);
      s.event('stop',`R${request.id}`,'cleared',{role});
      return [view(s,{...request,cleared_at:at})];
    });
  });
}
/** Call inside the transaction that claims/launches new work so a stop cannot race the check. */
export function assertWorkAllowed(s: Store, role: string): void {
  const target = name(role);s.role(target);
  const request = s.get('SELECT id FROM stop_requests WHERE workspace_id=? AND role=? AND cleared_at IS NULL',s.ws,target);
  check(!request, `Stop requested for ${target}${request ? ` (R${request.id})` : ''}; save current work and wait for a human to resume it`,4);
}
