# Context checkpoints and recovery

Sassato stores work state so an agent can recover after compaction, a fresh session
or a provider change. Keep native automatic compaction enabled. Checkpoint commands
save and inspect recovery state; they do not compact, clear, terminate or launch a
provider, and saved text never grants permission.

## Save meaningful progress

Save a complete checkpoint after meaningful progress, important decisions and
significant test results, and before a handoff or planned session transition.
First update task status, read relevant inbox messages and decisions, and inspect
the working files. Record discoveries before they exist only in conversation history.
Keep stable project rules in `CLAUDE.md` or `AGENTS.md`; keep changing work state in
Sassato. Do not copy whole transcripts into either place.

Read `sassato wip` to get your current WIP version. Then save a complete recovery
checkpoint (replace `3` with that version; omit `--expect` or use `0` for first WIP):

```sh
sassato checkpoint save --expect 3 \
  --current 'T42: parser implemented in src/parser.ts; task marked done' \
  --next 'Read the billing task requirements before claiming it' \
  --notes 'Preserve the parser API. Rejected regex-only parsing. Parser tests pass. No running jobs or unresolved parser questions.'
```

All three text fields are required and nonempty, up to 10,000 characters each.
`current` records the objective, progress and relevant paths; `next` records the
exact next action; `notes` records user constraints, discoveries, rejected
approaches, changed files, validation commands and results, remaining questions
and any running jobs. Say explicitly when none remain. Record durable human
decisions in their normal task/decision records as well. Store secret locations,
never secret values.

Saving a checkpoint updates your own WIP and appends a recovery record in one
transaction. It does not complete tasks, acknowledge mail or STOP, commit files,
or claim that jobs have finished. Existing WIP version checks prevent stale writes.
The WIP row is the current state; the checkpoint is an immutable snapshot of it,
not a second editable copy. Ordinary `wip set` remains supported and makes the old
checkpoint stale. Use `checkpoint save` in place of a WIP update when preserving
recovery state; there is no need to write both. Do not checkpoint after every
command or poll merely to refresh timestamps.

## Structured recovery evidence

Every new checkpoint captures `evidence.observed`:

- Repository directory, worktree root, Git directory/common directory, branch, HEAD,
  dirty status and observation time, where Git is available. The directory is the
  role's configured `working_dir`, or the caller's directory when none is configured.
- Up to 100 active owned or targeted task IDs, versions, statuses and routing fields,
  with total count and a truncation flag. Active here includes open, doing, blocked
  and review work; closed tasks are excluded from this evidence list.
- A snapshot of the role's durable notification progress, or `null` if none exists.

Git probes are read-only, bounded and run before the database transaction. Missing
Git, a non-repository directory or probe failure is reported as unavailable evidence;
it does not prevent saving the recovery text. Task/progress observations are captured
with the WIP update. Repository observations are not an atomic file snapshot: another
process can change the worktree during or after capture. Dirty worktrees are allowed.
Sassato never commits, stashes, resets or cleans files to prepare a checkpoint.

Add agent-written claims with `--evidence FILE`, using the
[JSON example](../examples/recovery-evidence.example.json) as a starting point:

```sh
sassato checkpoint save --expect 4 --evidence ./recovery-evidence.json \
  --current 'Parser ready; integration validation pending' \
  --next 'Settle the test server, then run integration checks' \
  --notes 'Preserve the public parser API; see the task for accepted constraints'
```

The file must be a JSON object with `version: 1` and all three arrays below. Use an
empty array only when the agent has checked that there are no entries to report.
Unknown fields are rejected. Text fields are nonempty and pass the normal secret
guard; reference logs and artifacts by location instead of embedding their contents.

| Field | Shape and limits |
| --- | --- |
| `validation` | Up to 20 `{command, result}` entries; command up to 1,000 characters, result up to 2,000 |
| `artifacts` | Up to 20 reference strings, each up to 1,000 characters |
| `jobs` | Up to 20 objects with unique `id` (100 characters), `description` (1,000), `state`, `disposition` and optional `reference` (1,000) |
| Job `state` | `running`, `completed`, `failed`, `stopped` or `unknown` |
| Job `disposition` | `finish`, `stop` or `adopt`: the intended handling of the job |

Input evidence is capped at 32,768 bytes, and the whole checkpoint event at 96,000
bytes. Oversized or invalid evidence leaves WIP and checkpoint history unchanged.
The reported fields are stored under `evidence.reported`, separately from observations.
Sassato does not run validation commands, verify their stated results, open artifact
references, inspect job processes or perform job adoption. In particular, recording
`adopt` does not give a replacement session control over a job or permission to use it.

Without `--evidence`, the reported part is `null`. `missing_evidence` explains absent
reports, unavailable repository observations or truncated task evidence. Missing
reports do not mean tests passed or no jobs remain. A checkpoint can be current by
its tracked durable inputs and still need these gaps reconciled before recovery.

## Freshness and recovery

```sh
sassato context --brief
sassato checkpoint show
sassato checkpoint show reviewer
```

