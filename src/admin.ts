import { messageIsNow } from './wait-digest.js';
import { processIdentity } from './coordination.js';
import { getNotificationProgress } from './notification-progress.js';
import { contextLine } from './context-brief.js';
import { backup, DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os';
import { Store, databasePath, SCHEMA_VERSION, type Row, type Param } from './storage.js';
import { WATCH_REASONS } from './launch-watch.js';
import { pendingLauncher } from './control.js';
import { AppError, check, id, integer, name, now, safe, text } from './errors.js';
import { normalizeOption, ROLE_OPTION_KEYS, validateRoleOptions } from './role-options.js';
import { loadConfig, workingDirectory } from './config.js';
import { validateSettings } from './workspace-settings.js';
import { EMPTY_SET_DIGEST, exportRules, readExport, ruleSet } from './rules.js';

export function initWorkspace(s: Store, workspace: string, configPath?: string | Row, humans?: string[]): Row {
  name(workspace);
  check(!configPath || humans === undefined, 'Choose --config or --humans, not both');
  const config = typeof configPath === 'string' ? loadConfig(configPath) : configPath ?? {};
  safe(config);
  check(config && typeof config === 'object' && !Array.isArray(config), 'Config must be an object');
  const directory=config.working_dir ?? process.cwd();
  const configs: Row[] = structuredClone(config.roles ?? [
    {name:'builder',provider:'claude',working_dir:directory},
    {name:'reviewer',provider:'codex',working_dir:directory},
    ...(humans ?? ['human']).map(human => ({name:human,kind:'human'}))
  ]);
  check(Array.isArray(configs) && configs.length > 0 && configs.length <= 100, 'Config needs 1–100 roles');
  check(configs.every(r => r && typeof r === 'object' && !Array.isArray(r)), 'Each role config must be an object');
  check(configs.some(r => r.kind === 'human'), 'Config must include at least one human role');
  const names = new Set<string>();
  for (const r of configs) {
    name(r.name); check(!names.has(r.name), `Duplicate role ${r.name}`); names.add(r.name);
    check(['human','agent'].includes(r.kind ?? 'agent'), 'Role kind must be human or agent');
    r.model = normalizeOption(r.model);
    for (const key of ['provider','model','working_dir']) if (r[key] !== undefined && r[key] !== null) text(r[key],key,4096);
    if (r.provider !== undefined && r.provider !== null) name(r.provider);
    for (const key of ROLE_OPTION_KEYS) r[key] = normalizeOption(r[key]) ?? null;
    validateRoleOptions(r.provider ?? null,r);
    if (r.working_dir != null) r.working_dir = workingDirectory(r.working_dir);
  }
  return s.tx(() => {
    const previous = s.get('SELECT * FROM workspaces WHERE name=?',workspace);
    if (previous) { s.use(workspace); return {workspace,created:false,roles:s.all('SELECT * FROM roles WHERE workspace_id=?',s.ws)}; }
    s.ws = s.run('INSERT INTO workspaces(name,created_at) VALUES(?,?)',workspace,now()).lastInsertRowid; s.workspace=workspace;
    for (const r of configs) s.run('INSERT INTO roles(workspace_id,name,kind,provider,model,working_dir,reasoning_effort,permission_mode,sandbox_mode,approval_policy) VALUES(?,?,?,?,?,?,?,?,?,?)',s.ws,r.name,r.kind ?? 'agent',r.provider ?? null,r.model ?? null,r.working_dir ? realpathSync(r.working_dir) : null,r.reasoning_effort,r.permission_mode,r.sandbox_mode,r.approval_policy);
    const original = s.actor;
    s.actor = configs.find(r => r.name === original && r.kind === 'human')?.name ?? configs.find(r => r.kind === 'human')!.name;
    try { const settings=validateSettings(s,config); s.event('workspace',workspace,'created',{roles:[...names],settings}); } finally { s.actor=original; }
    return {workspace,created:true,roles:s.all('SELECT * FROM roles WHERE workspace_id=?',s.ws)};
  });
}
export function attachWorkspace(s: Store, path: string): Row {
  s.requireHuman(); const canonical = realpathSync(path);
  check(statSync(canonical).isDirectory(), 'Attached path must be a directory');
  return s.tx(() => {
    const prior = s.get('SELECT workspace_id FROM workspace_paths WHERE path=?',canonical);
    check(!prior || prior.workspace_id === s.ws, 'Path is attached to another workspace', 4);
    s.run('INSERT OR IGNORE INTO workspace_paths(path,workspace_id) VALUES(?,?)',canonical,s.ws);
    if (!prior) s.event('workspace',s.workspace,'attached',{path:canonical});
    return {workspace:s.workspace,path:canonical};
  });
}
export function status(s: Store): Row {
  const actor=s.actor?s.requireActor():null;
  return s.snapshot(() => {
    const totals={workspace:s.workspace,
      stop_requests:s.all('SELECT id,role,requested_at,acknowledged_at FROM stop_requests WHERE workspace_id=? AND cleared_at IS NULL ORDER BY role',s.ws).map(row=>({...row,id:`R${row.id}`})),
      tasks:s.all('SELECT status,count(*) AS count FROM tasks WHERE workspace_id=? GROUP BY status',s.ws),
      open_blockers:s.get("SELECT count(*) AS n FROM blockers WHERE workspace_id=? AND status='open'",s.ws)!.n,
      pending_questions:s.get("SELECT count(*) AS n FROM questions WHERE workspace_id=? AND status='pending'",s.ws)!.n,
      stale_claims:s.get("SELECT count(*) AS n FROM tasks WHERE workspace_id=? AND lease_until<? AND status IN ('doing','blocked','review')",s.ws,now())!.n,
      cursor:s.get('SELECT coalesce(max(id),0) AS n FROM events WHERE workspace_id=?',s.ws)!.n};
    if(!actor)return totals; // Preserve the anonymous workspace read and its JSON shape.
    let progress:Row|null=null;try{progress=getNotificationProgress(s)??null;}catch(error){if(!(error instanceof AppError)||error.code!==4)throw error;progress={state:'invalid'};}
    const waiter=s.get('SELECT * FROM supervisor_waiters WHERE workspace_id=? AND role=? AND ended_at IS NULL',s.ws,actor);
    const worker=s.get('SELECT generation FROM managed_workers WHERE workspace_id=? AND role=?',s.ws,actor);
    const identity=waiter?processIdentity(waiter.pid):null;
    const own=s.all("SELECT id,title,status,version FROM tasks WHERE workspace_id=? AND owner=? AND status NOT IN ('done','dropped') ORDER BY priority DESC,id LIMIT 7",s.ws,actor);
    const waiting=s.all("SELECT b.id,b.task_id,substr(b.body,1,200) AS text FROM blockers b JOIN tasks t ON t.workspace_id=b.workspace_id AND t.id=b.task_id WHERE b.workspace_id=? AND b.waiting_on=? AND b.status='open' AND t.status NOT IN ('done','dropped') ORDER BY b.id LIMIT 7",s.ws,actor);
    // The Codex waiter for this role (T663): its open enrollment and how that enrollment's launcher last ended, and
    // a start refused since the last enrollment event. A closed enrollment with no refusal since shows nothing.
    const enrolled=s.get("SELECT id,action FROM events WHERE workspace_id=? AND entity='wake-enrollment' AND entity_id=? ORDER BY id DESC LIMIT 1",s.ws,actor);
    const openEpoch=enrolled?.action==='opened'?Number(enrolled.id):null;
    const ended=openEpoch===null?undefined:s.get("SELECT action,detail FROM events WHERE workspace_id=? AND entity='watch-dispatch' AND entity_id=? AND action IN ('exited','suspended') AND json_extract(detail,'$.epoch')=? ORDER BY id DESC LIMIT 1",s.ws,actor,openEpoch);
    const refusedStart=s.get("SELECT detail FROM events WHERE workspace_id=? AND entity='watch-dispatch' AND entity_id=? AND action='refused' AND id>? ORDER BY id DESC LIMIT 1",s.ws,actor,enrolled?.id??0);
    const reasonIn=(row:Row|undefined)=>{
      if(!row)return undefined;
      const reason=String(JSON.parse(row.detail).reason??'');
      return WATCH_REASONS.has(reason)?reason:'see the launcher terminal';
    };
    // Events alone cannot see a launcher that ended without writing one (a reboot, kill -9); its launch lock can.
    const gone=openEpoch!==null&&!ended&&!pendingLauncher(s,actor);
    const watcher=openEpoch!==null?{state:ended?ended.action:'enrolled',epoch:`E${openEpoch}`,...(gone?{launcher_running:false}:{}),...(ended?{reason:reasonIn(ended)}:{}),...(refusedStart?{start_refused:reasonIn(refusedStart)}:{})}
      :refusedStart?{state:'refused',reason:reasonIn(refusedStart)}:null;
    const replies=s.all("SELECT m.id,m.sender,substr(m.body,1,200) AS text FROM messages m JOIN receipts r ON r.workspace_id=m.workspace_id AND r.message_id=m.id WHERE m.workspace_id=? AND r.recipient=? AND r.state!='done' AND m.reply=1 ORDER BY m.id LIMIT 7",s.ws,actor);
    return {...totals,role:actor,own_tasks:own.slice(0,6).map(row=>({...row,id:`T${row.id}`,title:contextLine(row.title)})),waiting_on_role:waiting.slice(0,6).map(row=>({...row,id:`B${row.id}`,task_id:`T${row.task_id}`})),replies:replies.slice(0,6).map(row=>({...row,id:`M${row.id}`})),more:{tasks:own.length>6,waits:waiting.length>6,replies:replies.length>6},notification_progress:progress?{cursor:progress.cursor,version:progress.version,state:progress.state??'saved'}:{state:'absent'},waiter:{registered:Boolean(waiter),armed:Boolean(worker&&waiter&&identity&&waiter.generation===worker.generation&&identity===waiter.process_start)},...(watcher?{watcher}:{})};
  });
}
export function renderStatus(data:Row,lineLength=200):string {
  integer(lineLength,'line length',80,500);
  if(!data.role)return JSON.stringify(data,null,2);
  const lines=[`${data.workspace} / ${data.role} · cursor ${data.notification_progress.cursor??data.notification_progress.state} · latest ${data.cursor} · waiter ${data.waiter.armed?'armed':data.waiter.registered?'stale/unconfirmed':'unregistered'}${data.watcher?` · watcher ${data.watcher.state}${data.watcher.epoch?` ${data.watcher.epoch}`:''}${data.watcher.launcher_running===false?', launcher not running':''}${data.watcher.reason?` (${data.watcher.reason})`:''}${data.watcher.start_refused?`, a restart refused (${data.watcher.start_refused})`:''}`:''}`];
  for(const stop of data.stop_requests.filter((row:Row)=>row.role===data.role))lines.push(`STOP ${stop.id}: finish safely and checkpoint; inspect sas stop-status.`);
  for(const row of data.own_tasks)lines.push(`${row.id} ${row.status} · ${row.title}`);
  if(!data.own_tasks.length)lines.push('No own active tasks.');
  for(const row of data.waiting_on_role)lines.push(`${row.id} ${row.task_id} waits on you · ${row.text}`);
  for(const row of data.replies)lines.push(`${row.id} ${row.sender} awaits a reply · ${row.text}`);
  if(Object.values(data.more).some(Boolean))lines.push('More items exist; sas tasks, sas blockers, sas inbox --peek.');
  lines.push('Full records: sas show ID. Read only; no progress or receipts changed.');
  return lines.map(line=>contextLine(line,lineLength)).join('\n');
}
export function search(s: Store, query: string, options: {type?: string;role?: string;status?: string;since?: string;limit?:number;phrase?:boolean;prefix?:boolean} = {}): Row[] {
  text(query,'query',1000);
  const words = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (!words.length) return [];
  check(words.length <= 50,'Search has too many words');
  const quote = (s: string) => '"'+s.replaceAll('"','""')+'"';
  const match = options.phrase ? quote(words.join(' ')) : words.map((w,i) => quote(w)+(options.prefix && i === words.length-1 ? '*' : '')).join(' AND ');
  const filters=['d.workspace_id=?','search MATCH ?']; const params: Param[]=[s.ws,match];
  if (options.type) {
    const types=options.type.split(','); check(types.length <= 10 && types.every(t=>['task','message','fact','feedback','blocker','question','wip','event','import'].includes(t)),'Unknown search type');
    filters.push(`d.type IN (${types.map(()=>'?').join(',')})`); params.push(...types);
  }
  for (const key of ['role','status'] as const) if(options[key]) {filters.push(`d.${key}=?`);params.push(options[key]!);}
  if (options.since) {check(Number.isFinite(Date.parse(options.since)),'Invalid --since date');filters.push('d.updated_at>=?');params.push(new Date(options.since).toISOString());}
  params.push(integer(options.limit ?? 20,'limit',1,100));
  return s.all(`SELECT d.type,d.entity_id AS id,d.title,d.role,d.status,d.updated_at,snippet(search,1,'[',']',' … ',24) AS snippet,bm25(search,5,1) AS rank FROM search JOIN documents d ON d.id=search.rowid WHERE ${filters.join(' AND ')} ORDER BY rank,d.id LIMIT ?`,...params);
}
export function doctor(s: Store): Row {
  const integrity=s.get('PRAGMA quick_check')!;
  const foreign=s.all('PRAGMA foreign_key_check');
  const fts=s.get("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='search'")!.n === 1;
  const sqlite = s.get('SELECT sqlite_version() AS version')!.version;
  const result={ok:Object.values(integrity)[0] === 'ok' && foreign.length===0 && fts,node:process.version,sqlite,schema:s.get('PRAGMA user_version')!.user_version,fts5:fts,journal_mode:s.get('PRAGMA journal_mode')!.journal_mode,synchronous:s.get('PRAGMA synchronous')!.synchronous,foreign_key_errors:foreign,integrity:Object.values(integrity)[0],database:s.path};
  return result;
}
export async function backupDatabase(s: Store, output: string): Promise<Row> {
  s.requireHuman(); const destination=databasePath(output);
  check(destination !== resolve(s.path),'Backup must use another file');
  mkdirSync(dirname(destination),{recursive:true,mode:0o700});
  // Reserve exclusively: no overwrite of an existing backup or database.
  closeSync(openSync(destination,'wx',0o600));
  try {await backup(s.db,destination);return {path:destination,scope:'all workspaces',schema:SCHEMA_VERSION};}
  catch (error) {unlinkSync(destination);throw error;}
}
// A restore whose rules differ from the export beside its destination (T1276) is refused: every export
// file counts, a workspace the backup lacks has the empty set, and an export that cannot be read or holds
// another set at the same version counts as newer. A human may accept the restored set with force; the
// decision is recorded in each workspace the backup holds, and the export is rewritten after the restore.
// The check is against accidents (a restore of the wrong file), not an authority: whoever runs restore
// can already copy the files.
function olderRules(databasePath: string, beside: string, options: { force?: boolean; actor?: string }): Row[] {
  const folder = join(dirname(beside), 'rules'), older: Row[] = [];
  const names = existsSync(folder) ? readdirSync(folder).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)).sort() : [];
  const reader = new Store(databasePath, undefined, { readonly: true });
  try {
    for (const workspace of names) {
      const exported = readExport(beside, workspace);
      if (exported === undefined) continue;
      const held = Boolean(reader.get('SELECT id FROM workspaces WHERE name=?', workspace));
      if (held) reader.use(workspace);
      const set = held ? ruleSet(reader) : { set_version: 0, digest: EMPTY_SET_DIGEST };
      if (exported !== 'unreadable' && (exported.set_version < set.set_version || exported.set_version === set.set_version && exported.digest === set.digest)) continue;
      older.push({ workspace, held, set_version: set.set_version, export_set_version: exported === 'unreadable' ? 'unreadable' : exported.set_version });
    }
  } finally { reader.close(); }
  if (!older.length) return [];
  const list = older.map(w => `${w.workspace} (set version ${w.set_version}, export ${w.export_set_version})`).join(', ');
  check(options.force, `The restored rules differ from their export and are not newer: ${list}. A human decides: restore again with --force --as HUMAN to accept them`, 4);
  check(options.actor, 'Accepting older rules needs --as HUMAN', 3);
  for (const w of older.filter(w => w.held)) {
    const s = new Store(databasePath, options.actor);
    try { s.use(w.workspace); s.tx(() => { s.requireHuman(); s.event('rule-set', w.workspace, 'restored-older', { set_version: w.set_version, export_set_version: w.export_set_version }); }); } finally { s.close(); }
  }
  return older;
}
export async function restoreDatabase(source: string, target: string, options: { force?: boolean; actor?: string } = {}): Promise<Row> {
  const src=databasePath(source), dest=databasePath(target);
  check(existsSync(src),'Backup file does not exist');check(!existsSync(dest),'Restore destination already exists',4);
  const db=new DatabaseSync(src,{readOnly:true});
  let older: Row[] = [];
  try {
    const sourceVersion = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    check(sourceVersion >= 1 && sourceVersion <= SCHEMA_VERSION,'Unsupported backup schema');
    check(Object.values(db.prepare('PRAGMA integrity_check').get()!)[0]==='ok','Backup integrity check failed');
    check(db.prepare('PRAGMA foreign_key_check').all().length===0,'Backup foreign key check failed');
    // Built and checked under a temporary name; the destination appears only once it passed.
    mkdirSync(dirname(dest),{recursive:true,mode:0o700});
    const building=`${dest}.${process.pid}.restoring`;closeSync(openSync(building,'wx',0o600));
    try {
      await backup(db,building);
      const restored = new Store(building);
      restored.close();
      older = olderRules(building, dest, options);
      linkSync(building,dest);
    } finally {unlinkSync(building);}
    for (const w of older.filter(w => w.held)) {
      const s = new Store(dest, options.actor);
      try { s.use(w.workspace); s.tx(() => exportRules(s, { allowOlder: true })); } finally { s.close(); }
    }
    return {path:dest,scope:'all workspaces',schema:SCHEMA_VERSION,source_schema:sourceVersion,...(older.length?{older_rules_accepted:older}:{})};
  } finally {db.close();}
}
export function machine(): Row { return {load:loadavg(),cpus:cpus().length,free_memory:freemem(),total_memory:totalmem(),uptime_seconds:uptime(),note:'System totals only. Per-job ownership is not tracked.'}; }

