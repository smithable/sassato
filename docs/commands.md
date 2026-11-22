# Command reference

## Repository code map

`index build [--repo PATH]`, `index update --diff BASE..HEAD`, `index find WORD` and
`index show FILE|FUNCTION|MODULE` work without a workspace database. All accept
`--repo PATH`, `--cache PATH` and `--json`; queries accept `--limit 1..100`.
See [snapshot, dirty-view and safety semantics](index.md).

Both `sas` and `sassato` invoke the same CLI. Global flags may appear anywhere:
`--db PATH`, `--workspace NAME`, `--as ROLE`, `--json`, `--help`. Environment alternatives
are SASSATO_DB, SASSATO_WORKSPACE and SASSATO_ROLE. An explicitly supplied flag wins.
Workspace attachment allows the same workspace from multiple repositories/worktrees.
No write command silently guesses a role.

Strings containing spaces must be quoted. A value beginning with `--` can use the
`--option=VALUE` form; use `--` before positional text beginning with a dash.
IDs are returned by creation commands and are stable. Examples below use T1/H1/M1.

## Supervisor observations

`supervise` (or `supervise status`) reads registered session state, responsiveness,
checkpoint freshness, managed waiter identity, tasks and jobs separately. Output
always reports `management_enabled: false`: production provider adapters remain
observe-only. A missed ping, stale checkpoint or missing waiter never authorizes
termination or replacement.

`supervise ping ROLE` records a generation-bound nonce, at most once per 60 seconds
for that role and generation, with a 120-second acknowledgment deadline. The
outstanding nonce remains active until answered; later cadence requests cannot
replace it and mask an overdue response. The
role's `wait` returns `supervisor-ping`, including its nonce and generation. After
reading current state, the worker uses
`supervise ack NONCE --generation N --as ROLE`. Acknowledgment does not consume mail
or advance notification progress. Save and reuse the cursor returned by `wait`
under the usual reconciliation rules.
Frozen lifecycle states report responsiveness as `suspended`, retaining prior
nonce/deadline evidence without an acknowledgment obligation. Returning to
running/draining advances a durable ping epoch; the next request gets a fresh
nonce and deadline, and pre-freeze requests cannot be replayed or acknowledged.

The experimental controller/bootstrap implementation is available only to fixture
adapters in source tests. There is no production enrollment, replacement or
unattended-enable command. See the [implementation contract and remaining gates](supervisor.md).
Ordinary commands retain their standalone behavior. A role explicitly enrolled by
a fixture controller must supply `SASSATO_WORKER_GENERATION` and
`SASSATO_WORKER_TOKEN` for writes; stale, missing or frozen credentials fail closed,
including through legacy mutation commands. These credentials are not needed for
unmanaged roles or read-only observations. Managed `wait` additionally writes its
PID-bound observation and therefore requires current credentials. It cannot start
in a frozen lifecycle state: after Ready the worker stays behind its existing
adapter barrier, with no new tool or waiter, until retirement.

A role name denotes one instance across workspaces sharing the local database.
While managed, that instance is reserved to its enrolled workspace; switching
workspaces cannot bypass its generation fence. Use distinct role names for
independent workers.

If a generation freezes while an existing managed waiter is finishing, the waiter
still returns its notification cursor and marks `managed_observation` as
`cleanup-fenced`. Its observation remains reserved until the originating PID is
positively gone; the next eligible waiter can then reclaim the slot. This never
advances handled notification progress or permits work in the frozen generation.

## Setup and administration

| Command | Behavior |
| --- | --- |
| `init [--workspace NAME] [--humans NAME,NAME \| --config FILE] [--dry-run] [--launch builder,reviewer --new-window --as alice]` | Bare terminal init asks for workspace and human names; parameters stay noninteractive. Optionally launch selected roles. Dry-run previews all steps without changing coordination data |
| `workspace attach PATH --as alice` | Attach a canonical directory; refuse another workspace's existing exact attachment |
| `roles` | Role configuration and usage |
| `role set NAME --as alice [--provider NAME] [--model NAME] [--dir PATH] [--kind agent\|human]` | Create/change role; also supports --effort, --permission-mode, --sandbox, --approval; human required for permission changes |
| `status` | Task counts, pending questions, blockers, stale claims, event cursor |
| `migrate` | Apply pending schema migrations to the selected database; no workspace required |
| `doctor` | Schema, SQLite/FTS availability, WAL/FULL, integrity and foreign-key checks |
| `backup NEW_FILE --as alice` | Online consistent backup of **all workspaces**; no overwrite |
| `restore BACKUP --db NEW_FILE` | Validate and restore into a new file; never overwrite an existing database |
| `machine` | Host load, CPU, memory and uptime; no per-job ownership attribution |

Use `init --config ./sassato.config.json` for a workspace and its team. See
[configuration](configuration.md) for shared and per-role working directories, path
resolution, default human routing, import time zones and optional stop-file signals.
New defaults are builder, reviewer and human; existing workspaces keep their saved roles.
Bare init prompts only in a terminal without an existing workspace environment value.
`--interactive` explicitly enables prompts; `--no-interactive` disables them. JSON never
prompts. Configuration is validated before creating a database.

`workspace settings` reads routing/import/stop settings. A human can change them with
`workspace set --default-human NAME`, `--import-timezone ZONE`, or `--stop-file PATH`.
`--import-answer-markers JSON`, `--import-role-aliases JSON` and
`--import-timezone-aliases JSON` configure historical document labels; see
[configuration](configuration.md) for validation and examples.
`--open-work-roles a,b,c` names the roles woken when a task with no owner and no
`--for` role becomes ready (`all`, the default, wakes every eligible role); a role left out still
sees such tasks in `tasks --available` and is woken for work owned by or routed to it.
An empty list (`--open-work-roles ''`) deliberately disables only unrouted open-work
wakes, including idle reminders. When unset, every role may see eligible unrouted
open work in its idle reminder. A task routed to another role is excluded from
the waiting role’s idle open-work reminder even when the waiting role owns it.
The empty list does not disable eligible owned or explicitly routed work,
mail, answers or STOP. Role names are strict lowercase identifiers: whitespace or
uppercase aliases are rejected, not silently normalized.
Use `none` to clear the default human or stop file. `role set NAME --kind human` adds a
human; only an existing human can create/promote roles. Agent model/permission settings
inherit provider defaults unless explicitly configured.

## Registered checkouts and task briefs

Registration records existing non-bare Git checkouts; it never creates a worktree or
changes files, refs, branches or provider sessions. Coordination remains shared by
the workspace (project), with immutable project/repository/checkout IDs. Linked
worktrees share a physical repository ID; clones do not. Canonical Git paths,
device/inode and object format establish identity; branch and HEAD are observations.
Missing, moved or replaced paths fail closed and require operator reconciliation.

```sh
sas checkout register --dir /repos/project
sas checkout list
sas checkout show CHECKOUT_ID
sas checkout bind CHECKOUT_ID --dir /repos/project/src --task T1 --provider codex --session-id CONVERSATION_ID
sas checkout resolve src/parser.ts --task T1
sas brief save T1 --file ./brief.json --expect TASK_VERSION
sas brief show T1
sas handoff T1 reviewer 'Continue the parser' --brief-file ./brief.json --expect TASK_VERSION
```

