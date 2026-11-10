# Changelog

## 0.1.2 — unreleased

Review and recovery fixes:

- Checkpoints capture bounded repository/task evidence and optional validation,
  artifact and job reports, separating observations from agent claims.
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

- Recovery checkpoints atomically update WIP, preserve historical snapshots and
  expose freshness without changing provider sessions.

- Generic builder/reviewer/human defaults with inherited provider settings.
- Configurable human roles, default decision recipient, directories, import time zone
  and optional external stop file; configuration paths resolve from the config file.
- Interactive terminal setup and noninteractive JSON/config initialization.
- Named human questions and filtered queues; legacy command/database compatibility.
- Durable tasks, review gates, dependencies, decisions, mail receipts, facts and WIP.
- Cooperative and verified force stop, optional process launcher, and work notifications.
- Previewed Markdown imports and conservative repair, backups, exports and build identity.
- Tests and package smoke checks on Node 24 and 26; MIT license. No npm publication yet.
