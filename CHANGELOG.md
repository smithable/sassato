# Changelog

## 0.1.3 — unreleased

- **Changed:** a bare `#12` in a text that names several repositories is no longer read as the default
  repository's: it is not looked up, `ask-human` says so, and a wake does not call the task merged.
- **Changed:** `wake` refuses (exit 4) while another waiter for the same role and workspace is still running,
  naming its process. A killed or finished one never blocks.
- `ask-human` makes every other refusal (a task another role holds, bad options, an unknown `--seen`) before it
  looks pull requests up, so those are answered at once.
- `ask-human` looks up the pull requests a task or question names and refuses once when one is merged or closed,
  printing its state and date; it records when the asker repeats with `--seen-pr 12`. A wake's open-work and
  own-work entries say when every pull request a task names is merged. Short names for repositories are a new
  workspace setting (`workspace set --pull-repositories`, with `"#"` for the repository of a bare `#12`); URLs and
  `owner/repo#12` work without it. Needs `gh`
  and skips the check without it. Before, a human could be asked about a pull request merged days earlier.

- `ask-human` refuses once when a pending or recently answered question looks like the new one, prints it with its
  answer, and records when the asker repeats with `--seen H1,H2`; `answer` warns about open human tasks that share
  its words. Before, an answered question could be asked again by someone who had not looked. Database schema 20
  (`sassato migrate`).

- `send all` goes to every agent role and leaves human-kind roles out; a human role is reached only by name.
  Before, an announcement to the agents also landed in the human's mail.

- A signal `job run` passes on to its job is logged and kept as the job's reason (T1367): which signal, when,
  the parent chain `job run` started under and its parent at that moment (pid and program name, never arguments),
  so a job stopped from outside shows its likely caller; the sender itself cannot be read (T1284: a cancelled caller's command took a gate down with it).

- `humans` lists a human's whole queue by default (T1379). It stopped at 50 without saying so, which hid the three
  newest of 53 questions; `--limit N` still cuts, and then says on stderr how many it left out.

- `launch --watched ROLE...|--all` starts watched Codex roles in one command, with no question asked (T1193): a
  settings check on a throwaway thread (model, sandbox, approval, effort) replaces the `/status` look, the app server
  runs hidden with its log in the launch folder, the window is the only tab and is registered, and one background
  process watches every role started. An open window or server is refused with its pid; `--close-stale` closes only
  what an earlier `launch --watched` started. Before, `--watched` only changed the start prompt.

- `stats [--since DATE] [--role R] [--json]` reports waits from what sassato already stores (T1241): how long
  mail stayed unread per role and class, urgent mail not acknowledged within 30 minutes, mail a saved cursor
  passed while it stayed unread, reviews and questions to a human. A saved cursor now also names the mail its
  wake listed (`delivered` in the progress event), so `stats` says whether such mail was listed before it was
  read, or never listed (the T1233 fault); saves from earlier builds show as unknown.

- `launch-watch` no longer ends after five minutes without a receipt (T1191): a queued line waits for the
  window's current turn to end, which can take longer. Past five minutes it alerts the enrolling human once per
  enrollment and keeps waiting on the one queued wake; it ends only when the registered window or the app server
  is gone, saying which.

- `submit T1 SUMMARY --reviewer ROLE` works: the option was allowed for `submit` but never declared
  to the parser, which refused it as unknown. A test now checks every allowed option is declared, and the
  package smoke runs `submit --reviewer` from the packed tarball.
- A launch lock replaced by a dangling link is no longer taken for a released one: the launcher's own
  cleanup reports it (keeping the launch's own error) and `launch-unlock` refuses it for manual inspection;
  both leave the link in place. Only an absent path counts as released.

- `supervise status`, `supervise ping ROLE` and `supervise ack NONCE --generation N`
  separate responsiveness from checkpoints, sessions, waiters and job observations.
  Schema 10 adds generation-fenced writes and an experimental fixture replacement
  protocol. Production providers stay observe-only; unattended management is disabled.

- `wait --idle-minutes N` also wakes a role that holds no doing task but has open tasks of its own
  (its owner's or for it) that it can take now and has written nothing for N minutes: reason `open-work`, naming them
  highest priority and oldest first, so it takes one. A role with no open task is still not woken.
- Unchanged idle work repeats with increasing delays in both wake modes. A wake with only those reminders
  re-arms without a checkpoint. Scored launch and re-arm commands inherit the workspace speed profile.
- `launch-watch` accepts a `--remote` path that is the user’s own symlink to the user’s socket (Codex 0.167
  creates one), when every folder up to the root is the user’s or root’s and not writable by others unless
  sticky, and binds the watch and its
  queue calls to the socket it points at.
- If STOP arrives during `wake` output, the cursor save is refused in legacy mode as well as scored mode.
- `job run --kind KIND -- COMMAND` (schema 8): a heavy job asks before it starts, waits
  while the machine has no room (memory first, then cores, in turn by role), runs, and
  has its peak memory and CPU measured, so the next run of its kind asks for what it used.
  `job list` and `job stats` show the queue and the measurements. See
  [heavy jobs](docs/commands.md#heavy-jobs-on-a-shared-machine).
- `withdraw H1 REASON` withdraws a pending human question its asker no longer needs (a
  reworded one asked again, a decision made elsewhere): the asker, the task's creator or a
  human may; the question is recorded as cancelled with who and why, and its blocker is
  resolved, so the human's queue stops showing it.

## 0.1.2

- A task's creator and target may append a note to work another role holds; edits stay
  with the owner. **Changed:** before, only the owner could.
- `fact set … --answers T1` marks the open human task a fact answers; `humans` shows it.
- `wait --idle-minutes N` wakes a role that holds doing tasks and has written nothing for
  N minutes (reason `own-work`). Off by default.
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
