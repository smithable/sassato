# Recurring and scheduled tasks

Design proposal for review. Implement a durable calendar of work that comes due in a workspace. Give each occurrence an ordinary task with an owner or intended role, its scheduled time, and an outcome that can be found after a restart. A due occurrence conveys exactly the permissions of any other task.

## Where recurring work lives today

| Mechanism | What survives | What the team can lose |
|---|---|---|
| A provider session's periodic check, such as a check every 50 minutes | The check can recur while its session is running. | Its next deadline, missed checks, or even the existence of the timer may be invisible to the replacement session. |
| A daily or weekly instruction in a fact, long-lived task or WIP | The rule and sometimes the last result. | A fresh task for each period, whether it was skipped deliberately, and who picked it up. A note about Monday's run can look like completion of every Monday. |
| CI schedules, such as scheduled tests on the main branch, and host timers for health or maintenance | The external scheduler owns cadence and its run history. | Workspace participants may miss a failure or misremember the cadence. An unchanged commit may cause a scheduled invocation to skip the expensive work. |
| Nightly sample runs, batches of candidate photographs, image generation, enlargement and hardening rounds | Some have scripts, some are parked, and some wait for a previous batch or an operator. | A calendar entry alone cannot distinguish “run nightly” from “review the last batch first” or “paused until resumed”. |

For migration, inventory the actual scheduler, timezone, responsible role, last outcome and any existing pause. A discrepancy between a written cadence and an external timer goes to its owner for reconciliation. Never turn that discrepancy into a second timer. Existing tasks and external schedules continue normally until someone explicitly adopts an entry.

## User-visible model

A **schedule** is a versioned task template plus a time rule. An **occurrence** records one scheduled time or a coalesced range of missed times. The linked ordinary task follows existing claim, blocker, review, human-only, completion and handoff rules. Its history answers “what happened last time?” A held or blocked task remains visible with its blocker.

Proposed CLI sketches (new commands):

```sh
sas schedule add "Weekly hardening review" --for maintainer --weekly mon --at 09:00 --tz Europe/Helsinki
sas schedule add "Review import results" --for maintainer --once 2027-01-15T12:00:00Z
sas schedule list --due
sas schedule show SCHEDULE_ID --history
sas schedule preview SCHEDULE_ID --count 5
sas schedule pause SCHEDULE_ID --expect VERSION --reason "Waiting for the first report"
sas schedule resume SCHEDULE_ID --expect VERSION
sas schedule tick --workspace WORKSPACE
```

Support one-shot instants, daily and weekly local times, and fixed elapsed intervals anchored to a UTC instant. Display local time with the zone and next UTC instant. A 50-minute interval advances from its anchor; finishing a run late does not shift it. Leave arbitrary cron syntax and monthly rules to a later need. Reject invalid times, zones, nonpositive intervals and ambiguous one-shot inputs at entry.

Templates carry title, body, intended role, and existing human-only flag. Record who created or edited them. Use workspace management authority for enabling or changing schedules; agents can propose one through an ordinary task. A role handoff changes one occurrence. Reassigning future work requires an explicit template edit. Editing a paused template leaves it paused. Pausing or archiving preserves all history and already-issued tasks. Resume starts with the next future due time; show the skipped period. A separate, explicit “create now” may issue a one-off task.

## Delivery without a new resident process

Use a short reconciliation operation invoked by the existing supervised launcher or an explicitly configured OS timer. An already-running waiter can call the same operation at the next due time and then consume the ordinary task-assignment event. Expose the last successful tick and overdue schedules so an operator can tell if no caller is running. Read-only context and preview should have no scheduling side effects. If nothing is running, no task starts. On the next tick the workspace catches up from persisted state. Delivery still works in foreground or launcher-owned waiter mode without adding a second watcher. See [current architecture](architecture.md).

Keep three concerns separate in the UI:

- **Due work** creates one ordinary task. A worker decides how to perform it, including whether a shared heavy-job slot is available.
- **Externally scheduled work** records the authority and a pointer to run evidence. An optional task can ask a role to inspect that evidence. Enabling a second execution of the external job is outside the scheduler.
- **Paused or prospective work** is visible with a reason and no active next deadline. Candidate-image searches, image generation and enlargement may be separate stages. A schedule for finding candidates grants no approval to generate, spend, publish or promote them.

