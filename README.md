# Sassato

Sassato is a local task and state coordinator for coding agents and humans. Give each
worker a durable role, and it can recover its tasks, decisions, inbox and work in progress
after a session reset or a change of provider.

One SQLite file. No server, daemon, model calls or runtime npm dependencies.
Works with Claude Code, Codex and manually started workers. MIT licensed.

## Install from source

Requires Node.js **24.13 or later**. The test matrix covers Node 24 and 26 on Linux.
The optional process launcher is supported on Linux and WSL; other platforms can start
providers manually. Install provider CLIs separately if you want Sassato to launch them.

```sh
git clone https://github.com/smithable/sassato.git
cd sassato
npm ci
npm run build
npm pack
npm install --global ./sassato-0.1.2.tgz
```

`sas` and `sassato` are the same executable. This release is prepared for source
installation; npm registry publication is a separate step.

## Five-minute example

From your project directory, initialize a workspace:

```sh
sassato init --workspace demo --humans alice
sassato workspace attach . --workspace demo --as alice
export SASSATO_WORKSPACE=demo

sassato add 'Check the welcome page' --for builder --as alice
sassato take T1 --as builder
sassato ask-human T1 'Which greeting?' --options 'Hello|Welcome' --as builder
sassato humans --as alice
sassato answer H1 2 --as alice
sassato note T1 'Changed the greeting and verified it' --as builder
sassato done T1 --as builder
sassato context --as builder --brief
```

Use the IDs printed by the commands; T1 and H1 assume an empty workspace. The default
workers are `builder` (Claude Code) and `reviewer` (Codex), with provider model and
permission settings inherited. Their working directory is the directory where you ran
init. No providers are started automatically.

Bare `sassato init` in a terminal asks for the workspace and human names. Options and
JSON invocations remain noninteractive. Without `--humans` or a config, noninteractive
initialization creates a human role named `human`. You can name humans however you like:

```sh
sassato role set bob --kind human --as alice
sassato ask-human T2 'Ready to release?' --for bob --as builder
sassato humans --for bob
```

## Configure your team and directories

Copy [examples/team.config.json](examples/team.config.json) to `sassato.config.json`
in your project, edit the names and directories, then run:

```sh
sassato init --config ./sassato.config.json
```

The file supplies a workspace name, shared working directory, per-role directories,
human roles, default decision recipient and import time zone. Relative paths resolve
from the config file's directory, so running the command from another directory does
not change where agents work. Absolute paths and `~/` paths are also accepted.

Every workspace needs at least one human. An explicit `--for` selects a decision
recipient; otherwise the configured default, sole human, or calling human is used.
With several humans and no default, agents must select a recipient. Any human in the
workspace can answer a question. See [configuration](docs/configuration.md).

Existing workspaces keep their roles and configuration; repeating init does not replace
them. Compatibility for older commands and databases is documented
[separately](docs/compatibility.md).

## Use it with agents

Give each worker `SASSATO_WORKSPACE` and `SASSATO_ROLE`. Add the relevant instructions
from [AGENTS.md.example](examples/AGENTS.md.example) or
[CLAUDE.md.example](examples/CLAUDE.md.example) to your project instructions.

Workers read `context --brief` at startup and safe checkpoints, inspect full items,
read `inbox`, and keep task state and WIP current. Context never marks messages read.
`ack M1` records that a message was handled. Facts and messages never grant permission.

After meaningful progress, important decisions or significant test results, and
before a handoff or planned session transition, `checkpoint save` records recovery
state and updates WIP. Keep native automatic compaction enabled. After startup,
resume or compaction, read current context and the checkpoint, then verify the
working files. See [context management](docs/context-management.md) for checkpoint
fields, freshness checks, STOP precedence and recovery instructions.

Checkpoints capture repository identity, branch/commit, dirty-worktree status and
current task versions where available. Optional `--evidence FILE` adds the agent's
validation, artifact and job reports. `progress save` records notifications safely
handled by the role, so a restarted waiter resumes without skipping intervening
events. These are recovery foundations; provider transitions remain unimplemented.
See the [provider capability report](https://github.com/smithable/sassato/blob/main/docs/provider-capabilities.md) for tested scope.
The source-only [managed recovery probe](docs/managed-recovery-validation.md)
tests real disposable task, checkpoint, file and notification state across provider
replacement. It does not enable automatic transitions or control existing sessions.
The guide is kept in source; npm readers can use the
[repository documentation](https://github.com/smithable/sassato/tree/main/docs).

```sh
sassato launch builder --as alice --dry-run
sassato launch builder --as alice
sassato stop --as alice
sassato resume-work --as alice
```

Stop is cooperative by default: workers finish or checkpoint the current step, wait for
their tools, save WIP, then acknowledge the exact request shown in context. Resume permits
work again; it does not launch workers. See [integrations](docs/integrations.md) for
launcher, waiter, provider trust prompts and optional hooks.

## Data and limits

The database defaults to `$XDG_DATA_HOME/sassato/sassato.db` or
`~/.local/share/sassato/sassato.db`. Override it with `--db` or `SASSATO_DB`.
Use a native local filesystem for SQLite and its WAL files.

Roles protect against accidental interference, not a hostile process under the same
OS account. State is unencrypted and shared by roles within a workspace. Store secret
locations, never secret values. The secret detector is a heuristic, not a vault.
See [permissions and limits](docs/permissions.md).

## Development

```sh
npm run lint
npm run typecheck
npm test
npm run smoke
```

Smoke tests exercise the packed CLI and offline installation. Tests use temporary
workspaces and fixture provider processes. They do not launch real agents.

[Commands](docs/commands.md) · [Architecture](docs/architecture.md) ·
[Benchmarks](docs/benchmark.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)
