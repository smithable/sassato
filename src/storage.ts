import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, existsSync, realpathSync, chmodSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { check, name, now, safe, id } from './errors.js';
import { assertManagedIdentity,assertManagedWrite,type ManagedCredentials,type ManagedWriteMode } from './managed-generation.js';

// SQLite rows deliberately stay flexible at this small adapter boundary.
export type Row = Record<string, any>;
export type Param = SQLInputValue;
export const SCHEMA_VERSION = 16;
export function databasePath(value?: string): string {
  const path = resolve(value ?? process.env.SASSATO_DB ?? `${process.env.XDG_DATA_HOME ?? `${homedir()}/.local/share`}/sassato/sassato.db`);
  let ancestor = path;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  const canonical = realpathSync(ancestor);
  check(!/^\/mnt\/[a-z](?:\/|$)/i.test(path) && !/^\/mnt\/[a-z](?:\/|$)/i.test(canonical), 'Keep the database on native Linux/WSL storage, not a Windows mount');
  return path;
}
export class Store {
  db: DatabaseSync;
  ws = 0;
  workspace = '';
  actor: string | null;
  path: string;
  private depth = 0;
  private authorizedWriter:{workspace:number;actor:string|null}|null=null;
  private readonly credentials:ManagedCredentials;
  private readonly managedWriteMode:ManagedWriteMode;
  constructor(path: string, actor?: string, options: { readonly?: boolean; create?: boolean; managedCredentials?:ManagedCredentials; managedWriteMode?:ManagedWriteMode } = {}) {
    this.credentials=options.managedCredentials??{generation:process.env.SASSATO_WORKER_GENERATION,token:process.env.SASSATO_WORKER_TOKEN};
    this.managedWriteMode=options.managedWriteMode??'normal';
    this.path = path === ':memory:' ? path : databasePath(path); path = this.path;
    this.actor = actor ? name(actor) : null;
    if (path !== ':memory:') {
      check(options.create || existsSync(path), 'Database does not exist; run sassato init first', 3);
      if (options.create) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path, { readOnly: options.readonly ?? false });
    try {
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    if (!options.readonly) {
      if (path !== ':memory:') chmodSync(path, 0o600);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.migrate();
    } else {
      const version = Number(this.get('PRAGMA user_version')?.user_version);
      check(version <= SCHEMA_VERSION, 'Database was created by a newer Sassato; upgrade this CLI', 3);
      check(version === SCHEMA_VERSION, 'Database schema requires a writable migration; run sassato migrate with this database', 3);
    }
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  authenticateManaged():void { assertManagedIdentity(this,this.credentials); }
  writableFork():Store {
    check(this.path!==':memory:','Runtime observation needs a file-backed coordination database',4);
    const fork=new Store(this.path,this.actor??undefined,{managedCredentials:this.credentials,managedWriteMode:this.managedWriteMode});
    fork.use(this.workspace);return fork;
  }
  get(sql: string, ...params: Param[]): Row | undefined { return this.db.prepare(sql).get(...params); }
  all(sql: string, ...params: Param[]): Row[] { return this.db.prepare(sql).all(...params); }
  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    if(!this.depth)return this.tx(()=>this.run(sql,...params));
    if(this.authorizedWriter?.workspace!==this.ws || this.authorizedWriter.actor!==this.actor) {
      assertManagedWrite(this,this.credentials,this.managedWriteMode);
      this.authorizedWriter={workspace:this.ws,actor:this.actor};
    }
    const r = this.db.prepare(sql).run(...params); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
  tx<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try { assertManagedWrite(this,this.credentials,this.managedWriteMode);this.authorizedWriter={workspace:this.ws,actor:this.actor};const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* Preserve original error if SQLite already rolled back. */ } throw error; }
    finally { this.depth--;this.authorizedWriter=null; }
  }
  snapshot<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec('BEGIN'); this.depth++;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* Preserve original error if SQLite already rolled back. */ } throw error; }
    finally { this.depth--;this.authorizedWriter=null; }
  }
  use(workspace?: string, cwd = process.cwd()): void {
    let row: Row | undefined;
    if (workspace) row = this.get('SELECT * FROM workspaces WHERE name=?', name(workspace));
    else {
      const dir = realpathSync(cwd);
      const matches = this.all('SELECT w.*, p.path FROM workspace_paths p JOIN workspaces w ON w.id=p.workspace_id').filter(r => dir === r.path || dir.startsWith(r.path.endsWith(sep) ? r.path : r.path + sep));
      matches.sort((a,b) => b.path.length - a.path.length); row = matches[0];
    }
    check(row, 'Choose --workspace (or SASSATO_WORKSPACE), or attach this repository first', 3);
    this.ws = row.id; this.workspace = row.name;
    if (this.actor) this.role(this.actor);
  }
  role(role: string): Row {
    const r = this.get('SELECT * FROM roles WHERE workspace_id=? AND name=?', this.ws, role);
    check(r, `Unknown role ${role}`, 3); return r;
  }
  requireActor(): string { check(this.actor, 'Specify --as <role> or SASSATO_ROLE', 3); this.role(this.actor); return this.actor; }
  requireHuman(): string { const a = this.requireActor(); check(this.role(a).kind === 'human', 'This action requires a human role', 3); return a; }
  task(taskId: string): Row {
    const row = this.get('SELECT * FROM tasks WHERE workspace_id=? AND id=?', this.ws, id(taskId, 'T'));
    check(row, `Task ${taskId} not found in this workspace`, 3); return row;
  }
  event(entity: string, entityId: string, action: string, detail: unknown = {}): number {
    safe(detail);
    const actor = this.requireActor(), at = now();
    const n = this.run('INSERT INTO events(workspace_id,entity,entity_id,actor,action,detail,created_at) VALUES(?,?,?,?,?,?,?)', this.ws, entity, entityId, actor, action, JSON.stringify(detail), at).lastInsertRowid;
    if (!((entity==='session'&&action==='heartbeat') || (entity==='message'&&['read','done'].includes(action)) || entity==='notification-progress' || entity==='waiter' || entity==='nudge')) {
      this.index('event', `E${n}`, `${entityId} ${action}`, JSON.stringify(detail), { role: actor, updated_at: at });
    }
    return n;
  }
  index(type: string, entityId: string, title: string, body: string, fields: { role?: string | null; status?: string | null; updated_at?: string } = {}): void {
    safe([title, body]);
    this.run('INSERT INTO documents(workspace_id,type,entity_id,title,body,role,status,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,type,entity_id) DO UPDATE SET title=excluded.title,body=excluded.body,role=excluded.role,status=excluded.status,updated_at=excluded.updated_at', this.ws,type,entityId,title,body,fields.role ?? null,fields.status ?? null,fields.updated_at ?? now());
  }
  private migrate(): void {
    const version = Number(this.get('PRAGMA user_version')?.user_version);
    check(version <= SCHEMA_VERSION, 'Database was created by a newer Sassato; upgrade this CLI', 3);
    if (version === SCHEMA_VERSION) return;
    this.tx(() => {
      // Re-read under the write lock: another CLI may have migrated while we waited.
      let current = Number(this.get('PRAGMA user_version')?.user_version);
      check(current <= SCHEMA_VERSION, 'Database was created by a newer Sassato; upgrade this CLI', 3);
      if (current === 0) { this.db.exec(SCHEMA); current = 1; }
      if (current === 1) { this.db.exec(MIGRATION_2); current = 2; }
      if (current === 2) { this.db.exec(MIGRATION_3); current = 3; }
      if (current === 3) { this.db.exec(MIGRATION_4); current = 4; }
      if (current === 4) {
        const questionSequence = this.get("SELECT seq FROM sqlite_sequence WHERE name='questions'")?.seq ?? 0;
        this.db.exec(MIGRATION_5);
        this.run("UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name='questions'",questionSequence);
        this.cancelClosedQuestions();
        current = 5;
      }
      if (current === 5) { this.db.exec(MIGRATION_6); current = 6; }
      if (current === 6) { this.db.exec(MIGRATION_7); current = 7; }
      if (current === 7) { this.db.exec(MIGRATION_8); current = 8; }
      if (current === 8) { this.db.exec(MIGRATION_9); current = 9; }
      if (current === 9) { this.db.exec(MIGRATION_10); current = 10; }
      if (current === 10) { this.db.exec(MIGRATION_11); current = 11; }
      if (current === 11) { this.db.exec(MIGRATION_12); current = 12; }
      if (current === 12) { this.db.exec(MIGRATION_13); current = 13; }
      if (current === 13) { this.db.exec(MIGRATION_14); current = 14; }
      if (current === 14) { this.db.exec(MIGRATION_15); current = 15; }
      if (current === 15) this.db.exec(MIGRATION_16);
    });
  }
  private cancelClosedQuestions(): void {
    // Older releases left pending decisions attached to closed work. Preserve the
    // requests and existing answers, but do not let reopening revive those requests.
    const at = now(), actor = 'schema-migration', reason = 'Schema 5 migration: task was already closed; ask a new question after reopening.';
    const rows = this.all("SELECT q.*,b.waiting_on,b.body AS blocker_body FROM questions q JOIN tasks t ON t.workspace_id=q.workspace_id AND t.id=q.task_id JOIN blockers b ON b.workspace_id=q.workspace_id AND b.id=q.blocker_id WHERE q.status='pending' AND t.status IN ('done','dropped') ORDER BY q.workspace_id,q.task_id,q.id");
    const index = (workspace: number, type: string, entity: string, title: string, body: string, role: string | null, status: string | null) => {
      this.run('INSERT INTO documents(workspace_id,type,entity_id,title,body,role,status,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,type,entity_id) DO UPDATE SET title=excluded.title,body=excluded.body,role=excluded.role,status=excluded.status,updated_at=excluded.updated_at',workspace,type,entity,title,body,role,status,at);
    };
    const event = (workspace: number, entity: string, entityId: string, action: string, detail: Row) => {
      const body = JSON.stringify({...detail,migration:5});
      const id = this.run('INSERT INTO events(workspace_id,entity,entity_id,actor,action,detail,created_at) VALUES(?,?,?,?,?,?,?)',workspace,entity,entityId,actor,action,body,at).lastInsertRowid;
      index(workspace,'event',`E${id}`,`${entityId} ${action}`,body,actor,null);
    };
    const tasks = new Map<string,{workspace:number;id:number;questions:string[]}>();
    for (const q of rows) {
      const task = `T${q.task_id}`, question = `H${q.id}`, blocker = `B${q.blocker_id}`;
      this.run("UPDATE questions SET status='cancelled',cancelled_at=?,cancelled_by=?,cancel_reason=? WHERE workspace_id=? AND id=?",at,actor,reason,q.workspace_id,q.id);
      this.run("UPDATE blockers SET status='resolved',resolved_at=? WHERE workspace_id=? AND id=? AND status='open'",at,q.workspace_id,q.blocker_id);
      index(q.workspace_id,'question',question,q.question,JSON.stringify({options:JSON.parse(q.options),recommendation:q.recommendation,command:q.command,cancel_reason:reason}),q.waiting_on,'cancelled');
      index(q.workspace_id,'blocker',blocker,`${task} waits on ${q.waiting_on}`,q.blocker_body,q.waiting_on,'resolved');
      event(q.workspace_id,'question',question,'cancelled',{task,blocker,reason});
      const key = `${q.workspace_id}/${q.task_id}`, affected = tasks.get(key) ?? {workspace:q.workspace_id,id:q.task_id,questions:[] as string[]};
      affected.questions.push(question); tasks.set(key,affected);
    }
    for (const affected of tasks.values()) {
      const task = this.get('SELECT * FROM tasks WHERE workspace_id=? AND id=?',affected.workspace,affected.id)!;
      this.run('UPDATE tasks SET version=version+1,updated_at=? WHERE workspace_id=? AND id=?',at,affected.workspace,affected.id);
      event(affected.workspace,'task',`T${task.id}`,'questions-cancelled',{before:{version:task.version,updated_at:task.updated_at},after:{version:task.version+1,updated_at:at},cancelled_questions:affected.questions,reason});
      index(affected.workspace,'task',`T${task.id}`,task.title,task.body,task.owner??task.for_role,task.status);
    }
  }
}
const SCHEMA = `
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE workspaces(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE workspace_paths(path TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id));
CREATE TABLE roles(workspace_id INTEGER NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'agent' CHECK(kind IN ('agent','human')), provider TEXT, model TEXT, working_dir TEXT, usage TEXT, usage_until TEXT, PRIMARY KEY(workspace_id,name));
CREATE TABLE sessions(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL, role TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT, pid INTEGER, process_start TEXT, started_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, ended_at TEXT, FOREIGN KEY(workspace_id,role) REFERENCES roles(workspace_id,name));
CREATE UNIQUE INDEX one_active_session ON sessions(workspace_id,role) WHERE ended_at IS NULL;
CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', owner TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','doing','blocked','review','done','dropped')), priority INTEGER NOT NULL DEFAULT 0, human_only INTEGER NOT NULL DEFAULT 0 CHECK(human_only IN (0,1)), for_role TEXT, creator TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, lease_until TEXT, review_required INTEGER NOT NULL DEFAULT 0, reviewed_by TEXT, review_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,owner) REFERENCES roles(workspace_id,name), FOREIGN KEY(workspace_id,for_role) REFERENCES roles(workspace_id,name), FOREIGN KEY(workspace_id,creator) REFERENCES roles(workspace_id,name));
CREATE INDEX tasks_board ON tasks(workspace_id,status,priority DESC,id);
CREATE INDEX tasks_owner ON tasks(workspace_id,owner,status);
CREATE TABLE dependencies(workspace_id INTEGER NOT NULL, task_id INTEGER NOT NULL, depends_on INTEGER NOT NULL, PRIMARY KEY(workspace_id,task_id,depends_on), FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id), FOREIGN KEY(workspace_id,depends_on) REFERENCES tasks(workspace_id,id), CHECK(task_id!=depends_on));
CREATE INDEX dependency_reverse ON dependencies(workspace_id,depends_on);
CREATE TABLE blockers(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL, task_id INTEGER NOT NULL, kind TEXT NOT NULL, waiting_on TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')), created_by TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id));
CREATE INDEX blockers_task ON blockers(workspace_id,task_id,status);
CREATE TABLE questions(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL, task_id INTEGER NOT NULL, blocker_id INTEGER NOT NULL, asked_by TEXT NOT NULL, question TEXT NOT NULL, options TEXT NOT NULL DEFAULT '[]', recommendation TEXT, command TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered')), answer TEXT, answered_by TEXT, created_at TEXT NOT NULL, answered_at TEXT, UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id), FOREIGN KEY(workspace_id,blocker_id) REFERENCES blockers(workspace_id,id));
CREATE INDEX questions_status ON questions(workspace_id,status,id);
CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), sender TEXT NOT NULL, body TEXT NOT NULL, task_id INTEGER, created_at TEXT NOT NULL, UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,sender) REFERENCES roles(workspace_id,name), FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id));
CREATE TABLE receipts(workspace_id INTEGER NOT NULL, message_id INTEGER NOT NULL, recipient TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'unread' CHECK(state IN ('unread','read','done')), read_at TEXT, done_at TEXT, PRIMARY KEY(workspace_id,message_id,recipient), FOREIGN KEY(workspace_id,message_id) REFERENCES messages(workspace_id,id), FOREIGN KEY(workspace_id,recipient) REFERENCES roles(workspace_id,name));
CREATE INDEX inbox ON receipts(workspace_id,recipient,state,message_id);
CREATE TABLE facts(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), key TEXT NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL, checked_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(workspace_id,key));
CREATE TABLE wip(workspace_id INTEGER NOT NULL, role TEXT NOT NULL, current TEXT NOT NULL DEFAULT '', next TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, PRIMARY KEY(workspace_id,role), FOREIGN KEY(workspace_id,role) REFERENCES roles(workspace_id,name));
CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), entity TEXT NOT NULL, entity_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX event_entity ON events(workspace_id,entity,entity_id,id);
CREATE INDEX event_cursor ON events(workspace_id,id);
CREATE TRIGGER immutable_events_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'History is append-only'); END;
CREATE TRIGGER immutable_events_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'History is append-only'); END;
CREATE TABLE imports(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), path TEXT NOT NULL, digest TEXT NOT NULL, raw TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(workspace_id,path,digest));
CREATE TABLE import_items(workspace_id INTEGER NOT NULL, source_key TEXT NOT NULL, digest TEXT NOT NULL, task_id INTEGER, PRIMARY KEY(workspace_id,source_key), FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id));
CREATE TABLE documents(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), type TEXT NOT NULL, entity_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, role TEXT, status TEXT, updated_at TEXT NOT NULL, UNIQUE(workspace_id,type,entity_id));
CREATE INDEX document_filter ON documents(workspace_id,type,role,status);
CREATE VIRTUAL TABLE search USING fts5(title,body,content='documents',content_rowid='id',tokenize='unicode61',prefix='2 3');
CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN INSERT INTO search(rowid,title,body) VALUES(new.id,new.title,new.body); END;
CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN INSERT INTO search(search,rowid,title,body) VALUES('delete',old.id,old.title,old.body); END;
CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN INSERT INTO search(search,rowid,title,body) VALUES('delete',old.id,old.title,old.body); INSERT INTO search(rowid,title,body) VALUES(new.id,new.title,new.body); END;
INSERT INTO schema_migrations VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
PRAGMA user_version=1;
`;