Binding requires an owned active task and reserves one worker per role instance
and checkout across this database's projects. Use a separate registered checkout
for a reviewer (`checkout bind ... --mode review`). Working directories must be
existing canonical descendants of the registered root. Repository-relative path
resolution rejects symlinks escaping that root. `checkout release` requires verified
exit of the matching registered provider session and no active owned jobs; expired
task leases or session end markers alone do not release a reservation.
The reviewer binds its **own separately assigned review task**, not the coding
task whose owner submitted the change. Record that subject task and PR in the
review assignment; automatic subject/snapshot linkage is a later workflow phase.
Binding requires the current registered provider session with a verified PID/start
identity. It records that exact session row and the working subfolder's device/inode;
replacing the subfolder blocks further use. Release also refuses another live or
unknown current role process. Ended unrelated historical PID-less records do not
permanently block subsequent bindings. Unknown ownership needs explicit human
reconciliation; this foundations release has no automatic override or retirement.

The brief input is a version-1 JSON object:

```json
{
  "version": 1,
  "objective": "Complete the parser",
  "acceptance": ["The parser accepts the documented grammar"],
  "decisions": [{"decision": "Preserve the public API", "source": "T1 accepted decision"}],
  "open_issues": [],
  "validation": [{"command": "npm test", "result": "Passed"}],
  "artifacts": ["logs/test.txt"],
  "next_action": "Inspect the new failing input",
  "configuration": {"digest": "0000000000000000000000000000000000000000000000000000000000000000", "provenance": ["configuration manifest reference"]},
  "jobs": []
}
```

Supply the actual configuration manifest's SHA-256 digest and references. These
reported claims do not grant authority. The immutable saved brief adds observed
registry identity, cwd, branch/HEAD, active task versions, safely handled notification
progress, role-settings digest and dirty-work manifest. Staged blob IDs and local
hashes of unstaged/untracked content preserve evidence without storing file contents.
Dirty files must remain stable during capture; unsupported submodules, unreadable
files and files over 64 MiB block it. The complete saved brief is capped at 32 KiB;
oversize or incomplete input is rejected, never silently truncated. Report every
settled job as `{ "id": "tests", "state": "completed", "evidence": "logs/tests.txt" }`;
running or unknown jobs and active recorded jobs block capture.
Git probes and file hashing run outside SQLite write transactions. Index entries
are requested only for dirty paths. Sparse/assume-unchanged/skip-worktree state,
unmerged indexes, unfinished Git operations and non-UTF8 paths block capture
explicitly. Notification progress remains the caller's safely-handled attestation;
brief capture does not consume or acknowledge notifications.

A bound handoff records a **pending retirement intent** with its brief and inspected
task version. It transfers neither task ownership nor checkout reservation. Saving
a brief does not establish tool quiescence, authorize process termination or start a
successor; verified managed retirement/finalization is a separate capability.
This foundations slice deliberately has no pending-intent cancellation or
finalization path, including after a reservation is released. Keep the task with
its current owner pending the managed reconciliation capability; repeated brief
records are evidence, not permission to transfer it.
Unbound legacy `handoff` behavior remains unchanged. Ordinary commands need no daemon
or model calls. Do not install a development build against a live coordination database.

## Tasks, ownership and reviews

| Command | Behavior |
| --- | --- |
| `add TITLE [--body TEXT] [--owner ROLE] [--for ROLE] [--priority 0..100\|now\|normal] [--human-only] [--review-required] [--spare]` | Create one task; higher priority first. `--spare` makes it spare work (below). 90 and above (`now`) is set or lowered only by a human role |
| `tasks [--status all\|open,doing,...] [--owner ROLE] [--for ROLE] [--available] [--spare] [--limit N] [--after T1]` | Default live tasks, 50 per page (maximum 1000); --after follows priority/ID order; JSON includes items/has_more/next_after. Spare tasks are listed apart (JSON `spare`, at most 50, first page only); `--spare` lists only them; `--available` never includes them |
| `show T1 [--limit N] [--before-event NUMBER]` | Body, blockers, dependencies, questions and latest 100 audit events by default |
| `take T1 [--hours 4]` | Atomically claim eligible open work; lease 1–168 hours |
| `renew T1 [--hours 4]` | Renew owned lease, including stale lease |
| `note T1 TEXT` | Append a note to owned work, or as the task's creator or target to work another role holds; can annotate closed work |
| `update T1 --expect VERSION [--title TEXT] [--body TEXT] [--priority N\|now\|normal] [--for ROLE\|none]` | Reject stale client versions; only a human moves a task into or out of 90 and above |
| `handoff T1 ROLE SUMMARY` | Transfer ownership/target with notification; recipient explicitly claims |
| `release T1 REASON` | Remove ownership/lease, keep routing target; clear --for separately if needed |
| `submit T1 SUMMARY [--reviewer ROLE[,ROLE]]` | Doing → review; summary should include refs/tests/handoff details. The waiters of the named reviewers wake; without `--reviewer`, the task's creator's waiter wakes when an agent other than the owner created it, else every eligible role's |
| `review T1 --approve\|--reject --expect VERSION --note TEXT` | Review the inspected task version; stale approvals/rejections fail; rejection returns to doing and notifies owner |
| `done T1 [--ref TEXT]` | Complete owned doing/review task, with blockers/dependencies and required review checked |
| `drop T1 REASON` | Close without successful completion; cancel pending questions and resolve their linked blockers |
| `reopen T1 REASON` | Reopen closed work, retain owner, clear approval; explicitly claim again and ask new questions as needed |

`update` also accepts `--human-only`, `--agent-allowed`, `--review-required`, `--no-review`, `--spare`, `--no-spare`.
Only a human may downgrade human-only work or remove a required review. To make active
work human-only, release it first. Setting human-only clears owner and uses `--for`, an existing human target, or the default human routing below. Creating human-only work with `--owner` uses that human as its target unless `--for` is supplied.
Tasks routed with `--for ROLE` can only be claimed by that role, even if another role
created them. Untargeted work is available to any otherwise eligible worker.
An unowned agent task may be edited or annotated by its creator or target role.
Ordinary completion still requires a claim; an authorized editor may reconcile an
imported item without manufacturing a new claim. Human-only restrictions still apply.

`retitle [--owner ROLE]` previews active imported titles for one owner (your own by
default). `retitle --apply` removes a recognized leading status parenthesis when the
preserved body contains an unambiguous title after it. Original bodies and audit
history remain unchanged. Only a human can run this pass for another owner;
ambiguous titles are skipped and can be changed individually with `update`.

Reviews require `--expect`: read `show T1`, inspect its contents and retain `version`.
If the task changes before approval or rejection, the review fails without modifying
it. Read the changed task before reviewing again. This binds the review to task state,
not to a Git commit: `done --ref` is recorded evidence, not verified artifact identity.

`task add`, `task take`, etc. are accepted aliases of their top-level task verbs. Use
`tasks --status done --limit 20` for a bounded completed-work view; task list ordering is priority/ID.

### Spare work (T1102)

