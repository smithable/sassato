# A disposable rehearsal for supervisor retirement and recovery

The pending Claude rerun (B419/B421) still needs the attended trial because we cannot yet isolate its sign-in or bound its token usage. An offline fixture rehearsal could catch controller mistakes before the operator starts, and Codex could be the first real CLI considered later.

## Stage 1 — offline controller mechanics

Stage 1 requires a fixture-only entry point, a container launcher and three integration cases. fixture-controller.ts and fixture-recovery.ts supply fixture transitions and replay. Their synthetic descendant observations cannot signal a real lifecycle. C must separate proposal reconciliation, signalling, helper settlement and verified exit in attended.ts from its human TTY reader. Only the rehearsal entry point may supply a scripted decision. The effort estimate depends on that split and its refusal tests.

The launcher would use the gate.sh admission queue for one heavy job, adding a rehearsal job type if needed. Admission requires at least 6 GB available. Proposed fixture limits are 1 GiB memory, 128 processes, 128 MiB store tmpfs, 128 MiB checkout tmpfs and 32 MiB scratch. The container has networking disabled, no host mounts or sockets, and a read-only image pinned to the reviewed commit. Its minimal init is PID 1 and runs the controller as a child. Init keeps the container, tmpfs volumes and run binding alive through one controller crash.

The launcher accepts only a fixture case. The controller accepts no store, role, executable or checkout arguments or environment overrides. It exclusively creates its database in the empty private store, refuses existing entries and links, then creates fresh roles and a random workspace. This deliberately differs from the attended runbook's separate workspace in the same database. Fixture workers cannot write the store or approval channel. Init alone can restart one child with the retained database identity and enrollment. A mismatch or init exit ends the case as incomplete.

The normal case requires one launch per generation, distinct fixture conversations and task commits, the expected two-line file, unchanged dirty sentinel, saved-cursor mail replay, verified exits and final release. The fixture approver acknowledges a specific reconciled retirement proposal only after tools, waiters and helpers settle. A live helper or changed observation prevents retirement. A second case crashes the controller before retirement and requires fresh approval of the recovered worker. A third starts with a private STOP already present and requires zero launches. A ten-minute timeout ends the case and the launcher collects the result and disposes of its cgroup and volumes.

## Stage 2 — a separate real-provider decision

Johan would first authorize one attended measurement per provider, using the real CLI on the fixed two-generation fixture task without rehearsal machinery. The measurement records system and tool inputs, cached tokens, outputs and retries across both generations. Its measured total and an explicit allowance for variation determine a proposed hard ceiling for Johan to approve. Stage 2 stays pending until that measurement exists and trusted pre-dispatch accounting can actually enforce the ceiling. A turn count or timeout cannot bound tokens.

Provider access would require a **human-only provisioning task**. Johan supplies and revokes an isolated credential through a read-only memory-backed secret input available to provider bootstrap alone. No session transfers an existing sign-in or mounts a logged-in home. A synthetic-secret test must show that tools cannot read credentials through files, inherited environment, process inspection, logs or exported evidence. The launcher removes secret material, volumes and proxy authorization when the container exits. A worker-side broker for narrowly authorized task operations and a distinct provider identity would be additional Stage 2 work.

| Provider | Candidate route and prerequisite |
| --- | --- |
| Codex | The installed CLI offers device authorization and login from an API key or access token on stdin. Device or ChatGPT login can rewrite the auth file on refresh. The candidate for read-only provisioning is a scoped access token supplied by Johan. Two cold launches must succeed with the isolated credential read-only and the host keyring unavailable. API-key billing requires its own decision. |
| Claude | The installed CLI offers a long-lived subscription token via setup-token. A dedicated token would still need protection from tool subprocesses and an effective revocation path. The attended measurement already approaches the cost of the real Claude trial, leaving little immediate benefit. |

Stage 2 would keep the gate booking and filesystem limits. Its only external network access would go through a proxy restricted to the reviewed provider authentication and inference endpoints. Host services, cloud metadata, general egress, host keyrings, Docker sockets and host plugin configuration stay inaccessible. Each provider needs its own cold-start, isolation and budget tests before launch.

## What a rehearsal proves

- Stage 1 exercises two generations, settlement, private STOP, crash recovery, replay and evidence collection with controlled fixture processes. Refusal tests cover host invocation, existing databases or roles, substituted mounts, stale approval and a surviving helper.
- Stage 2 would additionally exercise the real CLI's process tree, helpers, waiters and conversation identities on the tested commit and configuration.

## What it does not prove

- A human saw and agreed to each retirement.
- The operator's terminal, TTY and WSL restart behave as expected.
- The host installation, migration and rollback steps work.

## Evidence and the attended pass

After the controller exits, init packages only allowlisted, bounded, redacted observations into one rehearsal-result.json with schema kind rehearsal, run ID, case, tested versions, transition and exit evidence, sentinel hash and failure reason. While init still holds tmpfs, the launcher copies that single file through the container runtime into a dedicated supervisor-rehearsals/<run-id>/ root outside attended evidence, then stops the container. A missing bundle means incomplete. There are no loose git logs or hashes. Each exported file thus carries the rehearsal marker in both its name and contents. The proposed runbook addition is one sentence: “A rehearsal directory or file cannot serve as attended evidence.” The human checks the original attended records.

A successful Stage 1 can eliminate repeated debugging of controller mechanics. After a passing real-provider rehearsal on the same commit, provider version and configuration, the remaining acceptance is one operator pass under the [attended runbook](attended-supervisor.md). A mismatch or failed case calls for investigation first. Only the attended Claude decision can close B419/B421 and T900/T899.
