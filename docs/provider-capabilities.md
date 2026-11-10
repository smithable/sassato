# Managed provider capability investigation

Checked on 2026-11-10. Interface discovery and bounded live conversational probes
passed for the versions below. This is evidence for a future optional supervisor,
not a supported managed-session feature. Real task/job handoff, configuration
continuity and UI reconnection remain unproved; the supervisor gate remains closed.
The [sanitized evidence summary](provider-capability-evidence.json) records what ran.

## Local observations

| Provider | Installed version | Observed locally | Not established |
| --- | --- | --- | --- |
| Codex | `0.167.0` | App-server schema generation succeeds; explicit thread start/resume/compact and turn interruption methods exist; completion events exist; TUI help offers `--remote` | Real job/process replacement, UI reconnection and settings continuity |
| Claude Code | `2.1.321` | Help offers `--print`, streaming input/output, explicit `--session-id`/`--resume`, model and permission controls | SDK library integration, interruption outcome, interactive-terminal continuity and settings continuity |

The local CLI login-status probes reported existing ChatGPT authentication for
Codex and claude.ai authentication for Claude. Account identifiers and credentials
were not recorded. Neither provider SDK resolved from this repository; none was
installed for this check. Versions and interface availability are observations,
not a minimum-version compatibility promise.

Run the non-model discovery probe from a source checkout:

```sh
node scripts/provider-capabilities.mjs
```

It reads CLI version/help and generates the Codex protocol schema in a temporary
directory, then removes that directory. It does not log in, inspect credentials,
start a server, invoke a model, change provider settings or update Sassato state.
Missing commands or changed schema layouts report unavailable/unconfirmed fields.
The output always distinguishes interface discovery from live validation.

## Live observations

The probes used temporary working directories, explicit provider identities and
existing authentication. They did not change config/auth, invoke tools, install
SDKs or connect to existing worker sessions. Normal provider runtime logs may
still be written. Default models/settings were left in place: Codex reported
`gpt-6-astra`, read-only sandbox and on-request approval; Claude reported
`claude-opus-5-5` and default permission mode.

| Operation | Codex 0.167.0 | Claude Code 2.1.321 |
| --- | --- | --- |
| Generate modest conversation history | Two turns passed | Two turns passed |
| Request and confirm compaction | `contextCompaction` started/completed and completed turn observed | `compact_boundary` and success observed through native CLI streaming |
| Recall marker, constraint and next action afterward | Passed | Passed |
| Fresh conversation follows supplied recovery text | Passed with distinct ephemeral thread | Passed with distinct explicit session UUID |
| Owned process shutdown | Exit 0 | Both print processes exited 0 |
| Additional interruption/error probe | Interrupted turn confirmed; nonexistent thread rejected | Not exercised beyond invalid CLI option rejection |
| Invalid CLI option | Rejected with exit 2 | Rejected with exit 1 |

Recovery used a synthetic text fixture naming a role, task and exact next action.
It did not read an actual Sassato database or transfer a live task, waiter or tool.
The Claude test sent `/compact` to its own native `--print` process with streaming
JSON input/output and session persistence disabled; it did not install or test an
SDK library. A successful native probe does not establish an SDK product's auth
eligibility or access to another terminal.

The opt-in reproduction script requires a source checkout, POSIX process groups
and Python 3. It invokes real models using the existing authentication and defaults;
it is never run by the normal build, tests or package smoke checks:

```sh
python3 scripts/provider-live-probe.py --provider codex
python3 scripts/provider-live-probe.py --provider claude
```

It creates temporary directories and new identities, allows bounded conversational
turns, checks completion and recall, and reaps only its own children. Output is a
sanitized JSON result, without transcripts, account details, IDs or machine paths.
It exits nonzero when a capability or completion signal cannot be verified. No
config/auth changes, trust-prompt bypass flags or credential copying are performed.
The extra interruption/error observations above are from a separate bounded probe;
the reproduction script covers history, compaction, recall and fresh recovery.

## Candidate adapters

| Provider/mode | First candidate | Completion evidence required |
| --- | --- | --- |
| Codex managed conversation | Local app-server with explicit thread IDs; retain the configured authentication and permission scope | Match the requested thread's `contextCompaction` item lifecycle and turn outcome; request acceptance alone is insufficient |
| Codex interactive UI | Evaluate attaching the TUI through `--remote` to the managed server | Demonstrate disconnect/reconnect without duplicate execution or settings loss |
| Claude managed native CLI | A supervisor-owned print/stream-JSON process with explicit session ID; fresh-process replacement and in-place compact are candidates | Verified old-process exit before replacement, new startup, recovery acknowledgment; compact requires the boundary signal |
| Claude SDK conversation | Separate optional adapter, only after selecting an authentication mode appropriate for the integration | Observe `compact_boundary`; a successful result with no boundary is not proof of compaction |

Codex documents fresh threads through `thread/start`, compaction through
`thread/compact/start`, and asynchronous completion notifications. The installed
generated schema confirms those names and requires `threadId` for compaction;
`turn/interrupt` requires both thread and turn IDs. Remote TUI attachment is also
documented, but retaining the existing UI has not been tested here.
[Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)

Claude documents `/compact` in an SDK-managed conversation, with enough prior
history to summarize. A successful result may occur without compaction, so require
the boundary event. Streaming `/clear` starts empty conversation context; a new
one-shot query already does that. Always target the captured session ID rather than
“continue latest” when roles share a directory. This does not establish control of
an independently opened interactive terminal.
[Claude SDK commands](https://code.claude.com/docs/en/agent-sdk/slash-commands)

The CLI's print mode is a documented programmatic entry point. Its setup differs
from an interactive terminal: it skips the workspace trust dialog, and bare mode
changes which configuration and authentication sources load. Do not use bare mode
as an automatic workaround for startup problems or silently alter permission scope.
[Claude programmatic use](https://code.claude.com/docs/en/headless)

The SDK documentation places restrictions on third-party products offering
claude.ai login or rate limits without prior approval. Consequently, the existing
subscription login is not evidence that a publicly distributed SDK adapter may use
that authentication arrangement. Do not silently switch users to API credentials
or a different billing path. Resolve the intended integration/authentication mode
before testing or advertising that adapter.
[Claude SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)

## Integration validation still required

Use a disposable repository and dedicated sessions, never an active worker's
provider ID. Keep the configured model, directory, instructions, hooks, tools and
approval scope. The test must make real model calls, so use the intentionally
selected existing authentication mode and record it without account identifiers.

1. Retain the conversational compaction checks above in an opt-in suite and test
   failure/no-boundary outcomes. A fixture pass is not permission to infer success
   from an immediate command acknowledgment.
2. Save a Sassato checkpoint, start fresh context under the same role and verify
   the next action, task ownership, dirty worktree and retained waiter cursor.
3. Exercise errors, interruption, startup failure and process exit. Treat lost
   acknowledgments as uncertain state, not permission to launch another worker.
4. Demonstrate the UI behavior for the selected adapter and terminal mode. Generic
   app-server or SDK success does not establish Windows Terminal/WSL compatibility.
5. Record exact versions and settings, success/failure evidence and unsupported
   cases before enabling any supervisor path.

Native automatic compaction remains enabled. No proposed transition command is
implemented by this investigation, and no agent should end its live session record,
inject terminal keystrokes or modify provider transcripts to simulate one.