/** Expand a search result by public ID, always within the selected workspace. */
export function showRecord(s: Store, recordId: string): Row {
  const tables: Record<string,string> = {M:'messages',F:'facts',K:'feedback',B:'blockers',H:'questions',E:'events',I:'imports'};
  const prefix = recordId[0], table = tables[prefix];
  check(table, 'Expected a task, message, fact, feedback, blocker, question, event or import ID');
  const row = s.get(`SELECT * FROM ${table} WHERE workspace_id=? AND id=?`,s.ws,id(recordId,prefix));
  check(row, `${recordId} not found in this workspace`,3);
  const result: Row = {...row,id:recordId};
  if (row.task_id) result.task_id=`T${row.task_id}`;
  if (row.blocker_id) result.blocker_id=`B${row.blocker_id}`;
  if (prefix==='H') { result.options=JSON.parse(row.options); result.for_role=s.get('SELECT waiting_on FROM blockers WHERE workspace_id=? AND id=?',s.ws,row.blocker_id)!.waiting_on; }
  if (prefix==='E') result.detail=JSON.parse(row.detail);
  if (prefix==='M') {
    result.now=messageIsNow(s,recordId);
    result.urgency=row.urgency??(row.urgent?5:row.reply?3:1);
  }
  if (prefix==='M') result.receipts=s.all('SELECT recipient,state,read_at,done_at FROM receipts WHERE workspace_id=? AND message_id=? ORDER BY recipient',s.ws,row.id);
  return result;
}
