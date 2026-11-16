"""Retained cgroup-v2 object and positive parent-namespace removal evidence.

Only the explicitly validated WSL kernel is supported by the removal fallback.
Read errors, missing paths, link counts and deleted path suffixes are not proof.
"""
import ctypes
import errno
import os
from pathlib import Path
import re
import stat
import struct

SUPPORTED_KERNEL = "6.6.87.2-microsoft-standard-WSL2"
CGROUP2_MAGIC = 0x63677270
DELETE = 0x200
CREATE = 0x100
MOVE = 0x40 | 0x80
INVALID = 0x400 | 0x800 | 0x2000 | 0x4000 | 0x8000
ISDIR = 0x40000000


class UnprovenRemoval(RuntimeError):
    pass


def check(value, message):
    if not value:
        raise UnprovenRemoval(message)


def fd_metadata(fd):
    info = os.fstat(fd)
    text = Path(f"/proc/self/fdinfo/{fd}").read_text()
    mount = re.search(r"^mnt_id:\s+(\d+)$", text, re.MULTILINE)
    check(mount is not None, "Missing mount identity")
    return {"device": info.st_dev, "inode": info.st_ino, "mode": info.st_mode, "uid": info.st_uid, "gid": info.st_gid, "mount_id": int(mount[1])}


def filesystem_magic(fd):
    libc = ctypes.CDLL(None, use_errno=True)
    buffer = ctypes.create_string_buffer(256)
    check(libc.fstatfs(fd, buffer) == 0, "Cannot identify retained filesystem")
    return ctypes.c_long.from_buffer(buffer).value


class NamespaceLedger:
    def __init__(self, watch, name):
        self.watch = watch
        self.name = name
        self.deleted = False
        self.invalid = False
        self.events = []

    def feed(self, data):
        check(not self.invalid, "Namespace history is already unknown")
        try:
            self._feed(data)
        except BaseException:
            self.invalid = True
            raise

    def _feed(self, data):
        offset = 0
        while offset < len(data):
            check(len(data) - offset >= 16, "Truncated namespace event")
            watch, mask, cookie, length = struct.unpack_from("iIII", data, offset)
            offset += 16
            check(length <= 4096 and offset + length <= len(data), "Invalid namespace event size")
            name = data[offset:offset + length].split(b"\0", 1)[0].decode("utf8")
            offset += length
            if mask & INVALID or watch != self.watch:
                self.invalid = True
            if name != self.name:
                continue
            self.events.append({"watch": watch, "mask": mask, "cookie": cookie, "name": name})
            check(len(self.events) <= 32, "Namespace history exceeds bound")
            if mask & (CREATE | MOVE) or self.deleted:
                self.invalid = True
            if mask & DELETE:
                if not mask & ISDIR:
                    self.invalid = True
                self.deleted = True
        check(not self.invalid, "Namespace continuity lost: move, replacement, overflow or watch loss")


