# Changelog

## 0.1.2 — unreleased

- `wip get` is an alias of `wip show`. A non-number `--expect` names where its version is
  shown (`wip show`, `progress show`, `fact get`, `show ID`).
- `send --needs-reply` (schema 7): mail that asks for a reply or a review wakes each
  recipient's waiter once and stays in its context under `replies`, read or not, until
  acknowledged. Upgrading runs `migrate`; every CLI on the machine needs this version.
- A checkpoint turns stale when its role has made ten changes of its own since it, or
  the first of them is thirty minutes old; context shows `own_changes_since`.
- Priority 90 and above (`--priority now`) is set or lowered only by a human role; context
  task rows show priority and who asked for the task. **Changed default:** an agent that
  set 90 or more before now gets an error.
- `block T2 --on T1` waits on another task (a dependency), such as the human-only task
  that holds a decision.
- An agent role's context lists only its own stale claims.
- Separate production coordination fixes from deferred provider recovery experiments;
  durable-state continuity is covered by ordinary Node tests.
- Require a first waiter cursor, retain urgent wake-ups until acknowledgement, and
  report assigned blockers and dropped dependencies. Sent mail shows receipt state.
- Restore pre-block task state with lease checks; allow targets to edit unowned work;
  record human-answer relay attribution and preview imported-title cleanup.
- Recheck activity after workers stop, allow unregistered roles with unfinished work
  to stop, and give verified providers a short SIGTERM grace before force escalation.
- Keep housekeeping in audit history but out of search (schema 6); tolerate historical
  timezone aliases while preventing new overrides of standard zones.
- Preserve extracted WIP conflict, completion output, date parsing and own-event
  notification fixes without enabling managed provider sessions.


Feedback fixes and stop controls:

- Historical author/timezone aliases are explicit settings; unconfigured imports use
  UTC. Date-only answer lines remain pending.
- Non-waiting stops report role completion independently; waiting stops retry only
  busy or unknown checks. Lock checks document flock and holder-file differences.
- Probe discovery and provider processes share cancellation-safe group cleanup.
- Added project links and npm/GitHub discovery metadata.

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