const MIGRATION_2 = `
ALTER TABLE roles ADD COLUMN reasoning_effort TEXT;
ALTER TABLE roles ADD COLUMN permission_mode TEXT;
ALTER TABLE roles ADD COLUMN sandbox_mode TEXT;
ALTER TABLE roles ADD COLUMN approval_policy TEXT;
INSERT INTO schema_migrations VALUES(2,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
PRAGMA user_version=2;
`;

const MIGRATION_3 = `
CREATE TABLE stop_requests(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  role TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  acknowledged_at TEXT,
  cleared_at TEXT,
  FOREIGN KEY(workspace_id,role) REFERENCES roles(workspace_id,name),
  FOREIGN KEY(workspace_id,requested_by) REFERENCES roles(workspace_id,name)
);
CREATE UNIQUE INDEX one_active_stop ON stop_requests(workspace_id,role) WHERE cleared_at IS NULL;
INSERT INTO schema_migrations VALUES(3,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
PRAGMA user_version=3;
`;

const MIGRATION_4 = `
ALTER TABLE messages ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0 CHECK(urgent IN (0,1));
CREATE INDEX urgent_messages ON messages(workspace_id,id) WHERE urgent=1;
INSERT INTO schema_migrations VALUES(4,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
PRAGMA user_version=4;
`;

