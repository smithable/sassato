"""Bounded live-ancestry admission evidence, never process containment or retirement."""
import json
import os
import select
import sys
from pathlib import Path


def record(pid):
    fields = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
    if fields[0] in ('Z', 'X'):
        raise RuntimeError('Ancestry contains a dead process')
    return {'pid': pid, 'parent': int(fields[1]), 'start': fields[19]}


def alive(fd):
    poll = select.poll()
    poll.register(fd, select.POLLIN)
    return not poll.poll(0)


def prove(caller, root, identity, *, inspect=record, pin=os.pidfd_open,
          live=alive, close=os.close, boot=None):
    """Pin every identity and reject any changed PPID edge in a second walk.

    Authorization is the final successful validation/pidfd poll in this call.
    Pidfds do not freeze PPID edges or keep the root alive after that decision.
    """
    boot = boot if boot is not None else Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    expected_boot, expected_start = identity.split(':')
    if expected_boot != boot or caller <= 1 or root <= 1:
        raise RuntimeError('Invalid caller or launch identity')
    handles = {}
    chain = []

    def pinned(pid):
        before = inspect(pid)
        fd = pin(pid)
        handles[pid] = fd
        after = inspect(pid)
        if before != after or not live(fd):
            raise RuntimeError('Ancestry identity changed while pinning')
        return after

    try:
        leader = pinned(root)
        if leader['start'] != expected_start:
            raise RuntimeError('Recorded launch root identity changed')
        current = caller
        for _ in range(64):
            if current in {row['pid'] for row in chain}:
                raise RuntimeError('Cyclic ancestry')
            row = leader if current == root else pinned(current)
            chain.append(row)
            if current == root:
                break
            current = row['parent']
            if current <= 1:
                raise RuntimeError('Command is not a live descendant of the owned provider')
        else:
            raise RuntimeError('Ancestry depth exceeds admission bound')
        # Validate root first, then every edge towards the caller. Each stored
        # parent is the next pinned node. A recycled PID cannot replace that node.
        for row in reversed(chain):
            if inspect(row['pid']) != row or not live(handles[row['pid']]):
                raise RuntimeError('Ancestry changed before authorization')
        if not all(live(fd) for fd in handles.values()):
            raise RuntimeError('Ancestry exited before authorization')
        return {'authorized': True, 'root': root, 'depth': len(chain)}
    finally:
        for fd in handles.values():
            close(fd)


if __name__ == '__main__':
    try:
        caller, root, identity = sys.argv[1:]
        # The Node CLI supplies its own PID, not a user-selected claimant.
        if int(caller) != os.getppid():
            raise RuntimeError('Caller is not the invoking CLI')
        print(json.dumps(prove(int(caller), int(root), identity)))
    except Exception as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(4)