A spare task is work worth doing when a role has nothing else: it is never ready work. `context`, `tasks
--available` and the waiter's ready-task wakes leave it out. It is offered only by the idle reminder
(`--idle-minutes`), as `spare-work` with at most three tasks, to a role that has no own work and no open
work it could take. The waiter's digest shows it as `SPARE WORK T1, … offered to ROLE`; it can be left out
with `--digest-skip` like `open-work`. The task's usual rules still apply (owner, `--for`, human-only,
dependencies, pending questions).

Two workspace settings, set only by a human:

- `workspace set --spare-work on|off` (default `on`): `off` stops every spare offer.
- `workspace set --spare-providers codex,claude` (default `any`): only roles whose provider is listed are
  offered spare work; `any` (an empty list) offers it to every provider.

`add --spare` creates one; `update T1 --spare|--no-spare --expect VERSION` sets or clears the flag, by the
same roles that may update the task otherwise. A cleared flag makes the task ordinary ready work, and the
change is in the task's history (`show T1`) with who made it, before and after.

## Feedback (T1113)

A feedback record is one line a role writes when it notices a workflow mistake, wasted tokens, something
untested, something sampleusers could test, or a point about Sassato itself. It is a record, not work: it
never wakes anyone, is never ready work, and needs no check first whether it is already known.

| Command | Meaning |
| - | - |
| `feedback add KIND TEXT [--re T1]` | Any role. KIND is `workflow`, `tokens`, `untested`, `sampleusers` or `sassato`; TEXT is one line of at most 500 characters. Sassato records who wrote it and when, and prints its number (`K1`, `K2`…) |
| `feedback list [--kind K] [--author ROLE] [--all] [--limit N] [--after K1]` | Open feedback, oldest first, 50 per page; `--all` includes closed ones |
| `feedback close K1 --task T1 \| --fact KEY \| --dropped REASON` | Closes it as a task, a rule (a fact, which must exist) or a stated no. Only a human, or a role a human named in `feedback_closers` |

- `workspace set --feedback-closers fable --as HUMAN` names the roles besides humans that close feedback
  (`none` clears the list; the default is none, so only humans close it).
- Humans and the roles in `feedback_closers` see `feedback: open=N · oldest_days=D` in `context` and
  `context --brief`; nobody else sees a feedback section.
- `show K1` prints one record, `search` finds feedback text (`--type feedback`), and `export` writes
  `feedback.md`.

## Dependencies, blockers and decisions

```sh
sas after T2 T1                       # T2 waits until T1 is done; cycles refused
sas unafter T2 T1
sas block T1 'Need callback endpoint' --kind agent --waits-on b
sas block T3 'Parked until the hardening pass' --kind other --waits-on fable  # parking: wakes nobody
sas block T2 --on T1                  # same as after: e.g. T1 is the human-only task holding the decision
sas blockers                         # explicit and derived open blockers
sas blockers --task T1
sas blockers --chain T1               # root causes across dependencies
sas resolve B1 'Endpoint confirmed'
sas ask-human T1 'Choose host' --for alice --options 'local|hosted' --recommend 2
sas ask-human T1 'Approve manual operation?' --for alice --command 'exact command text'
sas humans --for alice               # omit --for for the shared human queue
sas answer H1 2 --as alice
sas answer T1 'Free-text decision' --as alice
sas withdraw H1 'Asked again as H2'   # the asker, the task's creator or a human
```

A blocker of kind `agent` or `human` wakes the role it waits on (as a decision to make) when it is
opened; `other` and `external` wake nobody. So a task parked for later is blocked with `--kind other`
(`--waits-on` still names who sets it in the order); `agent` is for a question someone must answer now.

`ask-human` sends the question and notification to the human selected with `--for`.
Without `--for`, it uses the configured default human, the sole human, or the calling
human. Otherwise an agent must choose explicitly. `ask-human --new TITLE QUESTION` asks
a question that has no task yet: it makes the task (owned by and for the asker, the
question as its body) and asks the question in one step, and prints both ids; a task id
beside `--new` is refused. `humans [--for NAME] [--limit N] [--untouched]`
lists pending questions and human tasks, each with who asked (`asked_by`: the asker, or the
task's creator), its age in days (`age_days`), when it last changed (`touched_at`: the
question or its task) and `untouched` when that was more than seven days ago; `--untouched`
lists only those. Any human may answer; routing is not a private
access boundary. Earlier command names remain documented in [compatibility](compatibility.md).

Blocker kinds: agent, human, external, other. Every blocker names `--waits-on` explicitly.
Multiple blockers coexist. Dependencies are derived from task status and need no copied
status updates; dropped dependencies still block. A question creates a linked human
blocker. `answer T1` works only when exactly one pending question exists. Numeric answers
select an option; free text is also allowed. Answering records who/when, notifies owner
and asker, and resolves only that question's blocker. Pending question blockers cannot
be bypassed by resolving B1 directly. Dropping a task cancels its pending questions,
records who/when/why and resolves only their linked blockers. It does not manufacture
an answer. `show H1` and task history retain the cancelled question. Cancelled questions
cannot be answered and do not revive on reopening; ask a new question if still needed.
Other blockers remain in place. Commands remain inert text.

Resolving the last blocker restores the earlier review/open state, or doing when its
retained lease is still valid. An expired claim returns to open without changing its
owner. Multiple blockers do not overwrite the original state.

`answer H1 'Approved' --as alice --relayed-by assistant` records the role that typed
a human's decision in the audit event. It still requires a human actor; relay attribution
does not grant permission or authenticate either identity.

A decision given in a chat before anyone recorded the question is recorded whole:
`answer --asked QUESTION (--on T1 | --new TITLE) ANSWER --as alice --relayed-by assistant
[--close]` records the question, asked by the relaying role, and its answer in one step,
on the task or on a new one owned by and for the relaying role. `--relayed-by` is required.

## Mail, facts and WIP

| Command | Behavior |
| --- | --- |
| `send ROLE[,ROLE]\|all TEXT [--re T1] [--urgent \| --now] [--needs-reply]` | Append message, snapshot recipients, optional task link; `--needs-reply` asks each recipient for a reply or review |
| `inbox [--peek] [--state unread\|read\|done] [--limit N]` | Unread first; marks only returned unread messages read unless --peek |
| `sent [--limit N]` (alias `outbox`) | Sent messages with unread/read/acked status per recipient; JSON retains receipt timestamps |
| `ack M1 [M2 ...]` | Atomically mark up to 100 addressed messages done; validate the whole batch first; retries preserve timestamps |
| `fact set KEY TEXT --source LOCATION [--checked-at ISO_DATE] [--expect VERSION] [--answers T1]` | Create/correct shared fact; updates require expected version. `--answers` marks the open human task the fact answers: `humans` shows it as answered in the fact, and a human closes it |
| `fact get KEY` / `fact history KEY` | Current fact or immutable revisions |
| `facts [--limit N]` | List facts |
| `wip [show\|get ROLE]` | Read any role's WIP, default current role; its `version` is what `wip set` and `checkpoint save` take as `--expect` |
| `wip set [--current TEXT] [--next TEXT] [--notes TEXT] [--expect VERSION]` | Only current role's notes; updates require expected version. A stale version is refused with exit 4 and the current version; a non-number names the command that shows it |

