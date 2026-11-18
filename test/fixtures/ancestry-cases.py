"""Deterministic process-table races without changing production /proc inputs."""
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('ancestry', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def fake(change=None, dead=None, identity='boot:10', root_parent=1):
    rows = {10: {'pid': 10, 'parent': root_parent, 'start': '10'},
            20: {'pid': 20, 'parent': 10, 'start': '20'},
            30: {'pid': 30, 'parent': 20, 'start': '30'}}
    reads = {}
    closed = []
    opened = []

    def inspect(pid):
        reads[pid] = reads.get(pid, 0) + 1
        row = dict(rows[pid])
        if change:
            change(pid, reads[pid], row)
        return row

    def pin(pid):
        opened.append(pid)
        return pid

    def live(fd):
        return not (dead and dead(fd, reads))

    try:
        module.prove(30, 10, identity, inspect=inspect, pin=pin,
                     live=live, close=closed.append, boot='boot')
        return True
    except (RuntimeError, KeyError, OSError):
        return False
    finally:
        assert len(closed) == len(set(closed))
        assert set(closed) == set(opened)


assert fake()
# Same numeric PID with a different root birth identity must never authorize.
assert not fake(identity='boot:old')
assert not fake(identity='other-boot:10')
# Recycling an ancestor while opening the pidfd is caught by the second stat.
assert not fake(change=lambda pid, n, row: row.update(start='reused') if pid == 20 and n >= 2 else None)
# Reparenting after acquisition is caught by the second full edge walk.
assert not fake(change=lambda pid, n, row: row.update(parent=1) if pid == 30 and n >= 3 else None)
# Root exit after the last record must fail the final pidfd poll.
assert not fake(dead=lambda fd, reads: fd == 10 and reads.get(30, 0) >= 3)
# A root/ancestor exit while pinning and unreadable ancestry fail closed.
assert not fake(dead=lambda fd, reads: fd == 20)
assert not fake(change=lambda pid, n, row: row.update(parent=999) if pid == 30 else None)
assert not fake(change=lambda pid, n, row: row.update(parent=30) if pid == 20 else None)

# Real new-session descendants may cross SID/PGID boundaries while preserving ancestry.
identity = Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':' + module.record(os.getpid())['start']
child = subprocess.run([sys.executable, '-B', sys.argv[1], str(os.getpid()), str(os.getpid()), identity], capture_output=True, text=True)
assert child.returncode == 0, child.stdout + child.stderr
# Invoking helper directly cannot claim an arbitrary unrelated caller.
outsider = subprocess.run([sys.executable, '-B', sys.argv[1], '2', str(os.getpid()), identity], capture_output=True, text=True)
assert outsider.returncode != 0
print(json.dumps({'passed': True, 'cases': 11}))
