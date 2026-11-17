# Optional supervisor: implementation contract

Status: contract for foundations, cooperative attended replacement (release 1),
and enforced unattended replacement (release 2). Ordinary
Sassato commands remain standalone, deterministic and usable without a supervisor
or model calls. This document authorizes no installation or live-session takeover.
Existing [provider probes](provider-capabilities.md) do not prove production handoff.

### Current source implementation

The CLI exposes observation, nonce ping and acknowledgment commands, plus the
separate cooperative attended probe described in the [operator runbook](attended-supervisor.md). Schema 10
adds durable generation fences, controller/worker transitions, pings and managed
waiter reservations. Legacy writes from an enrolled role require its current
generation and token inside the same writer transaction; unmanaged roles keep
their existing behavior. Only token hashes are persisted.

The fixture controller exercises launch intent, bootstrap self-registration and
release, recovery acknowledgment, drain, atomic brief/checkpoint readiness,
retirement request, explicit fixture exit observation, generation advance and
same-role replacement. It also bounds pre-release retries and rechecks locks,
STOP, task versions, configuration, checkout/cwd identity and dirty manifests on
resumption and controller recovery. This fixture API has no lifecycle signaling path;
the attended implementation separately uses verified pidfd retirement.
The deterministic child fixture voluntarily exits when requested by its test.
Fixture descendant observations are explicitly synthetic and are never recorded
as real-provider containment proof. No existing terminal is enrolled or adopted.
Initial launch intent atomically reserves its physical checkout before spawning.
That reservation blocks competing managed launches and ordinary checkout binds,
including while launch identity is uncertain or its unreleased intent is cancelled.
Replaying an existing launch intent returns its durable identity with
`new_intent: false` and no credentials; it never authorizes a second spawn. An
uncertain, unregistered spawn remains blocked for a human. Cancellation revokes
both release credentials without erasing the reservation or permitting a retry.
Active running/draining recovery observes current work; immutable Ready snapshots
remain strict requirements for retirement and replacement.

When a human policy exists in the source fixture API, `job run` acquires shared
leases for every configured workspace maintenance lock before admission and holds
them until the run finishes. A controller requires the corresponding exclusive
lease and positive busy checks. This covers that job entry point only: external
gates, merges, releases, detached tools and failure containment still need their
own verified coverage before automatic replacement could be enabled.

Existing provider sessions remain observe-only. The compatibility status field
`management_enabled` remains false for unattended management; explicitly enrolled
attended probes have their separate human-confirmed lifecycle.
There is no CLI to configure fixture enrollment or enable unattended replacement.
Real adapter tool-start barriers, complete running/background tool inventory,
effective configuration continuity, owned descendant containment and the required
real Codex-then-Claude handoffs remain unproven. Cross-role transfer remains
unimplemented. This source implementation is partial phase 3 delivery, not phase 3
acceptance, provider proof, installation approval or unattended enablement.
The in-process Store and fixture adapter APIs are trusted implementation interfaces,
including their narrow lifecycle write modes. They do not sandbox code with raw
database or filesystem access; generation fencing is enforced on CLI mutations and
the Store mutation path. No CLI flag exposes privileged lifecycle write modes.

## Release 1: cooperative, attended replacement

This section defines the first real-provider release and takes precedence over
release-2 requirements below. The source implements `sassato supervise --attended --role ROLE`
as its entry point; real-provider acceptance and installation remain separate
human actions. A human starts and watches it in a terminal; it never runs
unattended or adopts an existing session. Ordinary commands remain standalone.
Persist an explicit attended-only enrollment for the selected human-created role;
`--attended` requires a terminal and cannot enable the unattended management flag.
A restart must again use attended mode and cannot inherit an earlier Enter.
Release 1 disables section 3.5's automatic startup retry: a failed startup blocks
for the human, without creating another generation.

Release 1 relies on a cooperating worker: after handing over it starts no tools,
waiters or background work. The supervisor may retire only a worker it launched,
after a complete saved brief and stopped waiter, with positive evidence that its
owned process group contains no other live members. The worker leader itself may
remain alive awaiting retirement. Unknown membership or identity, a live child,
missing brief, or active gate/merge/release/heavy job blocks retirement. A process
group is an observation boundary, not confinement: escaped or detached work is
not proven absent. Workers must settle all their work before declaring readiness;
this limitation is explicit in the attended prompt and runbook. The bootstrap
execs the provider as the recorded group leader; wrappers and provider-internal
helpers are not exempt from the live-member check. A provider that cannot settle
those helpers cannot pass this release's trial; do not change its configuration
or weaken the check to obtain a pass.

