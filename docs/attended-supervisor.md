# Attended supervisor: installation and disposable trials

Release 1 is a cooperative **two-generation probe**, started and watched by a
human. It does not adopt existing sessions, install hooks, change provider/host
settings, or enable unattended management. Its implementation contract is
[supervisor.md](supervisor.md). A process group is an observation boundary, not
confinement: the worker must settle every tool, waiter, helper and detached job.
A provider with helpers that remain alive cannot pass; do not exempt helpers or
change provider configuration to make it pass.

Source/CI fixture results are separate from installation and real-provider
acceptance. A human performs the Codex trial first, then Claude only after Codex
passes. Keep a human assistant present. Use disposable Git repositories and new
roles; never use an existing worker or valuable checkout. The commands below are
operator instructions, not actions for a coding session to execute.

## 1. Review, backup, stop, install, restart

The release reviewer must read the foundations/controller changes and the attended
implementation on their exact approved commits. Source merge alone is not install
permission. Record the approved merge commit and deployment authorization first.
Linux/WSL, Node 24.13+ with `process.execve`, Python 3 with Linux pidfds, Git and
`flock` are required. Provider executables must already be installed and signed in.

In the operator's terminal, set these to the actual existing database, human role
and approved merge commit. Retain the previous installed release's package tarball
for rollback and set `PREVIOUS_PACKAGE` to its absolute path; do not use a package
with only a matching version number. Do not use an unreviewed branch or overwrite
a backup. Run these installation/rollback blocks in a dedicated Bash shell with
`set -e` so a failed command stops the procedure:

```bash
set -e
export PROBE_DB="$HOME/.local/share/sassato/sassato.db"
export LIVE_HUMAN='your-existing-human-role'
export APPROVED_MERGE='the-reviewed-40-character-merge-commit'
export INSTALL_EVIDENCE="$HOME/repos/.session-scripts/supervisor-test/$(date +%Y-%m-%d-%H%M%S)-install"
mkdir -m 700 "$INSTALL_EVIDENCE"
export PREVIOUS_PACKAGE='/absolute/path/to/the-previous-installed-release.tgz'
test -f "$PREVIOUS_PACKAGE"
sassato --version --json > "$INSTALL_EVIDENCE/before-install-version.json"
export INSTALL_BACKUP="$INSTALL_EVIDENCE/before-install.db"
export INSTALL_VERSION="$INSTALL_EVIDENCE/before-install-version.json"
sassato backup "$INSTALL_BACKUP" --db "$PROBE_DB" --workspace smithable --as "$LIVE_HUMAN"
python3 - <<'PY_INSTALL_STATE'
import json, os, pathlib
state = {key: os.environ[key] for key in ('PROBE_DB', 'LIVE_HUMAN', 'PREVIOUS_PACKAGE')}
for key in ('PROBE_DB', 'PREVIOUS_PACKAGE'):
    assert pathlib.Path(state[key]).is_absolute(), key + ' must be absolute'
(pathlib.Path(os.environ['INSTALL_EVIDENCE']) / 'install-state.json').write_text(json.dumps(state))
PY_INSTALL_STATE
sassato stop --all --db "$PROBE_DB" --workspace smithable --as "$LIVE_HUMAN"
sassato stop-status --db "$PROBE_DB" --workspace smithable --as "$LIVE_HUMAN"
```

Wait for every session/job to checkpoint and stop; do not mark live sessions ended
or force a launch. Preserve the shared stop file's original state. The human then
uses a new installation checkout (choose a fresh path if this one exists):

```bash
git clone https://github.com/smithable/sassato.git "$HOME/repos/wt/sassato-attended-install"
cd "$HOME/repos/wt/sassato-attended-install"
git checkout --detach "$APPROVED_MERGE"
test "$(git rev-parse HEAD)" = "$APPROVED_MERGE"
npm ci --ignore-scripts
npm run build
npm pack --pack-destination "$INSTALL_EVIDENCE"
npm install --global "$INSTALL_EVIDENCE"/sassato-*.tgz
sassato --version --json
sassato migrate --db "$PROBE_DB"
sassato doctor --db "$PROBE_DB" --workspace smithable --as "$LIVE_HUMAN" --json
```