class RetainedScope:
    def __init__(self, root, expected, parent, expected_parent):
        check(os.uname().release == SUPPORTED_KERNEL, "Removal predicate is not validated on this kernel")
        self.root = Path(root)
        self.parent = Path(parent)
        self.closed = False
        self.bound = False
        self.tainted = False
        self.fds = []
        self.close_identities = {}
        try:
            self.parent_fd = self._open(self.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            self.root_fd = self._open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            self.events_fd = self._open(self.root / "cgroup.events", os.O_RDONLY | os.O_NOFOLLOW)
            check(filesystem_magic(self.parent_fd) == CGROUP2_MAGIC and filesystem_magic(self.root_fd) == CGROUP2_MAGIC, "Retained object is not cgroup v2")
            check((self.root / "cgroup.type").read_text().strip() == "domain", "Threaded or invalid cgroup type is unsupported")
            self.parent_meta = fd_metadata(self.parent_fd)
            self.root_meta = fd_metadata(self.root_fd)
            self.events_meta = fd_metadata(self.events_fd)
            check(all(self.root_meta[key] == expected[key] for key in ["device", "inode"]) and all(self.parent_meta[key] == expected_parent[key] for key in ["device", "inode"]), "Initial cgroup identity mismatch")
            check(self.parent_meta["mount_id"] == self.root_meta["mount_id"] == self.events_meta["mount_id"], "Cgroup mount identity mismatch")
            libc = ctypes.CDLL(None, use_errno=True)
            libc.inotify_init1.argtypes = [ctypes.c_int]
            libc.inotify_init1.restype = ctypes.c_int
            libc.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
            libc.inotify_add_watch.restype = ctypes.c_int
            self.watch_fd = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
            check(self.watch_fd >= 0, "Could not create namespace observation")
            self.fds.append(self.watch_fd)
            self._record_close_identity(self.watch_fd)
            self.watch_anchor = os.dup(self.watch_fd)
            self.fds.append(self.watch_anchor)
            self._record_close_identity(self.watch_anchor)
            watch = libc.inotify_add_watch(self.watch_fd, f"/proc/self/fd/{self.parent_fd}".encode(), DELETE | CREATE | MOVE | 0x400 | 0x800 | 0x1000000)
            check(watch >= 0, "Cannot watch the retained parent inode")
            self.watch_meta = fd_metadata(self.watch_fd)
            self.anchor_meta = fd_metadata(self.watch_anchor)
            self.ledger = NamespaceLedger(watch, self.root.name)
            self.assert_continuous()
            initial = self.event_file_observation()
            check(initial.get("populated") == "1", "Retained scope was not populated at binding")
            self.initial = {"kernel": os.uname().release, "parent_fd": self.parent_meta, "root_fd": self.root_meta, "events_fd": self.events_meta, "watch": watch, "event_file": initial}
            self.drain()
            check(not self.ledger.deleted, "Scope disappeared while establishing its live binding")
            self.bound = True
        except BaseException:
            self.close()
            raise

    def _open(self, path, flags):
        fd = os.open(path, flags | os.O_CLOEXEC)
        self.fds.append(fd)
        self._record_close_identity(fd)
        return fd

    def _record_close_identity(self, fd):
        info = os.fstat(fd)
        self.close_identities[fd] = (info.st_dev, info.st_ino)

    def close(self):
        if not self.closed:
            self.closed = True
            for fd in reversed(self.fds):
                try:
                    info = os.fstat(fd)
                    if (info.st_dev, info.st_ino) == self.close_identities.get(fd):
                        os.close(fd)
                except OSError:
                    pass

    def assert_continuous(self):
        check(not self.tainted, "Retained evidence is already unknown")
        try:
            self._assert_continuous()
        except BaseException:
            self.tainted = True
            raise

    def _assert_continuous(self):
        check(not self.closed, "Retained scope handle was lost")
        for fd, expected in [(self.parent_fd, self.parent_meta), (self.root_fd, self.root_meta), (self.events_fd, self.events_meta), (self.watch_fd, self.watch_meta), (self.watch_anchor, self.anchor_meta)]:
            check(fd_metadata(fd) == expected, "Retained descriptor identity changed")
        parent_fd = os.open(self.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            check(fd_metadata(parent_fd) == self.parent_meta and filesystem_magic(parent_fd) == CGROUP2_MAGIC, "Parent or mount identity changed")
        finally:
            os.close(parent_fd)
        try:
            info = self.root.lstat()
        except FileNotFoundError:
            check(self.bound, "Owned entry vanished before its live binding was established")
            return  # Absence is only an observation, never the predicate.
        check(stat.S_ISDIR(info.st_mode) and info.st_dev == self.root_meta["device"] and info.st_ino == self.root_meta["inode"], "Owned path was replaced")

    def drain(self):
        self.assert_continuous()
        total = 0
        while True:
            try:
                data = os.read(self.watch_anchor, 8192)
            except BlockingIOError:
                break
            except OSError:
                self.tainted = True
                raise
            check(data, "Namespace event stream ended")
            total += len(data)
            check(total <= 65536, "Namespace event read exceeds bound")
            self.ledger.feed(data)
        return self.ledger.deleted

    def event_file_observation(self):
        self.assert_continuous()
        try:
            raw = os.pread(self.events_fd, 4096, 0).decode()
        except OSError as error:
            # ENODEV is retained for audit only. It cannot establish deletion.
            if error.errno == errno.ENODEV:
                return {"errno": error.errno}
            self.tainted = True
            raise
        if not raw or len(raw) >= 4096:
            self.tainted = True
            raise UnprovenRemoval("Missing or oversized retained event-file observation")
        return dict(line.split() for line in raw.splitlines())

    def deletion_evidence(self):
        check(self.drain(), "No positive removal event for the continuously bound owned entry")
        try:
            self.root.lstat()
        except FileNotFoundError:
            pass
        else:
            raise UnprovenRemoval("A path exists after the original deletion; do not act on a replacement")
        return {"predicate": "retained-parent-IN_DELETE-ISDIR-with-unbroken-name-binding", "before": self.initial, "after": {"root_fd": fd_metadata(self.root_fd), "events_fd": fd_metadata(self.events_fd), "event_file": self.event_file_observation()}, "events": list(self.ledger.events)}

    def diagnostics(self):
        """Audit observations only; this method never establishes exit proof."""
        result = {"tainted": self.tainted, "closed": self.closed, "before": getattr(self, "initial", None), "descriptors": {}}
        for name in ["parent_fd", "root_fd", "events_fd", "watch_fd", "watch_anchor"]:
            try:
                result["descriptors"][name] = fd_metadata(getattr(self, name))
            except (OSError, UnprovenRemoval, AttributeError) as error:
                result["descriptors"][name] = {"error": str(error), "errno": getattr(error, "errno", None)}
        if hasattr(self, "ledger"):
            result["events"] = list(self.ledger.events)
            result["namespace_invalid"] = self.ledger.invalid
        try:
            result["event_file"] = self.event_file_observation()
        except (OSError, UnprovenRemoval) as error:
            result["event_file"] = {"error": str(error), "errno": getattr(error, "errno", None)}
        return result
