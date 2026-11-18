# Repository code index

The code map is deterministic and independent of workspaces, coordination databases,
providers and daemons. It never installs or launches an agent. Git must be available.
The package bundles the lockfile-resolved TypeScript compiler API and its license;
ordinary commands do not load the compiler. No runtime package download is needed.

```sh
sassato index build --repo /path/to/checkout
sassato index update --repo /path/to/checkout --diff BASE..HEAD
sassato index find setTimer --repo /path/to/checkout
sassato index show packages/index --repo /path/to/checkout
sassato index show src/example.ts --repo /path/to/checkout --json
```

Run `index update` after a merge. Both revisions must resolve to commits, and the
target must be the requesting checkout's HEAD. The target tree determines every
path, including renames and deletions. Only changed path/blob pairs need analysis;
unchanged content analysis is also reused by hash across paths and snapshots.

Committed indexes are immutable and keyed by the physical repository fingerprint,
commit, index schema and actual parser version. Linked worktrees share a repository
namespace; separate clones do not. Repository/checkout fingerprints use canonical
Git paths, device/inode identities and object format. Branch names and remote URLs
are observations, never identities. Registry IDs can be supplied as metadata to the
programmatic API; the index does not require a registry database.

Queries always use the requesting checkout's actual HEAD and then overlay its
current regular files, including staged, unstaged and relevant untracked changes.
Worktree bytes override staged bytes when both differ. Renames and deletions are
reflected without modifying the committed cache. Each query rebuilds this view;
changing HEAD or files invalidates the previous view digest. Missing or malformed
exact-HEAD snapshots visibly report `missing` or `stale` and search current source.
They never substitute a different branch's latest-main snapshot. The index refuses
an unborn HEAD or a repository/HEAD change detected during the read.
Submodules, unmerged indexes, sparse/skip-worktree entries and filenames with
invalid UTF-8 bytes fail explicitly. Valid Unicode filenames remain distinct.
Git reads use object plumbing and file listings; repository clean filters,
filesystem monitors and external diff commands are not executed.

Results contain repository-relative `path:line` locations, commit and view identity,
definitions, exports, file imports, directory modules, and related tests inferred
from imports. Module descriptions are generated counts and navigation aids, not
architectural decisions. Uses are syntactic potential references, including local
import aliases; they are not a type-checked call graph. External/package aliases,
dynamic paths and runtime dispatch may require source inspection. Exact symbolic
string arguments such as `run('setTimer')` are searched on demand for that query;
arbitrary string literals are never cached. Results default to 30 entries, with a
maximum `--limit 100`; truncation is explicit. Human output also has a character
budget; use narrower queries or JSON to inspect more locations.

Only TypeScript/JavaScript receives symbol analysis. Other files have paths and
hashes. No bodies, initializers, raw type literals or source snippets are stored.
Dependencies, build outputs, generated `*.gen.*`/`*.generated.*`, snapshots,
environment/credential/private-key files and symlinks are excluded. The existing
secret heuristic also excludes analysis of secret-like source content. It is a
heuristic, not a secret vault. Paths with control characters are excluded.

The cache defaults to `$XDG_CACHE_HOME/sassato/index` or `~/.cache/sassato/index`;
override it with `--cache PATH` or `SASSATO_INDEX_CACHE`. It contains metadata only.
The configured cache root resolves platform or user symlinks once and must be
owned by the current user without group/world write permission. Directories below
that root cannot be symlinks and have the same ownership/write checks. Immutable objects publish with an exclusive
temporary file and atomic hard link. The latest pointer is updated under an
exclusive directory lock only when it advances ancestry on `main`, `master`, or
`origin/HEAD` (in that order). Feature branches cannot capture it; old or divergent
builds cannot roll it back. A busy or abandoned `publish.lock` skips latest publication
and the build returns an explicit `latest_notice`; exact-commit queries still work.
The lock contains `owner.json` with its host, PID and start time. Recovery is manual:
verify that host/process is gone, then remove that lock directory and rebuild.
If `owner.json` is absent (a crash before its write), first verify no index builder
is running against this cache; an unknown owner is never evidence of a dead one.
The tool never steals a lock based on age or PID alone. The pointer is optional;
an invalid or unavailable ancestry hint cannot invalidate a published snapshot.

Resource bounds are explicit: 100,000 paths; 2 MiB per analyzed source file; 96 MiB
of committed source per build; 128 MiB of analyzed current source per query; 16 MiB
per worktree file hash; bounded Git reads and a 60-second overlay scan. Exceeding
the total source or time budget fails explicitly. Oversized sources remain path-only
with an analysis reason. Non-code and oversized source files are hashed in chunks;
files beyond the hashing limit remain visible with a stat-based view token and an
explicit unverified-content reason, causing an overlay state. Metadata objects are
limited to 64 MiB before publication, matching the read limit.

Cache compatibility includes the schema and parser version. Changes to extraction,
exclusion or secret heuristics must bump the index schema. Raw worktree hashes
intentionally avoid Git clean filters; repositories using line-ending conversion
can report an overlay for bytes that Git considers clean.

## Example engine measurement

On engine commit `709d3f02f4f0b91bba648bba0d621625448b603a`, Node 24.21.0,
a cold local cache with implementation `80fe3f56fc6252b8cb99948b042768770ada8327`
indexed 3,230 paths and analyzed 1,041 source files in 5.76 seconds. The canonical
snapshot was 29,685,227 bytes; snapshot plus reusable analysis occupied 58,076,533
bytes. Peak process RSS was about 447 MiB. These are one-run observations, not a
performance guarantee; concurrent machine load affects query times.

The three checked queries used the requesting checkout's exact commit with no
fallback: `show packages/core/src/sections/timers.ts` located `cronProblem` at line
108 and `readTimer` at line 132 (2.31 seconds); `show setTimer` found its definition
at line 619, registration at line 714, Studio dispatch in
`apps/studio/src/builder/TimerForm.tsx:108`, and test references (1.42 seconds);
`show packages/index/src/index.ts` listed barrel exports including `buildIndex`,
`buildContext`, `answerQuestion`, `findTests` and `noSignIn` (1.86 seconds). Runtime
string dispatch is a potential reference, requiring source inspection. The timer
file query exceeded the output budget and said so; JSON or a narrower query is
needed for its remaining locations.

## Resource bounds and cache retention

Queries retain at most twenty candidates per requested result before enrichment,
with at most `limit + 1` references per selected name or import alias. Broad queries
can therefore return a lower bound rather than an exhaustive count; JSON sets
`total_is_lower_bound` and `truncated`, and text says “at least”. Narrow the name or
path to explore another part of the repository. Related-test hints retain eight
paths per target.

The private navigation cache is disposable. On open and after indexing/querying,
oldest recognized analysis and commit objects are evicted above 256 MiB or 2,000
objects. Locks, latest hints, symlinks and unknown files are never eviction targets.
An evicted exact-commit snapshot is reported as missing and queries fall back to
current source; rebuilding recreates it. Retention is by object modification time,
not an assertion that an old commit is no longer useful.

Credential paths, including `.envrc`, `*.tfvars`, `*.tfvars.json`, `.pypirc`,
`kubeconfig`, `.aws/` and `.kube/`, are excluded before index reads. A dirty-work
brief instead refuses sensitive dirty paths: silently omitting them would make its
handover proof incomplete. Move credentials outside the checkout before capture.
Both dirty proofs and their identity probes share a 30-second deadline and a
128-MiB total content-read budget; exhausting either saves no brief.
