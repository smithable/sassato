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
Submodules, unmerged indexes and sparse/skip-worktree entries fail explicitly.
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
Cache directories cannot be symlinks. Immutable objects publish with an exclusive
temporary file and atomic hard link. The latest pointer is updated under an
exclusive directory lock only when it advances ancestry; old or divergent builds
cannot roll it back. A busy or abandoned `publish.lock` skips latest publication;
exact-commit queries still work. Inspect ownership before removing an abandoned lock.

Resource bounds are explicit: 100,000 paths; 2 MiB per analyzed source file; 96 MiB
of committed source per build; 128 MiB of current worktree bytes per query; 16 MiB
per non-code worktree file; bounded Git reads and a 60-second overlay scan. Exceeding
a worktree bound fails rather than silently presenting an incomplete current view.
Oversized committed sources remain path-only with an analysis reason.
