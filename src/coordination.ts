import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { Store, type Row } from './storage.js';
import { AppError, check, id, integer, name, now, text } from './errors.js';
import { workspaceSettings } from './workspace-settings.js';
import { getCheckpoint } from './checkpoints.js';
import { getNotificationProgress } from './notification-progress.js';
import { normalizeOption, ROLE_OPTION_KEYS, validateRoleOptions, type RoleOptions } from './role-options.js';

function optionalText(value: string | null | undefined, label: string, max = 2_000): string | null {
  if (value === undefined || value === null || value === '') return null;
  return text(value, label, max);
}
function date(value: string, label: string): string {
  check(/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && Number.isFinite(Date.parse(value)), `${label} must be an ISO date or timestamp`);
  const normalized = new Date(value).toISOString();
  check(normalized.slice(0,10) === value.slice(0,10), `${label} must be a valid UTC calendar date`);
  return normalized;
}
function limit(value: number | undefined, fallback = 20): number { return integer(value ?? fallback, 'limit', 1, 100); }
function publicMessage(row: Row): Row { return { ...row, urgent:Boolean(row.urgent), id: `M${row.id}`, task_id: row.task_id === null ? null : `T${row.task_id}` }; }
function publicFact(row: Row): Row { return { ...row, id: `F${row.id}` }; }
function externalId(value: string | undefined): string | null {
  if (value === undefined) return null;
  check(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(value), 'Session id must be 1–200 letters, digits, dots, underscores, colons or hyphens');
  return value;
}

export function roles(s: Store): Row[] { return s.all('SELECT * FROM roles WHERE workspace_id=? ORDER BY name', s.ws); }
export interface RoleInput extends RoleOptions { kind?: 'human' | 'agent'; provider?: string | null; model?: string | null; working_dir?: string | null }
export function setRole(s: Store, roleName: string, input: RoleInput): Row {
  const role = name(roleName), actor = s.requireActor();
  return s.tx(() => {
    const old = s.get('SELECT * FROM roles WHERE workspace_id=? AND name=?', s.ws, role);
    if (actor !== role || !old || (input.kind !== undefined && input.kind !== old.kind)) s.requireHuman();
    const kind = input.kind ?? old?.kind ?? 'agent';
    check(kind === 'human' || kind === 'agent', 'Role kind must be human or agent');
    if (old?.kind === 'human' && kind !== 'human') {
      check(workspaceSettings(s).default_human!==role,'Change the workspace default human before demoting this role',3);
      check(s.get("SELECT count(*) AS n FROM roles WHERE workspace_id=? AND kind='human'",s.ws)!.n > 1, 'The last human role must remain human',3);
      const work = s.get("SELECT id FROM tasks WHERE workspace_id=? AND human_only=1 AND status NOT IN ('done','dropped') AND (owner=? OR for_role=?) LIMIT 1",s.ws,role,role);
      const waiting = s.get("SELECT id FROM blockers WHERE workspace_id=? AND kind='human' AND waiting_on=? AND status='open' LIMIT 1",s.ws,role);
      check(!work && !waiting, 'Resolve or reassign pending human work before changing this role to an agent',3);
    }
    const provider = input.provider === undefined ? old?.provider ?? null : optionalText(input.provider, 'provider', 40);
    if (provider !== null) name(provider);
    check(!workspaceSettings(s).codex_watch[role]||(kind==='agent'&&provider==='codex'),'Disable this role in workspace codex_watch before changing its kind or provider',3);
    const model = input.model === undefined ? old?.model ?? null : optionalText(normalizeOption(input.model), 'model', 200);
    const launchOptions = Object.fromEntries(ROLE_OPTION_KEYS.map(key => [key,input[key] === undefined ? old?.[key] ?? null : normalizeOption(input[key]) ?? null]));
    for (const key of ['permission_mode','sandbox_mode','approval_policy'] as const) {
      if (launchOptions[key] !== (old?.[key] ?? null)) s.requireHuman();
    }
    validateRoleOptions(provider,launchOptions);
    let workingDir = input.working_dir === undefined ? old?.working_dir ?? null : optionalText(input.working_dir, 'working directory', 4_096);
    if (workingDir !== null) { workingDir = realpathSync(workingDir); check(statSync(workingDir).isDirectory(), 'Working directory must be a directory'); }
    s.run('INSERT INTO roles(workspace_id,name,kind,provider,model,working_dir,reasoning_effort,permission_mode,sandbox_mode,approval_policy) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,name) DO UPDATE SET kind=excluded.kind,provider=excluded.provider,model=excluded.model,working_dir=excluded.working_dir,reasoning_effort=excluded.reasoning_effort,permission_mode=excluded.permission_mode,sandbox_mode=excluded.sandbox_mode,approval_policy=excluded.approval_policy', s.ws,role,kind,provider,model,workingDir,launchOptions.reasoning_effort,launchOptions.permission_mode,launchOptions.sandbox_mode,launchOptions.approval_policy);
    const result = s.role(role); s.event('role',role,old ? 'updated' : 'created',{ before: old ?? null, after: result }); return result;
  });
}
export function setUsage(s: Store, usage: string, until?: string): Row {
  const actor = s.requireActor(), value = optionalText(usage, 'usage state');
  const expires = until ? date(until, 'usage until') : null;
  return s.tx(() => {
    s.run('UPDATE roles SET usage=?,usage_until=? WHERE workspace_id=? AND name=?',value,expires,s.ws,actor);
    s.event('role',actor,'usage',{ usage: value, until: expires }); return s.role(actor);
  });
}

