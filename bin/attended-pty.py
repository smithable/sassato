"""Own a separate provider PTY across controller crashes; never read its terminal.

The holder is outside the provider's new session/group. A separate, human-opened
attach client uses the private Unix socket. Tokens arrive only in the environment.
"""
import errno
import fcntl
import json
import os
import pty
import select
import socket
import struct
import sys
import termios
import tty
from pathlib import Path


def holder():
    directory, node, bootstrap = sys.argv[2:]
    path = str(Path(directory) / "terminal.sock")
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(path)
    os.chmod(path, 0o600)
    listener.listen(1)
    listener.setblocking(False)
    master, slave = pty.openpty()
    child = os.fork()
    if child == 0:
        listener.close()
        os.close(master)
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        for fd in (0, 1, 2):
            os.dup2(slave, fd)
        if slave > 2:
            os.close(slave)
        os.environ["SASSATO_ATTENDED_HOLDER_PID"] = str(os.getppid())
        os.execve(node, [node, bootstrap], dict(os.environ))
    os.close(slave)
    for key in ("SASSATO_WORKER_TOKEN", "SASSATO_ATTENDED_LAUNCH_TOKEN"):
        os.environ.pop(key, None)
    client = None
    tail = bytearray()
    with open(Path(directory) / "terminal.log", "ab", buffering=0) as log:
        while True:
            readable, _, _ = select.select([master, listener] + ([client] if client else []), [], [], 0.2)
            if listener in readable:
                connection, _ = listener.accept()
                if client:
                    connection.close()
                else:
                    client = connection
                    client.settimeout(0.2)
                    try:
                        client.sendall(tail)
                    except OSError:
                        client.close()
                        client = None
            if master in readable:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not data:
                    break
                log.write(data)
                tail.extend(data)
                if len(tail) > 65536:
                    del tail[:-65536]
                if client:
                    try:
                        client.sendall(data)
                    except OSError:
                        client.close()
                        client = None
            if client and client in readable:
                try:
                    data = client.recv(65536)
                    if data:
                        os.write(master, data)
                    else:
                        client.close()
                        client = None
                except OSError:
                    client.close()
                    client = None
    os.waitpid(child, 0)
    if client:
        client.close()
    listener.close()
    os.close(master)
    # Preserve socket pathname/logs as evidence; never kill a provider on holder exit.


def attach():
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.connect(sys.argv[2])
    original = termios.tcgetattr(0)
    try:
        tty.setraw(0)
        while True:
            readable, _, _ = select.select([connection, 0], [], [])
            if connection in readable:
                data = connection.recv(65536)
                if not data:
                    break
                os.write(1, data)
            if 0 in readable:
                data = os.read(0, 65536)
                # Ctrl-] detaches the client, leaving provider and holder running.
                if not data or b"\x1d" in data:
                    break
                connection.sendall(data)
    finally:
        termios.tcsetattr(0, termios.TCSADRAIN, original)
        connection.close()


if __name__ == "__main__":
    if sys.argv[1] == "holder":
        holder()
    elif sys.argv[1] == "attach":
        attach()
    else:
        raise RuntimeError("Unknown PTY operation")
