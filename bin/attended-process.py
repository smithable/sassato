"""Linux attended-only observations. Never a confinement or detached-job proof."""
import json
import os
import select
import signal
import sqlite3
import subprocess
import sys
import time
from pathlib import Path


def record(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
        return {"pid": pid, "state": fields[0], "group": int(fields[2]),
                "session": int(fields[3]), "start": fields[19]}
    except FileNotFoundError:
        return None


def observe(pid, identity):
    boot, start = identity.split(":")
    if Path("/proc/sys/kernel/random/boot_id").read_text().strip() != boot:
        raise RuntimeError("Boot identity changed")
    leader = record(pid)
    if leader and (leader["start"] != start or leader["group"] != pid or leader["session"] != pid):
        raise RuntimeError("Leader identity or original process group changed")
    members = []
    for path in Path("/proc").iterdir():
        if path.name.isdecimal():
            row = record(int(path.name))
            if row and row["group"] == pid and row["state"] not in ("Z", "X"):
                members.append(row)
    members.sort(key=lambda row: row["pid"])
    return {"leader": leader, "live_members": members,
            "exited": not members and (leader is None or leader["state"] in ("Z", "X"))}


def signal_guards(fd):
    guards = json.loads(os.environ['SASSATO_ATTENDED_SIGNAL_GUARDS'])
    busy = subprocess.run([guards['node'], guards['busy_helper']], env={**os.environ, 'SASSATO_ATTENDED_BUSY_CHECKS': json.dumps(guards['busy_checks'])}, capture_output=True, text=True, check=False)
    if busy.returncode != 0:
        raise RuntimeError('External busy guards changed or failed immediately before signal')
    if guards['stop_file'] is None:
        raise RuntimeError('An explicit stop-file guard is required')
    if os.path.lexists(guards['stop_file']):
        raise RuntimeError('STOP arrived before signal')
    with sqlite3.connect(Path(guards['db']).as_uri() + '?mode=rw', uri=True) as connection:
        connection.execute('BEGIN IMMEDIATE')
        worker = connection.execute("SELECT generation,state,pid,process_start FROM managed_workers WHERE id=?", (guards['worker_id'],)).fetchone()
        if not worker or worker[0] != guards['generation'] or worker[1] != 'retiring':
            raise RuntimeError('Generation or retirement state changed')
        tasks = [dict(zip(('id', 'version', 'status', 'owner'), row)) for row in connection.execute("SELECT id,version,status,owner FROM tasks WHERE workspace_id=? AND owner=? AND status NOT IN ('done','dropped') ORDER BY id", (guards['workspace'], guards['roles'][0]))]
        if tasks != guards['task_versions']:
            raise RuntimeError('Task ownership/version changed before signal')
        progress = connection.execute("SELECT id,detail FROM events WHERE workspace_id=? AND entity='notification-progress' AND entity_id=? AND action='saved' ORDER BY id DESC LIMIT 1", (guards['workspace'], guards['roles'][0])).fetchone()
        expected = guards['notification_progress']
        if not progress or 'E' + str(progress[0]) != expected['id']:
            raise RuntimeError('Handled notification progress changed before signal')
        if connection.execute('SELECT 1 FROM stop_requests WHERE workspace_id=? AND role IN (?,?) AND cleared_at IS NULL', (guards['workspace'], *guards['roles'])).fetchone():
            raise RuntimeError('STOP arrived before signal')
        if connection.execute("SELECT 1 FROM jobs WHERE status IN ('waiting','running') OR (orphans IS NOT NULL AND orphans!='[]')").fetchone():
            raise RuntimeError('A running/unknown protected job arrived before signal')
        if os.path.lexists(guards['stop_file']):
            raise RuntimeError('STOP arrived immediately before signal')
        signal.pidfd_send_signal(fd, signal.SIGTERM)


def main():
    action, raw_pid, identity = sys.argv[1:]
    pid = int(raw_pid)
    if pid <= 1 or action not in ("observe", "retire"):
        raise RuntimeError("Invalid attended process request")
    before = observe(pid, identity)
    if action == "observe" or before["exited"]:
        return before
    if [row["pid"] for row in before["live_members"]] != [pid]:
        raise RuntimeError("Other live process-group members block retirement")
    fd = os.pidfd_open(pid)
    try:
        # Pin first, then revalidate; never signal through a numeric PID/PGID.
        pinned = observe(pid, identity)
        if pinned["exited"]:
            return pinned
        if [row["pid"] for row in pinned["live_members"]] != [pid]:
            raise RuntimeError("Process group changed before retirement")
        signal_guards(fd)
        poll = select.poll()
        poll.register(fd, select.POLLIN)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if poll.poll(50):
                after = observe(pid, identity)
                if after["exited"]:
                    return {**after, "pidfd_exit": True, "signal": "TERM"}
            time.sleep(0.01)
        raise RuntimeError("TERM deadline elapsed; no KILL and no successor")
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        print(json.dumps(main()))
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(4)
