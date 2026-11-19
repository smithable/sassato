# Wake urgency and workspace speed

Proposed for Fable’s decision (T931). Sol would build after design approval. A human opts the workspace into scored delivery. Existing installations keep their current waiter policy until then.

## When the waiter returns

Wake when a role’s eligible, undelivered work reaches its threshold, or when any entry reaches its own deadline. Count age from that entry’s original event time across invocations. At normal speed, a single urgent message wakes within two minutes and a reply request within five. A single ordinary message has no timer. Ten ordinary messages can still reach the normal threshold together. Entries weighing 0–1 ride the next delivery, including an idle wake when the role has eligible work. An ordinary inbox alone does not qualify a role for an idle wake. To cover the numeric score 2, use the same five-minute deadline as 3–4. Take the earliest deadline across pending entries; a new message never postpones an urgent one.

| Incoming item | Points |
| --- | ---: |
| Ordinary mail, another role finishing my requested task, review approved | 1 |
| Reply requested, assigned or newly ready task, requested review, resolved blocker | 3 |
| Urgent mail, review rejected, blocker assigned to me, dropped dependency needing my decision | 5 |
| STOP, an answer to my human question, an outstanding valid supervisor ping, mail sent with now | Immediate |

STOP has precedence over all work and stops dispatch until human resume. Preserve file STOP, generation and nonce checks, acknowledgement deadlines and launcher enrollment fences. Immediate items beat scoring and digest filters where required by the existing safety and control semantics. A STOP never consumes unrelated work. Put immediate items and the trigger on the first page, then sort scored items by descending weight and oldest timestamp, with event ID breaking ties. A completion that also makes my task ready scores the actionable ready transition once, at 3. Include the full eligible batch on an ordinary threshold or age wake, even if the trigger was one entry. Retain digest pagination and the pending-result receipt contract.

Use existing recipient, assignment and reviewer eligibility rules. Exclude self-generated and already handled events, and respect ordinary digest-skip preferences. Count a message once per recipient by message ID. Marking it read keeps it eligible; acknowledging removes it. Successful delivery advances a durable per-role delivery position even if acknowledgement comes later. Unacknowledged items remain in inbox without raising the same score on every re-arm. Workflow transitions use their event ID and current eligibility. Drop superseded transitions before scoring; repeated updates to one outstanding obligation keep its first timestamp. Score the complete eligible set before applying output limits. A truncated digest must retain a discoverable path to every omitted item. Never advance past unseen entries without either staging them or preserving them for a later delivery.

Take one consistent read for eligibility, effective settings and the digest boundary. On scored wake or launcher consumption, commit progress using the existing expected-version check; on timeout, cancellation, uncertain queue delivery or a failed write, preserve pending work. A raw wait that does not persist progress remains a read-only preview; repeated use with the same cursor can repeat a result. Recheck STOP at dispatch and consumption. A settings change recomputes from existing timestamps; lowering the speed cannot reset the oldest age. If a process restarts and the threshold or age was already reached, return on the first scan.

## What senders and operators set

Proposed CLI: `send --urgency 0..10` accepts integers only. Ordinary defaults to 1. Keep the reply obligation independent of its weight. With legacy flags use the highest implied weight, including 5 for urgent plus reply. An explicit number sets the weight and may accompany needs-reply. Reject conflicting explicit urgent/number combinations with a usage error. Keep now as the existing immediate override, including existing sender access; record its use. Preserve the old flags and fields for older readers. Save the effective score, immediate flag, reply flag, actor and optional reason in the send transaction. For pre-upgrade messages derive score from their stored flags and now from the corresponding send event. New clients needing numeric semantics must check workspace capability before enabling scored mode.

Agents can set 0–5 freely. Require a short nonempty reason for 6–10, validate server-side, and keep it in the coordination audit. A high number cannot bypass the receiver threshold. Show senders their submitted score, and show the recipient why a digest woke (total/threshold, age limit or immediate cause). Report high-score reasons and repeated now overrides by sender to the operator. A reason provides an audit trail rather than proof of urgency. Score zero is for directed work that may wait for another delivery; background telemetry stays outside the eligible set. Speed never changes a sender’s score.

