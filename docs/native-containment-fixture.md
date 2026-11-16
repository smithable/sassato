# Native containment fixture

This source-only experiment runs inert Python fixtures, never providers. It does
not establish a provider tool barrier, complete job inventory, settings continuity,
protected-job exclusion or real handoff. It has no Sassato management CLI route.

The tested mechanism targets Linux, Python with pidfd support and an existing
systemd user manager with a delegated cgroup v2 subtree. The installed systemd 255
manuals (`systemd-run(1)`, `systemd.service(5)`, `systemd.kill(5)`) were inspected
before execution. No parent delegation, controller or permission is changed.

A transient **service** starts a new helper as a child of that user manager.
`--scope` is deliberately not used: it would start from the caller and would not
establish that migration from an unrelated cgroup is permitted. The service uses
a unique persisted name, the user manager's root slice and a fixed fixture helper.
Intent is fsynced before `systemd-run --user --no-ask-password --no-block`.
Enqueue success is not bootstrap or execution success, and an uncertain result
never permits another launch. Reconciliation inspects the same durable unit.

| Property | Required behavior |
| --- | --- |
| `Type=exec` | Execute only the fixed inert helper; wait for its own registration before release. |
| `ExitType=cgroup` | A detached descendant keeps the service running after the main process exits. |
| `RemainAfterExit=yes` | Retain unit identity even after all fixture processes exit. |
| `KillMode=none`, `SendSIGKILL=no`, `SendSIGHUP=no` | Unit stop must never signal an unverified group. |
| `Restart=no` | No automatic launch or retry. |
| Empty start/stop hooks and success/failure actions | No additional commands or cleanup actions. |
| `WatchdogSec=0`, `RuntimeMaxSec=infinity`, `OOMPolicy=continue` | No manager watchdog/runtime/OOM teardown; the fixture has its own finite self-exit deadline. |
| `NoNewPrivileges=yes` | No privilege gain by the fake helper. |
| `Delegate=cpu memory pids`, `TasksMax=12` | Delegate only already enabled parent controllers, bounded to this new unit. |

The existing root slice must equal the discovered user-manager cgroup and already
have all requested controllers enabled. Its identity, permissions and controller
set are recorded and rechecked. A parent change or unsupported property blocks the
experiment. No `--collect`, persistent unit, parent write or real provider is used.
The first real-kernel check launches only the held helper, never releases its fork
phase, requests fixture STOP, waits for its own exit, proves emptiness and retires
that exact empty unit. If any required effective property differs, preserve the
intent/evidence, do not release or issue unit-stop, and report the unsupported path.

The helper registers boot/start/PID, launch-token hash and actual cgroup while held.
Before release and each signal, verify the transient unit ID, description,
InvocationID, effective lifecycle properties, fixed executable/helper hash, actual
process argv, UID, registered fingerprints and cgroup directory identities. Read
the complete recursive membership twice with explicit depth/process bounds. Missing
or changing observations are unknown, never empty. The released fixture forks a
child, grandchild and detached descendant; they do no external work and have a
short self-exit deadline. Their registrations must match every live member.

Signals use newly opened pidfds after matching the recorded fingerprint and owned
scope. A numeric PID or delivered signal alone is never exit proof. All recorded
pidfds must report exit and the whole recursive scope must be positively empty.
Only then may `systemctl --user stop` forget this exact owned transient unit.
Unknown ownership or exit preserves evidence and blocks; there is no fallback
group kill, wildcard unit cleanup or adoption of an existing process. STOP is
checked before launch, release, recovery and signaling. Default CI uses temporary
fixture data; the real-kernel lab is an explicit separate invocation.

## Retained removal evidence

The first held-only native probe exited safely, but systemd pruned its empty
cgroup and cleared `ControlGroup` before a path-based empty check. That probe did
not retain kernel handles. Its unit metadata and evidence remain untouched;
neither a new handle nor missing-path metadata can retrospectively prove it.

The alternate predicate is restricted to
`6.6.87.2-microsoft-standard-WSL2`. While the bootstrap is live and held, pin the
parent directory, owned cgroup directory and `cgroup.events` descriptors. Verify
the cgroup-v2 filesystem, mount ID, device/inode, domain type and parent identity.
Start an inotify watch on the pinned parent before verifying the live binding
again. Continuously retain the original watch instance and descriptors.

Positive deletion requires `IN_DELETE | IN_ISDIR` for the exact owned basename
with an uninterrupted namespace history. Reject matching creation or movement,
replacement, queue overflow, unmount, watch loss, descriptor identity changes,
changed parent/mount or a subsequently existing path. An absent path, cleared
unit field, link count, deleted suffix, EOF or read error is never this predicate.
The retained event-file result, including an actual `ENODEV`, is audit data only.
Permission and transient read failures invalidate the evidence. Every recorded
process must independently have a positive exit result, and its complete sealed
inventory and no-new-fork barrier must remain unchanged. Unit InvocationID and
effective safe lifecycle properties are verified again before cleanup.