/** Linux process start time plus boot identity: PID reuse and reboots cannot impersonate an old process. */
export function processIdentity(pid: number): string | null {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`,'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') return null;
    const start = fields[19];
    if (!/^\d+$/.test(start)) return null;
    return `${readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()}:${start}`;
  } catch { return null; }
}
function providerProcess(pid: number, provider: string): boolean {
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0').filter(Boolean);
    // Node-based wrappers may place their executable script in argv[1]. No substring matches.
    return args.slice(0,2).some(arg => {
      const executable = basename(arg).replace(/\.(?:js|mjs|cjs|exe)$/,'');
      return executable === provider || (provider === 'codex' && executable === 'codex-cli');
    });
  } catch { return false; }
}
export function sessionState(row: Row): 'ended' | 'running' | 'stale' | 'unknown' {
  // Registry end is intent, not proof of process exit (SessionEnd can run before exit).
  if (!row.pid || !row.process_start) return row.ended_at ? 'ended' : 'unknown';
  const fingerprint = processIdentity(Number(row.pid));
  if (!fingerprint) {
    try { process.kill(Number(row.pid),0); return 'unknown'; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? (row.ended_at ? 'ended' : 'stale') : 'unknown'; }
  }
  if (fingerprint !== row.process_start) return row.ended_at ? 'ended' : 'stale';
  return providerProcess(Number(row.pid),row.provider) ? 'running' : 'unknown';
}
export function sessions(s: Store): Row[] {
  return s.all('SELECT x.* FROM sessions x WHERE x.workspace_id=? AND x.id=(SELECT max(y.id) FROM sessions y WHERE y.workspace_id=x.workspace_id AND y.role=x.role) ORDER BY x.role',s.ws).map(row => ({ ...row, id: `S${row.id}`, state: sessionState(row), heartbeat_stale: Date.now()-Date.parse(row.last_seen_at) > 15*60_000 }));
}
export interface SessionInput { provider: string; external_id?: string; pid?: number; replace?: boolean }
export function registerSession(s: Store, input: SessionInput): Row {
  const actor = s.requireActor(), provider = name(input.provider), external = externalId(input.external_id);
  const pid = input.pid === undefined ? null : integer(input.pid,'pid',1,2**31-1);
  const fingerprint = pid === null ? null : processIdentity(pid);
  if (pid !== null) check(fingerprint && providerProcess(pid,provider), 'PID is not a verifiable running process for this provider',3);
  return s.tx(() => {
    const latest = s.get('SELECT * FROM sessions WHERE workspace_id=? AND role=? ORDER BY (ended_at IS NULL) DESC,id DESC LIMIT 1',s.ws,actor);
    const old = latest && (!latest.ended_at || sessionState(latest) === 'running') ? latest : undefined;
    const at = now();
    if (old) {
      const sameProcess = pid !== null && old.pid === pid && old.process_start === fingerprint && old.provider === provider;
      const sameSession = old.external_id === external && old.provider === provider;
      if (!old.ended_at && sameSession && (sameProcess || (pid === null && old.pid === null))) {
        s.run('UPDATE sessions SET last_seen_at=? WHERE id=? AND workspace_id=?',at,old.id,s.ws);
        s.event('session',`S${old.id}`,'heartbeat',{ role: actor });
        return { ...s.get('SELECT * FROM sessions WHERE workspace_id=? AND id=?',s.ws,old.id), id: `S${old.id}`, state: sessionState(old) };
      }
      const state = sessionState(old);
      check(state !== 'running' || sameProcess, 'The role already has a verified running session; do not duplicate it',4);
      check(input.replace || sameProcess, 'An existing session needs explicit --replace (or end it first)',4);
      // Unknown process identity is not proof of exit. Explicit replacement is an operator decision,
      // while a verified live process can never be replaced by a different PID.
      s.run('UPDATE sessions SET ended_at=? WHERE workspace_id=? AND id=?',at,s.ws,old.id);
      s.event('session',`S${old.id}`,'replaced',{ role: actor, previous_external_id: old.external_id });
    }
    const n = s.run('INSERT INTO sessions(workspace_id,role,provider,external_id,pid,process_start,started_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?)',s.ws,actor,provider,external,pid,fingerprint,at,at).lastInsertRowid;
    s.event('session',`S${n}`,'registered',{ role: actor, provider, external_id: external, pid });
    const result = s.get('SELECT * FROM sessions WHERE workspace_id=? AND id=?',s.ws,n)!;
    return { ...result,id:`S${n}`,state:sessionState(result) };
  });
}
function currentSession(s: Store, external?: string): Row {
  const actor = s.requireActor();
  const row = s.get('SELECT * FROM sessions WHERE workspace_id=? AND role=? AND ended_at IS NULL',s.ws,actor);
  check(row, 'No active session registered for this role',3);
  if (external !== undefined) check(row.external_id === externalId(external),'Session was replaced; this session may not update its successor',4);
  return row;
}
export function heartbeat(s: Store, external?: string): Row {
  return s.tx(() => {
    const row = currentSession(s,external), at = now();
    s.run('UPDATE sessions SET last_seen_at=? WHERE workspace_id=? AND id=?',at,s.ws,row.id);
    s.event('session',`S${row.id}`,'heartbeat',{ role: row.role });
    return { ...row,id:`S${row.id}`,last_seen_at:at,state:sessionState(row) };
  });
}
export function endSession(s: Store, external?: string, targetRole?:string): Row {
  return s.tx(() => {
    let row:Row;
    if(targetRole===undefined)row=currentSession(s,external);
    else {
      s.requireHuman();const target=name(targetRole);
      check(s.role(target).kind==='agent','Human session-end override applies to agent roles',3);
      const latest=s.get('SELECT * FROM sessions WHERE workspace_id=? AND role=? ORDER BY (ended_at IS NULL) DESC,id DESC LIMIT 1',s.ws,target);
      check(latest,'No session registered for the target role',3);
      if(external!==undefined)check(latest.external_id===externalId(external),'Session was replaced; inspect the current registration before ending it',4);
      // A remote turn may outlive the terminal that already ended this row.
      // Human verification must produce a new audit event without impersonating it.
      row=latest;
    }
    const at=now();
    s.run('UPDATE sessions SET ended_at=coalesce(ended_at,?) WHERE workspace_id=? AND id=?',at,s.ws,row.id);
    s.event('session',`S${row.id}`,'ended',{ role: row.role,...(targetRole===undefined?{}:{human_override:true}) });
    return { ...row,id:`S${row.id}`,ended_at:row.ended_at??at,state:'ended' };
  });
}

export function send(s: Store, recipients: string[] | 'all', body: string, options: { task?: string; urgent?: boolean } = {}): Row {
  const actor = s.requireActor(), content = text(body,'message');
  return s.tx(() => {
    const targets = [...new Set(recipients === 'all' ? roles(s).map(r => r.name as string).filter(r => r !== actor) : recipients.map(name))];
    check(targets.length > 0 && targets.length <= 100,'Choose 1–100 message recipients');
    targets.forEach(role => s.role(role));
    const task = options.task ? s.task(options.task).id : null, at = now();
    const n = s.run('INSERT INTO messages(workspace_id,sender,body,task_id,created_at,urgent) VALUES(?,?,?,?,?,?)',s.ws,actor,content,task,at,options.urgent?1:0).lastInsertRowid;
    for (const recipient of targets) s.run('INSERT INTO receipts(workspace_id,message_id,recipient) VALUES(?,?,?)',s.ws,n,recipient);
    s.index('message',`M${n}`,`${actor} → ${targets.join(', ')}`,content,{role:actor,updated_at:at});
    s.event('message',`M${n}`,'sent',{ recipients: targets, task: options.task ?? null, urgent:!!options.urgent });
    return { id:`M${n}`,sender:actor,recipients:targets,urgent:!!options.urgent,body:content,task_id:options.task ?? null,created_at:at };
  });
}
export interface InboxOptions { peek?: boolean; state?: 'unread' | 'read' | 'done' | 'pending' | 'all'; limit?: number }
export function inbox(s: Store, options: InboxOptions = {}): Row[] {
  const actor = s.requireActor(), count = limit(options.limit), state = options.state ?? 'pending';
  check(['unread','read','done','pending','all'].includes(state),'Invalid inbox state');
  const read = () => {
    const predicate = state === 'all' ? '1=1' : state === 'pending' ? "r.state IN ('unread','read')" : 'r.state=?';
    const params = state === 'all' || state === 'pending' ? [s.ws,actor,count] : [s.ws,actor,state,count];
    const rows = s.all(`SELECT m.*,r.state,r.read_at,r.done_at FROM receipts r JOIN messages m ON m.workspace_id=r.workspace_id AND m.id=r.message_id WHERE r.workspace_id=? AND r.recipient=? AND ${predicate} ORDER BY CASE r.state WHEN 'unread' THEN 0 WHEN 'read' THEN 1 ELSE 2 END,m.urgent DESC,m.id LIMIT ?`,...params);
    if (!options.peek) for (const row of rows) if (row.state === 'unread') {
      row.read_at = now(); row.state = 'read';
      s.run("UPDATE receipts SET state='read',read_at=? WHERE workspace_id=? AND message_id=? AND recipient=? AND state='unread'",row.read_at,s.ws,row.id,actor);
      s.event('message',`M${row.id}`,'read',{ recipient: actor });
    }
    return rows.map(publicMessage);
  };
  return options.peek ? read() : s.tx(read);
}
export function outbox(s: Store, options: { limit?: number } = {}): Row[] {
  const actor = s.requireActor();
  return s.snapshot(() => s.all('SELECT * FROM messages WHERE workspace_id=? AND sender=? ORDER BY id DESC LIMIT ?',s.ws,actor,limit(options.limit)).map(row => ({ ...publicMessage(row),receipts:s.all('SELECT recipient,state,read_at,done_at FROM receipts WHERE workspace_id=? AND message_id=? ORDER BY recipient',s.ws,row.id) })));
}
export function acknowledge(s: Store, messageId: string): Row {
  const actor = s.requireActor(), n = id(messageId,'M');
  return s.tx(() => {
    const row = s.get('SELECT * FROM receipts WHERE workspace_id=? AND message_id=? AND recipient=?',s.ws,n,actor);
    check(row,'Message is not addressed to this role',3);
    if (row.state !== 'done') {
      const at = now();
      s.run("UPDATE receipts SET state='done',read_at=coalesce(read_at,?),done_at=? WHERE workspace_id=? AND message_id=? AND recipient=?",at,at,s.ws,n,actor);
      s.event('message',messageId,'done',{ recipient:actor });
    }
    return { ...s.get('SELECT * FROM receipts WHERE workspace_id=? AND message_id=? AND recipient=?',s.ws,n,actor),message_id:messageId };
  });
}

export interface FactInput { body: string; source: string; checked_at?: string; expected_version?: number }
export function setFact(s: Store, key: string, input: FactInput): Row {
  const actor = s.requireActor(); text(key,'fact key',200);
  const body = text(input.body,'fact'), source = text(input.source,'fact source',4_096), checked = input.checked_at ? date(input.checked_at,'checked date') : now();
  return s.tx(() => {
    const old = s.get('SELECT * FROM facts WHERE workspace_id=? AND key=?',s.ws,key);
    if (old) check(input.expected_version !== undefined && integer(input.expected_version,'expected version',1) === old.version,'Fact changed or expected version missing; read it and retry with --expect',4);
    else check(input.expected_version === undefined || input.expected_version === 0,'Fact does not exist at that version',4);
    const at = now();
    s.run('INSERT INTO facts(workspace_id,key,body,source,checked_at,updated_by,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace_id,key) DO UPDATE SET body=excluded.body,source=excluded.source,checked_at=excluded.checked_at,updated_by=excluded.updated_by,updated_at=excluded.updated_at,version=facts.version+1',s.ws,key,body,source,checked,actor,at);
    const result = s.get('SELECT * FROM facts WHERE workspace_id=? AND key=?',s.ws,key)!;
    s.index('fact',`F${result.id}`,key,`${body}\nSource: ${source}\nChecked: ${checked}`,{role:actor,updated_at:at});
    s.event('fact',`F${result.id}`,old ? 'corrected' : 'created',{ before:old ?? null, after:result });
    return publicFact(result);
  });
}
function factTimeParts(value:string,zone:string):Record<string,string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).map(part=>[part.type,part.value]));
}
function factDay(value:string,zone:string):string {
  const p=factTimeParts(value,zone);return `${p.year.padStart(4,'0')}-${p.month}-${p.day}`;
}
export function facts(s: Store, options: { key?: string; limit?: number; since?:string } = {}): Row[] {
  return s.snapshot(()=>{
  if(options.key!==undefined)return s.all('SELECT * FROM facts WHERE workspace_id=? AND key=?',s.ws,options.key).map(publicFact);
  const count=limit(options.limit);
  if(options.since===undefined)return s.all('SELECT * FROM facts WHERE workspace_id=? ORDER BY updated_at DESC,id DESC LIMIT ?',s.ws,count).map(publicFact);
  const day=options.since,utc=Date.parse(`${day}T00:00:00.000Z`);
  check(/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(utc)&&new Date(utc).toISOString().slice(0,10)===day,'--since must be a calendar date in YYYY-MM-DD form');
  const zone=workspaceSettings(s).import_timezone,result:Row[]=[];
  // Fetch bounded pages beginning before every possible local midnight. Comparing
  // calendar dates in the workspace zone also handles midnight DST transitions.
  let after=new Date(utc-36*3_600_000).toISOString(),afterId=0;
  while(result.length<count) {
    const rows=s.all('SELECT * FROM facts WHERE workspace_id=? AND (updated_at>? OR (updated_at=? AND id>?)) ORDER BY updated_at,id LIMIT 100',s.ws,after,after,afterId);
    if(!rows.length)break;
    for(const row of rows)if(factDay(row.updated_at,zone)>=day) {result.push(publicFact(row));if(result.length===count)break;}
    const last=rows[rows.length-1];after=last.updated_at;afterId=last.id;
  }
  return result;
  });
}
export function factHistory(s: Store, key: string): Row[] {
  const fact = s.get('SELECT id FROM facts WHERE workspace_id=? AND key=?',s.ws,key);
  check(fact,'Fact not found',3);
  return s.all("SELECT * FROM events WHERE workspace_id=? AND entity='fact' AND entity_id=? ORDER BY id",s.ws,`F${fact.id}`).map(row => ({ ...row,id:`E${row.id}`,detail:JSON.parse(row.detail) }));
}
/** Human-readable facts keep the full version text and provenance out of generic clipping. */
export function renderFacts(s:Store,rows:Row[],kind:'list'|'get'|'history'):string {
  if(!rows.length)return 'No matching facts.';
  const zone=workspaceSettings(s).import_timezone;
  const clean=(value:unknown)=>String(value??'').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,' ');
  const oneLine=(value:unknown)=>clean(value).replace(/\s+/g,' ').trim();
  const stamp=(value:string)=>{const p=factTimeParts(value,zone);return `${p.year.padStart(4,'0')}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${zone}`;};
  return rows.map(row=>{
    const fact=kind==='history'?row.detail.after:row;
    const identity=kind==='history'?row.entity_id:fact.id;
    const provenance=`set by ${oneLine(fact.updated_by)} at ${stamp(fact.updated_at)}, source: ${oneLine(fact.source)}`;
    const heading=`${identity} ${oneLine(fact.key)} · version ${fact.version}`;
    if(kind==='list') {const body=oneLine(fact.body);return `${heading} · ${body.length>220?body.slice(0,220)+'…':body} · ${provenance}`;}
    return `${heading}\n${clean(fact.body)}\n${provenance}\nchecked at ${stamp(fact.checked_at)}`;
  }).join(kind==='list'?'\n':'\n\n');
}
export interface WipInput { current?: string; next?: string; notes?: string; expected_version?: number }
export function setWip(s: Store, input: WipInput): Row {
  const actor = s.requireActor();
  for (const value of [input.current,input.next,input.notes]) if (value !== undefined && value !== '') text(value,'WIP entry',10_000);
  return s.tx(() => {
    const old = s.get('SELECT * FROM wip WHERE workspace_id=? AND role=?',s.ws,actor);
    if (old) check(input.expected_version !== undefined && integer(input.expected_version,'expected version',0) === old.version,`WIP changed or expected version missing; current version is ${old.version}. Read it and retry with --expect ${old.version}`,4);
    else check(input.expected_version === undefined || input.expected_version === 0,'WIP does not exist at that version',4);
    const at = now(), current = input.current ?? old?.current ?? '', next = input.next ?? old?.next ?? '', notes = input.notes ?? old?.notes ?? '';
    s.run('INSERT INTO wip(workspace_id,role,current,next,notes,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,role) DO UPDATE SET current=excluded.current,next=excluded.next,notes=excluded.notes,updated_at=excluded.updated_at,version=wip.version+1',s.ws,actor,current,next,notes,at);
    const result = s.get('SELECT * FROM wip WHERE workspace_id=? AND role=?',s.ws,actor)!;
    s.index('wip',actor,`${actor} WIP`,`${current}\n${next}\n${notes}`,{role:actor,updated_at:at});
    s.event('wip',actor,old ? 'updated' : 'created',{ before:old ?? null, after:result }); return result;
  });
}
export function getWip(s: Store, role?: string): Row {
  const target = role ? name(role) : s.requireActor(); s.role(target);
  return s.get('SELECT * FROM wip WHERE workspace_id=? AND role=?',s.ws,target) ?? {role:target,current:'',next:'',notes:'',version:0};
}

const clip = (value: unknown, max = 160): string => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').slice(0,max);
export interface ContextData {
  workspace: string; role: string; permissions: string; cursor: number; snapshot_cursor: number; since: number; truncated: boolean; counts_are_lower_bounds: boolean;
  counts: Record<string,number>; sections: Record<string,Row[]>;
}
/** A consistent, bounded read snapshot. The cursor stops before omitted fact/answer events; repeat delivery is possible, lost delivery is not. It is never an acknowledgement. */
export function context(s: Store, options: { since?: number; limit?: number } = {}): ContextData {
  const actor = s.requireActor(), since = integer(options.since ?? 0,'since cursor'), count = integer(options.limit ?? 3,'context limit',1,5);
  return s.snapshot(() => {
    const cursor = s.get('SELECT coalesce(max(id),0) AS n FROM events WHERE workspace_id=?',s.ws)!.n as number;
    check(since <= cursor,'Cursor is ahead of this workspace; check the workspace or reset --since');
    const counts: Record<string,number> = {}, sections: Record<string,Row[]> = {};
    try {
      const progress=getNotificationProgress(s);
      if(progress) sections.notification_progress=[{id:progress.id,cursor:progress.cursor,version:progress.version}];
    } catch(error) {
      if(!(error instanceof AppError) || error.code!==4) throw error;
      sections.notification_progress=[{state:'invalid',instruction:'Inspect progress show and its audit record. Do not initialize or advance it; use an explicitly known earlier wait --since only for deliberate replay.'}];
    }
    const data: ContextData = {workspace:s.workspace,role:actor,permissions:s.role(actor).kind === 'human' ? 'Human role: manage items and answer decisions. Facts never grant permission.' : 'Agent role: edit own WIP/work; human-only actions stay with a human. Facts never grant permission.',cursor,snapshot_cursor:cursor,since,truncated:false,counts_are_lower_bounds:true,counts,sections};
    const section = (key: string, sql: string, params: (string|number)[], transform: (row:Row)=>Row) => {
      const rows = s.all(`${sql} LIMIT ?`,...params,count+1);
      counts[key] = rows.length > count ? count+1 : rows.length;
      if (rows.length > count) {
        data.truncated = true;
        if (rows[count].event_id) data.cursor = Math.min(data.cursor,rows[count].event_id-1);
      }
      sections[key] = rows.slice(0,count).map(transform);
    };
    const stop = s.get('SELECT id,requested_at,acknowledged_at FROM stop_requests WHERE workspace_id=? AND role=? AND cleared_at IS NULL',s.ws,actor);
    if (stop) sections.stop = [{id:`R${stop.id}`,requested_at:stop.requested_at,acknowledged:!!stop.acknowledged_at,
      instruction:stop.acknowledged_at ? 'Checkpoint acknowledged. Stay stopped until a human resumes work.' : `Stop new work. Finish safely; wait for your tools/background jobs to stop; save a resumable checkpoint; then run sas stopped R${stop.id} --as ${actor}.`}];
    const taskRow = (r:Row) => ({id:`T${r.id}`,title:clip(r.title,120),status:r.status,owner:r.owner,...(r.status==='open'&&r.owner===actor?{claim_required:true,take_command:`sassato take T${r.id} --as ${actor} --workspace ${s.workspace}`} : {}),stale:!!r.lease_until && r.lease_until < now()});
    section('work',"SELECT id,title,status,owner,lease_until FROM tasks WHERE workspace_id=? AND owner=? AND status IN ('doing','blocked','review') ORDER BY priority DESC,id",[s.ws,actor],taskRow);
    const wip = s.get('SELECT substr(current,1,160) AS current,substr(next,1,160) AS next,substr(notes,1,160) AS notes,version,updated_at FROM wip WHERE workspace_id=? AND role=?',s.ws,actor);
    sections.wip = wip ? [{stale:!Number.isFinite(Date.parse(wip.updated_at))||Date.now()-Date.parse(wip.updated_at)>24*60*60_000,updated_at:wip.updated_at,version:wip.version,current:clip(wip.current),next:clip(wip.next),notes:clip(wip.notes)}] : [];
    const checkpoint = getCheckpoint(s,actor);
    if (checkpoint) sections.checkpoint = [{id:checkpoint.id,state:checkpoint.state,stale:checkpoint.state!=='current',saved_at:checkpoint.saved_at,read:'sassato checkpoint show'}];
    section('available',`SELECT t.id,t.title,t.status,t.owner,t.lease_until FROM tasks t WHERE t.workspace_id=? AND t.status='open' AND (t.owner IS NULL OR t.owner=?) AND (t.for_role IS NULL OR t.for_role=?) AND (t.human_only=0 OR ?='human') AND NOT EXISTS(SELECT 1 FROM blockers b WHERE b.workspace_id=t.workspace_id AND b.task_id=t.id AND b.status='open') AND NOT EXISTS(SELECT 1 FROM dependencies d JOIN tasks dep ON dep.workspace_id=d.workspace_id AND dep.id=d.depends_on WHERE d.workspace_id=t.workspace_id AND d.task_id=t.id AND dep.status!='done') ORDER BY t.priority DESC,t.id`,[s.ws,actor,actor,s.role(actor).kind],taskRow);
    section('reviews',"SELECT id,title,status,owner,lease_until FROM tasks WHERE workspace_id=? AND status='review' AND reviewed_by IS NULL AND (owner IS NULL OR owner!=? OR ?='human') ORDER BY priority DESC,id",[s.ws,actor,s.role(actor).kind],taskRow);
    const inboxCounts = s.all('SELECT state,count(*) AS n FROM receipts WHERE workspace_id=? AND recipient=? GROUP BY state',s.ws,actor);
    for (const row of inboxCounts) counts[`inbox_${row.state}`] = row.n;
    section('inbox',"SELECT m.id,m.sender,m.urgent,substr(m.body,1,180) AS body,m.task_id,r.state FROM receipts r JOIN messages m ON m.workspace_id=r.workspace_id AND m.id=r.message_id WHERE r.workspace_id=? AND r.recipient=? AND r.state!='done' ORDER BY CASE r.state WHEN 'unread' THEN 0 ELSE 1 END,m.urgent DESC,m.id",[s.ws,actor],r=>({id:`M${r.id}`,from:r.sender,urgent:!!r.urgent,state:r.state,text:clip(r.body,160),task:r.task_id ? `T${r.task_id}` : null}));
    section('blockers',"SELECT b.id,b.task_id,b.waiting_on,substr(b.body,1,180) AS body FROM blockers b JOIN tasks t ON t.workspace_id=b.workspace_id AND t.id=b.task_id WHERE b.workspace_id=? AND b.status='open' AND t.status NOT IN ('done','dropped') AND (t.owner=? OR b.waiting_on=?) ORDER BY b.id",[s.ws,actor,actor],r=>({id:`B${r.id}`,task:`T${r.task_id}`,waits_on:r.waiting_on,text:clip(r.body,160)}));
    section('dependencies',"SELECT t.id,d.depends_on,p.title,p.owner,p.status FROM dependencies d JOIN tasks t ON t.workspace_id=d.workspace_id AND t.id=d.task_id JOIN tasks p ON p.workspace_id=d.workspace_id AND p.id=d.depends_on WHERE d.workspace_id=? AND (t.owner=? OR p.owner=?) AND t.status NOT IN ('done','dropped') AND p.status!='done' ORDER BY t.id,p.id",[s.ws,actor,actor],r=>({task:`T${r.id}`,waits_on:`T${r.depends_on}`,owner:r.owner,status:r.status,title:clip(r.title,100)}));
    section('questions',"SELECT q.id,q.task_id,b.waiting_on AS for_role,substr(q.question,1,160) AS question FROM questions q JOIN tasks t ON t.workspace_id=q.workspace_id AND t.id=q.task_id JOIN blockers b ON b.workspace_id=q.workspace_id AND b.id=q.blocker_id WHERE q.workspace_id=? AND q.status='pending' AND t.status NOT IN ('done','dropped') AND (q.asked_by=? OR t.owner=? OR ?='human') ORDER BY t.priority DESC,q.id",[s.ws,actor,actor,s.role(actor).kind],r=>({id:`H${r.id}`,task:`T${r.task_id}`,for_role:r.for_role,question:clip(r.question,140)}));
    section('answers',"SELECT q.id,q.task_id,substr(q.answer,1,180) AS answer,e.id AS event_id FROM events e JOIN questions q ON q.workspace_id=e.workspace_id AND e.entity_id='H'||q.id JOIN tasks t ON t.workspace_id=q.workspace_id AND t.id=q.task_id WHERE e.workspace_id=? AND e.id>? AND e.entity='question' AND e.action='answered' AND (q.asked_by=? OR t.owner=?) ORDER BY e.id",[s.ws,since,actor,actor],r=>({id:`H${r.id}`,task:`T${r.task_id}`,answer:clip(r.answer,160),event_id:r.event_id}));
    section('stale',"SELECT id,title,status,owner,lease_until FROM tasks WHERE workspace_id=? AND lease_until<? AND status IN ('doing','blocked','review') ORDER BY lease_until,id",[s.ws,now()],taskRow);
    section('facts',"SELECT f.id,f.key,substr(f.body,1,160) AS body,substr(f.source,1,120) AS source,f.checked_at,f.version,min(e.id) AS event_id FROM events e JOIN facts f ON f.workspace_id=e.workspace_id AND e.entity_id='F'||f.id WHERE e.workspace_id=? AND e.id>? AND e.entity='fact' GROUP BY f.id ORDER BY event_id",[s.ws,since],r=>({id:`F${r.id}`,key:clip(r.key,80),text:clip(r.body,140),source:clip(r.source,90),checked_at:r.checked_at,version:r.version,event_id:r.event_id}));
    const session = s.get('SELECT * FROM sessions WHERE workspace_id=? AND role=? AND ended_at IS NULL',s.ws,actor);
    const role = s.role(actor);
    sections.session = [{state:session ? sessionState(session) : 'unregistered',provider:session?.provider ?? role.provider,usage:clip(role.usage,120),usage_until:role.usage_until,last_seen_at:session?.last_seen_at ?? null}];
    // Bound JSON as well as terminal output, preserving counts and lookup IDs for omitted rows.
    while (JSON.stringify(data).length > 5_800 || Object.values(sections).reduce((n,rows)=>n+rows.length,0) > 33) {
      // Keep delta notifications ahead of snapshots: a bounded snapshot must not prevent the
      // next cursor from making progress, nor hide a returned delta in terminal rendering.
      const delta = (key: string) => key === 'facts' || key === 'answers';
      const candidates = Object.entries(sections).filter(([key,rows])=>key !== 'session' && key !== 'stop' && key !== 'wip' && key !== 'checkpoint' && key !== 'notification_progress' && rows.length > 0).sort((a,b)=>Number(delta(a[0]))-Number(delta(b[0])) || JSON.stringify(b[1]).length-JSON.stringify(a[1]).length);
      if (!candidates.length) break;
      const omitted = candidates[0][1].pop()!;
      if (omitted.event_id) data.cursor = Math.min(data.cursor,omitted.event_id-1);
      data.truncated = true;
    }
    return data;
  });
}
export function renderContext(data: ContextData): string {
  const lines = [`${data.workspace} / ${data.role} · cursor ${data.cursor}`];
  for (const stop of data.sections.stop ?? []) lines.push(`STOP ${stop.id}: ${stop.instruction}`);
  lines.push(data.permissions,`Inbox: ${data.counts.inbox_unread ?? 0} unread, ${data.counts.inbox_read ?? 0} read and pending.`);
  for (const [section,rows] of Object.entries(data.sections)) if (section !== 'stop') for (const row of rows) {
    const values = Object.entries(row).filter(([,value])=>value !== null && value !== '' && value !== false).map(([key,value])=>key === 'id' ? value : `${key}=${value}`).join(' · ');
    lines.push(`${section}: ${clip(values,300)}`);
  }
  if (data.truncated) lines.push('More items exist; use tasks, inbox, blockers, humans or facts for details.');
  lines.push('Context does not mark mail read. Keep this cursor for --since; use inbox to read, ack to finish.');
  let result = lines.slice(0,39).join('\n');
  if (lines.length > 39 || result.length > 5_900) result = `${result.slice(0,5_850)}\n[Truncated; use detailed commands.]`;
  return result;
}
