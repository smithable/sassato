# Changelog

## 0.1.2 — unreleased

Review and recovery fixes:

- Reviews now require `--expect VERSION`; stale approval and rejection fail atomically.
- Review submissions and results wake eligible waiting roles, preserving event cursors.
- Dropped tasks cancel pending questions with retained history; reopening requires new
  questions. Database upgrades preserve existing records and are transactional.
- Checkpoint freshness covers targeted task dependencies, avoids workspace-wide fact
  invalidation, and is visible in brief context. Old checkpoint formats need refreshing.
- Context advice remains optional, requires known reports, and leaves manual resets
  to the human. Native auto-compaction remains the default.

First public source release preparation:

- Recovery checkpoints and advisory continue/compact/fresh recommendations with STOP
  precedence, explicit agent reports, saved-state freshness and provider guidance.

- Generic builder/reviewer/human defaults with inherited provider settings.
- Configurable human roles, default decision recipient, directories, import time zone
  and optional external stop file; configuration paths resolve from the config file.
- Interactive terminal setup and noninteractive JSON/config initialization.
- Named human questions and filtered queues; legacy command/database compatibility.
- Durable tasks, review gates, dependencies, decisions, mail receipts, facts and WIP.
- Cooperative and verified force stop, optional process launcher, and work notifications.
- Previewed Markdown imports and conservative repair, backups, exports and build identity.
- Tests and package smoke checks on Node 24 and 26; MIT license. No npm publication yet.
