# A disposable rehearsal for supervisor retirement and recovery

The pending Claude rerun (B419/B421) still needs the attended trial because we cannot yet isolate its sign-in or bound its token usage. An offline fixture rehearsal could catch controller mistakes before the operator starts, and Codex could be the first real CLI considered later.

## Stage 1 — offline controller mechanics

The smallest useful increment is one fixture-only entry point, one container launcher and three integration cases using the existing generation, retirement and recovery machinery. It needs no provider credential, network interface beyond loopback, proxy, token budget or new signing key. Estimate two to four engineering days including refusal tests, subject to checking how much attended-controller logic can be reused. This is a proposal for C after review and authorization.

The launcher acquires the machine's existing gate lock, starts a nonprivileged container with private namespaces and a read-only image pinned to the reviewed commit, and allocates new memory-backed store and checkout volumes. It exposes no host mounts, sockets, user homes or live STOP file. Its inputs select only a fixture case. The rehearsal controller has no option or environment override for an existing store, role, executable or checkout. The production controller cannot dispatch the fixture approver.

Before opening a database the rehearsal controller authenticates its inherited bootstrap channel to the trusted launcher and checks namespace, cgroup and mount identities against that launch. It exclusively creates a new database under a pinned, initially empty store directory and rejects links and pre-existing entries. It creates its own random workspace and fresh disposable roles. A marker file or a caller-supplied path cannot establish eligibility. Fixture workers cannot write the store or the approver channel. For the crash case the surviving launcher retains the database identity, volume handles and run ID for one replacement controller. A changed identity or a lost launcher ends the run as incomplete.

The normal case requires one launch per generation, distinct fixture conversations and task commits, the expected two-line file, unchanged dirty sentinel, saved-cursor mail replay, verified exits and final release. The fixture approver acknowledges a specific reconciled retirement proposal only after tools, waiters and helpers settle. A live helper or changed observation prevents retirement. A second case crashes the controller before retirement and requires fresh approval of the recovered worker. A third starts with a private STOP already present and requires zero launches. A ten-minute timeout ends the case and the launcher disposes of its cgroup and volumes.

## Stage 2 — a separate real-provider decision

Johan would first authorize one attended measurement per provider, using the real CLI on the fixed two-generation fixture task without rehearsal machinery. The measurement records system and tool inputs, cached tokens, outputs and retries across both generations. Its measured total and an explicit allowance for variation determine a proposed hard ceiling for Johan to approve. Stage 2 stays pending until that measurement exists and trusted pre-dispatch accounting can actually enforce the ceiling. A turn count or timeout cannot bound tokens.

Provider access would require a **human-only provisioning task**. Johan supplies and revokes an isolated credential through a read-only memory-backed secret input available to provider bootstrap alone. No session transfers an existing sign-in or mounts a logged-in home. A synthetic-secret test must show that tools cannot read credentials through files, inherited environment, process inspection, logs or exported evidence. The launcher removes secret material, volumes and proxy authorization when the container exits. A worker-side broker for narrowly authorized task operations and a distinct provider identity would be additional Stage 2 work.

| Provider | Candidate route and prerequisite |
| --- | --- |
| Codex | The installed CLI offers device authorization and login from an API key or access token on stdin. Johan could provision a disposable device sign-in separately. Two cold launches must succeed with the isolated credential read-only and the host keyring unavailable. API-key billing requires its own decision. |
| Claude | The installed CLI offers a long-lived subscription token via setup-token. A dedicated token would still need protection from tool subprocesses and an effective revocation path. Until that is demonstrated, Claude remains attended. |

Stage 2 would keep the gate booking and filesystem limits. Its only external network access would go through a proxy restricted to the reviewed provider authentication and inference endpoints. Host services, cloud metadata, general egress, host keyrings, Docker sockets and host plugin configuration stay inaccessible. Each provider needs its own cold-start, isolation and budget tests before launch.

## What a rehearsal proves

- Stage 1 exercises two generations, settlement, private STOP, crash recovery, replay and evidence collection with controlled fixture processes. Refusal tests cover host invocation, existing databases or roles, substituted mounts, stale approval and a surviving helper.
- Stage 2 would additionally exercise the real CLI's process tree, helpers, waiters and conversation identities on the tested commit and configuration.

## What it does not prove

- A human saw and agreed to each retirement.
- The operator's terminal, TTY and WSL restart behave as expected.
- The host installation, migration and rollback steps work.

## Evidence and the attended pass

The proposed exporter writes a separate rehearsal directory containing rehearsal-result.json with a required rehearsal schema kind, fixture or provider identity, case, source commit, image digest and run ID. It retains bounded, redacted transition and process observations, sentinel hash, exit results and failure reason. A new format check would reject the rehearsal filename and kind in any attended-evidence import. This needs a new check and negative tests. Today's attended acceptance is reviewed by a human using the runbook and its original evidence files. A copied or renamed summary cannot establish acceptance.

A successful Stage 1 can eliminate repeated debugging of controller mechanics. After a passing real-provider rehearsal on the same commit, provider version and configuration, the remaining acceptance is one operator pass under the [attended runbook](attended-supervisor.md). A mismatch or failed case calls for investigation first. Only the attended Claude decision can close B419/B421 and T900/T899.
