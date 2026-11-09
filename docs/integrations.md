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

Force stop kills only verified registered provider PIDs and reports refusals for uncertain
identities. It does not guarantee termination of every detached child process. Acknowledgment
and process termination are distinct states.

An optional external `stop_file` can be set in workspace configuration or passed with
`--stop-file`. New workspaces do not assume any machine-wide stop-file location. Sassato
never deletes an external stop signal.

## Notifications

`sassato wait --since CURSOR --as ROLE` is a read-only notification command. It returns
for urgent unread mail, a human answer, resolved blockers, assignments/handoffs, newly
available work, stop, or timeout. Ordinary mail does not wake it. Reads do not consume
inbox receipts. Use the returned cursor when rearming so intervening events are not lost.

The Claude launch prompt instructs the worker to keep exactly one provider-native background
tool task waiting. It does not install a daemon or use private messaging APIs. A session
already idle without a waiter needs an initial human nudge. Codex startup assumes no
background wake-up and checks the inbox between tasks.

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
Current human/configuration changes keep schema v4; existing state is preserved.