const MIGRATION_5 = `
CREATE TABLE questions_v5(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL, task_id INTEGER NOT NULL, blocker_id INTEGER NOT NULL, asked_by TEXT NOT NULL, question TEXT NOT NULL, options TEXT NOT NULL DEFAULT '[]', recommendation TEXT, command TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered','cancelled')), answer TEXT, answered_by TEXT, created_at TEXT NOT NULL, answered_at TEXT, cancelled_at TEXT, cancelled_by TEXT, cancel_reason TEXT, UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id), FOREIGN KEY(workspace_id,blocker_id) REFERENCES blockers(workspace_id,id));
INSERT INTO questions_v5(id,workspace_id,task_id,blocker_id,asked_by,question,options,recommendation,command,status,answer,answered_by,created_at,answered_at) SELECT id,workspace_id,task_id,blocker_id,asked_by,question,options,recommendation,command,status,answer,answered_by,created_at,answered_at FROM questions;
DROP TABLE questions;
ALTER TABLE questions_v5 RENAME TO questions;
CREATE INDEX questions_status ON questions(workspace_id,status,id);
INSERT INTO schema_migrations VALUES(5,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
PRAGMA user_version=5;
`;

// Remove search copies only; the complete audit stream and its cursors survive.
const MIGRATION_6 = `
DELETE FROM documents WHERE type='event' AND entity_id IN (
  SELECT 'E'||e.id FROM events e WHERE ((e.entity='session' AND e.action='heartbeat')
      OR (e.entity='message' AND e.action IN ('read','done'))
      OR e.entity='notification-progress')
);
INSERT INTO schema_migrations VALUES(6,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
PRAGMA user_version=6;
`;

