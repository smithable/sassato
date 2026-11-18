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