The supervisor owns the confirmation terminal. Give the provider separate terminal
I/O, never the confirmation input stream; provider output/input cannot supply Enter.
The launch design must let the worker survive supervisor termination for the
recovery trial (for example, a separately owned PTY holder whose lifetime does not
follow the controller). Record the holder's ownership and lifetime separately;
it cannot bypass the no-other-live-members rule inside the provider group.
If terminal separation or recovery cannot be demonstrated, block that provider.
A ready worker is intentionally silent with no waiter: suspend ping/waiter health
expectations in that state, retaining identity, STOP and readiness monitoring.

Before each retirement, display the role, generation, exact owned process identity,
checkout, HEAD/dirty state, brief and intended successor (or final stop), then wait
for the human's Enter. EOF, loss of the terminal or any other response does not
approve retirement. Approval is for this transition only; after Enter, recheck
STOP, ownership, readiness, process-group membership and busy guards before any
signal. A changed observation blocks and requires reconciliation and fresh
approval. Do not hold the exclusive maintenance lock while waiting for Enter;
acquire it nonblocking after confirmation, then recheck every guard. Keep it
through retirement/startup, releasing it on a blocked or stopped outcome.
Confirmation does not override a failed guard. Verify exit of the owned
group before starting another generation. A stuck retirement blocks for the human;
release 1 adds no unattended force-kill fallback. On crash recovery, first
reconcile any recorded retirement request with actual exit evidence. A conclusively
exited worker needs no further signal or retirement prompt; a still-live worker
requires fresh Enter before another signal, and uncertain exit blocks replacement.
Bind leader signaling to a verified pidfd, boot ID/start time and the originally
recorded PGID equal to its leader PID; never signal a reused numeric identity.
Because the verified group contains only the leader, retire that leader through
its pidfd, using documented graceful shutdown if supported, then TERM with a
30-second bound. Verify group exit as well. No KILL path is added in release 1;
a timeout blocks for the human without starting a successor.

Preserve durable generation/checkout reservations, launch-before-spawn intent,
bootstrap registration/release, exit verification, task ownership, notification
cursor, dirty files and recovery acknowledgment from sections 1–3. No destructive
Git actions, provider transcript edits or artificial `session end` are permitted.
Use each human-created role's configured provider/model/sandbox/approval settings;
never widen them or silently substitute defaults. Release 1 does not claim proof
of full effective configuration continuity across provider internals. Its blocking
configuration fingerprint covers the recorded Sassato role provider/model/effort,
sandbox/approval settings, resolved executable and version, normalized launch argv
template and cwd. Exclude per-generation prompts/IDs from that template; credentials
and launch tokens never appear in logged argv or briefs (tokens are not passed
in argv). Record the bounded nonsecret launch intent separately.
Compare that subset in the brief and before each launch; missing or changed fields
block. Section 2's full effective tools/hooks/instruction/environment digest and
its internal-verification gate apply to release 2. Never record secret values.

There are no provider hooks and no provider or host configuration changes. The
enforced all-tool start barrier, complete background/nested/detached job inventory,
full configuration-continuity proofs and escape-resistant containment are release 2
requirements; they do not block this cooperative attended release. Those guarantees
must not be inferred from a process-group check or a successful attended test.
Unattended replacement remains disabled, including after release-1 acceptance.

### Release-1 acceptance and human runbook

Use fixtures in CI. Real-provider acceptance is performed by a human in a terminal,
with a human assistant present, using disposable roles and scratch repositories.
Run same-role Codex replacement first; proceed to Claude only after Codex passes. These
are independent provider trials, not cross-provider or cross-role transfer proof.
No existing session or valuable checkout is used.
The implementation supplies exact install, launch, expected-output and stop
instructions; a source merge does not authorize installation. Required release
review covers the foundations and controller changes as well as release 1 before
the human performs backup, stop, installation and restart.

1. The human creates `probe-codex`, then separately `probe-claude`, and an otherwise
   empty scratch Git repository at `~/repos/wt/probe-<provider>`. Use the role's
   configured provider settings without editing provider/global configuration or
   hooks. The human also configures the disposable role's Sassato-side checkout,
   attended enrollment and busy/maintenance guards; these are coordination records,
   not provider or host configuration changes. The runbook supplies exact commands,
   including the existing shared merge guard. Missing/unknown guards still block.
   Do not create or alter a host lock/service policy for this test. Save evidence at
   `~/repos/.session-scripts/supervisor-test/<time>-<provider>/`.