// Mail that asks its recipients for a reply or a review: listed until acknowledged (T715).
const MIGRATION_7 = `
ALTER TABLE messages ADD COLUMN reply INTEGER NOT NULL DEFAULT 0 CHECK(reply IN (0,1));
INSERT INTO schema_migrations VALUES(7,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
PRAGMA user_version=7;
`;

// Heavy jobs on the machine: who asked, what they needed and what they used (T753).
const MIGRATION_8 = `
CREATE TABLE jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), role TEXT NOT NULL, kind TEXT NOT NULL, version TEXT, command TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('waiting','running','done','refused','released')), need_mb INTEGER NOT NULL, cpu_need REAL NOT NULL, margin REAL NOT NULL, measured_mb INTEGER, load_estimate TEXT CHECK(load_estimate IN ('more','same','less')), mem_estimate INTEGER, pid INTEGER NOT NULL, process_start TEXT, cgroup TEXT, current_mb INTEGER, peak_mb INTEGER, cgroup_peak_mb INTEGER, cpu_s REAL, wall_s REAL, exit_code INTEGER, reason TEXT, orphans TEXT, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, FOREIGN KEY(workspace_id,role) REFERENCES roles(workspace_id,name));
CREATE INDEX jobs_open ON jobs(status,id) WHERE status IN ('waiting','running');
CREATE INDEX jobs_kind ON jobs(kind,id);
CREATE INDEX jobs_turns ON jobs(workspace_id,role,started_at);
INSERT INTO schema_migrations VALUES(8,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
PRAGMA user_version=8;
`;

