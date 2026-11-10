# Architecture decision: one local database

Sassato keeps independent provider processes coordinated through a local SQLite database.
The CLI is compiled TypeScript with no runtime npm dependencies. A small `Store` adapter
encapsulates `node:sqlite`, so a future driver change need not change CLI commands.

## Storage and concurrency

WAL allows readers and one writer to progress concurrently. Connections enable foreign
keys, a five-second busy timeout and synchronous FULL. Mutations use short BEGIN IMMEDIATE
transactions for ownership checks, task changes, audit and FTS updates. A contested claim
checks open status and ownership inside the transaction. Expired leases do not authorize
stealing. Readers use snapshot transactions where multiple queries must agree.

Task reviews require the inspected version for approval and rejection. Task/fact/WIP
edits use expected versions where stale client edits could overwrite newer
work. Mutations made by state-machine commands operate on the current row inside the
transaction. Events are append-only, with database triggers rejecting updates/deletes.
The first migration runs atomically, records schema_migrations and PRAGMA user_version;
unknown newer schemas are refused. Readonly operations never migrate.

Every logical row/query is workspace-scoped. Task/dependency/message links use composite
foreign keys including the workspace. IDs are database-wide integers rendered with prefixes:
T task, B blocker, H human question, M message, F fact, E event, S runtime session, I import, R stop request.
Explicit `--workspace` wins over SASSATO_WORKSPACE; otherwise the longest attached canonical
repository path wins. There is no fallback to a random or last-used workspace. `--as` wins
over SASSATO_ROLE; missing write identity is an error.

Tasks are one table with six status values. A dependency is a link, not copied status text.
Recursive cycle checks and root-blocker traversal use the same transaction/snapshot.
The human queue combines pending questions and human-directed tasks. Answering resolves
only the question's blocker; unrelated blockers remain and the task is never auto-completed.
One optional review gate requires a recorded independent approval before completion.
Dropping a task cancels pending questions with an audit record and resolves their
linked blockers; reopening requires new questions rather than reviving old requests.

## Search and context

Recovery checkpoints use append-only `checkpoint` events and the existing WIP row;
no schema change is required. Saving both is atomic and uses WIP optimistic version
checks. A fingerprint of relevant durable state and a 24-hour age check mark old
recovery records stale. Session heartbeats do not affect freshness. `context advise`
is an optional human-facing hint that combines saved state with explicit agent reports
in a read-only snapshot; it never measures provider context or invokes compaction. See [context management](context-management.md).

A shared documents table feeds an external-content FTS5 index with unicode61 and prefix
indexes. SQLite triggers update the index in the source mutation transaction. Search ranks
with BM25 and returns bounded snippets plus IDs. User query words are quoted, with optional
explicit phrase/prefix mode; text does not become SQL or raw FTS operators. Workspace,
type, role, status and date filters are parameterized. Substring/trigram search and embeddings
are deferred. History participates in search, so earlier text can still match after an edit.

Context is a bounded snapshot (at most about 40 lines and 6000 characters), with current
work, inbox, blockers/dependencies, decisions, changed facts and session state. Its `cursor`
is a safe continuation point for facts/answers; `snapshot_cursor` is the snapshot's high-water
mark. Omitted deltas hold the continuation cursor back, so paging may repeat delivered rows
but cannot silently skip omitted ones. Counts other than inbox totals are lower bounds.
Receipts are separate: context and --since never mark mail read or done.

## Sessions and launch

Durable role ownership never depends on external transcript IDs. The runtime registry stores
replaceable provider/session metadata and heartbeat times. A Linux PID fingerprint combines
boot ID with process start time; provider argv is also checked. A heartbeat alone does not
prove a process is alive. Unknown state prevents automatic duplication. The optional launcher
uses argv arrays, per-role exclusive locks and explicit foreground supervision. No daemon, LLM calls, resident scheduler, remote API or direct provider wake-up is involved.
The optional mail waiter polls only for the lifetime of an explicit CLI invocation.

Stop requests are durable per-role generations with an explicit acknowledgment and human
clear operation. Claim/launch checks share their transaction with the stop guard. Context
always retains the active role's stop instruction even when other sections are trimmed.
The stop command polls only while a human is waiting; there is no resident controller.
An acknowledgment is cooperative, while verified PID exit is an independent observation.
Force mode signals only fingerprint-verified provider PIDs and reports any refusals.

## Recovery and extensibility

The online SQLite backup API captures committed WAL state. Backups cover the whole database,
including all workspaces. Restore checks schema, integrity and foreign keys into a new path;
existing files are never overwritten. Markdown export is a readable snapshot, not a writable
replica. Import preserves raw source and provenance with digest confirmation and item identities.
Ambiguity is surfaced for reconciliation; originals remain untouched.

Optional future additions can be isolated modules: resource-gate adapters, richer policies,
additional providers, channels or alternative drivers. No abstractions for those are imposed now.
The benchmark does not justify a resident service or cache.

References: [Node SQLite](https://nodejs.org/api/sqlite.html),
[SQLite WAL](https://www.sqlite.org/wal.html), [FTS5](https://www.sqlite.org/fts5.html).

Schema v4 adds a checked urgent flag and partial index to messages. `wait --urgent`
reads urgent unread receipts and durable stop requests in short snapshots; notification
never changes delivery state. Build metadata records a source fingerprint independently
of the release version. Existing-import repair binds its preview to eligible stored state
and preserves later agent edits.