2. `sassato supervise --attended --role probe-<provider>` starts generation 1 with
   a fixed two-step task. Step 1 writes line one to a file and commits it, then
   saves a handover brief: objective, done, exact next step, HEAD, dirty state and
   notification cursor. Include a deliberate uncommitted sentinel file in the
   dirty manifest; generation 2 must preserve its bytes without committing it.
   The worker stops its waiter and all other work before becoming ready.
3. The supervisor checks the saved brief, stopped waiter and owned process group
   with no other live members, prints the proposed retirement, and waits for Enter.
   After approval and guard rechecks, it ends only that owned process group,
   verifies exit, and starts generation 2 in the same directory. While generation 1
   is ready, enqueue a uniquely identified test notification without advancing its
   saved handled cursor. Generation 2 must read and acknowledge it once using the
   saved cursor; record replay evidence without suppressing legitimate redelivery.
4. Generation 2 acknowledges its generation, reconciles the brief with live Git
   and coordination state, verifies the dirty sentinel, writes line two and commits
   only the intended file. It hands over with no further work. The supervisor again
   checks readiness and asks for Enter, ends that group and stops without generation 3.
   The controller records `retiring -> exited -> stopped` with reason `completed`,
   finalizes the bound pending handoff with no successor, and releases the exclusive
   maintenance lock and probe checkout reservation only after verified exit.
   Keep the brief/events
   and task completion or ownership disposition explicit, never a fictitious live
   session end or a lease-expiry release.
5. Save supervisor logs, Sassato events, briefs and Git log/dirty evidence. Pass
   requires both lines in two task commits from distinct generations, one worker
   for each generation, no duplicate launch, preserved dirty bytes and handled
   notification cursor, and both generations' verified exit.
6. In separate disposable trials, start with `~/repos/stop` present and prove that
   nothing launches. The human schedules this shared-stop trial when no unrelated
   sessions are active, since creating the file stops them too; never run it as an
   agent-side test. Also terminate the supervisor between steps 2 and 3 and restart
   it. Recovery reconciles the existing worker/intent without launching a duplicate
   and requires fresh Enter before retirement. Unknown ownership blocks instead of
   adopting or signaling another process. Preserve the same dirty-file evidence.
   Only the human manages the shared stop file; record its pre-existing state and
   never clear another stop request to make a test pass. STOP passes only with
   recorded refusal and zero launch events/processes. Crash recovery passes only
   after completing through generation-2 acknowledgment and final verified exit,
   with one launch per generation, fresh retirement approval, preserved dirty bytes
   and notification replay. Save the restart observations and event/log evidence.

An incomplete real-provider trial leaves that provider's attended acceptance open.
The runbook must distinguish installed behavior, fixture evidence, attended
provider evidence and still-disabled release-2 capabilities.

## 1. Scope, identity and authority

Start with Linux/WSL `sassato supervise`; an optional service comes later. This
deterministic controller has a non-human reporting identity and monitors registered
workers, managing only its own launches. Existing terminals are observe-only. Keep
coordinator, human-assistant and design-reviewer identities; use numbered
builder/reviewer instances. Preserve existing role names.

Human-owned policy bounds role templates, instance counts, repositories, task routing
and provider configurations. Instances copy templates; the supervisor cannot create
human roles, expand permissions, answer approvals or clear STOP. Reports, facts and
briefs never grant authority. Keep human-only launch/configuration controls; add a
narrow managed-launch path. No AI planner initially.

Register existing folders first, with immutable project, repository and checkout
IDs. A project shares coordination; each task binds an explicit checkout and cwd.
A physical repository is identified by canonical Git common directory, its
device/inode and object format; linked worktrees share it, separate clones do not.
A checkout records canonical per-worktree Git directory, root and existing cwd
beneath that root, each with device/inode. Branch and HEAD are observations, never
IDs. Revalidate before use; missing, moved or replaced paths require explicit rebind,
never fallback. The first release supports non-bare Git checkouts only.

Reserve one coding worker per checkout, and one worker per role instance, across
projects sharing this local database. Separate review checkouts are required.
Serialize common-Git-dir ref/worktree mutations as well as registry reservations.
Replacement never creates a worktree, resets, stashes, deletes files or switches
branches. Persist SQLite and controller locks on a verified local native Linux filesystem;
unsupported locking/identity semantics block management. Multi-host scheduling is deferred.
The independent index uses the same physical fingerprint as its cache namespace,
with registry IDs optional; resolve its view against actual HEAD plus dirty files,
never an unrelated latest-main snapshot. Index failure falls back to source search.

## 2. Health and session boundaries