## Durability and boundaries

Store schedule identity, workspace, revision, state, cadence, timezone, next due instant and template in SQLite. Persist each occurrence with its intended UTC instant, civil-time label, schedule revision, optional covered range, status and linked task ID. Add a unique key on workspace, schedule and occurrence instant. Use a distinct schedule identifier namespace; session IDs already use S. Back up these rows with the workspace.

Inside a single write transaction re-read the schedule, check its revision/state and applicable role STOP, insert the occurrence, create the task and assignment event through existing task logic, and advance the cursor. A duplicate tick returns the recorded result. A crash before commit changes nothing; after commit the normal saved notification cursor handles delivery. Task completion and review state come from the linked task. Rewinding the clock cannot recreate an occurrence. Never infer success from a wake, claim, elapsed time or cleared blocker.

Default to **one outstanding occurrence per schedule**. If three nightly checks passed while the machine was offline, create one task naming the three due slots and their date range. If a prior task is still open, blocked, doing or in review, record later due times as coalesced against it without sending a new assignment; present that range in history. Do not change an accepted result retroactively. On a race between completion and a tick, use the task state observed in the write transaction. Persist ranges and counts for long gaps instead of inserting an unbounded number of individual missed rows. Completing the task records its actual result; coalesced slots remain identifiable as coalesced. If each missed run has business significance, leave that schedule external until a bounded replay policy has its own design.

While the destination is stopped, leave delivery deferred and do not wake, launch or claim anything. After human resume, reconcile once under the catch-up policy. While a schedule is paused, advance no executable backlog. Schedule edits take effect prospectively from the edit instant; record any superseded unissued range and leave issued tasks attached to their original revision. A scheduler migration starts with an empty calendar; existing work is never silently enrolled.

For daily/weekly rules, resolve a nonexistent spring-forward time to the first valid local instant after the gap; during a repeated fall-back hour choose the first occurrence only. Anchor future dates to the requested civil time independently of either adjustment. Fixed intervals are elapsed time and ignore daylight-saving transitions. Show resolved instants in preview before activation.

## Acceptance scenarios for C

| Scenario | Required observation |
|---|---|
| Two launchers tick simultaneously, including after a transaction timeout | One occurrence, task and assignment event. Restarting either launcher reproduces the same task ID. |
| Machine sleeps across three due times, or a clock jumps backwards | One catch-up task with the due range/count. An earlier time cannot duplicate a recorded slot. |
| Prior task awaits human input, review or the heavy slot | One existing task with its original owner and blocker. History shows later covered slots without repeated wakes. |
| STOP races with a tick, then the operator resumes | Ordering is transactional. No delivery after STOP takes effect; an already-issued task stays recorded. Resume produces at most one catch-up assignment. |
| Pause, edit, resume; two operators edit the same revision | Paused dates remain skipped. A stale update fails. Existing task text, role and historical revision stay intact. |
| Daily local 03:30 crosses both Helsinki daylight transitions; an interval crosses the same dates | Preview and issuance agree: spring gap adjusted, autumn duplicate issued once, next normal day back at 03:30. Interval remains exactly its configured elapsed duration. |
| CI already owns a nightly run; a human-only publishing task comes due | An evidence-review task can link to the CI result without launching CI. Only a human can take the human-only task. |
| Restore database, replay waiter cursor, or tick a different workspace | History and next due survive restore to the backed-up point. Replaying notifications creates no task. One workspace cannot mutate another workspace’s calendar. Restoring an older backup requires reconciling post-backup external actions before repeating them. |

First delivery: calendar CRUD with revision checks, preview/history, deterministic tick and tests with an injected clock. Then integrate the launcher and durable notifications. Trial with one explicitly enabled, low-cost reminder; measure missed deliveries, duplicates and catch-up behavior across a restart before migrating any operational schedule. C owns a later implementation after review of this proposal.
