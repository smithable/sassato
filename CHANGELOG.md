# Changelog

## 0.1.2 — unreleased

Feedback fixes and stop controls:

- Removed personal-name commands and import rules; configured humans and literal
  import answer markers replace them. Existing stored role names remain unchanged.
- `stop --all` can wait for configured held locks and busy commands; errors and
  timeouts remain unknown. `stop-status --quiet` exposes active stop intent to scripts.
- Launcher checkpoint/progress commands include workspace and role identity;
  first notification progress starts from reconciled bounded context rather than zero.
- Closed/reopened tasks supersede older review results. Repository evidence requires
  a configured directory and suppresses clean/process filters. Historical evidence
  remains readable; missing evidence files report input errors.
- Maintainer provider reports remain in source rather than the npm package.

Review and recovery fixes:

- Recovery checkpoints atomically update WIP, preserve historical snapshots and
  expose freshness. They capture bounded repository/task evidence and optional
  validation, artifact and job reports, separating observations from agent claims.
- Durable notification progress resumes waiters after restart; advancing it requires
  an explicit version-checked save after handling a notification. Waiters remain read-only.
- Older format-2 checkpoints remain readable with missing-evidence notices; new
  recovery records use format 3 without another database schema migration.

- Reviews now require `--expect VERSION`; stale approval and rejection fail atomically.
- Review submissions and results wake eligible waiting roles, preserving event cursors.
- Dropped tasks cancel pending questions with retained history; reopening requires new
  questions. Database upgrades preserve existing records and are transactional.
- Checkpoint freshness covers targeted task dependencies, avoids workspace-wide fact
  invalidation, and is visible in brief context. Old checkpoint formats need refreshing.
- Milestone checkpoints and recovery guidance preserve work across session changes.
  Native auto-compaction remains the default; Sassato does not execute transitions.

First public source release preparation:

- Generic builder/reviewer/human defaults with inherited provider settings.
- Configurable human roles, default decision recipient, directories, import time zone
  and optional external stop file; configuration paths resolve from the config file.
- Interactive terminal setup and noninteractive JSON/config initialization.
- Named human questions and filtered queues; legacy command/database compatibility.
- Durable tasks, review gates, dependencies, decisions, mail receipts, facts and WIP.
- Cooperative and verified force stop, optional process launcher, and work notifications.
- Previewed Markdown imports and conservative repair, backups, exports and build identity.
- Tests and package smoke checks on Node 24 and 26; MIT license. No npm publication yet.
