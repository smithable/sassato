"""Give the real CLI its own confirmation PTY. No real provider is used."""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

node, cli, db, scenario = sys.argv[1:]
master, slave = pty.openpty()
command = [node, cli, 'supervise', '--attended', '--role', 'builder', '--db', db, '--workspace', 'demo', '--as', 'human']
children = []
output = ''
approvals = 0
crashed = False
restarted = False
mailed = False
held_lock = None


def start():
    child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    children.append(child)
    return child


def rows(sql):
    with sqlite3.connect(db, timeout=5) as connection:
        connection.row_factory = sqlite3.Row
        return [dict(row) for row in connection.execute(sql)]


def valid(pid, identity):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
        return identity == Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':' + fields[19]
    except FileNotFoundError:
        return False


try:
    child = start()
    if scenario == 'pre-enter':
        os.write(master, b'\n')
    deadline = time.monotonic() + 35
    acknowledged_prompts = 0
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.05)
        if readable:
            try:
                data = os.read(master, 65536)
                output += data.decode(errors='replace')
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
        prompts = output.count('anything else cancels): ')
        if prompts > acknowledged_prompts:
            acknowledged_prompts = prompts
            if scenario == 'crash' and not crashed:
                child.kill()
                child.wait(timeout=3)
                before = rows('SELECT count(*) n FROM managed_workers')[0]['n']
                child = start()
                crashed = True
                restarted = before == 1
                continue
            if scenario in ('no-confirmation', 'pre-enter'):
                time.sleep(0.3)
                assert rows('SELECT state FROM managed_workers')[0]['state'] == 'ready'
                child.terminate()
                break
            if scenario == 'eof':
                os.write(master, b'\x04')
                continue
            if scenario == 'cancel':
                os.write(master, b'no\n')
                continue
            if scenario == 'busy-after-enter':
                held_lock = open(Path(db).parent / 'maintenance.lock', 'a')
                fcntl.flock(held_lock, fcntl.LOCK_SH)
            if scenario == 'dirty-after-enter':
                (Path(db).parent / 'repo' / 'attended-sentinel.txt').write_text('changed after readiness')
            if scenario == 'task-after-enter':
                with sqlite3.connect(db) as connection:
                    connection.execute('UPDATE tasks SET version=version+1')
            if scenario == 'stop-after-enter':
                with sqlite3.connect(db) as connection:
                    connection.execute("INSERT INTO stop_requests(workspace_id,role,requested_at,requested_by) VALUES(1,'builder',datetime('now'),'human')")
            if not mailed and scenario in ('complete', 'crash'):
                # Mail while generation 1 is ready, without changing its cursor.
                result = subprocess.run([node, cli, 'send', 'builder', 'unique-attended-replay-notification', '--urgent', '--db', db, '--workspace', 'demo', '--as', 'human'], capture_output=True, text=True)
                assert result.returncode == 0, result.stderr
                mailed = True
            os.write(master, b'\n')
            approvals += 1
        if child.poll() is not None:
            break
    else:
        raise RuntimeError('Controller deadline elapsed')
    if child.poll() is None:
        child.wait(timeout=5)
    # Drain output after process exit.
    while select.select([master], [], [], 0.05)[0]:
        try:
            data = os.read(master, 65536)
            if not data:
                break
            output += data.decode(errors='replace')
        except OSError:
            break
    if child.returncode:
        for log in Path(db).parent.glob('.sat-*/terminal.log'):
            output += '\nPROVIDER LOG: ' + log.read_text(errors='replace')
    print(json.dumps({'code': child.returncode, 'output': output, 'approvals': approvals, 'crashed': crashed, 'restarted': restarted, 'prompts': acknowledged_prompts}))
finally:
    for child in children:
        if child.poll() is None:
            child.kill()
        child.wait()
    # Test-only cleanup, restricted to freshly recorded fixture-owned identities.
    for row in rows('SELECT pid,process_start FROM managed_workers'):
        if row['pid'] and valid(row['pid'], row['process_start']):
            try:
                os.killpg(row['pid'], signal.SIGTERM)
            except ProcessLookupError:
                pass
    for row in rows('SELECT payload FROM managed_transitions'):
        payload = json.loads(row['payload'])
        if payload.get('holder_pid') and valid(payload['holder_pid'], payload['holder_start']):
            # Holder normally reaps its child and exits; allow it time first.
            for _ in range(30):
                if not valid(payload['holder_pid'], payload['holder_start']):
                    break
                time.sleep(0.02)
    if held_lock:
        held_lock.close()
    os.close(master)
    os.close(slave)
