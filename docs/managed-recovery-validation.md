# Managed recovery validation

This document defines the proof required before implementing an optional session
supervisor. A conversational probe can establish native compaction or fresh-context
behavior. It does not establish recovery of actual Sassato work or permission to
replace an independently running worker. The existing
[capability report](provider-capabilities.md) records those narrower observations.

This batch validates disposable managed sessions against real Sassato state. It
does not add a supervisor, transition command, automatic reset policy or production
worker replacement. Live results must name the exact provider version, transport,
authentication mode and scope tested. Untested dimensions remain explicit.

## Disposable proof fixture

Each provider run needs its own temporary repository/worktree and database, generated
provider identities and owned child processes. Do not reuse production roles,
session IDs, live waiters or tool jobs. Use existing authentication deliberately;
do not copy credentials, change login/billing modes, bypass trust or broaden a
provider's configured permissions to make a failing test pass.

Create actual Sassato records and retain independent assertions for:

| Fixture | Required evidence |
| --- | --- |
| Durable role and owned task | A doing task with captured ID, owner, status and version; recovery continues it under the same role |
| Worktree | Repository identity, HEAD and branch, plus an intentionally dirty sentinel file whose bytes are hashed before replacement |
| Checkpoint | A saved event with objective, constraints, discoveries, validation, unresolved work and an exact next action; optional structured evidence is clearly separated into observations and reports |
| Notification progress | A cursor already handled, saved with its progress version; an actionable notification committed after that cursor and before replacement startup |
| Job disposition | A harmless runner-owned job recorded in checkpoint evidence, with an explicit finish, stop or adopt plan and independent evidence of what actually happened |
| Project instructions | A fixture-only instruction marker loaded through the selected provider's supported project-instruction mechanism |
| Scope | The chosen model, working directory, tools, hooks and permission/approval settings recorded for both old and replacement execution |

A provider repeating text included in its prompt does not prove it read the
database, loaded project instructions or inspected the working files. Require
provider tool/protocol evidence and independent postcondition checks. The fixture
must still be reconstructible from the script when raw run logs stay private.

## Fresh-replacement acceptance

1. Start an explicitly identified managed provider execution in the disposable
   directory. Observe readiness and effective configuration. Record what the
   controller requested separately from what the provider confirmed.
2. Have that execution inspect real fixture state and perform the bounded initial
   step. The controller may save the checkpoint from the observed fixture state and
   explicit reports; distinguish this from an agent writing its own checkpoint.
   Save at a stable boundary and retain the last safely
   handled notification cursor. Checkpoint creation alone does not attest that jobs
   have finished or that notifications were handled.
3. Settle the recorded job through its planned action. Verify process exit for
   finish/stop, or explicitly demonstrate supported adoption. Do not treat a job's
   reported state or disposition as proof that the action occurred.
4. End the old owned execution and verify it can no longer act before starting the
   replacement. A session registry edit, request acceptance or stale heartbeat is
   insufficient. Reap owned processes and retain completion/exit evidence. If the
   chosen protocol reuses a controller process, distinguish that process from the
   retired conversation and prove execution is quiescent through supported signals.
5. Start a fresh explicitly identified conversation under the same Sassato role.
   Assert its provider ID differs. Never use unscoped “continue latest.” Preserve
   the selected working directory, model, permission scope and project setup.
6. Have the replacement read current context, the checkpoint, task details,
   independent notification progress and working files. Require a structured
   acknowledgment of the actual task/version, checkpoint, constraint and next action.
   Then have it perform the bounded next step from the saved objective.
7. Independently verify the owned task was preserved, the dirty file bytes and HEAD
   were retained, and no unrelated records or paths were changed. A normal task
   update may advance its version; assert the expected change rather than silently
   accepting any version difference.
8. Deliver the post-cursor notification through the normal waiter path. Prove it
   remains pending until safely handled and that progress advances only to its
   returned cursor afterward. Do not seed recovery from a newer context snapshot or
   restore the checkpoint's historical progress over a newer independent record.
   The current live probe deliberately tests the read-only portion: it replays the
   notification twice and verifies that progress and inbox receipts remain untouched.
   Saving handled progress is covered by deterministic CLI tests; the live probe
   does not claim that its read-only provider performs that mutation.
9. Close and reap only runner-owned processes. Confirm no fixture job or provider is
   left running. Preserve a sanitized result even when the run fails; failure or
   timeout must exit nonzero rather than being relabeled as unsupported success.

The sanitized result should report assertion outcomes and observed settings without
account identifiers, credentials, full transcripts, production paths or provider IDs.
Store distinct-identity comparisons rather than publishing identifiers themselves.

## Configuration and interface scope

| Dimension | Passing evidence | Insufficient evidence |
| --- | --- | --- |
| Model | Same deliberately selected effective model in old and replacement startup/turn metadata | A model name repeated by the agent |
| Permissions | Compared effective sandbox/approval or permission mode, with unchanged or narrower scope | Reusing the same prompt while changing launch flags |
| Working directory | Provider metadata and a real tool read in the fixture directory | A path string in recovery text |
| Instructions | Fixture instruction loaded through the normal mechanism and checked during recovery | Repeating the same instruction in the recovery prompt |
| Tools | Required tool is advertised and actually reads the fixture state | Tool names listed in help |
| Hooks | Configured fixture hook behavior observed before and after replacement, or explicitly recorded as untested/absent | Assuming inherited hooks loaded because the session started |
| Process truth | Actual owned old-execution completion/exit and distinct fresh readiness | `session end` while the old process can still act |
| UI | Demonstrated reconnect/relaunch for the specific advertised interface | Headless success used to claim TUI or Windows Terminal support |

