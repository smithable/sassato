# Topics

Status: design, for review. The command reference will be in [commands.md](commands.md).

Some work is not yet work. A question is being researched, a choice is waiting on a human, or a
thread of ideas has no action in it yet. Today such a thing is either an open task, which wakes
sessions and is offered to them as work, or mail, which nobody can find again. A **topic** is a
third place: a shared page for planning, research and decisions that holds the human's words, the
links to what was found and the open questions, and that ends in named tasks or a reason a human
acknowledged.

A topic is a task of kind `topic`. It reuses the task's id space (`T…`), its search, `show`, notes,
questions and history. What makes it different is what it never does: it is never offered as work,
never taken, and wakes nobody as open work.

## Schema 17

```sql
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'work' CHECK(kind IN ('work','topic'));
CREATE TABLE topic_links(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL,
  topic_id INTEGER NOT NULL, target TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
  follow_up INTEGER NOT NULL DEFAULT 0 CHECK(follow_up IN (0,1)), status TEXT NOT NULL DEFAULT 'linked'
  CHECK(status IN ('linked','removed')), added_by TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,topic_id) REFERENCES tasks(workspace_id,id));
CREATE INDEX topic_links_topic ON topic_links(workspace_id,topic_id,status);
```

- Every existing task gets `kind='work'`. The migration adds a column and a table and changes no row.
- A link's `target` is a task (`T…`), a question (`H…`), a fact key, a pull request (`owner/repo#N`
  or its URL) or a repository path. A link to a task shows that task's live status.
- A link is removed by marking it `removed`, never deleted, so the history stays whole.

## States

| Topic state | Meaning |
| - | - |
| `open` | In discussion. The only state a topic is ever worked in. |
| `done` | Closed into follow-up tasks, which it names. |
| `dropped` | Closed with a reason a human acknowledged. |

A topic has no owner and no lease, and is never `doing`, `review` or `blocked`. Its **keeper**
(`for_role`, the creator by default) keeps its links tidy and closes it; anyone may add to it.

## Commands

| Command | What it does |
| - | - |
| `topic add TITLE [--body TEXT] [--keeper ROLE] [--link TARGET]…` | Any role opens a topic. No wake is sent, to the keeper either. |
| `topics [--all] [--json]` | One line per open topic: id, title, keeper, days since its last event, its pending questions (`H…`) and its linked tasks with their status. `--all` adds closed ones. |
| `topic link T TARGET [--label TEXT]` / `topic unlink T L…` | Any role adds or removes a link. |
| `note T TEXT` | On a topic, **any role** may note it, agent or human. |
| `ask-human T …` | As today: the question is recorded on the topic and shows in `humans`. |
| `topic close T --into T2[,T3…]` | The keeper, the creator or a human closes it as `done` into tasks of kind `work` that exist. Each becomes a follow-up link. |
| `topic close T --reason TEXT --acknowledged H…` | Closes it as `dropped`. `H…` must be an answered question on this topic. A human role may close it this way without `--acknowledged`. |
| `show T` | Adds `kind`, the links, the follow-ups and the pending questions. |

On a topic, `take`, `submit`, `done`, `block`, `release`, `handoff` and `after` are refused with
"T… is a topic: note it, link it, or close it with sas topic close". No task may wait on a topic (`after`, `block --on`);
a follow-up names its topic in a link instead.

### Notes by any role

Today only the holder, or an unowned task's creator or target, may note a task. A topic has no holder
by design, so `noteTask` accepts any role of the workspace when `kind='topic'`. What a note may say
does not change: the same text checks, no secrets, one event per note. A held task keeps today's
rule.

## What it never does

Each query that offers, counts or wakes for work gains `kind='work'`:

- `tasks --available`, and the `open-work`, `spare-work`, `task-ready` and `task-assigned` wakes;
- the idle nudge's count of open work, and the supervisor's monitor and snapshot;
- recovery evidence and attended reconciliation, which look for held work.

`tasks` lists topics only with `--kind topic` or `--kind all`; by default it lists work, as today.

## Wakes and the brief

- **Wakes.** A topic wakes nobody as open work. A note on a topic, a new link or a new question adds a
  quiet entry for the keeper only; an answered question wakes its asker, as today.
- **The brief.** One line, `Topics: N open (M pending questions)`, and one line for each topic the
  role keeps or has noted that changed since the role's cursor (`T… · title · new note by X`).
- **`humans`.** A question on a topic goes under "Can wait": no work waits on a topic, by definition.

## Prune

- `quiet-review` and `names-merged-pr` leave topics out.
- A new section, `quiet-topics`: an open topic with no event for 30 days, listed so the weekly round
  asks its keeper to close it into tasks or with a reason. Topics move slowly, so the age is fixed at
  30 days rather than `--days`.
- `same-title` includes topics, since a topic and a task with one title are worth a look.

## Tests

- The migration from schema 16 gives every task `kind='work'` and keeps every row.
- A topic is in none of: `tasks --available`, the wakes for open, spare, ready or assigned work, the idle
  nudge's count; and `take`, `done`, `block` and `after` on it are refused with the topic message.
- Any role notes a topic; a role that does not hold a work task still may not note it.
- `topics` shows pending questions and linked tasks with their status; `show` shows the links.
- `topic close --into` needs existing work tasks and records them as follow-ups; `--reason` needs an
  answered question on the topic or a human role.
- `prune` lists a 30-day quiet topic under `quiet-topics` and not under `quiet-review`.

## Questions for review

1. **Turning tasks into topics.** Should there be `topic from T…`, for an open, unowned task that is
   not human-only, so the first topics keep their ids and history? The alternative is new topics
   that link the old tasks, which are then dropped.
2. **Quiet entries.** Should a note on a topic reach its keeper as a quiet wake entry, as proposed,
   or nobody until the brief?
3. **Thirty days** for `quiet-topics`, fixed.