Save the version/build, migration and doctor output. Confirm doctor reports
`"ok": true` and `"schema": 11` for `PROBE_DB` before continuing. The version
command reports the CLI schema; doctor reads the database schema. Perform the
planned WSL restart from the Windows terminal (`wsl --shutdown`) only after jobs
have stopped. Reopen the operator and assistant terminals. The human alone reconciles and clears their own prior STOP
requests when ready; never clear someone else's request to make a probe pass.
Do not launch ordinary workers during the controlled trial window.

When ordinary sessions restart after the trial window, their first coordination
step is the digest waiter, after reading checkpoint/context/inbox and their saved
notification cursor: `sassato wait --since CURSOR --as ROLE --workspace smithable`.
It batches urgent/needs-reply mail and workflow events after 120 seconds of quiet,
600 seconds at most. STOP, human answers and `--now` mail wake it immediately;
reserve `--now` for an outage, broken main or a stop that cannot wait. Handle each
digest entry, acknowledge handled mail, save the returned cursor with its expected
progress version and re-arm one waiter. Never advance to the latest context cursor
or re-arm during STOP.

### Roll back the installation

The old CLI cannot open the migrated database. Going back requires both the exact
previous CLI package and `before-install.db`; reinstalling the old CLI alone is
insufficient. Restoring loses coordination changes made since that backup, so the
human must reconcile those changes before resuming workers. Keep all sessions and
jobs stopped, close every other database client, and preserve the shared STOP file.
`INSTALL_EVIDENCE` always identifies the installation directory; trial setup uses
`TRIAL_EVIDENCE` separately. After a shell/WSL restart, recover the installation
variables below using the actual retained installation directory, never a trial
directory. Do this before stopping or changing any installation/database files:

```bash
set -e
export INSTALL_EVIDENCE='/absolute/path/to/the-retained-install-directory'
export INSTALL_BACKUP="$INSTALL_EVIDENCE/before-install.db"
export INSTALL_VERSION="$INSTALL_EVIDENCE/before-install-version.json"
PROBE_DB="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["PROBE_DB"])' "$INSTALL_EVIDENCE/install-state.json")"
export PROBE_DB
LIVE_HUMAN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["LIVE_HUMAN"])' "$INSTALL_EVIDENCE/install-state.json")"
export LIVE_HUMAN
PREVIOUS_PACKAGE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["PREVIOUS_PACKAGE"])' "$INSTALL_EVIDENCE/install-state.json")"
export PREVIOUS_PACKAGE
python3 - <<'PY_PREFLIGHT'
import json, os, pathlib, sqlite3, tarfile
backup, package, version_file = (pathlib.Path(os.environ[key]) for key in
                                ('INSTALL_BACKUP', 'PREVIOUS_PACKAGE', 'INSTALL_VERSION'))
assert all(path.is_absolute() and path.is_file() for path in (backup, package, version_file))
version = json.loads(version_file.read_text())
assert version['build'] and version['version'] and isinstance(version['schema'], int)
with sqlite3.connect(backup.as_uri() + '?mode=ro', uri=True) as db:
    assert db.execute('PRAGMA user_version').fetchone()[0] == version['schema'], 'Backup schema differs'
    assert db.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'Backup integrity failed'
    assert db.execute('PRAGMA foreign_key_check').fetchall() == [], 'Backup foreign keys failed'
with tarfile.open(package, 'r:gz') as archive:
    metadata = json.load(archive.extractfile('package/package.json'))
    assert metadata['name'] == 'sassato' and metadata['version'] == version['version']
print('Backup schema/integrity and rollback package preflight passed')
PY_PREFLIGHT
sassato stop --all --db "$PROBE_DB" --workspace smithable --as "$LIVE_HUMAN"
sassato stop-status --db "$PROBE_DB" --workspace smithable --as "$LIVE_HUMAN"
```

Wait for every worker/job to settle and every other database client to close.
Reinstall the old CLI, verify its exact build, then restore and validate a staging
database **before moving the live database**. The staging path is beside `PROBE_DB`
so final placement stays on the same filesystem. Restore refuses an existing path.

