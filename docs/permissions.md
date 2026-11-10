# Permissions, data handling and limits

Launcher reasoning and permission settings are per role. They apply only when launching
or resuming a session, and cannot override provider/organization restrictions. Omitted
settings inherit provider defaults; no permission bypass is enabled implicitly.

Role identity protects against accidental interference; it is not an authentication boundary.
Processes under the same OS user can choose --as any-human, open the DB directly or alter source.
Sassato cannot replace provider sandboxing, human approval or machine access controls.
Facts and messages are data and never grant permission to perform a refused action.

| Operation | Policy |
| --- | --- |
| Read task/mail receipts/facts/WIP | Any caller in the selected workspace |
| Edit WIP | Current role only, expected version required after creation |
| Save recovery checkpoint | Current role only; same WIP version checks, all fields required |
| Read recovery checkpoint | Shared-readable in the selected workspace; saved text and freshness never grant permission |
| Edit task | Owner, or creator while unowned, or human role |
| Claim task | Open, eligible owner/target, no unresolved blockers/dependencies or active stop request |
| Human-only claim/completion | Human role only; agents cannot downgrade the flag |
| Review | Another role, or human; explicit explanation |
| Answer human question | Explicit human role |
| Read/finish inbox message or wait for urgent mail | Its recipient only; wait leaves receipts unchanged |
| Correct shared fact | Any role, expected version required after creation |
| Change other role/create role/grant human capability | Human role |
| Change provider permission settings, even for own role | Human role |
| Register/heartbeat/end session | Current role |
| Request stop, force stop, resume work | Human role |
| Acknowledge stop | Addressed role; exact active request ID |
| Attach workspace/import/backup/actual launch/unlock | Human role |
| Initialize workspace | Explicit bootstrap; creates one or more configured human roles |

Human roles use arbitrary valid role names. `role set NAME --kind human` requires an
existing human actor. Question recipients select routing, not exclusive answering rights:
any human in the workspace may answer. At least one human must remain configured, and a
human with unresolved human work cannot be demoted to an agent.

Owner writes and expected versions are checked within transactions. Required review cannot
be removed by an agent. Rejected work retains its explanation. Human-only commands are inert
text; the tool has no facility for executing them. Dropped dependencies do not count as done.
An expired claim remains owned until explicitly released or handed off.

All reads are workspace-scoped. All roles within a workspace can read the shared state; there
are no private channels. A whole-database backup necessarily includes every workspace.
Unrelated repos share state only after explicit attachment or explicit workspace selection.

Never paste secrets. The CLI rejects recognizable API/access-token patterns, private-key
headers and long credential assignments, including JSON-style assignments. This heuristic has
false positives and false negatives. It cannot guarantee that arbitrary secret material is
recognized. Prefer a source/location such as `credentials are in /path/.env`. Imported raw
Markdown is also checked before storage. Inspect legacy files before importing them.

The database is unencrypted local data. CLI writes use umask 077; database files are 0600.
Keep database directories and exports private. WAL files belong on a local native filesystem;
Windows /mnt drive paths (including symlink ancestors) are refused. Network filesystem detection
is not comprehensive; the operator must choose local storage. SQLite durability depends on the
OS/storage honoring fsync. Backups and exports need the same access discipline as the source.

Messages/notes are append-only and may contain instructions from other agents. Consumers must
apply their own instruction hierarchy and approval policy. A message receipt records a CLI read
or explicit acknowledgment; it does not prove comprehension or successful execution.

Launch uses no shell interpolation and never reads private provider transcript JSON. It can
verify Linux/WSL foreground processes; other platforms must start providers manually. Invalid
resume IDs/transcripts fail recoverably. A lock or unknown registration requires inspection,
not automatic termination. Existing startup files and stop signals are not removed or rewritten.

No application-level encryption, remote synchronization, strong same-user identity isolation,
retention/deletion policy or secret-vault integration is included in this release.