Only a human may set workspace speed or a role’s base threshold and timed age limits. Default normal values are 10 points, two minutes for scores 5–10 and five minutes for scores 2–4. Slow doubles the threshold and triples each finite age. Fast halves the threshold (round up to at least 1) and multiplies finite ages by 0.3 (round up to at least one second). Scores 0–1 have no age trigger at any speed.

| Speed | Threshold | Age, 5–10 | Age, 2–4 | Eligible-work idle check | Checkpoint age before asking | Minimum between supervisor pings |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Slow | 20 | 6 min | 15 min | 100 min | 120 min | 5 min |
| Normal | 10 | 2 min | 5 min | 50 min | 60 min | 2 min |
| Fast | 5 | 36 sec | 90 sec | 25 min | 30 min | 1 min |

Idle checks wake only for eligible work and retain the existing opt-out. Checkpoint age applies only to a working role with evidence of activity since its save. Keep one outstanding ping per generation, its current response deadline, and existing STOP, busy and lifecycle guards. Speed changes authorize neither a new supervisor nor a provider action. Current monitor code has a one-minute minimum ping interval and a two-minute deadline; opting into normal intentionally reduces ping frequency. A legacy explicit settle/settle-max invocation uses the old batching algorithm for that call; explicit idle and timeout bounds keep their meaning. Document this precedence for scripts.

## Estimated wake cost

Read-only replay of the same 168 hours, 12 November 2026 00:00 to 19 November 00:00 UTC (end exclusive), for eight agent roles. Each policy receives the same historical stream. The baseline starts a digest on waking mail or workflow events (including assigned and ready work), waits for two minutes of quiet, and caps batching at ten minutes. Ordinary mail alone never starts that window. Its 50-minute idle check starts a digest only for eligible work. Scored profiles use the thresholds, entry deadlines and idle intervals above.

| Policy | Potential deliveries | Workspace wakes/hour | Fable deliveries | Fable wakes/hour |
| --- | ---: | ---: | ---: | ---: |
| Current policy | 2,133 | 12.70 | 385 | 2.29 |
| Slow | 853 | 5.08 | 110 | 0.65 |
| Normal | 1,703 | 10.14 | 246 | 1.46 |
| Fast | 3,701 | 22.03 | 627 | 3.73 |

Normal produced 430 fewer potential workspace deliveries (20.2%) and 139 fewer for Fable (36.1%). Its urgent deadline is measured from arrival, so later ordinary traffic cannot extend a lone urgent message’s wait past two minutes. Fast trades more frequent eligible-work checks and earlier threshold crossings for shorter waits.

The projection routes mail by receipt, reconstructs task and routing state from audit patches, and includes observed STOP/resume, answers and ping requests. At each idle check it looks for owned work in progress or an eligible open task, accounting for recorded dependencies, blockers, questions and open-work routing. A role write during the interval suppresses that idle check. The simulated waiter immediately re-arms after each delivery. These counts replace the earlier directed-events-only replay, which omitted idle and general readiness. They estimate opportunities to wake rather than billed turns. Unknown state in older imports, superseded workflow items, nondefault digest filters, file-only STOP, provider uptime, and time spent doing work can affect real counts. Pending deliveries start empty at the left boundary. Speed does not synthesize extra pings in this replay. Compare observed wake reasons and latency during a human-authorized trial before treating the estimates as savings.

## Acceptance and rollout

1. Add settings and audit fields with legacy defaults. Test old messages, numeric bounds, aliases, conflicting flags, reason checks, broadcast and human-only policy writes.
2. Add the receiving policy behind opt-in. Use a controllable clock for threshold equality, zero score, early ack, repeated read/re-arm, speed changes, timeout and restart. Verify a large digest, concurrent waiters and an unconsumed staged result preserve every obligation.
3. Connect idle and supervisor scheduling; test the three profiles and disabled features, STOP during dispatch, and a near-deadline ping alongside ordinary mail. Keep rollout independent of installation or enabling real sessions.