Mail read/done is per recipient. Reading another role's WIP never changes it. Facts need
a source and checked date (default now); they never confer permission. Empty quoted WIP
fields clear that field. Fact keys may contain path-like components.

## Sessions and context

`checkpoint save --current TEXT --next TEXT --notes TEXT [--expect WIP_VERSION] [--evidence FILE]`
atomically updates your WIP and saves a recovery record. All text fields are required;
read WIP first and supply its version for updates. `checkpoint show [ROLE]` reads the
latest record and its freshness (`null` if absent).
A checkpoint is stale once its role has made ten changes of its own since it (mail
sent, tasks created or changed, reviews, facts), or once the first of them is thirty minutes
old; `own_changes_since` counts them. Reads, acknowledgements, lease renewals, WIP and
notification progress do not count.

`checkpoint save` and `wip set` warn, on stderr and as `warnings` in the JSON, when a field
says it is waiting on a human role by name ("waiting on", "waits on", "wait for" or "waiting for"
followed within a few words by the role) and names no question (`H12`) and no `humans` list:
a wait on a human belongs in `ask-human`, where `humans --for NAME` shows it. The save goes
through either way.

Saving observes repository/worktree, branch, commit and dirty status with bounded
read-only Git probes, then snapshots current owned/targeted task versions and durable
notification progress. `--evidence` accepts a version-1 JSON object with `validation`,
`artifacts` and `jobs` arrays, up to 20 entries each and 32,768 input bytes. These
are agent reports: commands and jobs are not executed or adopted. See the
[evidence example](../examples/recovery-evidence.example.json) and
[field limits](context-management.md#structured-recovery-evidence).

`progress show [ROLE]` reads the latest notification progress (`null` if absent).
`progress save --cursor N --expect VERSION` saves the current role's safely handled
event cursor. Use `--expect 0` for the first save; later use the progress record's
version, which is independent of the WIP version. Progress is monotonic and cannot
exceed this workspace's latest event; stale writes fail. Identical retries return
the existing result. Saving never acknowledges inbox receipts or STOP.

Save checkpoints after meaningful progress, decisions and significant validation,
and before a handoff or planned session transition. Keep native automatic compaction
enabled. After startup, resume or compaction, read current context and the checkpoint,
inspect relevant records and verify files. These commands do not invoke provider
controls or end a session. See [context management](context-management.md) for
freshness rules and the recovery workflow.

```sh
sas session register --provider codex --session-id UUID --as c
sas session heartbeat --session-id UUID --as c
sas session end --session-id UUID --as c
sas sessions
sas usage 'Out of usage until Tuesday' --until 2026-11-10 --as builder
sas context --as b --brief --json
sas context --as b --since 123
```

Register supports `--pid PID` for verified provider identity on Linux and `--replace` for
explicit replacement. Unknown identity without PID is visible and prevents automatic launch.
A fresh session can recover role work without any prior transcript ID. Use SessionStart
hook for Claude and explicit registration/manual bootstrap for other providers. Heartbeats
show last activity; they alone do not establish liveness. Expired usage notes remain visible
with their date until explicitly updated. Ended metadata cannot override a verified live PID.

Context is always bounded; --brief is accepted for bootstrap compatibility. It never
changes receipts. Save its `cursor` for the next `context --since`; `snapshot_cursor`
is informational, not the continuation point. Waiter recovery uses its own returned
cursor and durable progress, not context pagination. Truncation can cause repeat delivery when paging; use stable IDs
for deduplication. Cursor tracks changed facts and answered questions; current work, pending
mail and blockers remain visible regardless of --since. Its `questions` are the role's own
open questions to humans (asked by it or on a task it owns), each with `age_days` and
`untouched` as in `humans`. Non-inbox counts are lower bounds.
Detailed commands show full records. JSON context is limited to roughly 5800 characters;
terminal context to 40 lines/6000 characters.

## Heavy jobs on a shared machine

`job run --kind KIND [--wait | --no-wait] [--job-version TEXT] [--load more|same|less] [--mem MB] -- COMMAND [ARGS...]`
asks before a heavy command starts (a full test run, a benchmark, anything with a browser
and a server), waits while the machine has no room for it, runs it, measures it and records
the run. Its exit status is the command's; a job that is not started exits 75 with the reason.
Jobs count across every workspace in the database, since they share one machine.

- **Need.** A kind asks for the highest peak memory of its last five runs that ended with
  exit 0, of the same `--job-version`, plus a fifth. With fewer than two such runs of that
  version it takes the latest five of any version plus half; with none, a default (gate 6 GB,
  evolution 4, benchmark 3, container-tests 4, other kinds 2). A peak among the latest five
  rows of any end (failed, released, still going) can only raise the need, so runs cut off
  early never lower it. The session's estimate can raise the need, never lower it: `--load
  more` takes the half margin, `--mem MB` sets a floor; `--load less` and `same` are only
  recorded.
- **Admission.** Waiting jobs go in turn: the role with the fewest starts since the oldest
  waiting job asked goes first, then by arrival, and no later job starts ahead of one that
  waits. The first in turn starts when the memory available now, minus what running jobs may
  still grow to (their need, or their present use plus a fifth once past it), minus 3 GB kept
  free, covers its need, and the cores of running jobs plus its own stay within the machine's.
  A need larger than the machine's memory less the reserve is refused at once. `--no-wait`
  is refused instead of waiting.
- **Measuring.** Each job runs in its own systemd user scope, when one can be made. Every two
  seconds its memory is read from the scope's cgroup less its page cache (`memory.current`
  minus the file pages in `memory.stat`, since the kernel reclaims cache and MemAvailable
  counts it free); the peak is the highest of those, and CPU time comes from `cpu.stat`. The
  cgroup's own `memory.peak`, cache included, is kept beside it. Without a scope the job's
  process group and descendants are sampled from /proc. SIGINT, SIGTERM and SIGHUP to
  `job run` go to every process of the job (the scope, or the process group). Processes a job
  leaves running after a normal end are named, never killed. A job whose `job run` process
  is gone is released.

`job list` shows running and waiting jobs and the room left. `job stats` shows per kind and
version the runs, failures, median and highest peak, CPU and wall time, how the peaks compared
with the needs asked for, the estimates given, and what the next run will ask for.

## Search, migration and launch

`search TEXT [--type task,message,fact,feedback,blocker,question,wip,event,import] [--owner ROLE]
[--status STATUS] [--since ISO_DATE] [--limit 1..100] [--phrase] [--prefix]` searches literal
words by default, ANDed together. --phrase matches a literal phrase; --prefix applies to
the last word. --owner filters the document's indexed role (sender for messages, owner or
target for tasks). FTS punctuation is tokenized, not executed. Rank and snippet are returned.
Audit history can match text no longer present in the current task. Expand any result with
`show T1|M1|F1|B1|H1|E1|I1`; WIP results use `wip show ROLE`.

`import --backlog FILE --wip FILE --actions DIR --sessions FILE --dry-run` previews one or
more sources. Use the same options with `--confirm DIGEST` to apply as a human. Conflicts
never overwrite live records. `export NEW_DIRECTORY` writes readable snapshots with
per-task histories. See [migration details](integrations.md).

`launch ROLE... [--all] [--resume|--fresh] [--dry-run] [--no-prompt] [--watched]
[--terminal native|windows-terminal] [--new-window] [--distro NAME] [--window NAME] [--stop-file PATH]`.
Actual launch needs an explicit human role, such as --as alice. --new-window selects Windows Terminal and opens one new
window per role; it conflicts with --window and native terminal mode. Native interactive output cannot use --json; dry-run JSON
is supported. Native launch allows one role. Windows Terminal is opt-in and waits for verified provider startup; errors or startup timeout fail the command. `launch-unlock ROLE... --as alice` clears only demonstrably stale
locks. A lock written before the machine last booted (a WSL restart ends every launcher) is cleared by the next
launch itself and recorded as a `launch-lock` event; a lock whose launcher died in the current boot still needs
`launch-unlock`, and launch says so. See [provider and hook setup](integrations.md).

Resume: a role resumes its registered provider session. A Codex session registers no ID, so for a Codex role launch
resumes the newest saved Codex session (CODEX_HOME or ~/.codex, sessions/) that has the role's working directory and
whose launch prompt names the role, searching the newest 200; so a plain `launch` of a Codex role now resumes where it
used to start fresh. --fresh starts a new session; --resume fails when none is found.

The start prompt says who does the waiting. A Codex role launched with `--watched` (one that `launch-watch` will
serve) is told its launcher does the waiting and to arm no waiter; without it, a Codex role is told that no launcher
waits for it and to read its inbox and context between tasks. `--watched` applies to Codex roles only. A resumed
session keeps its first prompt, so each turn `launch-watch` queues says it too.

## Output contract

--json writes a single JSON value to stdout; errors are on stderr, with no success output.
No matches are `[]` and exit 0. Exit 1 is storage/runtime, 2 malformed input, 3 identity/
permission/not-found and 4 conflict/state/version. The runtime may emit its own warnings
to stderr on Node versions where node:sqlite is experimental. Query/parameter values are
bound, and no-match is never confused with a permission failure.

## Stop control

| Command | Behavior |
| --- | --- |
| `stop [ROLE...] [--all] --as alice` | Request cooperative stop and wait; defaults to all agent roles |
| `stop [ROLE...] --timeout SECONDS --as alice` | Bound the wait; timeout exits 4 and leaves requests active |
| `stop [ROLE...] --no-wait --as alice` | Request stop and return immediately |
| `stop [ROLE...] --force --as alice` | SIGTERM verified registered provider PIDs, allow up to one second, then SIGKILL verified survivors |
| `stop-status [ROLE...]` | Read active stop requests and their observed state |
| `stop-status [ROLE...] --quiet [--stop-file PATH]` | Print no normal output; exit 4 if stop intent or the optional stop file is active, otherwise 0 |
| `stopped R123 --as ROLE` | Acknowledge this exact current request after tools stop and WIP is saved |
| `resume-work [ROLE...] [--all] --as alice` | Clear requests, allowing new claims and launches; does not launch sessions |

See [integration details](integrations.md#stop-and-resume-work) for cooperative agent
setup, verification limits, and the separate legacy stop file. Stop and resume require
a human role. Acknowledgment is limited to the role addressed by the request.

An all-role stop (explicit `--all`, or no role arguments) also waits for the
workspace's configured [busy checks](configuration.md#busy-checks-before-an-all-role-stop-completes).
The same `--timeout` covers both agent acknowledgements and checks. Busy and unknown
checks are reported by name and prevent successful completion; a timeout leaves
stop intent active. Only non-idle checks are retried while roles shut down; once
all roles have stopped, every check is re-probed before reporting machine quiet.
Idle observations from that final phase are then retained. Default timeout 0 waits indefinitely, even if a check
keeps failing. Use `--timeout SECONDS` to bound this wait.
`--no-wait` and `--force` report role completion without executing checks; both
return `machine_quiet: null` in JSON. Force still only signals verified provider PIDs;
it rechecks process identity and stop intent before escalating. Force does not await
cooperative completion or guarantee descendant jobs have stopped.
A role with no registered session or pending launch is inactive even when it owns
unfinished tasks. An unverifiable registration still requires acknowledgement or
verified exit; absence of a usable PID is not proof that a session stopped.

`stop-status --quiet` reads stop intent, including acknowledged requests that have
not been cleared, and the optional configured `stop_file`. `--stop-file` overrides
that file for this check. It does not run busy commands. Storage or inspection
failures return an error, never exit 0; scripts should proceed only on exit 0.
It suppresses normal output even with `--json`; errors still go to stderr.

```sh
if sassato stop-status --quiet --workspace my-project; then
  ./scheduled-job
fi
```

## Feedback improvements (0.1.1)

- `--version` prints the release and build fingerprint; `--version --json` also includes build time and schema version.
- Task pages return `{items, has_more, next_after}` in JSON. Human output shows a continuation hint when more matching tasks exist. Preserve filters while passing `--after T123`.
- `done T123` permits the eligible owner or a human to complete an unclaimed imported item; a human may also complete an unclaimed human-only item. Blockers, dependencies and review gates still apply.
- `answer H123 'answer' --close --as alice` answers and completes the associated task atomically. If another blocker or review prevents closing, neither change is committed.
- `send b 'Please review now' --urgent --as a` stores urgent mail. Urgent unread mail is prioritized within the inbox.
- `send b 'Please read PR 4' --needs-reply --as a` asks b for a reply or review. It wakes b's waiter once (`REPLY M1 from a asks for your reply: …`; urgent mail instead wakes it until acknowledged), and b's context lists it under `replies`, read or not, until b acknowledges it with `ack`.
- `wait --as b [--since EVENT_CURSOR] [--timeout SECONDS] [--stop-file PATH] [--idle-minutes N] [--settle SECONDS] [--settle-max SECONDS]` waits for relevant mail/workflow changes or a stop request, prints a bounded digest and exits 0. Stop takes precedence; timeout exits 5. It never consumes receipts or spawns a provider. Default timeout 0 waits indefinitely. With `--idle-minutes N` it also wakes b (`OWN WORK T1, … held by b …`) when b holds doing tasks and has written nothing for N minutes; when b holds none doing but has open tasks (b's own or for b) that b can take now (no open blocker or pending human question, no unfinished dependency), it wakes b with those instead (`OPEN WORK T1, … for b …`, highest priority and oldest first) so b takes one. A role with no open task is not woken. Any write of b's own starts the period again. Off by default.
- `import ... --repair --dry-run` previews conservative corrections to existing imports; use the same options and `--confirm DIGEST` to apply. Agent-edited tasks and WIP are preserved; untouched imported WIP can be refreshed from a newer dated entry.

Version 0.1.2 imports the newest dated WIP entry per role (ordinary or stopped), supports
previewed repair of untouched imported WIP, and shows source age in context.
WIP older than 24 hours has `stale=true`; new imports retain the source timestamp.

Context lists an agent role's own stale claims only; a human role sees every role's. Its task
rows show `priority` and `asked_by`, the role that created the task, marked `(human)` for a
human role.

`wait` also reports human answers (`answer`), newly assigned blockers (`blocker-assigned`),
resolved blockers (`blocker-resolved`), dropped prerequisites (`dependency-dropped`),
new assignments/handoffs (`task-assigned`), claimable work (`task-ready`), review
submissions (`review-submitted`), and owner review results (`review-approved` or
`review-rejected`). Ordinary mail and the waiting role's own actions do not wake it. Self-authored
workflow events still advance the returned cursor; their effects remain visible
in context and history. STOP always takes precedence, including self-requested STOP. An assigned task may still be blocked; `task-ready` means currently claimable work or already-owned work whose dependency
has cleared. Check current state before claiming, since another role may act.
The optional `--urgent` flag remains accepted for compatibility and does not disable
workflow notifications. Reviews are currently untargeted: an unapproved submission
wakes any independent agent role or a human role in the workspace; humans retain
the existing self-review override. Results wake only the task's current owner.
Superseded review transitions and results on closed work are skipped; read task history for the complete sequence.
Edits that clear approval while work remains in review request another review
(`review-submitted`). Review notifications include the event's task `version`;
read the current task and supply that inspected version to `review --expect`. Notifications do not claim or
review anything. Every result includes `cursor`; human output prints it too.
Without `--since`, wait resumes from durable notification progress when present;
otherwise it fails rather than inventing a new baseline. Explicit `--since` always
overrides progress. When progress is absent, retain the initial context `cursor`, inspect the full inbox
and relevant records (including truncated items), and reconcile pending work before
initializing that captured cursor with `--expect 0`. Do not use `snapshot_cursor`
or a later context cursor; leave progress absent if handling is incomplete.
After safely handling each result, save that result's cursor, then re-arm the waiter.
Timeout cursors can also be saved. If handling fails or the session crashes, leave
progress unchanged so recovery replays the event. Never substitute a newer context
`snapshot_cursor` for the last safely handled waiter cursor. Existing unacknowledged urgent
mail and STOP still return independently of progress. See [notification recovery](context-management.md#durable-notification-progress).

Unacknowledged urgent messages remain eligible after reading until `ack M1` records
handling. Legacy single-event output (`--settle 0`) includes up to 2,000 characters
and an identity-qualified inbox
command when truncated. Without `--since` or saved notification progress, `wait`
fails with an input error instead of silently skipping events. STOP still takes precedence.

## Settled notification digests

Agent roles default to `--settle 120 --settle-max 600`. After the first eligible
wake, only a **new relevant notification** restarts the quiet window. Pending
urgent messages are deduplicated during that wait; unrelated role traffic does
not extend it. Human roles default to `--settle 0`, which preserves the original
first-event output. Any caller can choose immediate legacy behavior explicitly.
The API uses the same role defaults. Seconds must be integers: settle 0–3600,
maximum 1–3600; the maximum can be shorter than the quiet window.

```sh
sas wait --since 123 --settle 120 --settle-max 600 --as builder
sas send builder 'Please review the result' --urgent --needs-reply --as lead
sas send builder 'Main is broken: inspect T4 immediately' --now --re T4 --as lead
sas ack M12 M13 M14 --as builder
```

`--now` implies urgency and bypasses settling. Plain `--urgent` collects normally.
STOP, a human answer and a valid supervisor ping also return immediately, with
any notifications already collected attached. Supervisor deadlines remain in
force. A human answer returns after the events already there are read, so answers
given together arrive in one digest, each once: its notice mail stays in the inbox
but is not a digest entry. An answer relayed by a role (`--relayed-by`) is not
delivered back to that role, neither as an entry nor as mail. The `now` bit is stored with recipients in the canonical send audit event;
old messages without it are false. No schema migration is needed.

A digest groups entries under `needs-a-decision`, `review-requested`, `finished`
and `other`. Each entry has record/event IDs, sender, kind, optional task and a
single-line summary of at most 160 Unicode characters. Show the full record by ID
and read the current task before acting; the digest grants no authority. Once
collection starts, relevant ordinary mail and completed tasks created/owned by
the role can join the digest, although they do not start an idle waiter themselves.

The collector stops at 100 entries. If another relevant event would overflow it,
the continuation cursor stays **before** that omitted event. Immediate answers and
supervisor pings bypass even a full urgent-mail page; the digest may repeat that
signal until earlier work is handled and its safe cursor catches up. `has_more`
marks continuation work in an immediate result. With the legacy waiter, handle and acknowledge
the returned entries, save the returned cursor with `progress save --expect`, then
wait again. Urgent mail remains eligible until acknowledged, even if its send event
precedes the cursor; this makes an interrupted or repeated wait safe. The digest
never marks a receipt read/done or saves notification progress. Atomic multi-ack
rejects the whole request when any ID is malformed or belongs to another recipient;
duplicate IDs are acknowledged once.

The hard maximum and the overall `--timeout` bound collection. If the overall
timeout expires with collected notifications, the result is a digest (exit 0),
with `flush: deadline`; an empty timeout still exits 5. Other flush reasons are
`quiet`, `max`, `capacity` and `immediate`. Polling can add up to one 500 ms poll to
an arrival's observation. JSON includes `digest.entries`, settings and flush reason;
`reason` is `digest` for a normal collection, while immediate results retain their
`stop`, `answer`, `urgent` or `supervisor-ping` reason and carry the buffered digest.

For a reproducible estimate, `scripts/wait-replay.mjs TRACE.json [SETTLE] [MAX]`
accepts a sanitized array (or `{ "events": [...] }`) of unique notification IDs
with numeric monotonic/millisecond timestamps, `wake: false` for ordinary updates,
and `immediate: true` for answers/now/STOP. It uses the runtime quiet/max policy and
reports first-event versus batched wake counts and delay. It does not read databases
or claim that event counts equal actual provider turns. Keep private traces outside
the repository; document the historical audience projection and omitted event kinds.

### Brief context changes and role status

`context --brief --since CURSOR` lists new addressed mail, relevant task state changes,
new or corrected facts (by key), and answers to questions asked by the role or on its
current tasks. It does not repeat WIP, session snapshots, old mail or unchanged facts.
An unchanged-fact count points to `sas facts`. An active STOP is always shown.

The delta reads at most 2,000 audit events per call and returns up to 20 distinct
records (`--limit 1..100`). Repeated changes to a record share one line showing its
current state. The returned cursor stops before an omitted notification; when more
changes remain, repeat `context --brief --since RETURNED_CURSOR`. This can repeat a
record across pages and never acknowledges mail or saves notification progress.
Keep using your handled wait cursor for notification progress.

`context --brief` without `--since` keeps the bounded snapshot view for a fresh start.
Every brief line is at most 200 Unicode characters, with control characters flattened
and a public record ID for `sas show ID`. `--line-length 80..500` changes that limit.
Non-brief context and its existing JSON snapshot retain their snapshot behavior.

`status --as ROLE` prints one screen with the role's active tasks, open blockers
waiting on it, mail awaiting its reply, saved notification cursor and waiter state.
Each queue shows up to six records and points to detailed commands if more remain.
`--line-length` also applies here. A waiter is armed only when its registered process
identity and worker generation match; a stale observation is not evidence of a live
waiter. Unmanaged waits have no managed observation and appear unregistered.
`status --json` retains workspace totals and adds the structured role summary.
Without a role, `status` keeps its previous workspace summary and JSON shape.
Both views are read-only and leave receipts and notification progress unchanged.

### Cooperative attended probe

`supervise enroll --role ROLE --file JSON` is human-only enrollment of an existing
provider role, active scratch task, registered checkout and explicit busy/lock
guards. `supervise --attended --role ROLE` requires a human terminal;
`supervise attach --role ROLE` opens the separate provider terminal. Workers use
`supervise assignment`, `supervise reconcile --session-id ID` and finally
`supervise ready --file JSON --expect TASK_VERSION`. Ready is cooperative and
freezes further CLI writes; it proves no enforced tool barrier. The two-generation
probe requires fresh human Enter before each owned retirement and never enables
unattended management. See the [operator runbook](attended-supervisor.md).

For example, an agent's `wait --timeout 10` can return a collected digest with
`flush: deadline` even though its default quiet window is 120 seconds. Treat exit 5
as an **empty** timeout; a short timeout never discards notifications already
collected. `--settle 0` explicitly selects immediate notification behavior.

## One call per wake (T977)

`sas wake` replaces the waiter's read-handle-save routine with one call. It is the background waiter:

```sh
sas wake --since 123 --idle-minutes 50 --as builder  # first wake after context
sas wake --since 140 --ack M12,M13 --as builder      # the re-arm: acknowledge what was handled, wait again
```

In one call, `wake`:
1. acknowledges the mail named with `--ack`, once its cursor checks have passed;
2. waits exactly like `wait` (same settling, STOP and immediate signals). It needs saved progress (the start
   text makes it). `--since` defaults to the saved cursor; one past it is refused, since it would skip events,
   and an earlier one replays them;
3. prints what the role needs to act without a second read:
   - STOP, with the `stopped` command;
   - each digest entry with its full text: a message's body; a task's state, its brief when the task is
     new to the role, a review's note, and the notes written since the last wake (the last three); a question
     with its answer. One record woken twice for the same reason is printed once, with both senders;
   - urgent and needs-reply mail still waiting for an acknowledgement (twenty, newest first, with a count of the
     rest).

   Text over 1,500 characters is cut, with a marked tail naming the record to `show`;
4. saves the notification cursor after the output is printed, with the expected-version check, and prints a
   last line saying so. A wake whose output never reached the session saves nothing. If progress moved while
   it waited (another waiter or session), nothing is saved, that line says not to re-arm from this cursor,
   and the exit status is 4;
5. ends with the exact re-arm command (with the same `--idle-minutes` and `--stop-file`, if given), and `--ack` for the
   urgent and needs-reply mail it showed.

A wake with nothing new prints one line and the save line (`Nothing new for builder · cursor 140 · re-arm: …`,
`Cursor 140 saved.`).
A STOP saves nothing and offers no re-arm.

Saving at wake time means the role attests that it **read** the entries, not that it finished them. After a restart, a role reads `sassato context`'s reviews, replies and blockers sections, because the cursor no longer marks what was handled. Work
that cannot be finished at once goes on its task (a note or a block). Urgent mail keeps coming back until
it is acknowledged.

A wake is then: one `sas wake`; the handling; one command with the writes (notes, replies, one
`checkpoint save`); the re-arm, in the same response as the last write.

### Leaving out what a role never acts on

`workspace set --digest-skip JSON` (a human) names, per role, the digest entry kinds that neither wake it
nor fill its digest:

```sh
sas workspace set --digest-skip '{"fable":["own-work","task-finished"]}' --as johan
```

These kinds can be skipped: `own-work`, `open-work`, `spare-work`, `task-finished`, `mail`. Urgent mail, replies, answers,
blockers, reviews, ready tasks, dropped dependencies and STOP always reach the role, since they can concern
its own work.
The default is none: every role gets its digest as before.

`node scripts/digest-stats.mjs <copy of the database> <workspace> [days]` counts, per role, the kinds the
waiter would have put in each digest over the last days, so a list can rest on numbers. Run it on a copy:
it reads current task states, so it shows what still applies, not every past wake.

### Inbox

`sas inbox` lists newest first within unread, read and done. `--unread` is short for `--state unread`.

## Auto-compact window per Claude role (T980)

```sh
sas role set builder --autocompact 200000 --as alice   # launch passes: claude --autocompact 200000
sas role set builder --autocompact auto --as alice     # back to Claude Code's own default
```

A human sets it. It applies to Claude roles only, from 100,000 to 10,000,000 tokens, and `sas roles` shows it
as `autocompact` (null when unset). It is kept in the workspace settings, so it needs no schema change. Unset
by default: nothing changes until it is set. In the session, `/autocompact` shows the window in force. Claude
Code raises a conversation's window by itself when what loads with every request fills more than half of it.

### Consume a launcher wake

An enrolled Codex thread runs `sas wake --pending --as ROLE --workspace WORKSPACE`
to read the launcher's outstanding digest immediately; the queued turn also says that the launcher does the waiting
and the thread arms no waiter. This preserves the original
batch boundary and idle-work trigger. Only the matching registered thread may
consume it. Handle and acknowledge any mail in the ordinary way. The launcher
owns the wait loop.

The worker writes the digest to stdout before committing its notification cursor
and receipt together. Check the exit status, including with `--json`: a broken
pipe or a conflicting session, progress version or enrollment requires recovery.
A crash before commit permits replay. STOP takes precedence and leaves the cursor
in place. A duplicate command after consumption exits with a conflict unless a
new digest is pending. The pending mode takes no wait or acknowledgement options.
The consumer alone does not start or enable a launcher.

### Accepted Codex versions (T1098)

`sassato launch` for a Codex role and `sassato launch-watch` run `codex --version` first. The
workspace setting `codex_versions` (default `0.167.0`) is the list of tested versions (T664):

- a tested version starts silently;
- a newer version than 0.167.0 that is not on the list starts with a warning on stderr naming the
  tested versions;
- a version older than 0.167.0 is refused with exit 4.

```text
Warning: Codex CLI 0.168.0 is not a tested version (tested: 0.167.0); starting anyway. After a trial, a human marks it tested with: sassato codex accept 0.168.0
Codex CLI 0.166.0 is older than 0.167.0, the oldest sassato starts (tested: 0.167.0)
```

`launch-watch` accepts a notice on stderr (an update hint) beside `--version` and `queue --help`
when their exit and answer are right; the queue call itself stays strict.

- `sassato codex versions`: the tested list (read-only, any role).
- `sassato codex accept VERSION --as HUMAN`: marks an exact version tested (`MAJOR.MINOR.PATCH`);
  `--replace` makes it the only one. An agent is refused ("Only a human accepts a Codex version").
  The change is a settings event, so the workspace history shows who accepted which version and when.
  At most 16 versions are kept. Claude roles are not checked.

### Launcher-owned Codex waiter (Linux, accepted Codex versions)

A human can enroll one **existing remote session** in a foreground launcher.
Use the same workspace and registry as the worker. First verify the human terminal
is attached to the intended thread, the daemon is running, approvals are visible
there, and the thread’s normal model and permissions apply. The supported TUI
invocation is `codex --remote unix:///absolute/socket resume UUID` (or the
same remote option after the UUID). The registry must name that live TUI PID
and its UUID, the socket must belong to the current OS user (a path that is a
symlink to it, as Codex 0.167 makes, is followed when the link is the user’s too;
every folder up to the root must be the user’s or root’s and not writable by others
unless sticky; the identity and
the queue calls use the socket’s resolved path), and the worker
must already have reconciled and saved notification progress.

