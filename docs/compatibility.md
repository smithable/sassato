# Compatibility with earlier local versions

Existing databases keep their stored role names, providers, directories, tasks and history.
Repeating init does not replace their configuration. No schema migration is required for
configurable human roles or workspace settings.

Older databases without explicit workspace settings retain their original bootstrap human
as the default recipient. Stored import time zones are retained; without an explicit setting,
imports now use UTC. Set the historical time zone before re-importing older local dates.
There is no implicit external
stop-file path; an explicitly configured `stop_file` is retained.
Inspect these with `workspace settings`; change them with human-only `workspace set`.
New workspaces use generic roles, UTC imports and no external stop file by default.

The personal-name commands `ask-johan` and `johan` have been removed. Update scripts to
use `ask-human` and `humans`, with `--for NAME` when a particular human is intended.
Programmatic callers use `askHuman` and `humanQueue`; the old named exports are removed.
Markdown exports now use only `humans.md` for the human queue. Existing human role names,
questions, answers and audit records remain unchanged.

For an existing Smithable workspace, inspect `workspace settings` and explicitly retain
`default_human: "johan"` if that is the intended recipient. No role rename or named
compatibility logic is needed. An authorized human can run:

```sh
sassato workspace set --default-human johan --import-timezone Europe/Mariehamn --workspace smithable --as johan
sassato workspace set --import-answer-markers '["Johan answered", "Johan’s answers", "Johan:"]' --workspace smithable --as johan
```

If historical documents use `human assistant` / `human assistance` for `hassist` or
`Mariehamn` for `Europe/Mariehamn`, configure those aliases explicitly, as shown in the
example below. Alias targets must already be configured roles.

Add any other historical answer prefixes that the source documents use; see the
[Smithable example configuration](../examples/smithable.config.json). Repeating `init`
does not apply settings to an existing workspace. Preview an import again after changing
its markers, and use `import --repair` only after reviewing the proposed metadata repair.
An answer already stored in Sassato does not need re-importing.

Scripts that create a new workspace and relied on the former built-in roster should
supply an explicit config. The new defaults are builder, reviewer and human; no existing
workspace is renamed. Model settings are inherited rather than pinned to a previous team.

Markdown import recognizes configured role names. Generic `Answer:`, `Answered` and
`Decision:` labels work by default; person-specific answer headings require explicit
`import_answer_markers` rather than being inferred from role names.
Historical role-label and time-zone spellings require explicit `import_role_aliases`
and `import_timezone_aliases` maps; there are no built-in project aliases. These settings
affect future imports only, without renaming stored roles or rewriting timestamps. Preview all imports; raw source and previous answers are preserved, and ambiguous
items remain marked for reconciliation rather than silently treated as current work.

## Review and recovery update

Review approvals and rejections now require `--expect VERSION`. Update scripts to
read the task and pass the version they inspected; missing versions are input errors,
and stale versions are conflicts. On a conflict, review the new state rather than
blindly retrying with its version. Completion references remain unverified metadata.

Database schema 5 adds cancelled human questions and cancellation metadata. Run
`sassato migrate --db PATH` with the new CLI before using read-only commands on an
older database; normal writes also migrate automatically. The upgrade is atomic.
Older CLIs refuse the newer schema. Keep a database backup before upgrading if you
need the option to return to the old CLI.

Pending questions on already closed tasks are cancelled during migration; answered
questions and original audit history are preserved. Reopening a task requires a new
question when a decision is still needed. Nothing is answered on the human's behalf.

New recovery checkpoints use format 3. Format-2 records retain their existing
freshness checks and remain readable, with `missing_evidence` explaining that they
have no structured recovery metadata. Format-1 records from pre-release builds and
unknown formats retain readable
historical text but report `unsupported`; review current state and save a new
checkpoint. Ordinary WIP remains intact. Neither checkpoint evidence nor notification
progress requires another database schema migration or rewrites historical events.

Existing checkpoint commands still work without `--evidence`; missing agent reports
are explicit, not interpreted as successful validation or no running jobs. Older
CLIs that only understand format 2 may show format-3 records as unsupported; their
WIP text is still readable. Use the new CLI to inspect the complete record.

Wait's explicit `--since` behavior is unchanged. Without it, a role with saved
notification progress now resumes there; a role without progress still starts at
the latest event. Updated worker instructions first reconcile full inbox and work
records, including truncated context items, then initialize absent progress from
the initial context `cursor`. They preserve existing progress and never jump to
`snapshot_cursor` or a later context cursor. Incomplete handling leaves progress
absent. Progress versions are separate from WIP versions, and
progress does not consume inbox receipts. An older CLI does not use these progress
records automatically, so supply the recorded cursor explicitly when mixing versions.

## Coordination review update

Schema 6 removes housekeeping copies from the search index while retaining the full
append-only event history. Back up before upgrading, then run `sassato migrate`
with the selected database before using read-only commands. Older CLIs cannot read
this schema; deploy the upgraded CLI to all workers that share the database.

Previously stored timezone aliases recognized by Intl (such as `est`, `cet`, and
`gmt`) are ignored on read, preserving their standard meaning and allowing unrelated
settings updates. Original settings remain in history. New writes reject such aliases;
use a nonstandard label such as `local time` for a custom historical timezone.

A first `wait` now requires an explicit `--since` cursor or saved notification
progress. Keep the cursor captured before reading/handling current work, as described
in [context management](context-management.md). Reading urgent mail does not clear
its wake-up; acknowledge it after handling to avoid repeated delivery.