```bash
set -e
export ROLLBACK_EVIDENCE="$INSTALL_EVIDENCE/rollback-$(date +%Y-%m-%d-%H%M%S)"
mkdir -m 700 "$ROLLBACK_EVIDENCE"
npm install --global "$PREVIOUS_PACKAGE"
sassato --version --json > "$ROLLBACK_EVIDENCE/cli-version.json"
python3 - <<'PY_VERSION'
import json, os, pathlib
expected = json.loads(pathlib.Path(os.environ['INSTALL_VERSION']).read_text())
actual = json.loads((pathlib.Path(os.environ['ROLLBACK_EVIDENCE']) / 'cli-version.json').read_text())
assert all(actual[key] == expected[key] for key in ('version', 'build', 'schema')), 'Wrong rollback CLI'
PY_VERSION
export RESTORED_DB="$PROBE_DB.rollback-$(date +%Y-%m-%d-%H%M%S)"
sassato restore "$INSTALL_BACKUP" --db "$RESTORED_DB"
sassato doctor --db "$RESTORED_DB" --workspace smithable --as "$LIVE_HUMAN" --json > "$ROLLBACK_EVIDENCE/doctor.json"
python3 - <<'PY_PLACE'
import json, os, pathlib, sqlite3
expected = json.loads(pathlib.Path(os.environ['INSTALL_VERSION']).read_text())
target = pathlib.Path(os.environ['ROLLBACK_EVIDENCE'])
report = json.loads((target / 'doctor.json').read_text())
source, restored = (pathlib.Path(os.environ[key]) for key in ('PROBE_DB', 'RESTORED_DB'))
assert source.is_absolute() and source.is_file() and restored.is_file()
assert report['ok'] and report['schema'] == expected['schema'], 'Staging validation failed'
# Close/checkpoint staging WAL before placing the database; never lose restored data.
db = sqlite3.connect(restored)
try:
    assert db.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0] == 0
finally:
    db.close()
# Preserve migrated files beside the live path, on the same filesystem.
preserved = pathlib.Path(str(restored) + '.migrated')
preserved.mkdir(mode=0o700)
for suffix in ('', '-wal', '-shm', '-journal'):
    path = pathlib.Path(str(source) + suffix)
    if path.exists():
        path.rename(preserved / path.name)
restored.rename(source)
# Retain any checkpointed staging sidecars as evidence under their distinct names.
for suffix in ('-wal', '-shm', '-journal'):
    path = pathlib.Path(str(restored) + suffix)
    if path.exists():
        path.rename(preserved / path.name)
print('Migrated database preserved at', preserved)
PY_PLACE
sassato doctor --db "$PROBE_DB" --workspace smithable --as "$LIVE_HUMAN" --json
```

Verify the CLI build matches `INSTALL_VERSION`, doctor reports `ok`
and the previous schema, and the expected workspace records are present. If any
step fails, keep workers stopped and preserve all evidence; do not migrate the
restored database with the newer CLI. Only the human reconciles prior STOP
requests and authorizes workers to resume.

## 2. Prepare one disposable trial

Use the **same local database** so machine-wide jobs remain visible, but a separate
`supervisor-probe` workspace. Do not place SQLite or coordination locks on a network
share. Set `PROVIDER=codex` and `SOURCE_ROLE` to an existing configured Codex role;
for the second trial use `claude` and a configured Claude role. The script copies
only Sassato role settings; it does not edit a provider's configuration.
Choose a new evidence directory for each normal/STOP/crash trial, and new disposable
role/repository names for repeat trials (enrollment and generation tombstones are
intentionally retained). The normal first roles are `probe-codex`, `probe-claude`.

After the planned WSL restart, recover the installation paths in the new operator
shell before preparing a trial. Launch locks left by the launchers the restart ended are cleared by
the next `sassato launch` (a `launch-lock` event); no `launch-unlock` is needed for them. Use the actual retained installation directory:

```bash
set -e
export INSTALL_EVIDENCE='/absolute/path/to/the-retained-install-directory'
PROBE_DB="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["PROBE_DB"])' "$INSTALL_EVIDENCE/install-state.json")"
export PROBE_DB
LIVE_HUMAN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["LIVE_HUMAN"])' "$INSTALL_EVIDENCE/install-state.json")"
export LIVE_HUMAN
export PROVIDER=codex
export SOURCE_ROLE='your-existing-codex-role'
export PROBE_ROLE="probe-$PROVIDER"
export PROBE_REPO="$HOME/repos/wt/$PROBE_ROLE"
export TRIAL_EVIDENCE="$HOME/repos/.session-scripts/supervisor-test/$(date +%Y-%m-%d-%H%M%S)-$PROVIDER"
mkdir -m 700 -p "$TRIAL_EVIDENCE"
sassato roles --db "$PROBE_DB" --workspace smithable --as "$LIVE_HUMAN" --json > "$TRIAL_EVIDENCE/source-roles.json"
sassato init --db "$PROBE_DB" --workspace supervisor-probe --humans operator --as operator --no-interactive
mkdir -m 700 "$PROBE_REPO"
git -C "$PROBE_REPO" init -b main
git -C "$PROBE_REPO" commit --allow-empty --signoff -m 'Initialize disposable attended trial'
```