Start the app server from a shell where `sas --version` works: the worker runs
`sas wake --pending` in the server’s environment (a terminal opened before fnm or
the PATH is set up cannot find it). Sassato never starts, stops or removes the
server or its socket. Stopping a dedicated Codex 0.167 app server can remove
Codex’s shared `/tmp/codex-daemon-UID` folder, where the managed daemon’s socket
lives too; new Codex launches then fail until that daemon is restarted.

In a separate terminal, run:

    sas launch-watch ROLE --session-id UUID --remote unix:///absolute/socket --workspace TEAM --as HUMAN

Enrollment is explicit on every start. The launcher holds the ordinary role
launch lock and refuses managed/attended roles. An existing launcher holding
that lock precludes enrollment. The launcher checks the registered process,
its startup arguments, socket identity and configured role settings. The human
verifies the currently displayed conversation; startup arguments alone cannot
attest what is on screen. Dedicated local daemon, attached TUI and human
approval handling are prerequisites. The command never starts a provider or
supplies model, sandbox or approval overrides.

Local waits use the standard digest and a 50-minute eligible-work wake. A quiet
wait makes zero model calls. A work digest is staged before the queue client
receives a fixed instruction to run `sas wake --pending`. Worker receipt starts
the next wait from saved progress. Unacknowledged urgent mail already delivered
by this enrollment is suppressed while other work can still wake the worker.
An overdue acknowledgement sends one reminder per receipt to the operator.