const MIGRATION_9 = `
CREATE TABLE registry_projects(id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL UNIQUE REFERENCES workspaces(id));
CREATE TABLE registry_repositories(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, common_dir TEXT NOT NULL UNIQUE, identity TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE registry_checkouts(id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES registry_repositories(id), fingerprint TEXT NOT NULL UNIQUE, root TEXT NOT NULL UNIQUE, git_dir TEXT NOT NULL UNIQUE, identity TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE project_checkouts(project_id TEXT NOT NULL REFERENCES registry_projects(id), checkout_id TEXT NOT NULL REFERENCES registry_checkouts(id), PRIMARY KEY(project_id,checkout_id));
CREATE TABLE checkout_bindings(id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL, task_id INTEGER NOT NULL, role TEXT NOT NULL, checkout_id TEXT NOT NULL REFERENCES registry_checkouts(id), working_dir TEXT NOT NULL, cwd_device TEXT NOT NULL, cwd_inode TEXT NOT NULL, session_row_id INTEGER NOT NULL REFERENCES sessions(id), provider TEXT NOT NULL, provider_session_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('coding','review')), created_at TEXT NOT NULL, released_at TEXT, FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id), FOREIGN KEY(workspace_id,role) REFERENCES roles(workspace_id,name));
CREATE UNIQUE INDEX checkout_coding_reservation ON checkout_bindings(checkout_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX role_checkout_reservation ON checkout_bindings(role) WHERE released_at IS NULL;
CREATE TABLE task_briefs(id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL, task_id INTEGER NOT NULL, role TEXT NOT NULL, binding_id TEXT NOT NULL REFERENCES checkout_bindings(id), body TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id), FOREIGN KEY(workspace_id,role) REFERENCES roles(workspace_id,name));
CREATE TRIGGER immutable_briefs_update BEFORE UPDATE ON task_briefs BEGIN SELECT RAISE(ABORT,'Briefs are immutable'); END;
CREATE TRIGGER immutable_briefs_delete BEFORE DELETE ON task_briefs BEGIN SELECT RAISE(ABORT,'Briefs are immutable'); END;
INSERT INTO schema_migrations VALUES(9,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
PRAGMA user_version=9;
`;

