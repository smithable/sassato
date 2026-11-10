# Compatibility with earlier local versions

Existing databases keep their stored role names, providers, directories, tasks and history.
Repeating init does not replace their configuration. No schema migration is required for
configurable human roles or workspace settings.

Older databases without explicit workspace settings retain their original bootstrap human
as the default recipient, their original import time zone and external stop-file behavior.
Inspect these with `workspace settings`; change them with human-only `workspace set`.
New workspaces use generic roles, UTC imports and no external stop file by default.

The legacy `ask-johan` command still explicitly addresses that named human. `johan`
remains an alias for the shared human queue. These names are compatibility aliases only;
new instructions use `ask-human` and `humans`. The old export filename is retained in
workspaces that contain its corresponding human, alongside `humans.md`.

Scripts that create a new workspace and relied on the former built-in roster should
supply an explicit config. The new defaults are builder, reviewer and human; no existing
workspace is renamed. Model settings are inherited rather than pinned to a previous team.

Markdown import recognizes configured role names and configured humans in answer headings.
Historical role-label and time-zone spellings remain accepted by a small compatibility
adapter. Preview all imports; raw source and previous answers are preserved, and ambiguous
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

Recovery checkpoints saved with the older fingerprint format remain readable but
report `unsupported`; review the current state and save a new checkpoint. Ordinary
WIP remains intact. Checkpoint saving and reading require no additional destructive
migration; historical checkpoint text is retained even when its freshness format
is unsupported.