The scratch repository needs the operator's normal Git name/email configured
already. Keep any required local commit trailers. Do not change global Git settings
for this test. The initial empty commit is setup; the probe must add two distinct
task commits.

Configure the disposable coordination records with this script:

```bash
python3 - <<'PY'
import json, os, pathlib, subprocess
root = pathlib.Path(os.environ['TRIAL_EVIDENCE'])
db, role, repo = (os.environ[key] for key in ('PROBE_DB','PROBE_ROLE','PROBE_REPO'))
base = ['--db', db, '--workspace', 'supervisor-probe']
def sas(*args, actor='operator'):
    return json.loads(subprocess.check_output(['sassato', *args, *base, '--as', actor, '--json'], text=True))
roles = json.loads((root / 'source-roles.json').read_text())
source = next(row for row in roles if row['name'] == os.environ['SOURCE_ROLE'])
assert source['kind'] == 'agent' and source['provider'] == os.environ['PROVIDER']
args = ['role','set',role,'--provider',source['provider'],'--dir',repo]
for key, flag in [('model','model'),('reasoning_effort','effort'),('sandbox_mode','sandbox'),('approval_policy','approval'),('permission_mode','permission-mode')]:
    if source.get(key) is not None:
        args += ['--' + flag, source[key]]
sas(*args)
sas('role','set','probe-controller','--kind','agent')
# Actual house guards: merge-green uses exclusive-create, not flock.
# Check both gate lock locations, because the runner can use the system path.
checks = [
    {'name':'gate-system','type':'flock','path':'/var/lib/smithable-gate/.gate-lock'},
    {'name':'gate-user','type':'flock','path':str(pathlib.Path.home() / 'repos/.gate-lock')},
    {'name':'merge','type':'command','argv':['python3','-c',
      'import os,sys;sys.exit(0 if os.path.lexists(sys.argv[1]) else 1)',
      str(pathlib.Path.home() / 'repos/.merge-lock')], 'cwd':repo,'timeout_ms':1000},
    {'name':'release-heavy-jobs','type':'command','argv':['python3','-c',
      'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); sys.exit(0 if c.execute("SELECT 1 FROM jobs WHERE status IN (\'waiting\',\'running\') OR (orphans IS NOT NULL AND orphans!=\'[]\')").fetchone() else 1)', db],
      'cwd':repo,'timeout_ms':1000}
]
(root / 'busy-checks.json').write_text(json.dumps(checks))
sas('workspace','set','--stop-file',str(pathlib.Path.home() / 'repos/stop'),
    '--busy-checks',json.dumps(checks))
checkout = sas('checkout','register','--dir',repo)
task = sas('add','Disposable attended two-step task','--for',role,'--owner',role)
sas('take',task['id'],actor=role)
# A fresh role has no prior notifications to lose. Replays start from zero.
sas('progress','save','--cursor','0','--expect','0',actor=role)
policy = {'checkout':checkout['checkout_id'],'task':task['id'],
          'controller_role':'probe-controller',
          'controller_lock':str(root / 'controller.lock'),
          'maintenance_lock':str(pathlib.Path.home() / 'repos/.sassato-git.lock')}
(root / 'enrollment.json').write_text(json.dumps(policy))
sas('supervise','enroll','--role',role,'--file',str(root / 'enrollment.json'))
(root / 'trial.json').write_text(json.dumps({'role':role,'task':task['id'],'repository':repo,'database':db},indent=2))
PY
```

These observations cover the named gate/merge guards and booked jobs. Schedule a
controlled idle window: no unrelated releases, gates or unbooked heavy work may
start during the trial. Attended release 1 does not prove complete exclusion of
detached/unbooked job sources. Missing/error/unknown guards block; never replace a
failed check with an unconditional idle command. Enrollment adds shared maintenance
leases to Sassato `job run`; it does not alter a host service or lock policy.

## 3. Run, confirm, and preserve replay evidence

