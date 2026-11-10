import { backup, DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os';
import { Store, databasePath, SCHEMA_VERSION, type Row, type Param } from './storage.js';
import { check, id, integer, name, now, safe, text } from './errors.js';
import { normalizeOption, ROLE_OPTION_KEYS, validateRoleOptions } from './role-options.js';
import { loadConfig, workingDirectory } from './config.js';
import { validateSettings } from './workspace-settings.js';
import { latestWatchStatuses } from './watch-status.js';

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
  return s.snapshot(() => ({workspace:s.workspace,
    watchers:latestWatchStatuses(s),
    stop_requests:s.all('SELECT id,role,requested_at,acknowledged_at FROM stop_requests WHERE workspace_id=? AND cleared_at IS NULL ORDER BY role',s.ws).map(row=>({...row,id:`R${row.id}`})),
    tasks:s.all('SELECT status,count(*) AS count FROM tasks WHERE workspace_id=? GROUP BY status',s.ws),
    open_blockers:s.get("SELECT count(*) AS n FROM blockers WHERE workspace_id=? AND status='open'",s.ws)!.n,
    pending_questions:s.get("SELECT count(*) AS n FROM questions WHERE workspace_id=? AND status='pending'",s.ws)!.n,
    stale_claims:s.get("SELECT count(*) AS n FROM tasks WHERE workspace_id=? AND lease_until<? AND status IN ('doing','blocked','review')",s.ws,now())!.n,
    cursor:s.get('SELECT coalesce(max(id),0) AS n FROM events WHERE workspace_id=?',s.ws)!.n}));
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
    const types=options.type.split(','); check(types.length <= 10 && types.every(t=>['task','message','fact','blocker','question','wip','event','import'].includes(t)),'Unknown search type');
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
export async function restoreDatabase(source: string, target: string): Promise<Row> {
  const src=databasePath(source), dest=databasePath(target);
  check(existsSync(src),'Backup file does not exist');check(!existsSync(dest),'Restore destination already exists',4);
  const db=new DatabaseSync(src,{readOnly:true});
  try {
    const sourceVersion = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    check(sourceVersion >= 1 && sourceVersion <= SCHEMA_VERSION,'Unsupported backup schema');
    check(Object.values(db.prepare('PRAGMA integrity_check').get()!)[0]==='ok','Backup integrity check failed');
    check(db.prepare('PRAGMA foreign_key_check').all().length===0,'Backup foreign key check failed');
    mkdirSync(dirname(dest),{recursive:true,mode:0o700});closeSync(openSync(dest,'wx',0o600));
    try {
      await backup(db,dest);
      const restored = new Store(dest);
      restored.close();
    } catch(error) {unlinkSync(dest);throw error;}
    return {path:dest,scope:'all workspaces',schema:SCHEMA_VERSION,source_schema:sourceVersion};
  } finally {db.close();}
}
export function machine(): Row { return {load:loadavg(),cpus:cpus().length,free_memory:freemem(),total_memory:totalmem(),uptime_seconds:uptime(),note:'System totals only. Per-job ownership is not tracked.'}; }

/** Expand a search result by public ID, always within the selected workspace. */
export function showRecord(s: Store, recordId: string): Row {
  const tables: Record<string,string> = {M:'messages',F:'facts',B:'blockers',H:'questions',E:'events',I:'imports'};
  const prefix = recordId[0], table = tables[prefix];
  check(table, 'Expected a task, message, fact, blocker, question, event or import ID');
  const row = s.get(`SELECT * FROM ${table} WHERE workspace_id=? AND id=?`,s.ws,id(recordId,prefix));
  check(row, `${recordId} not found in this workspace`,3);
  const result: Row = {...row,id:recordId};
  if (row.task_id) result.task_id=`T${row.task_id}`;
  if (row.blocker_id) result.blocker_id=`B${row.blocker_id}`;
  if (prefix==='H') { result.options=JSON.parse(row.options); result.for_role=s.get('SELECT waiting_on FROM blockers WHERE workspace_id=? AND id=?',s.ws,row.blocker_id)!.waiting_on; }
  if (prefix==='E') result.detail=JSON.parse(row.detail);
  if (prefix==='M') result.receipts=s.all('SELECT recipient,state,read_at,done_at FROM receipts WHERE workspace_id=? AND message_id=? ORDER BY recipient',s.ws,row.id);
  return result;
}
