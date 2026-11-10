# Command reference

Both `sas` and `sassato` invoke the same CLI. Global flags may appear anywhere:
`--db PATH`, `--workspace NAME`, `--as ROLE`, `--json`, `--help`. Environment alternatives
are SASSATO_DB, SASSATO_WORKSPACE and SASSATO_ROLE. An explicitly supplied flag wins.
Workspace attachment allows the same workspace from multiple repositories/worktrees.
No write command silently guesses a role.

Strings containing spaces must be quoted. A value beginning with `--` can use the
`--option=VALUE` form; use `--` before positional text beginning with a dash.
IDs are returned by creation commands and are stable. Examples below use T1/H1/M1.

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
Use `none` to clear the default human or stop file. `role set NAME --kind human` adds a
human; only an existing human can create/promote roles. Agent model/permission settings
inherit provider defaults unless explicitly configured.

## Tasks, ownership and reviews

| Command | Behavior |
| --- | --- |
| `add TITLE [--body TEXT] [--owner ROLE] [--for ROLE] [--priority 0..100] [--human-only] [--review-required]` | Create one task; higher priority first |
| `tasks [--status all\|open,doing,...] [--owner ROLE] [--for ROLE] [--available] [--limit N] [--after T1]` | Default live tasks, 50 per page (maximum 1000); --after follows priority/ID order; JSON includes items/has_more/next_after |
| `show T1 [--limit N] [--before-event NUMBER]` | Body, blockers, dependencies, questions and latest 100 audit events by default |
| `take T1 [--hours 4]` | Atomically claim eligible open work; lease 1–168 hours |
| `renew T1 [--hours 4]` | Renew owned lease, including stale lease |
| `note T1 TEXT` | Append a note to owned work; can annotate closed work |
| `update T1 --expect VERSION [--title TEXT] [--body TEXT] [--priority N] [--for ROLE\|none]` | Reject stale client versions |
| `handoff T1 ROLE SUMMARY` | Transfer ownership/target with notification; recipient explicitly claims |
| `release T1 REASON` | Remove ownership/lease, keep routing target; clear --for separately if needed |
| `submit T1 SUMMARY` | Doing → review; summary should include refs/tests/handoff details |
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
sas blockers                         # explicit and derived open blockers
sas blockers --task T1
sas blockers --chain T1               # root causes across dependencies
sas resolve B1 'Endpoint confirmed'
sas ask-human T1 'Choose host' --for alice --options 'local|hosted' --recommend 2
sas ask-human T1 'Approve manual operation?' --for alice --command 'exact command text'
sas humans --for alice               # omit --for for the shared human queue
sas answer H1 2 --as alice
sas answer T1 'Free-text decision' --as alice
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
| `send ROLE[,ROLE]\|all TEXT [--re T1] [--urgent]` | Append message, snapshot recipients, optional task link |
| `inbox [--peek] [--state unread\|read\|done] [--limit N]` | Unread first; marks only returned unread messages read unless --peek |
| `sent [--limit N]` (alias `outbox`) | Sent messages with unread/read/acked status per recipient; JSON retains receipt timestamps |
| `ack M1` | Recipient marks message done, preserving read/done timestamps |
| `fact set KEY TEXT --source LOCATION [--checked-at ISO_DATE] [--expect VERSION]` | Create/correct shared fact; updates require expected version |
| `fact get KEY` / `fact history KEY` | Current fact or immutable revisions |
| `facts [--limit N]` | List facts |
| `wip [show ROLE]` | Read any role's WIP, default current role |
| `wip set [--current TEXT] [--next TEXT] [--notes TEXT] [--expect VERSION]` | Only current role's notes; updates require expected version |

Mail read/done is per recipient. Reading another role's WIP never changes it. Facts need
a source and checked date (default now); they never confer permission. Empty quoted WIP
fields clear that field. Fact keys may contain path-like components.

## Sessions and context

`checkpoint save --current TEXT --next TEXT --notes TEXT [--expect WIP_VERSION] [--evidence FILE]`
atomically updates your WIP and saves a recovery record. All text fields are required;
read WIP first and supply its version for updates. `checkpoint show [ROLE]` reads the
latest record and its freshness (`null` if absent).

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
- `wait --as b [--since EVENT_CURSOR] [--timeout SECONDS] [--stop-file PATH]` waits for unacknowledged urgent mail, workflow changes relevant to b, or a stop request, prints one line and exits 0. Stop takes precedence; timeout exits 5. It never consumes receipts or spawns a provider. Default timeout 0 waits indefinitely.
- `import ... --repair --dry-run` previews conservative corrections to existing imports; use the same options and `--confirm DIGEST` to apply. Agent-edited tasks and WIP are preserved; untouched imported WIP can be refreshed from a newer dated entry.

Version 0.1.2 imports the newest dated WIP entry per role (ordinary or stopped), supports
previewed repair of untouched imported WIP, and shows source age in context.
WIP older than 24 hours has `stale=true`; new imports retain the source timestamp.

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
otherwise it preserves the legacy behavior of starting at the latest event at
invocation. Explicit `--since` always overrides progress. When progress is absent, retain the initial context `cursor`, inspect the full inbox
and relevant records (including truncated items), and reconcile pending work before
initializing that captured cursor with `--expect 0`. Do not use `snapshot_cursor`
or a later context cursor; leave progress absent if handling is incomplete.
After safely handling each result, save that result's cursor, then re-arm the waiter.
Timeout cursors can also be saved. If handling fails or the session crashes, leave
progress unchanged so recovery replays the event. Never substitute a newer context
`snapshot_cursor` for the last safely handled waiter cursor. Existing unacknowledged urgent
mail and STOP still return independently of progress. See [notification recovery](context-management.md#durable-notification-progress).

Urgent messages continue to wake the waiter after reading until `ack M1` records
handling. Wait output includes up to 2,000 characters and an identity-qualified inbox
command when truncated. Without `--since` or saved notification progress, `wait`
fails with an input error instead of silently skipping events. STOP still takes precedence.