Use a terminal recorder that preserves TTY input/output (`tee` does not). For
example start `script -q -f -e "$TRIAL_EVIDENCE/controller.log"`, then run the applicable
command inside that recorded shell. The controller requires a human terminal:

```bash
sassato supervise --attended --role probe-codex --db "$PROBE_DB" --workspace supervisor-probe --as operator
# Only after a passing Codex trial, in its separately prepared Claude trial:
sassato supervise --attended --role probe-claude --db "$PROBE_DB" --workspace supervisor-probe --as operator
```

The controller prints a command for a **second terminal**. Open it and use that
exact `supervise attach --role ...` command; this is the provider's terminal.
Confirmation input stays in the controller terminal. Ctrl-] detaches the client
without ending the worker. Provider output cannot supply retirement Enter.
Reattach to generation 2 with the same attach command after its release.

Generation 1 receives a fixed task: write `line one` to `attended-probe.txt`, commit
only that file, and leave `attended-sentinel.txt` uncommitted with the exact bytes
`keep these bytes\n`. It acknowledges its fresh actual conversation identity,
reads live state/Git and the saved cursor, settles its waiter and every tool/job,
and calls `supervise ready` as its last tool. Its complete brief and checkpoint
are saved atomically. It then remains silent with no waiter. If it asks for help,
use its separate terminal; never weaken a failed guard.

At the first retirement prompt, **before pressing Enter**, enqueue a unique mail
from a third human/assistant terminal and save its ID. A new terminal does not
inherit the operator shell's exports: first set this trial's actual evidence path
and recover its database/role from the recorded `trial.json`. Use this recovery
block in any replacement terminal too; never guess a fresh evidence directory:

```bash
set -e
export TRIAL_EVIDENCE='/absolute/path/to/this-trial-evidence-directory'
PROBE_DB="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["database"])' "$TRIAL_EVIDENCE/trial.json")"
export PROBE_DB
PROBE_ROLE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["role"])' "$TRIAL_EVIDENCE/trial.json")"
export PROBE_ROLE
sassato send "$PROBE_ROLE" "attended-replay-$(date +%s)-$PROBE_ROLE" --urgent --db "$PROBE_DB" --workspace supervisor-probe --as operator --json > "$TRIAL_EVIDENCE/replay-message.json"
sassato progress show --db "$PROBE_DB" --workspace supervisor-probe --as "$PROBE_ROLE" --json > "$TRIAL_EVIDENCE/ready-cursor.json"
```

Do not advance generation 1's handled cursor. Inspect the proposal: role,
generation, boot/start/PID/PGID identity, checkout, HEAD/dirty manifest, brief and
successor. Only Enter approves this one transition. Other input, EOF or terminal
loss cancels; a failed recheck blocks even after Enter. The maintenance lease is
acquired nonblocking only after Enter. The controller uses identity-bound pidfd
TERM with a 30-second limit; no KILL fallback or automatic startup retry exists.

Generation 2 must reconcile the previous brief, exact Git/dirty state and cursor,
read/acknowledge the unique notification once, preserve the sentinel bytes and
append `line two` in a second commit of only `attended-probe.txt`. Legitimate
notification redelivery must remain possible; do not skip ahead to a newer context
cursor. At its final ready prompt inspect and press Enter again. Expect verified
exit followed by `stopped`, reason `completed`, task completion, released probe
checkout reservation, and **no generation 3**. A successful source test is not a
passing real-provider trial.

## 4. Stop, recover, collect evidence

To interrupt a trial without approving retirement, cancel the confirmation or
terminate **the controller PID you started**. The provider's PTY holder survives;
the checkout/reservation stays intact. Do not kill a discovered terminal, edit a
provider transcript, use `session end`, or reset/stash/delete files. For durable
STOP, the human runs `sassato stop "$PROBE_ROLE" --db "$PROBE_DB" --workspace
supervisor-probe --as operator`. An unreleased bootstrap exits without launching
the provider. A released worker cooperatively checkpoints/stops; no successor is
launched. A retirement timeout or unknown identity needs human reconciliation.
Do not retry by reenrolling a tombstoned role. Ordinary `sassato launch` also
refuses any managed generation reservation, including uncertain and completed
probe generations. Pending ordinary native/terminal launchers block a managed
start even before session registration. Do not remove their lock to force the
trial; reconcile the launcher first. Use a fresh disposable role for a new trial.

