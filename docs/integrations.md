# Providers, imports and recovery

Sassato is pull-based. Workers read `context --brief` at startup, task transitions and
safe checkpoints; they inspect `inbox` explicitly. No daemon is installed.

## Configure and launch

Start with [workspace configuration](configuration.md). Set each agent's `working_dir`
to its project or worktree and choose its provider. Models and permission settings are
optional; omitted values inherit provider defaults.

```sh
sassato launch builder --as alice --dry-run
sassato launch builder --as alice
sassato launch reviewer --as alice --fresh
```

Launch planning is read-only. Actual launch requires a human role, a provider executable
on PATH, a valid working directory, and no active stop request. Existing sessions are
verified before resumption; uncertain process identity requires inspection. An expired
lease or stale heartbeat is never proof that a process can be killed.

First-use provider prompts may require a person, including folder trust and sign-in.
Run the provider manually in a new working directory before relying on unattended startup.
Sassato never accepts trust prompts or changes provider approval settings automatically.

Native launch opens one worker in the current terminal. On WSL, Windows Terminal can
open multiple workers, with one window per role:

```sh
sassato launch builder reviewer --new-window --as alice --dry-run
sassato launch builder reviewer --new-window --as alice
```

Windows Terminal must be available and WSL_DISTRO_NAME set (or use `--distro`). The launcher
resolves provider executables, preserves the required PATH and waits for verified startup.
`launch-unlock ROLE` requires a human and removes only demonstrably stale locks.

## Worker instructions and hooks

Review and adapt `examples/AGENTS.md.example` or `examples/CLAUDE.md.example` for your
project. The launcher supplies workspace and role environment variables. Manually started
workers should receive SASSATO_WORKSPACE and SASSATO_ROLE explicitly.

The optional `examples/claude-hook.mjs` registers verified provider processes and prints
bounded context. Merge `examples/claude-settings.example.json` into your own settings only
after editing its script path. Existing settings are never overwritten. No Codex hook
configuration is installed; Codex workers read context and inbox between tasks.

Save recovery state with `checkpoint save` after meaningful progress, important
decisions and significant test results, and before a handoff or planned session
transition. This also updates WIP; no duplicate update or per-command checkpoint is
required. Keep native automatic compaction enabled. After startup, resume or
compaction, read `checkpoint show` and current context, inspect relevant records,
then verify the working files. The hook reloads context but does not save discoveries
before a reset. See [context management](context-management.md) for commands,
freshness limits and recovery steps. Sassato does not execute session transitions.

## Stop and resume work

```sh
sassato stop --as alice
sassato stop builder --timeout 30 --as alice
sassato stop --no-wait --as alice
sassato stop --force --as alice
sassato resume-work --as alice
```

Cooperative stop creates a durable request. Workers start no new work, finish or checkpoint
the current step, wait for their tools/jobs, save WIP and run the exact `stopped R123`
command shown in context. Acknowledgment leaves them stopped until a human resumes them.
A timeout leaves the request active. Resume permits new work; it does not start sessions.

Force stop sends SIGTERM only to verified registered provider PIDs, waits up to one
second, then rechecks identities and stop intent before sending SIGKILL to survivors.
It reports refusals for uncertain identities. It does not guarantee termination of every detached child process. Acknowledgment
and process termination are distinct states.

An optional external `stop_file` can be set in workspace configuration or passed with
`--stop-file`. New workspaces do not assume any machine-wide stop-file location. Sassato
never deletes an external stop signal.

## Notifications

`sassato wait [--since CURSOR] --as ROLE` is a read-only notification command. It returns
for unacknowledged urgent mail, a human answer, assigned/resolved blockers, dropped dependencies, assignments/handoffs, newly
available work, review submissions/results, stop, or timeout. Ordinary mail does not wake it. Reads do not consume
inbox receipts. Without `--since` it uses the role's saved notification progress if
present; without either, it reports an input error. The explicit cursor always wins.
Updated worker instructions initialize absent progress from the initial context
`cursor` only after reading full inbox/records and reconciling pending work, including
truncated items. They retain this bounded cursor through further reads, never use
`snapshot_cursor`, and leave progress absent if handling fails or remains incomplete.