An absent configured hook or tool set can establish a narrow baseline. It does not
establish continuity for arbitrary user hooks or tools. Similarly, a successful
native CLI transport does not establish an SDK library's authentication eligibility
or control of an independently opened terminal. Record these limits in the matrix.

## Supervisor gate

Keep these evidence levels separate:

| Level | What it establishes | What remains |
| --- | --- | --- |
| Provider primitive | Documented controls work in bounded real conversations, with explicit identities and completion events | Actual Sassato/task/job recovery and configuration continuity |
| Disposable recovery proof | The tested managed path preserves real coordination and working state across replacement | Durable transition accounting, concurrent control and crash reconciliation |
| Supervisor release validation | An implementation passes lifecycle failure tests and opt-in live confirmation for its advertised mode | Broader versions/platforms, UI modes or automatic policies not exercised |

Before choosing a first production adapter, both providers need a passing disposable
proof or a clearly scoped unsupported result. Do not infer support for a missing
dimension or convert gaps into repeated requests for manual compaction. Select the
smallest proven mode and keep ordinary CLI coordination independent of it.

Before releasing any supervisor path, deterministic lifecycle tests must cover:

- Duplicate transition requests, two controllers and stale generation ownership.
- STOP during preparation, execution and before recovered work; external stop files
  and human STOP must remain effective.
- Lost startup acknowledgments, controller/provider crashes and uncertain old-process
  exit, without spawning a duplicate worker.
- Bounded retry behavior, including normal completion without a restart loop.
- Active tool jobs and durable services that cannot be silently abandoned or adopted.
- Notification arrival between the last handled event and replacement startup.
- Checkpoint conflicts, malformed records, stale recovery evidence and permission drift.
- Compaction accepted without completion; for Claude, success without a compact
  boundary must not be treated as successful compaction.

Run a small opt-in live confirmation in addition to those fixtures. A mocked lifecycle
pass does not establish actual provider compatibility. Native Windows Terminal/WSL
integration and UI reconnection require their own observed checks. Automatic
pressure-based transition policy comes only after execution reliability is proved.

## Current result: supervisor gate closed

Checked on 2026-11-10. The disposable fixture checks and non-model `--fixture-only`
path passed. Neither live provider completed the real-state recovery proof. These
outcomes are narrower than general provider incompatibility: they identify failures
in the tested host, configuration and restricted probe path. No production worker
was controlled and no supervisor was enabled.

| Path | Result | Evidence and limit |
| --- | --- | --- |
| Fixture without model calls | Passed | Actual scratch database/repository, controller-owned job settlement, unchanged task/file state and repeated read-only notification replay |
| Codex `0.167.0`, app-server with inherited read-only sandbox | Blocked before initial state inspection completed | Command tool failed. A separate non-model sandbox check reproduced `sandbox-helper-unavailable`: bwrap could not execute the installed Codex binary path even though it exists outside the sandbox. Fresh replacement was not reached. |
| Claude Code `2.1.321`, native streaming CLI | Blocked before initial state inspection completed | Two attempts requested shell commands outside the probe's exact allowed inspection command. After clarifying the bounded prompt, the next attempt returned `provider-tool-error-or-permission-denial`. Fresh replacement was not reached. |

Codex's two failed model probes exited the owned provider process with code 0 during
cleanup. Claude's first two were terminated within the owned process group (exit 143);
the clarified retry exited 0 without forced cleanup, with an empty owned process
group reported. The disposable job was reaped with exit 0 on every recorded attempt.
The read-only command failures were not worked around by altering permissions,
provider configuration or credentials. Authentication was inherited; this batch did
not repeat the earlier login-status investigation or establish another billing mode.

The prior successful conversation-only compaction probes remain valid within their
original scope. They do not cancel these failed actual-state recovery results. See
the [capability matrix](provider-capabilities.md) and
[sanitized evidence](provider-capability-evidence.json) for both levels.

The source-checkout reproduction entry point is:

```sh
npm run build
python3 scripts/managed-recovery-probe.py --provider codex
python3 scripts/managed-recovery-probe.py --provider claude
# No provider or model calls:
python3 scripts/managed-recovery-probe.py --provider codex --fixture-only
```

It requires Python 3, POSIX process groups and the selected installed provider. It
is an opt-in live-model test using existing authentication, not part of normal unit
tests or package smoke. `scripts/managed-recovery-fixture.mjs` creates a scratch Git
repository and Sassato database. The provider's read-only tool invokes the fixture's
inspection command to query actual task, checkpoint, progress, inbox and file state.

When initial inspection succeeds, the runner requires old-process exit before its
fresh-start callback settles the scratch job, saves recovery state and creates a
notification in the replacement gap. The replacement must then read that state;
the controller checks file bytes, full Git status, HEAD, task ownership/version,
role configuration, event state, progress, mail and job exit independently. The live
attempts above stopped before this path; only the fixture checks exercised it.

This is a restrictive read-only baseline. Hooks, interactive UI and arbitrary
tools/settings continuity remain unproved. The adapters accept only the versions
named above and reject other versions until validated. Scripts are source-checkout
tools and are not included in the npm package. A future passing probe would still
need the supervisor lifecycle and failure tests listed above before release.