const MIGRATION_10 = `
CREATE TABLE managed_controllers(id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), role TEXT NOT NULL, lock_path TEXT NOT NULL, pid INTEGER, process_start TEXT, created_at TEXT NOT NULL, FOREIGN KEY(workspace_id,role) REFERENCES roles(workspace_id,name));
CREATE TABLE managed_workers(id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL, role TEXT NOT NULL UNIQUE, controller_id TEXT NOT NULL REFERENCES managed_controllers(id), binding_id TEXT REFERENCES checkout_bindings(id), generation INTEGER NOT NULL CHECK(generation>0), token_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('running','draining','ready','retiring','exited','starting','reconciling','blocked','stopped')), provider TEXT NOT NULL, external_id TEXT, pid INTEGER, process_start TEXT, configuration_digest TEXT NOT NULL, updated_at TEXT NOT NULL, context TEXT NOT NULL DEFAULT '{}', FOREIGN KEY(workspace_id,role) REFERENCES roles(workspace_id,name));
ALTER TABLE managed_workers ADD COLUMN ping_epoch INTEGER NOT NULL DEFAULT 0 CHECK(ping_epoch>=0);
ALTER TABLE managed_workers ADD COLUMN checkout_id TEXT REFERENCES registry_checkouts(id);
CREATE UNIQUE INDEX managed_checkout_reservation ON managed_workers(checkout_id) WHERE checkout_id IS NOT NULL;
CREATE TRIGGER managed_ping_thaw AFTER UPDATE OF state ON managed_workers WHEN OLD.state NOT IN ('running','draining') AND NEW.state IN ('running','draining') BEGIN UPDATE managed_workers SET ping_epoch=OLD.ping_epoch+1 WHERE id=NEW.id; END;
CREATE TABLE managed_transitions(id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES managed_workers(id), generation INTEGER NOT NULL, idempotency_key TEXT NOT NULL, state TEXT NOT NULL, expected_task_versions TEXT NOT NULL, brief_id TEXT REFERENCES task_briefs(id), launch_token_hash TEXT, bootstrap_pid INTEGER, bootstrap_start TEXT, bootstrap_released_at TEXT, retry_count INTEGER NOT NULL DEFAULT 0, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', UNIQUE(worker_id,idempotency_key));
CREATE UNIQUE INDEX managed_transition_active ON managed_transitions(worker_id) WHERE state NOT IN ('complete','blocked','stopped');
CREATE TABLE supervisor_pings(id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL, role TEXT NOT NULL, generation INTEGER NOT NULL, nonce TEXT NOT NULL UNIQUE, requested_at TEXT NOT NULL, deadline TEXT NOT NULL, acknowledged_at TEXT, FOREIGN KEY(workspace_id,role) REFERENCES roles(workspace_id,name));
ALTER TABLE supervisor_pings ADD COLUMN ping_epoch INTEGER NOT NULL DEFAULT 0 CHECK(ping_epoch>=0);
CREATE TABLE supervisor_waiters(id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL, role TEXT NOT NULL, pid INTEGER NOT NULL, process_start TEXT NOT NULL, generation INTEGER NOT NULL, cursor INTEGER NOT NULL, armed_at TEXT NOT NULL, ended_at TEXT, FOREIGN KEY(workspace_id,role) REFERENCES roles(workspace_id,name));
CREATE UNIQUE INDEX supervisor_waiter_active ON supervisor_waiters(role) WHERE ended_at IS NULL;
INSERT INTO schema_migrations VALUES(10,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
PRAGMA user_version=10;
`;

