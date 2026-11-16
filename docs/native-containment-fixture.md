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
