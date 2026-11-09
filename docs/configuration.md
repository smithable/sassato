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

`stop_file` is an optional file signal, relative to the config file. New workspaces do
not watch a machine-wide file by default. Durable `stop` requests work without this field.
The launch/wait `--stop-file` option overrides the workspace setting for that command.

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
