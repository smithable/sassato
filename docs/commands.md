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
| `add TITLE [--body TEXT] [--owner ROLE] [--for ROLE] [--priority 0..100\|now\|normal] [--human-only] [--review-required]` | Create one task; higher priority first. 90 and above (`now`) is set or lowered only by a human role |
| `tasks [--status all\|open,doing,...] [--owner ROLE] [--for ROLE] [--available] [--limit N] [--after T1]` | Default live tasks, 50 per page (maximum 1000); --after follows priority/ID order; JSON includes items/has_more/next_after |
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

`update` also accepts `--human-only`, `--agent-allowed`, `--review-required`, `--no-review`.
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

## Dependencies, blockers and decisions

```sh
sas after T2 T1                       # T2 waits until T1 is done; cycles refused
sas unafter T2 T1
sas block T1 'Need callback endpoint' --kind agent --waits-on b
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

`ask-human` sends the question and notification to the human selected with `--for`.
Without `--for`, it uses the configured default human, the sole human, or the calling
human. Otherwise an agent must choose explicitly. `humans [--for NAME] [--limit N]`
lists pending questions and human tasks. Any human may answer; routing is not a private
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
mail and blockers remain visible regardless of --since. Non-inbox counts are lower bounds.
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

`search TEXT [--type task,message,fact,blocker,question,wip,event,import] [--owner ROLE]
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

`launch ROLE... [--all] [--resume|--fresh] [--dry-run] [--no-prompt]
[--terminal native|windows-terminal] [--new-window] [--distro NAME] [--window NAME] [--stop-file PATH]`.
Actual launch needs an explicit human role, such as --as alice. --new-window selects Windows Terminal and opens one new
window per role; it conflicts with --window and native terminal mode. Native interactive output cannot use --json; dry-run JSON
is supported. Native launch allows one role. Windows Terminal is opt-in and waits for verified provider startup; errors or startup timeout fail the command. `launch-unlock ROLE... --as alice` clears only demonstrably stale
locks. See [provider and hook setup](integrations.md).

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
force. The `now` bit is stored with recipients in the canonical send audit event;
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
marks continuation work in an immediate result. Handle and acknowledge
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