A queue call waits up to 30 seconds; after a timeout it is tried once more
after a short pause, for work only and only when the first call printed
nothing; STOP, the binding and whether the worker already consumed the result
are checked again first, and a STOP notice is never sent twice. A queue
warning (even with exit zero), a second timeout, a changed binding or five
minutes without consumption suspends dispatch and alerts the enrolling human.
A suspended watcher, and any start refused once the role name is valid (the
launch lock included), also sends one urgent mail to the workspace's default
human, with a fixed reason and never the provider's output. `sas status` shows
the role's open enrollment (`watcher enrolled E12`, or `watcher exited E12
(queue delivery uncertain)` once its launcher has ended; `watcher enrolled
E12, launcher not running` when its launcher ended without a word, as after a
reboot) until a human closes it, and a start refused since then (`watcher refused (…)`, or `a restart
refused (…)` beside an open one). Interrupting the launcher (Ctrl-C) is
recorded (`watcher suspended E12 (interrupted)`) but not mailed. Each refused
start mails, so a script that retries a start sends one mail per try. An
approval prompt may account for the delay. Check the human terminal. STOP
preempts the wait, queues at most one fixed stop notice to the same eligible
session, and ends enrollment. The worker checkpoints and acknowledges STOP.

After interruption, reboot or an uncertain delivery, inspect:

    sas watch-status ROLE --workspace TEAM --as HUMAN

An open epoch is durable even if the launcher has gone. A pending event number
identifies a digest the bound worker can consume. If its original session is
unavailable, reconcile the inbox, work and saved progress first. Once the old
launcher has exited, a human can close exactly that epoch (use its numeric ID):

    sas watch-close ROLE --epoch N --workspace TEAM --as HUMAN

This preserves worker progress. Start a fresh enrollment explicitly after
reconciling. A stale same-boot launch lock follows ordinary `launch-unlock`
recovery. Do not end a live session or replay an uncertain queue command to
clear a lock. A process killed outright cannot send an alert; its open epoch
and pending intent remain visible in `watch-status`.

After explicit reconciliation, eligible mail still awaiting acknowledgement can
wake the new enrollment again. A stopped epoch leaves unconsumed notifications
available from the worker’s last committed cursor.

## Scored wake delivery

`workspace settings` reports the wake policy. Existing databases use `legacy`
mode and `normal` speed. A human can select `--wake-mode scored` and
`--speed slow|normal|fast` with `workspace set`. The optional `--wake-roles`
JSON object replaces the per-role overrides. For example,
`--wake-roles '{"builder":{"threshold":12,"urgent_seconds":90,"reply_seconds":240}}'`
sets three base values. Omitted values use the normal defaults before the
workspace speed multiplier. Use the empty object to clear all overrides.

`send --urgency N` accepts decimal integers from 0 to 10. Agents add a short
`--reason TEXT` for scores 6 to 10. `--needs-reply` keeps its independent
reply obligation. `--urgent` means 5 and agrees only with an explicit 5.
`--now` remains immediate. The legacy waiter still uses the legacy mail flags.
`workspace wake-audit --as HUMAN` lists recent high scores with their reasons
and counts of repeated immediate overrides by sender.

In scored mode, a role wakes at its total or earliest age limit. Immediate
signals are first in the digest. A raw `wait` previews the result. Use `wake`
to advance scored progress, including continuation pages. The launcher's
`wake --pending` and direct `wake` both save their receipt after successful output.
Scripts using `wait --json` can handle the page and then call
`progress save --cursor N --expect VERSION --scored-receipt JSON`. Pass the
result's `cursor` as `N` and the compact JSON value of its `scored` field as
`JSON`. Capture the progress version before waiting. The receipt preserves
delivered events beyond the cursor and allows the next page to return immediately.
For a legacy idle result, pass the top-level `idle` value as
`--idle-receipt JSON` instead. If `wait` used `--stop-file`, pass the same
path to `progress save` when saving either kind of receipt.

In either mode, unchanged idle work repeats after the idle interval, then doubles
the delay up to one day. Task changes and the role’s own work reset the delay.
Checkpoint and WIP bookkeeping leave it intact. A wake with only unchanged idle
work prints `nothing new: re-arm only`. Direct and launcher wakes save this state
with the notification receipt. Scored launch and re-arm commands use the profile’s
idle interval. An explicit `--idle-minutes` applies to the current invocation.

For a scored or idle JSON `wake`, use the exit status and `progress show` to verify the
receipt. An omitted page remains available on re-arm. A delivered message
stays in inbox until acknowledged. The progress audit records the wake
reason, score and speed without copying message text.

Giving `wait` or `wake` either explicit settle option selects legacy batching
for that invocation. Explicit idle and timeout bounds still apply. Use
`--idle-minutes 0` to disable idle wakes. The scored supervisor uses the
profile's minimum ping interval, keeps the existing response deadline, and
can request a fresh checkpoint on a normal ping for active work with writes
since its saved checkpoint. These settings do not enroll, launch, or
replace a provider session.

See the [approved rules and profiles](wake-urgency.md). To reuse a metadata
replay, pipe a JSON object with `start`, `end`, `paused` and `trace` to
`node scripts/replay-wake-policy.mjs` after building. Each trace row contains
its ISO time, event kind and stable ID, followed by an optional numeric
weight. The approved design replay's `start`, `end`, `paused` and `trace`
variables can be exported directly. Compare the estimated counts with
`scored_score` in successful notification-progress events from the trial.
