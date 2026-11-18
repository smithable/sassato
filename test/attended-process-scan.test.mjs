import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../bin/attended-process.py', import.meta.url));

// A process listed by the /proc scan may exit before its stat is read; Linux then answers ESRCH.
// Run observe() with every non-leader stat read raising ProcessLookupError (T944).
const run = (failLeader) => spawnSync('python3', ['-c', `
import importlib.util, os, pathlib, json
spec = importlib.util.spec_from_file_location("ap", ${JSON.stringify(helper)})
ap = importlib.util.module_from_spec(spec); spec.loader.exec_module(ap)
os.setsid()
me = os.getpid()
real = pathlib.Path.read_text
def read_text(self, *a, **k):
    parts = self.parts
    if len(parts) == 4 and parts[1] == "proc" and parts[3] == "stat" and (parts[2] != str(me) or ${failLeader ? 'True' : 'False'}):
        raise ProcessLookupError(3, "No such process")
    return real(self, *a, **k)
pathlib.Path.read_text = read_text
boot = real(pathlib.Path("/proc/sys/kernel/random/boot_id")).strip()
start = real(pathlib.Path(f"/proc/{me}/stat")).rsplit(") ", 1)[1].split()[19]
try:
    print(json.dumps(ap.observe(me, f"{boot}:{start}")))
except ProcessLookupError:
    print("leader-raised")
`], { encoding: 'utf8' });

test('a scanned process that exits mid-read is skipped', () => {
  const result = run(false);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim().startsWith('{'), result.stdout);
});

test('the pinned leader still raises on ESRCH', () => {
  const result = run(true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'leader-raised');
});

// Codex's TUI on WSL keeps a PowerShell clipboard reader as a child in its group (T953). It is
// listed as a helper, not a live member; any other child still blocks, a second reader blocks,
// and the group is not exited while the reader lives. The real executable check is pointed at
// this Python, which stands in for WSL's /init.
const withChildren = (scripts, { leaderGone = false, otherPath = false } = {}) => spawnSync('python3', ['-c', `
import importlib.util, os, pathlib, json, subprocess, sys, tempfile
spec = importlib.util.spec_from_file_location("ap", ${JSON.stringify(helper)})
ap = importlib.util.module_from_spec(spec); spec.loader.exec_module(ap)
ap.WSL_INIT_EXE = os.path.realpath(sys.executable)
os.setsid()
me = os.getpid()
boot = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()
start = pathlib.Path(f"/proc/{me}/stat").read_text().rsplit(") ", 1)[1].split()[19]
if ${leaderGone ? 'True' : 'False'}:
    real = ap.record
    def record(pid, scanning=False):
        row = real(pid, scanning)
        return {**row, "state": "Z"} if row and pid == me else row
    ap.record = record
with tempfile.TemporaryDirectory() as tmp:
    d = pathlib.Path(tmp) / "Windows" / "System32" / "WindowsPowerShell" / "v1.0"
    d.mkdir(parents=True)
    exe = ap.WINDOWS_POWERSHELL = str(d / "powershell.exe")
    if ${otherPath ? 'True' : 'False'}:
        ap.WINDOWS_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
    pathlib.Path(exe).write_text("import sys\\nfor _ in sys.stdin: pass\\n")
    children = [subprocess.Popen(["/init", exe, exe, "-NoProfile", "-NonInteractive", "-Command", script], executable=sys.executable, stdin=subprocess.PIPE) for script in ${JSON.stringify(scripts)}]
    seen = ap.observe(me, f"{boot}:{start}")
    for child in children:
        child.stdin.close(); child.wait()
    after = ap.observe(me, f"{boot}:{start}")
print(json.dumps({"members": len(seen["live_members"]), "helpers": len(seen["helpers"]), "exited": seen["exited"], "exitedAfter": after["exited"]}))
`], { encoding: 'utf8' });

const reader = `
$ErrorActionPreference = 'Stop'
$out = [Console]::OpenStandardOutput()
$utf8 = [System.Text.UTF8Encoding]::new($false)
while ($null -ne [Console]::ReadLine()) {
    $bytes = $utf8.GetBytes([string](Get-Clipboard -Raw))
    $header = [BitConverter]::GetBytes([uint32]$bytes.Length)
    $out.Write($header, 0, $header.Length)
    $out.Write($bytes, 0, $bytes.Length)
    $out.Flush()
}
`;
const observed = (result) => {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

test('the WSL clipboard reader is a helper, not a blocking member', () => {
  assert.deepEqual(observed(withChildren([reader])), { members: 1, helpers: 1, exited: false, exitedAfter: false });
});

test('a gone leader with its reader alive is not exited until the reader ends', () => {
  assert.deepEqual(observed(withChildren([reader], { leaderGone: true })), { members: 0, helpers: 1, exited: false, exitedAfter: true });
});

test('a script that only mentions the reader still blocks', () => {
  assert.deepEqual(observed(withChildren([`${reader}\nStart-Sleep 60`])), { members: 2, helpers: 0, exited: false, exitedAfter: false });
});

test('a reader at another path blocks', () => {
  assert.deepEqual(observed(withChildren([reader], { otherPath: true })), { members: 2, helpers: 0, exited: false, exitedAfter: false });
});

test('a second reader blocks', () => {
  assert.deepEqual(observed(withChildren([reader, reader])), { members: 2, helpers: 1, exited: false, exitedAfter: false });
});