const MIGRATION_11 = `
ALTER TABLE messages ADD COLUMN urgency INTEGER CHECK(urgency BETWEEN 0 AND 10);
ALTER TABLE messages ADD COLUMN urgency_reason TEXT;
ALTER TABLE messages ADD COLUMN immediate INTEGER CHECK(immediate IN (0,1));
CREATE TABLE scored_wake_delivery (
  workspace_id INTEGER NOT NULL, role TEXT NOT NULL, event_id INTEGER NOT NULL REFERENCES events(id),
  PRIMARY KEY(workspace_id,role,event_id), FOREIGN KEY(workspace_id,role) REFERENCES roles(workspace_id,name)
);
INSERT INTO schema_migrations VALUES(11,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
PRAGMA user_version=11;
`;

// Spare tasks: offered only to an idle role, never in ready work or wakes (T1102).
const MIGRATION_12 = `
ALTER TABLE tasks ADD COLUMN spare INTEGER NOT NULL DEFAULT 0 CHECK(spare IN (0,1));
INSERT INTO schema_migrations VALUES(12,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
PRAGMA user_version=12;
`;

// Feedback record (T1113): one line per observation, closed as a task, a fact or a stated no.
const MIGRATION_13 = `
CREATE TABLE feedback(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK(kind IN ('workflow','tokens','untested','sampleusers','sassato')), body TEXT NOT NULL, task_id INTEGER,
  author TEXT NOT NULL, created_at TEXT NOT NULL, closed_by TEXT, closed_at TEXT,
  outcome TEXT CHECK(outcome IN ('task','fact','dropped')), outcome_ref TEXT,
  CHECK((closed_at IS NULL)=(outcome IS NULL)), FOREIGN KEY(workspace_id,author) REFERENCES roles(workspace_id,name));
CREATE INDEX feedback_open ON feedback(workspace_id,closed_at,id);
INSERT INTO schema_migrations VALUES(13,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
PRAGMA user_version=13;
`;

