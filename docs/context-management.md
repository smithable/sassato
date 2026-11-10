# Context checkpoints and advice

Sassato helps an agent recover after compaction or a fresh session. It stores work
state and offers optional hints about retaining or reducing conversation context.
Recovery is the primary feature; advice is experimental and need not be consulted
at every task boundary. Recommendations are hints for a human, not commands an
agent can execute through Sassato: Sassato does not compact, clear, terminate or launch a provider through
these commands, and advice never grants permission.

## At a task boundary

First update task status, read relevant inbox messages and decisions, and inspect
the working files. Save discoveries before they exist only in conversation history.
Keep stable project rules in `CLAUDE.md` or `AGENTS.md`; keep changing work state in
Sassato. Do not copy whole transcripts into either place.

Read `sassato wip` to get your current WIP version. Then save a complete recovery
checkpoint (replace `3` with that version; omit `--expect` or use `0` for first WIP):

```sh
sassato checkpoint save --expect 3 \
  --current 'T42: parser implemented in src/parser.ts; task marked done' \
  --next 'Review the unrelated billing task; read its requirements before claiming' \
  --notes 'Preserve the parser API. Rejected regex-only parsing. Parser tests pass. No running jobs or unresolved parser questions.'

```

All three text fields are required and nonempty, up to 10,000 characters each.
`current` records the objective, progress and relevant paths; `next` records the
next concrete action; `notes` records user constraints, discoveries, rejected
approaches, test results, remaining questions and any running jobs. Say explicitly
when none remain. Record durable human decisions in their normal task/decision
records as well. Store secret locations, never secret values.

Saving a checkpoint updates your own WIP and appends a recovery record in one
transaction. It does not complete tasks, acknowledge mail or STOP, commit files,
or claim that jobs have finished. Existing WIP version checks prevent stale writes.
The WIP row is the current state; the checkpoint is an immutable snapshot of it,
not a second editable copy. Ordinary `wip set` remains supported and makes the old
checkpoint stale. Use `checkpoint save` in place of a WIP update when preparing
for a handoff or reset; there is no need to write both.

## Optional advice for a human

```sh
sassato context advise --relation same --pressure high --jobs idle --json
sassato context advise --relation related --pressure low --jobs running
sassato context advise --unsaved
```

Keep native automatic compaction as the normal workflow. Ask for advice only when
a manual reset is actually being considered. The benefit of proactive resets is
not established by these rules: relatedness and pressure are reports, not measured
predictions of quality or cost. Unknown inputs mean continue, even for unrelated work.

These inputs describe the agent's assessment **at the time of the request**:

| Input | Meaning |
| --- | --- |
| `--relation same\|related\|unrelated\|unknown` | Whether the next work benefits from the current conversation |
| `--pressure low\|high\|unknown` | Context pressure reported from the provider or agent judgment |
| `--jobs idle\|running\|unknown` | Whether the agent has live tools, background jobs or notification waiters |
| `--unsaved` | New discoveries or constraints have not yet been recorded |

Omitted relation, pressure and jobs default to `unknown`; Sassato never estimates
token usage from task counts, transcript length or elapsed time. Omitted `--unsaved`
means no unsaved discoveries were reported, not that Sassato verified their absence.
Do not report `idle` while a waiter is still running. Settle it through the provider's
supported controls and retain its continuation cursor before a reset. Re-establish
the normal single-waiter workflow after recovery only when STOP is absent.

| Condition | Recommendation |
| --- | --- |
| Active durable STOP or configured stop file | `stop`: follow STOP instructions and remain stopped |
| Missing/stale checkpoint, unsaved discoveries, unread mail, or jobs not confirmed idle | `continue`: address the reasons before considering a reset |
| Next work unrelated; pressure known; no owned or targeted tasks doing, blocked or in review; checkpoint current; jobs idle | `fresh`: ask the human whether to start a fresh conversation |
| Same/related work; reported high pressure; checkpoint current; jobs idle | `compact`: an optional hint for the human to consider native compaction |
| Related work with low pressure, unknown inputs, or unrelated work with unfinished owned or targeted tasks | `continue`: retain context; settle or hand off unfinished work first |

`continue` may mean checkpointing, reading mail or settling jobs, rather than starting
new work. It never overrides a blocker, permission rule or task ownership. There is
no blanket reset after each task and no fixed token percentage.

Both text and JSON output include reasons and next steps. JSON also identifies the
reported inputs, checkpoint, active-task count and unread-message count. Advice is
a read-only snapshot: concurrent updates can change it immediately, so recheck at
the actual boundary. It never marks mail read or changes the session registry.

## Freshness and recovery

```sh
sassato context --brief
sassato checkpoint show
sassato checkpoint show reviewer
```

The bounded context includes a checkpoint reference and its freshness state when
one exists. Unsupported older checkpoint formats require a fresh save; their
recovery text remains available. Read the full
record with `checkpoint show`; it returns `null` if none exists. Recovery records
are role-owned and workspace-scoped; other roles can read them, just like WIP.
They survive provider changes and new session IDs. Audit events retain older records.

A checkpoint is stale after 24 hours, or when its saved inputs change: WIP version;
owned or targeted task versions; relevant blockers, questions and dependencies;
pending mail receipts; workspace settings/attachments; or the role's configuration.
Unrelated roles' tasks, shared fact edits and session heartbeats do not invalidate
it. Sassato does not track which facts a role relied on; read relevant facts during
recovery rather than treating checkpoint freshness as fact validation.
This is a conservative freshness check, not proof that the summary is complete.
Sassato cannot see unsaved reasoning, changed files, provider context usage or live
tool jobs through these commands. The agent must assess those explicitly.

After a reset, read current context and the checkpoint, inspect full task/decision
records, check inbox and verify working files and test results. A stale checkpoint
can still be useful historical context; reconcile it before saving a new one. Read
current STOP status before continuing, even if the saved next action says to work.

## Provider controls

Keep native automatic compaction enabled unless your provider setup deliberately
changes it. Compaction retains a summary; a fresh conversation sheds old reasoning
and relies more heavily on the saved checkpoint and project instructions.

Claude Code supports automatic compaction and user-invoked `/compact` and `/clear`.
Its ordinary Skill tool cannot invoke `/compact`. An instruction in `CLAUDE.md`
does not itself add that capability. The optional Sassato SessionStart hook reloads
bounded context after clear/compact; it does not save a pre-reset checkpoint.
See [Claude context behavior](https://code.claude.com/docs/en/how-claude-code-works)
and [skill invocation limits](https://code.claude.com/docs/en/skills).

Codex supports automatic compaction and user-facing context controls. Its app-server
also exposes `thread/compact/start` for controllers. Sassato does not currently
integrate with that API. See [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference),
[commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli) and
[app-server](https://learn.chatgpt.com/docs/app-server).

Manual reset hints are for the human using supported controls in the installed
provider version. The agent can prepare recovery state and explain the hint; the
advice command does not give it access to those controls. Continue with native
automatic compaction when no manual action is needed. Do not inject terminal keystrokes or
rewrite provider transcript files. For a fresh process, the existing human-only
`sassato launch ROLE --fresh --as HUMAN` still requires the old session to have ended;
advice neither ends it nor bypasses launch checks. Never mark a still-running
provider session ended merely to permit another launch. The human should close the
old provider process before replacing it. No watcher or daemon is added.