Record worker generation, task/version bindings, provider/session ID, controller
launch ID, PID, Linux boot ID/start time, cwd, and effective configuration digest.
The digest covers model, effort, sandbox, approval mode, tools/hooks/instructions
and their content hashes, executable/version, profile, actual argv and relevant
environment provenance without storing secrets or credential hashes. Inherit the
same authentication and behavior. Unverifiable settings block replacement; never
substitute defaults. Require a new conversation ID, not resumed context. Gate UI
reconnection separately for each mode.

Every 60 seconds, request a generation-bound nonce acknowledgment through Sassato,
due within 120 seconds. Report responsiveness, provider activity, last checkpoint
freshness, task state, waiter identity/cursor and tool/job state separately. The
worker handles pings at tool boundaries; a busy provider may be responsive without
an armed waiter. Idle workers need exactly one waiter. Checkpoints and heartbeats
alone prove neither useful progress nor process exit. A missed deadline, stale
checkpoint or missing waiter marks attention-needed and requests reconciliation;
none alone permits termination. Declared long work, approval waits and task blockers
are visible states, not hang heuristics. No fixed context-percentage or task-count
reset; native compaction stays enabled. Idle time alone does not cause replacement.

Keep a session for the same objective, tests and review fixes. Request handover for
an unrelated objective, accepted design moving to implementation, independent PR
review, or corrected requirements after confusion. Same-review follow-up can retain
the reviewer, which must inspect the new head and intervening diff. Independent
review receives requirements, decisions and evidence, not the author's transcript.

## 3. Handover and replacement protocol

Use durable states `running -> draining -> ready -> retiring -> exited -> starting
-> reconciling -> running`, with `blocked` and `stopped` outcomes. One transition ID
and expected generation make retries idempotent. A database reservation and a
single-controller OS lock fence competing supervisors; lease expiry alone never
proves a worker dead or permits another launch. Every managed-role write requires
its current generation in the same transaction, including legacy commands; unmanaged
roles remain compatible. This
fences database operations, not filesystem writes. For release 2, an adapter-enforced
no-new-tool barrier and verified process-tree exit are mandatory. Release 1 uses
the cooperative readiness, owned-group checks and per-retirement approval above.

A bound task handoff records pending intent plus brief, retaining both owner and
checkout reservation until verified retirement. Foundations (delivery phase 1) cannot
finalize it; replacement (phase 3) adds that capability. Different successor checkouts
do not waive retirement. Legacy unbound handoff stays compatible.
Same-role replacement preserves the owner; cross-role transfer requires exact brief
and task versions after exit. CLI: `brief save/show`, `handoff --brief-file FILE
--expect VERSION` (`--brief` remains the context flag).

1. **Drain.** Stop new assignments and tools. Settle every tool, waiter and background
   job. In release 1, running or unknown jobs block handover; no implicit adoption.
   Preserve the last safely handled notification cursor, including timeout results.
2. **Save ready.** Save a versioned, immutable brief and checkpoint atomically with
   readiness: objective/acceptance criteria, accepted decisions and provenance,
   open issues, validation/artifact references, exact next action, task versions,
   notification progress, configuration digest, repository/checkout/cwd/HEAD,
   staged/unstaged/untracked manifest digest and explicit settled-job evidence.
   Cap the serialized brief at 32 KiB; reject oversize or incomplete evidence rather
   than truncate silently. Hash bounded file manifests locally without persisting
   contents; ignored files stay untouched but are excluded from preservation proof.
   Unsupported sparse/submodule/index states or in-progress Git operations block
   handover in v1. Unreadable files or changing observations block readiness. Observe
   the final manifest after cooperative quiescence in release 1, or the enforced
   no-new-tool barrier in release 2. The worker waits for retirement; it never marks its live session ended or starts its successor.
3. **Retire (release 2; release 1 uses the attended protocol above).** Recheck readiness, identity, configuration, STOP and busy guards.
   Prefer adapter graceful shutdown, then bounded TERM (30 seconds). KILL is a
   logged, human-notified fallback only for an already quiesced, positively owned
   process with all guards still satisfied. A stuck worker without proven quiescence
   stays blocked for the human. Signal only the recorded controller-owned process
   identity via a verified pidfd, never a discovered terminal, ancestor or reused PID.
   Require an owned containment scope with provable descendant membership/exit (such
   as an already delegated cgroup); a process group alone is insufficient. No host
   policy changes to obtain this capability. Confirm the whole scope empty; an end
   marker or delivered signal is not exit. If unsupported, management stays off.
