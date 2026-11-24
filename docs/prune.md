# Prune listing and fact expiry

Status: design, for review (T1415). Nothing here is built yet.

Old work piles up in a workspace. Tasks sit in review after their change merged. Questions outlive
the reason they were asked. Two tasks say the same thing. Facts describe a week that has passed.
Today a session finds these by hand, reading every task and fact. This note adds two things:

- **a read-only listing**, `sassato prune`, that finds the candidates by fixed rules;
- **an expiry date on facts**, so that a fact known to be short-lived leaves the brief on its own.

Deciding what to close stays with a session (weekly) and the existing rules:

- the owner closes a task;
- a task with no result on main needs a reason and a human's yes.

The listing never closes, drops, withdraws or edits anything.

## `sassato prune`

```
sassato prune [--days N] [--section NAME[,NAME]] [--json]
```

- **Read-only.** It reads one snapshot and writes no event, so running it twice changes nothing.
- **Any role may run it.** It shows only what `tasks`, `humans` and `facts` already show that role.
- **`--days N`** is the quiet age (default 7). `--section` limits the listing to the named sections.
- **Plain output:** one line per candidate under a heading per section, oldest first. Each line gives
  the id, its age, its holder, a short text and the rule that matched.
- **`--json`:** the same data as `{sections: {name: [rows]}}`.

### Sections

Each section is one rule, so a line says exactly why it is there. The rules match what a hand-made
audit found.

| Section | Rule | What a hand audit found |
| - | - | - |
| `quiet-review` | Task in `review` or `blocked` with no event (note, change, blocker) for N days. | "done with proof" |
| `names-merged-pr` | Task not done or dropped whose notes or body name a pull request (`#123` or a PR URL) and say `merged`, with no event since that note. | "done with proof" |
| `old-questions` | Pending question older than N days (the `humans` queue's `age_days`). | questions overtaken by events |
| `same-title` | Two or more open tasks whose titles match once cut down: lower case, a leading `Low:`/`Feedback (…):` and the punctuation removed. | "duplicates" |
| `expired-facts` | Facts past their `expires_at` (below). | — |
| `dated-facts` | Facts whose key holds a date (`YYYY-MM-DD`) more than N days old, or whose `checked_at` is more than 30 days old. | "stale facts": usage snapshots, keys with a date |
| `marked-facts` | Facts whose body starts with `DUPLICATE`, `Superseded` or `Withdrawn` (any case). | "self-marked duplicate" |

### Not in v1

- **Pull request state.** sassato stays offline and holds no GitHub token. `names-merged-pr` reads
  sassato's own text. The weekly session checks a listed PR with `gh` before closing.
- **Fuzzy duplicates.** Only equal cut-down titles count. A near match is the session's judgment.
- **Closing in bulk.** A `--close` flag would turn a listing into an action. The design is a listing
  plus judgment, so there is none.

## Fact expiry

```
sassato fact set KEY TEXT --source WHERE [--expires DATE|none] --expect V
```

- **Schema v6:** `ALTER TABLE facts ADD COLUMN expires_at TEXT` (an ISO date or time, null when the
  fact has no expiry). The migration adds a column and nothing else. Old facts keep null.
- **Dates.** `--expires` takes `YYYY-MM-DD`, which means the end of that day in UTC, or a full ISO
  time. A date in the past is refused when the fact is set. `none` clears the expiry.
- **A correction keeps the expiry.** `fact set` without `--expires` keeps a future one, so a
  correction does not silently make a short-lived fact permanent. It drops one already past: a
  correction is a fresh check of the fact.
- **An expired fact:**
  - leaves `context`, `context --brief` and the rule brief;
  - shows in `fact get` and `fact history` with `expired: true`;
  - shows in `facts` (and `search`) marked `expired`;
  - is listed by `prune` under `expired-facts`.

  Nothing is deleted. The fact's history is append-only already.
- **Who sets one:** anyone who may set the fact.
- **No default expiry.** `decisions.*` get none. A short-lived kind, such as `usage.*`,
  `budgets.*` or a temporary arrangement like "this role orchestrates until the weekly reset", is
  given one by the session that writes it. sassato does not guess an expiry from the key's name.

## The weekly round

- **Today.** A session runs `sassato prune` once a week and reads each line. It closes what is its
  own, asks owners in one mail per owner, and puts to a human only what needs a human's yes. It then corrects or lets expire the facts listed.
- **Later.** When recurring tasks exist, the round is a weekly recurring task. Until
  then it is a line in that session's routine. That is not a sassato change.

## Tests

- `prune`:
  - each section finds its case and leaves a near miss out;
  - one row per candidate;
  - writes no event (the event count is unchanged);
  - runs for an agent and a human role;
  - `--days` and `--section` narrow the listing.
- `fact set --expires`:
  - a past date is refused;
  - `none` clears the expiry;
  - a correction keeps a future expiry and drops a past one;
  - an expired fact is absent from `context` and the brief, and marked in `fact get`, `facts` and
    `search`;
  - the migration from v5 keeps every fact with a null expiry.

## Questions for review

1. Should `names-merged-pr` call `gh` when it is on the path? This note says no: offline,
   deterministic, no token.
2. Should a correction keep the expiry, or should the writer always restate it? This note says a
   correction keeps a future expiry.
3. Is 7 days the right quiet age for the weekly round, and 30 days right for `checked_at`?