Use fresh disposable roles/checkouts for additional trials. In the **crash trial**,
terminate the recorded controller after generation 1 becomes ready and before
approving its retirement. Restart the same attended command, with the same
role/database/enrollment. It must reconcile the existing identity/launch, keep one
worker and require fresh Enter. Finish through generation 2 acknowledgment,
notification replay, preserved sentinel and final verified exit. Recovery never
inherits an old Enter and never respawns an uncertain/unregistered startup.

For the **shared-stop trial**, the human schedules a window with no unrelated
sessions active, records whether `~/repos/stop` already exists, and only creates it
when it was absent. Start a newly prepared trial with the stop file present:
expect refusal and zero worker/launch events. The human removes only the stop
request/file they created, afterward. Agents must not perform this machine-wide
trial or clear a pre-existing request.

Save the following per trial (the recorder log and private runtime PTY log must be
retained; neither is a native provider transcript to edit):

```bash
# In a replacement terminal, export TRIAL_EVIDENCE as in the recovery block first.
PROBE_DB="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["database"])' "$TRIAL_EVIDENCE/trial.json")"
PROBE_REPO="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["repository"])' "$TRIAL_EVIDENCE/trial.json")"
export PROBE_DB PROBE_REPO
sassato show "$(python3 -c 'import json,os;print(json.load(open(os.environ["TRIAL_EVIDENCE"]+"/trial.json"))["task"])')" --db "$PROBE_DB" --workspace supervisor-probe --as operator --json > "$TRIAL_EVIDENCE/task.json"
sassato sessions --db "$PROBE_DB" --workspace supervisor-probe --as operator --json > "$TRIAL_EVIDENCE/sessions.json"
sassato export "$TRIAL_EVIDENCE/export" --db "$PROBE_DB" --workspace supervisor-probe --as operator
sassato backup "$TRIAL_EVIDENCE/after-trial.db" --db "$PROBE_DB" --workspace supervisor-probe --as operator
git -C "$PROBE_REPO" log --format=fuller > "$TRIAL_EVIDENCE/git-log.txt"
git -C "$PROBE_REPO" status --porcelain=v1 > "$TRIAL_EVIDENCE/dirty.txt"
sha256sum "$PROBE_REPO/attended-sentinel.txt" > "$TRIAL_EVIDENCE/sentinel.sha256"
```

Keep the `.sat-<controller-id-prefix>-<generation>` runtime directories beside the
database; they hold terminal sockets/logs and are named in transition payloads.
The terminal files are not automatically deleted.
Each `terminal.log` keeps the first 8 MiB of provider output. After that, the holder
continues to drain and relay output, and reattach still replays the latest 64 KiB.
Input from an attached client waits when the holder's 64 KiB queue is full, so
a provider that pauses reading cannot block the holder from draining its output.
Preserve terminal files until reviewed. Pass requires
two task commits from distinct conversations/generations, one launch per generation,
correct two-line file, unchanged dirty bytes, saved-cursor mail replay, two positive
exit records and final reservation release. For STOP/crash trials also retain zero
launch evidence or fresh approval/restart observations as applicable. An incomplete
trial leaves that provider's attended acceptance open; unattended mode stays off.

### Tool-command admission

A provider tool shell may create a new session and process group. Assignment,
reconciliation and readiness therefore authenticate the current generation token
and prove a live ancestry chain from the invoking CLI to the exact recorded launch
root. The Linux helper pins the root, caller and each intervening process with
pidfds, verifies the boot/start identities and parent edges after pinning, and
rechecks the complete bounded chain and pidfd liveness. Missing or changing evidence
refuses admission. A copied token, matching UID or process group is insufficient.

Assignment authenticates against one database read snapshot. Mutations compare the
complete captured worker row inside the write transaction, check reservation and
binding guards, and obtain a fresh ancestry decision after their writes immediately
before returning to commit. A failed final check rolls the transaction back.
Authorization is decided at the final successful ancestry validation and pidfd poll;
earlier proof is never reused at that boundary. This is admission evidence, not an
atomic process-tree snapshot: pidfds do not freeze parent edges or keep the root
alive. A process may exit or reparent after the decision and an already admitted
command may then commit. There is no guarantee of containment or of rejecting every
exit concurrent with commit. A stricter lifetime-bound guarantee requires a broker
or an enforced lifecycle design. Retirement signaling and cooperative tool/job
settlement remain unchanged; this does not enable unattended mode.