The bounded context includes a checkpoint reference and its freshness state when
one exists. New records use format 3; format-2 records remain readable with notices
for missing structured evidence. Unsupported older formats require a fresh save;
their recovery text remains available. Read the full record with `checkpoint show`;
it returns `null` if none exists. Recovery records
are role-owned and workspace-scoped; other roles can read them, just like WIP.
They survive provider changes and new session IDs. Audit events retain older records.

A checkpoint is stale after 24 hours, or when its saved inputs change: WIP version;
owned or targeted task versions; relevant blockers, questions and dependencies;
pending mail receipts; workspace settings/attachments; or the role's configuration.
Unrelated roles' tasks, shared fact edits and session heartbeats do not invalidate
it. Sassato does not track which facts a role relied on; read relevant facts during
recovery rather than treating checkpoint freshness as fact validation.
This is a conservative freshness check, not proof that the summary is complete.
Checkpoint reads do not rerun Git or inspect working files. The saved repository
metadata is historical, and freshness does not prove files are unchanged. Sassato
cannot see unsaved reasoning, provider context usage or live tool-job state through
these commands. The agent must assess those explicitly.

After a reset, read current context and the checkpoint, inspect full task/decision
records, check inbox and verify working files and test results. A stale checkpoint
can still be useful historical context; reconcile it before saving a new one. Read
current STOP status before continuing, even if the saved next action says to work.

## Durable notification progress

Notification progress is separate from WIP and checkpoint freshness. It records the
last waiter/event cursor safely handled by the role, so a replacement session can
replay unhandled events. Progress writes never acknowledge mail receipts or STOP,
claim tasks, or execute work. The waiter itself remains read-only and never advances
progress just because it returned an event.

```sh
sassato progress show
# If absent, start from zero to replay safely:
sassato progress save --cursor 0 --expect 0
sassato wait --timeout 60
# After safely handling the returned event, or a normal timeout:
sassato progress save --cursor RETURNED_CURSOR --expect PROGRESS_VERSION
```

Replace the placeholders with the result's cursor and the version from `progress show`.
The first save requires `--expect 0`; later writes require the current progress
version. This is not the WIP version. Identical retries with the same cursor and
original expected version return the existing record without another event. A
conflicting stale write fails; inspect it before retrying, since another session
may have advanced the role's progress. Cursors cannot move backward or past the
workspace's latest event.

Only advance after safely handling the returned notification and all its relevant
items. If handling fails, remains incomplete or the session crashes, leave progress
unchanged. Recovery can then replay it; handlers should tolerate repeated delivery.
Timeout results have scanned the intervening events and may also be saved. Use the
waiter's returned cursor, never a newer context `snapshot_cursor`: an event could
have arrived while the previous one was being handled.

On restart, `wait` without `--since` reads independent latest progress. Without a
saved record it retains the legacy latest-at-invocation default, so the updated
worker instructions initialize absent progress to 0 for conservative recovery.
Explicit `--since` overrides the saved value and permits deliberate replay without
rewinding durable progress. Malformed or unsupported saved progress fails clearly;
inspect its audit event and use an explicit earlier cursor for safe replay.

`progress show ROLE` is shared-readable, while saves always belong to the current
role. Bounded context exposes the current progress reference, cursor and version.
A checkpoint's progress copy is historical evidence; do not restore it over a newer
independent record. Urgent unread mail and STOP still return regardless of the
saved cursor. STOP takes precedence and prohibits restarting a waiter until resumed.

## Provider behavior and notification recovery

Native automatic compaction is the default. Compaction retains a summary; a fresh
conversation relies more heavily on the saved checkpoint and project instructions.
The Claude example's “Compact instructions” section describes what to preserve;
it does not request human intervention for routine context maintenance.

The optional Claude SessionStart hook reloads bounded Sassato context after
startup, resume, clear or compaction. It does not save a pre-reset checkpoint.
Codex workers explicitly read current context and the checkpoint at startup,
resume and after compaction. Existing project instructions, permissions and
provider settings continue to apply.

Record tools, background jobs and notification waiters that still exist. Before a
planned transition, settle them through supported controls and retain the last
safely handled waiter/event cursor. After recovery, follow the normal single-waiter
workflow only when STOP is absent. Retain the returned cursor on timeout as well;
do not jump to the latest event and lose notifications that arrived between waits.
See [integrations](integrations.md) for provider-specific notification setup.

Checkpoint commands do not implement automatic session transitions or control an
independently opened provider terminal. Do not terminate your own session for
routine context maintenance, inject terminal keystrokes, or rewrite provider
transcripts. `session end` records an exit; it does not stop a process. Never mark
a live provider session ended to bypass launch checks. The existing human-only
`launch --fresh` does not replace a live session. No supervisor or extra watcher is
installed by checkpoint saving or recovery.

See [provider capabilities](provider-capabilities.md) for the compatibility evidence
and limits of future managed-session work. No supervisor command is implemented here.
The [managed recovery validation guide](managed-recovery-validation.md) documents
the opt-in actual-state probe and the remaining lifecycle release gates.
