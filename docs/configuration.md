# Workspace configuration

Copy `examples/team.config.json` into your project as `sassato.config.json`. Edit it
before initialization; the example directories are `.` so the copied file works from
its own directory without machine-specific paths.

```json
{
  "workspace": "my-project",
  "working_dir": ".",
  "default_human": "alice",
  "import_timezone": "UTC",
  "roles": [
    { "name": "builder", "kind": "agent", "provider": "claude", "working_dir": "." },
    { "name": "reviewer", "kind": "agent", "provider": "codex", "working_dir": "." },
    { "name": "alice", "kind": "human" },
    { "name": "bob", "kind": "human" }
  ]
}
```

```sh
sassato init --config ./sassato.config.json --dry-run
sassato init --config ./sassato.config.json
```

`--workspace` overrides the file's workspace name. `--humans` is an alternative to a
config file, not an override for its role list. A config is read and validated before a
database is created or any worker is launched. Unknown top-level fields are rejected.

## Paths

`working_dir` at the top level supplies the default for agent roles. A role's own
`working_dir` overrides it. Set different directories for separate repositories or
worktrees. Each directory must already exist. Explicit human role directories are
accepted too, but humans are never launched as providers.

Relative paths resolve from the directory containing the config file. `~/` expands to
the current user's home directory. Absolute paths retain their meaning. Stored working
directories are canonical absolute paths; moving the project requires updating them.
A config with no role directory or shared directory leaves that role unconfigured for
launch. The built-in builder/reviewer defaults use the current project directory.

Initialization does not attach a directory automatically. Attach the appropriate project
roots explicitly with `workspace attach PATH --workspace NAME --as HUMAN`.

## Roles and settings

Role names use lowercase letters, digits, underscores or hyphens and start with a letter.
At least one role must have `kind: "human"`. Agents cannot create/promote human roles.
Agent fields include `provider`, `model`, `reasoning_effort`, `permission_mode`,
`sandbox_mode` and `approval_policy`; omitted settings inherit provider defaults.
Do not copy a permission mode unless you intend to grant it.

`default_human` chooses where untargeted human work and questions go. Omit it or set it
to null to require a choice when multiple humans are available. A person's name has no
special priority. Any human may answer a question, regardless of its recipient.

`import_timezone` is an IANA time zone used for dates without an explicit zone in legacy
Markdown imports. New workspaces default to UTC. Explicit UTC, numeric offsets and IANA
zones in source headers take precedence.

`import_answer_markers` adds up to 32 literal answer-heading prefixes, each at most
200 characters. It defaults to `[]`; generic `Answer:`, `Answered` and `Decision:`
labels still work. Matching ignores case and Markdown emphasis, and requires a word
boundary after a marker that ends in a letter or digit. Markers are not regular
expressions, and a human role name alone does not create an answer rule.

For example, `"import_answer_markers": ["Alice answered", "Alice's answers", "Alice:"]`
recognizes those headings when followed by a substantive answer on the same line or
the next nonempty line. Empty sections, pending placeholders and dates alone are not
answers. Imported answers remain preserved evidence; they do not mark a task complete.
Configure an existing workspace with:

```sh
sassato workspace set --import-answer-markers '["Alice answered", "Alice:"]' --as alice
```

Use `[]` to clear custom markers. Marker changes can change import interpretation, so
obtain and review a new import preview before confirming it. The
[Smithable example](../examples/smithable.config.json) keeps that team's historical
phrases in configuration.

`stop_file` is an optional file signal, relative to the config file. New workspaces do
not watch a machine-wide file by default. Durable `stop` requests work without this field.
The launch/wait `--stop-file` option overrides the workspace setting for that command.

### Busy checks before an all-role stop completes

`busy_checks` lets `sassato stop --all` wait for external work as well as agent
acknowledgements. The default is an empty list. Only a human can configure checks:

```json
{
  "busy_checks": [
    { "name": "gate", "type": "flock", "path": "/var/lib/project-gate/.gate-lock" },
    { "name": "merge", "type": "flock", "path": "~/repos/.merge-lock" },
    { "name": "jobs", "type": "command", "argv": ["./scripts/jobs-busy"], "cwd": ".", "timeout_ms": 1000 }
  ]
}
```

A `flock` check tests whether an exclusive advisory lock is **held**. A leftover,
unlocked file is idle; a missing file is idle and is never created by the check.
The checker opens existing regular files without writing, requires the POSIX
`flock` utility, and treats unreadable files, symlinks, unsupported systems and
inspection failures as unknown. The producer must use compatible `flock` locking;
this does not detect a process that merely creates a marker file.

A command receives its `argv` directly, without shell evaluation. Exit 0 means busy,
exit 1 means idle, and other exits, signals, spawn errors or timeouts mean unknown.
Output is discarded. Use a short, read-only command that does not start background
work; Sassato terminates timed-out check process groups and rejects checks leaving
children, but cannot supervise children that detach into another process group.
Checks inherit the caller's environment and run only during a human's waiting
all-role stop, never during agent context reads or quiet stop-status checks.

Names must be unique role-style names. There are at most 16 checks, 32 command
arguments of at most 4096 characters each, and a command timeout of 1–10000 ms
(default 1000). Lock probes have a 1000 ms timeout. Checks run concurrently outside
database transactions, and each probe is capped by the stop command's remaining
timeout. Relative paths and a command executable containing `/` resolve from the
config file; `cwd` defaults to that directory. Bare executable names use PATH.

For an existing workspace, use a JSON array (paths resolve from the current folder):

```sh
sassato workspace set --busy-checks '[{"name":"merge","type":"flock","path":"./.merge-lock"}]' --as alice
sassato workspace set --busy-checks '[]' --as alice
```

An unknown or busy check prevents completion and is included in progress and final
output. `--no-wait` and `--force` leave configured checks unverified; they do not
claim machine quiet. Named-role stops do not run workspace-wide busy checks.
Quiet means the selected agents stopped cooperatively and configured checks were
idle at observation time; it is not a machine-wide process inventory or a lock
that prevents unrelated work from starting afterward.
Interrupting a waiting stop with Ctrl-C or SIGTERM cancels and reaps its check
processes, returns exit 4, and leaves durable stop requests active. SIGKILL cannot
run cleanup handlers; read-only checks must not launch detached background jobs.

## Existing workspaces

Repeating init leaves existing roles/settings unchanged. Use explicit human commands:

```sh
sassato role set builder --dir ./worktree --as alice
sassato role set bob --kind human --as alice
sassato workspace settings
sassato workspace set --default-human bob --as alice
sassato workspace set --import-timezone America/New_York --as alice
sassato workspace set --default-human none --stop-file none --as alice
```

Paths supplied directly on commands resolve from the current directory. Workspace settings
are recorded in the existing audit history; this feature needs no schema migration.
Only humans may change them. Change the default recipient and resolve/reassign pending
human work before demoting a human role.