The matching kernel's
[cgroup_destroy_locked](https://github.com/microsoft/WSL2-Linux-Kernel/blob/linux-msft-wsl-6.6.87.2/kernel/cgroup/cgroup.c)
rejects populated groups and online children before removal. The successful
directory-removal path in
[vfs_rmdir](https://github.com/microsoft/WSL2-Linux-Kernel/blob/linux-msft-wsl-6.6.87.2/fs/namei.c)
calls
[d_delete_notify](https://github.com/microsoft/WSL2-Linux-Kernel/blob/linux-msft-wsl-6.6.87.2/include/linux/fsnotify.h),
which reports the original directory entry's deletion to the parent watch.
This supports empty-at-removal only; the separate process exits exclude an
escaped surviving fixture. Directory link counts are unsuitable because
[kernfs_refresh_inode](https://github.com/microsoft/WSL2-Linux-Kernel/blob/linux-msft-wsl-6.6.87.2/fs/kernfs/inode.c)
refreshes them from the subdirectory count.

One held-only native run observed the exact directory-deletion event, unchanged
retained descriptor identities and positive helper exit, followed by cleanup of
its own empty unit. The event-file descriptor returned `ENODEV` after removal;
that result was audit data only. Full fork-tree and fault validation, predicate
assessment and source review remain required. Each lab report
records pre/post descriptor metadata, actual events and event-file errno/results.
Losing the original descriptors before proof, including controller crash, leaves
exit unknown. Temporary-filesystem watch tests verify the implementation only;
they do not establish cgroup behavior. Default native invocation stays held-only.
The separate explicit `--full-tree` lab option releases the bounded fork phase,
seals its no-new-child inventory, lets main exit, verifies that child, grandchild
and detached descendant remain in the original scope, and signals only those
positively owned processes through pidfds. It requires the same positive empty
proof before cleanup.

Pin the main process's exit pidfd while its live identity is still verified,
before requesting main-only exit. Opening a pidfd after reaping can fail even
while the numeric process-group/session identity remains allocated: the matching
[pidfd_prepare](https://github.com/microsoft/WSL2-Linux-Kernel/blob/linux-msft-wsl-6.6.87.2/kernel/fork.c)
requires an associated thread-group task. A native run observed `EINVAL` in that
window and preserved evidence without signaling or cleanup. That errno is never
exit proof; the lab instead requires `POLLIN` from the continuously held pidfd.

Before opening the original retained binding, persist `binding_started`. A new
controller may not bind again after that attempt, even if the helper is still
held and live. This closes the crash window before the completed binding is
saved and prevents reconnect from resetting namespace history. The explicit
`--fault-case lost-handle-reconnect` closes the original handles, opens a fresh
controller, checks duplicate-launch/rebinding rejection, requests fixture STOP,
proves helper exit and checks that cleanup remains blocked. It intentionally
preserves its unit metadata. This exercises handle loss and reconnect, rather
than claiming an operating-system controller crash. `--fault-case stop-held`
checks release and recovery rejection after fixture STOP, then uses the original
retained handles to prove exit and retire its own empty unit.

## Actual disposable-controller death

`python3 -B scripts/native_containment_crash_lab.py --run-kernel-crash-fixture
--evidence-parent PATH` is a separate explicit experiment. It starts two cases
sequentially: abrupt death after durable `binding_started` but before handle
construction, and abrupt death after release and sealing the four-process idle
inventory. No production controller, provider or existing session is involved.

Before each new disposable controller does work, the parent saves launch intent,
verifies its actual PID, boot/start fingerprint, executable arguments, UID and
parent PID, pins a pidfd, and releases an identity-bound gate. At the recorded
injection point the child fsyncs its receipt and calls `os._exit` with a fixed
case-specific status. No `finally`, explicit close or unlock runs. The parent
waits/reaps that exact child and checks its retained pidfd exit result before
starting a fresh reconciler process with the same ownership handshake.

The fresh process checks that the durable intent survived death exactly, acquires
the original OS lock without replacing its file, rejects duplicate launch and
rebinding of lost namespace history, and checks STOP blocks launch, release and
recovery. The held case also verifies recovery cannot reset binding history.
It requests fixture STOP, positively observes every recorded helper's exit and
checks cleanup remains rejected without the original retained handles. Exact
unit metadata and evidence are preserved in both cases; no unit-stop or guessed
signal occurs. Historical experiments are never adopted or cleaned up.

The fresh reconciler guards the current core's `subprocess.run` manager calls,
allowing only metadata reads for its exact new unit, and rejects its retained
handle constructor. These guards block mutations through those specific APIs.
They are not a general sandbox: direct file writes or a future alternative API
are outside the guards. Durable state and barrier assertions independently detect
unexpected writes; the core's ordinary fail-closed checks remain required.

There are exactly two newly created units and four disposable controller
processes per invocation. Helpers have their existing 20-second self-exit bound
and at most four members per unit. Each new controller arms its own 30-second
watchdog before custom imports or scenario reads. The parent uses a single
35-second absolute controller deadline clamped to the 70-second case deadline,
reserving its final two seconds for reaping. A timeout or setup error may terminate
only that newly spawned controller through its original pinned pidfd after fresh
start/argv/UID/parent verification. It never signals helpers, groups, shared
processes or existing sessions. Unknown ownership blocks signaling and records an
unreaped-controller diagnostic; it cannot produce a passing case. Failure waits
out only this invocation's known helper deadlines. Errors while preserving those
observations are attached to the original failure and do not suppress its summary.
Launch requires at least one second of startup work plus the full reap reservation
to remain on the case deadline. An early exit before identity verification is
recorded with `verified_ownership=false`; reaping an owned child and observing its
pidfd exit does not turn that failed handshake into a passing case.
Offline tests exercise a fixed inert Python stub and temporary locks/files,
without invoking a user manager, native unit, provider or external model.

This supplies fixture controller-death evidence only. It does not establish
real-provider recovery, tool barriers, complete job inventory, configuration
continuity or protected-job exclusion. Deeper native cgroup layouts remain a
separate unproven case.
