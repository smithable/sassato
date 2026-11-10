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

## Freshness and recovery

```sh
sassato context --brief
sassato checkpoint show
sassato checkpoint show reviewer
```

The bounded context includes a checkpoint reference and its freshness state when
one exists. Unsupported older checkpoint formats require a fresh save; their
recovery text remains available. Read the full record with `checkpoint show`;
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
Sassato cannot see unsaved reasoning, changed files, provider context usage or live
tool jobs through these commands. The agent must assess those explicitly.

After a reset, read current context and the checkpoint, inspect full task/decision
records, check inbox and verify working files and test results. A stale checkpoint
can still be useful historical context; reconcile it before saving a new one. Read
current STOP status before continuing, even if the saved next action says to work.

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