4. **Start.** Only after confirmed exit, advance generation, preserve task ownership
   under the role instance, and start fresh in the exact saved cwd with the same
   configured provider/settings. Persist launch intent before spawn. Use an owned
   child bootstrap that self-registers PID/start/boot identity and launch token
   against that intent before polling a durable generation-bound release. It cannot
   execute the provider before release; STOP, cancelled intent or a 120-second
   unreleased timeout makes it exit. Recovery can verify token plus identity and
   complete or cancel the handshake. Reconcile uncertain spawns before retrying.
5. **Reconcile.** The new worker acknowledges the transition/generation, reads live
   STOP, context, checkpoint, inbox and relevant records, verifies Git/files/settings
   and reconciles changed task versions before acting. HEAD/manifest/cwd/configuration
   mismatch blocks; never restore files automatically. Resume the durable handled
   notification cursor, never latest. Release assignments only after
   this acknowledgment. One automatic retry, with a new generation and token, is
   allowed only for a conclusively failed, exited startup that never passed its
   bootstrap release gate. Recheck Git/brief/settings/tasks before retrying.
   Post-release failure or a second failure blocks for the human.

Every destructive lifecycle action and spawn checks both durable role/workspace
STOP and the configured stop file. STOP during replacement cancels pending launch;
a spawned but unreconciled child must not begin work. Never clear or acknowledge
STOP on a worker's behalf. Recheck immediately before releasing the child; filesystem
STOP is also checked by its bootstrap because it is not atomic with SQLite.

Busy checks cover gates, the configured merge lock, release steps and heavy jobs.
Require positive idle evidence; absent configuration, errors or unknown results
block retirement. Prevent races with a common maintenance flock: jobs hold shared
mode for their whole duration; retirement takes
exclusive mode nonblocking before final idle checks. Hold through retirement/startup,
release on blocked/stopped states while retaining the checkout reservation, and
reacquire/recheck before any resumed retire, start or release, including after a
block or controller crash. Until that exclusion
covers every protected job source, unattended replacement remains off. Release 1
still requires configured guards and cooperative settlement; it does not claim
complete enforcement across detached job sources. Do not interpret missing job reports as an empty machine.

After controller failure, reacquire its lock and reconcile every transition against
recorded process fingerprints, launch tokens and exit evidence before any new spawn.
Surviving owned children may be reattached only by that durable controller identity;
unprovable ownership or incomplete dirty-work evidence blocks recovery. Never edit
provider transcripts or use `session end` to bypass an active-session check.

## 4. Delivery and acceptance

| Phase | Required evidence before completion |
| --- | --- |
| 1. Foundations | Two workers resolve the right checkouts/cwd; linked worktrees, separate clones and symlink aliases distinguish correctly; replaced/missing paths fail closed; duplicate role/checkout claims conflict; bounded briefs preserve dirty staged, unstaged and untracked work. |
| 2. Index (independent) | Immutable commit/schema snapshots; divergent HEAD, rename, deletion and dirty overlays; older publication cannot replace newer latest; stale/unavailable view reports fallback. |
| 3. Replacement | Fixture providers exercise every state; crash before/after each durable transition, especially spawn/record/release; concurrent controllers, PID reuse, lost acknowledgments and duplicate retry never yield two acting workers. STOP at every boundary prevents work/launch; busy/unknown checks and an overlapping job acquisition prevent signals. Missing cwd/config changes block. Dirty content, task ownership and cursor survive; startup retries are bounded. |
| 3. Release-1 provider gate | The disposable attended trials above pass separately for Codex then Claude; no hooks/config edits/existing sessions. Source approval and human installation remain separate. Unattended mode stays off. |
| 3. Release-2 provider gate | One real disposable same-role handoff per exact provider/adapter version and operating mode, first Codex then Claude: distinct conversation, preserved settings/instructions/tools, dirty files, owner, notification replay, exit proof and recovery acknowledgment. Cross-role transfer requires separate proof of owner/checkout transfer after exit. Fixture/conversation-only success does not enable either. Changed provider/configuration invalidates evidence. Human explicitly enables unattended replacement after reviewing evidence. |
| 4. Workflow | Record repository, isolated review checkout, exact base/head/merge-base commit OIDs and content-addressed tree. Uncommitted review captures all non-ignored files, with explicit exclusions; secret-bearing input blocks materialization. Approval binds tree and task version. Immediately before merge verify exact approved head/tree and base; changed integration context requires renewed review. Test stale approval rejection; route fixes to the coding checkout. |
| 5. Tuning | Measure orientation time, token use, rediscovery and defects; adaptive reset policy and service installation come later. |

Use fixture databases/providers for CI; never production sessions. No session installs
this build. Human deployment separately performs backup, stop, installation and host
restart after the required release review. Source
merge, provider evidence and unattended enablement are distinct decisions.
