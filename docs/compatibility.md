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