// Rules in sassato (T1276): a proposal is fixed once made and its human question decides it;
// each approval adds a row to rule_versions, numbered per workspace as the set's version. Nothing
// in either table is deleted, and neither a proposal's content nor a version row can change.
const MIGRATION_14 = `
CREATE TABLE rule_proposals(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  key TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('set','retire')), text TEXT, reason TEXT,
  scope TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('always','step')), base_version INTEGER NOT NULL, digest TEXT NOT NULL,
  proposed_by TEXT NOT NULL, task_id INTEGER NOT NULL, question_id INTEGER NOT NULL, created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','refused','withdrawn')),
  decided_at TEXT, decided_by TEXT, relayed_by TEXT, decision TEXT,
  CHECK((action='set')=(text IS NOT NULL)), CHECK((status='pending')=(decided_at IS NULL)),
  UNIQUE(workspace_id,question_id), FOREIGN KEY(workspace_id,proposed_by) REFERENCES roles(workspace_id,name));
CREATE INDEX rule_proposals_key ON rule_proposals(workspace_id,key,status);
CREATE TRIGGER rule_proposals_fixed BEFORE UPDATE OF workspace_id,key,action,text,reason,scope,kind,base_version,digest,proposed_by,task_id,question_id,created_at ON rule_proposals
  BEGIN SELECT RAISE(ABORT,'A rule proposal cannot be changed; propose again'); END;
CREATE TRIGGER rule_proposals_kept BEFORE DELETE ON rule_proposals BEGIN SELECT RAISE(ABORT,'Rule proposals are kept'); END;
CREATE TABLE rule_versions(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  set_version INTEGER NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('in-force','retired')),
  text TEXT, scope TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('always','step')), proposal_id INTEGER NOT NULL REFERENCES rule_proposals(id),
  approved_by TEXT NOT NULL, relayed_by TEXT, created_at TEXT NOT NULL, CHECK((status='in-force')=(text IS NOT NULL)),
  UNIQUE(workspace_id,set_version), UNIQUE(workspace_id,key,version));
CREATE TRIGGER rule_versions_fixed BEFORE UPDATE ON rule_versions BEGIN SELECT RAISE(ABORT,'Rule versions cannot be changed'); END;
CREATE TRIGGER rule_versions_kept BEFORE DELETE ON rule_versions BEGIN SELECT RAISE(ABORT,'Rule versions are kept'); END;
INSERT INTO schema_migrations VALUES(14,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
PRAGMA user_version=14;
`;
// Which set of rules each session read (T1276 part 2); a session takes no task before its record.
const MIGRATION_15 = `
CREATE TABLE rule_loads(workspace_id INTEGER NOT NULL REFERENCES workspaces(id), session_id INTEGER NOT NULL REFERENCES sessions(id),
  set_version INTEGER NOT NULL, digest TEXT NOT NULL, loaded_at TEXT NOT NULL, PRIMARY KEY(workspace_id,session_id,set_version));
INSERT INTO schema_migrations VALUES(15,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
PRAGMA user_version=15;
`;

// A fact may say when it stops holding (T1415): an expired fact leaves the context, stays readable.
const MIGRATION_16 = `
ALTER TABLE facts ADD COLUMN expires_at TEXT;
INSERT INTO schema_migrations VALUES(16,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
PRAGMA user_version=16;
`;