Read `sassato progress show --as ROLE --workspace WORKSPACE` for the progress version. Only after safely handling a result,
save its returned cursor with `sassato progress save --cursor CURSOR --expect VERSION --as ROLE --workspace WORKSPACE`, then
re-arm. Save returned timeout cursors too. Failed or interrupted handling leaves
progress unchanged for replay. Never replace it with the latest context snapshot.
Checkpoint evidence includes a historical progress copy; use the independent latest
record for recovery. See [durable progress](context-management.md#durable-notification-progress).

The Claude launch prompt instructs the worker to keep exactly one provider-native background
tool task waiting. It does not install a daemon or use private messaging APIs. A session
already idle without a waiter needs an initial human nudge. Codex startup assumes no
background wake-up and checks the inbox between tasks. When no actionable work remains, its
default is an ordinary foreground `sassato wait --timeout 60`, using reconciled notification
progress. It handles the result and waits again; it should continue existing work before waiting.

## Import legacy Markdown

Imports preserve original sources and require a human-confirmed preview digest:

```sh
sassato import --backlog ./backlog.md --wip ./wip.md --actions ./decisions --dry-run --as alice
sassato import --backlog ./backlog.md --wip ./wip.md --actions ./decisions --confirm DIGEST --as alice
```

Backlog sections use configured role names, for example `## builder`, followed by numbered
items. WIP accepts dated role headers such as `- 2026-11-09 14:07 (builder): Current work`.
Only the newest recognized entry per role is offered. Explicit zones take precedence;
otherwise the workspace's `import_timezone` applies (UTC for new workspaces).

Action files use `Answer:`, `Decision:`, or headings naming a configured human. Existing
answers stay preserved; unanswered actions become human questions. Resume-hint files can
contain `claude --resume UUID # role builder` or `codex resume UUID # role reviewer`.
These are hints only, never evidence of a currently running process.

The importer recognizes documented formats, not arbitrary natural-language task state.
Ambiguous ownership/status is flagged for reconciliation. Inspect the preview before
confirming. Use the same explicit human role for preview/application when routing would
otherwise depend on the caller.

`--repair --dry-run` offers conservative metadata repairs of untouched imported items.
It preserves IDs, source provenance and later human/agent edits. Apply with the matching
`--repair --confirm DIGEST`; changed source or target state requires a new preview.

## Backup, export and upgrades

```sh
sassato backup ./before-upgrade.db --as alice
sassato export ./workspace-export
sassato doctor
```

Backup includes every workspace. Export writes readable backlog, WIP, human decisions
and per-task history into a new directory. Existing files are never overwritten. Treat
exports and backups as private workspace data.

Install an updated local package, compare `sassato --version` with the intended build,
and run `doctor`. Writable commands apply supported schema migrations; reads do not
mutate schemas. `restore BACKUP --db NEW_FILE` validates and restores into a new file.
Schema v5 adds explicit question cancellation; existing records and audit history are
preserved. See [upgrade compatibility](compatibility.md) before switching CLI versions.

After safely handling urgent mail, run `sassato ack MESSAGE_ID --as ROLE --workspace WORKSPACE`
before rearming the waiter. Reading the inbox alone leaves urgent notifications pending.


## Experimental Codex queue watcher

The default remains foreground `sassato wait`. An optional foreground watcher can queue a
fixed instruction to check Sassato in an **existing registered Codex thread**. It uses the
[documented Codex queue command](https://learn.chatgpt.com/docs/developer-commands?surface=cli),
`codex queue --thread ID --message TEXT --resume --remote ENDPOINT`,
not a second `codex exec resume` writer. App-server is experimental. Queue acceptance is
not proof that a model turn ran or finished; inspect the thread and Sassato inbox.

This is off by default and intended for isolated validation before a supervised rollout.
Native approval behavior, long idle periods, server restart and machine reboot must be checked
for the installed provider version before production use. The watcher never answers an
approval, starts a new thread, or passes model, sandbox or approval overrides. It never reads
provider transcripts or private session databases. The operator owns the app-server lifecycle.

After registering the existing thread and reconciling its notification progress, a human can
configure a local endpoint and explicitly start the watcher:

```sh
sassato workspace set --codex-watch '{"reviewer":{"remote":"unix:///absolute/path/codex.sock"}}' --as human
sassato watch reviewer --as human
# Equivalent, with a dedicated Windows Terminal window under WSL:
sassato launch reviewer --watch --new-window --as human
```

Setting `codex_watch` does not start anything. Ordinary `launch` keeps its existing behavior;
`--watch` selects the foreground watcher. A watcher holds the same exclusive role lock as a
normal launcher, so two cannot own a role at once. An already open launcher must exit before
a separate watcher can acquire that lock; do not remove a live lock. The remote Codex TUI may
attach separately to the same daemon with `codex --remote ENDPOINT resume THREAD_ID`.
No cron job, daemon or restart policy is installed by Sassato.

`watch` uses saved notification progress, or an explicit `--since CURSOR` after reconciliation.
Only the agent saves durable notification progress. Stored mail text and task titles never
become queued prompts. Each queue attempt records the role, reason, event/message ID and exit
code in Sassato's audit log. A warning or ambiguous output stops the watcher visibly; even a
successful queue command only means “queued”. Repeated urgent notifications are retried after
five minutes and then fifteen minutes. If still unhandled fifteen minutes after the third attempt,
that notification is marked exhausted with a visible audit event. Other notifications remain
watched; acknowledging mail removes its retry state. STOP queues one fixed stop instruction and exits (an already acknowledged STOP exits without
waking the stopped worker). Starting again
requires a human to resume work and explicitly restart the watcher; removing a stop file alone
does not rearm an exited watcher.

Use `sassato workspace set --codex-watch '{}' --as human` to disable future watcher starts.
Stop any currently running foreground watcher separately. Recheck the audit log after any
interruption before restarting: a process crash between queue acceptance and recording its
result cannot provide exactly-once delivery.

The configured endpoint must own the registered thread. Attach any interactive TUI to that
same daemon; do not aim a watcher at a thread being driven by a separate standalone TUI.
Sassato's role lock coordinates Sassato launchers, not independently started provider processes.
