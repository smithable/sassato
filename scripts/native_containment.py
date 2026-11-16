"""Experimental source-only containment primitive for fixed inert fixtures.

This module has no provider or arbitrary-program launch path. It is not an
adapter enablement gate, process sandbox, or general-purpose unit manager.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import select
import signal
import stat
import subprocess
import sys
import time
import uuid

CGROUP_ROOT = Path("/sys/fs/cgroup")

class UnknownScope(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise UnknownScope(message)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def fingerprint(pid):
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
    require(fields[0] not in ["Z", "X"], "Process is not live")
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip() + ":" + fields[19]


def identity(path):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode), "Scope path is not a directory")
    return {"device": info.st_dev, "inode": info.st_ino}


def properties(unit=None):
    names = ["Id", "LoadState", "ActiveState", "SubState", "Transient", "Description", "InvocationID", "ControlGroup", "MainPID", "ExecMainPID", "Type", "ExitType", "RemainAfterExit", "KillMode", "SendSIGKILL", "SendSIGHUP", "Restart", "Delegate", "TasksMax", "ExecStartPre", "ExecStartPost", "ExecStop", "ExecStopPost", "OnFailure", "OnSuccess", "FailureAction", "SuccessAction", "WatchdogUSec", "RuntimeMaxUSec", "OOMPolicy", "NoNewPrivileges"]
    argv = ["systemctl", "--user", "show", "--no-pager", "--property=" + ",".join(names)]
    if unit:
        argv += ["--", unit]
    result = subprocess.run(argv, capture_output=True, text=True, timeout=5)
    values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    require(result.returncode == 0 or result.returncode == 1 and values.get("LoadState") == "not-found", "Cannot read exact user-manager unit metadata")
    return values


def read_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_size <= 65536, "Untrusted or oversized fixture evidence")
        return json.load(stream)


def atomic_json(path, value):
    data = json.dumps(value, sort_keys=True).encode()
    require(len(data) <= 65536, "Fixture evidence exceeds its bound")
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".new")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def recursive_members(root, expected, max_processes=12, max_directories=8):
    """Unknown/changing reads never mean empty; include every descendant cgroup."""
    require(identity(root) == expected, "Owned cgroup path identity changed")
    directories = []
    processes = set()
    pending = [(root, 0)]
    while pending:
        path, depth = pending.pop()
        require(depth <= 4 and len(directories) < max_directories, "Cgroup traversal exceeds its bound")
        before = identity(path)
        values = (path / "cgroup.procs").read_text().split()
        require(all(re.fullmatch(r"[1-9][0-9]*", value) for value in values), "Malformed process inventory")
        processes.update(map(int, values))
        require(len(processes) <= max_processes, "Process inventory exceeds its bound")
        for entry in path.iterdir():
            info = entry.lstat()
            require(not stat.S_ISLNK(info.st_mode), "Symlink in owned cgroup tree")
            if stat.S_ISDIR(info.st_mode):
                pending.append((entry, depth + 1))
        require(identity(path) == before, "Cgroup changed during inventory")
        directories.append((str(path), before))
    require(identity(root) == expected, "Owned cgroup path changed during inventory")
    return {"pids": sorted(processes), "directories": sorted(directories)}


def positively_exited(claim):
    try:
        fd = os.pidfd_open(claim["pid"])
    except ProcessLookupError:
        return True
    try:
        poll = select.poll()
        poll.register(fd, select.POLLIN)
        if poll.poll(0):
            return True
        # A different boot/start proves the original exited; never signal this PID.
        return fingerprint(claim["pid"]) != claim["start"]
    finally:
        os.close(fd)


class FixtureScope:
    REQUIRED = {"Transient": "yes", "Type": "exec", "ExitType": "cgroup", "RemainAfterExit": "yes", "KillMode": "none", "SendSIGKILL": "no", "SendSIGHUP": "no", "Restart": "no", "Delegate": "yes", "TasksMax": "12", "FailureAction": "none", "SuccessAction": "none", "WatchdogUSec": "0", "RuntimeMaxUSec": "infinity", "OOMPolicy": "continue", "NoNewPrivileges": "yes"}
    EMPTY = ["ExecStartPre", "ExecStartPost", "ExecStop", "ExecStopPost", "OnFailure", "OnSuccess"]

    def __init__(self, directory, token=None):
        self.directory = Path(directory).resolve(strict=True)
        info = self.directory.stat()
        require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700, "Fixture evidence directory must be private and owned")
        self.directory_identity = identity(self.directory)
        self.lock = os.open(self.directory / "controller.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            os.close(self.lock)
            raise
        try:
            self.token = token
            self.state = read_json(self.directory / "intent.json")
            require(re.fullmatch(r"sassato-fixture-[0-9a-f]{32}\.service", self.state["unit"]) and self.state["generation"] == 1, "Not a fixture launch identity")
            require(self.state["helper"] == str(Path(__file__).with_name("native_containment_helper.py").resolve()) and self.state["python"] == str(Path(sys.executable).resolve()), "Not the fixed fixture executable")
            self.lock_identity = os.fstat(self.lock)
            require(stat.S_ISREG(self.lock_identity.st_mode), "Controller lock is not a regular file")
            lock_identity = {"device": self.lock_identity.st_dev, "inode": self.lock_identity.st_ino}
            if "lock_identity" not in self.state:
                require(self.state["state"] == "prepared", "Uncertain controller lock identity")
                self._save(lock_identity=lock_identity)
            require(self.state["lock_identity"] == lock_identity, "Controller lock was replaced")
        except BaseException:
            self.close()
            raise

    @classmethod
    def prepare(cls, parent, lifetime=20):
        require(sys.platform == "linux" and hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"), "Linux pidfd support is required")
        require(5 <= lifetime <= 30, "Fixture lifetime must be between 5 and 30 seconds")
        manager = properties("-.slice")
        group = manager.get("ControlGroup", "")
        require(group.startswith("/user.slice/") and ".." not in Path(group).parts, "No existing user-manager delegation")
        parent_scope = CGROUP_ROOT / group.lstrip("/")
        enabled = sorted((parent_scope / "cgroup.subtree_control").read_text().split())
        require(set(["cpu", "memory", "pids"]).issubset(enabled) and os.access(parent_scope, os.W_OK), "Existing delegation is insufficient; do not change parent policy")
        directory = Path(parent).resolve(strict=True) / ("scope-" + uuid.uuid4().hex)
        directory.mkdir(mode=0o700)
        token = os.urandom(32).hex()
        unit = "sassato-fixture-" + uuid.uuid4().hex + ".service"
        helper = Path(__file__).with_name("native_containment_helper.py").resolve(strict=True)
        data = {"version": 1, "revision": 0, "generation": 1, "unit": unit, "description": "Sassato inert fixture " + unit, "state": "prepared", "token_hash": digest(token.encode()), "helper": str(helper), "helper_hash": digest(helper.read_bytes()), "python": str(Path(sys.executable).resolve()), "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(), "parent_group": group, "parent_identity": identity(parent_scope), "parent_mode": stat.S_IMODE(parent_scope.stat().st_mode), "parent_uid": parent_scope.stat().st_uid, "parent_gid": parent_scope.stat().st_gid, "parent_controllers": enabled, "deadline": time.monotonic() + lifetime, "stop_requested": False, "directory_identity": identity(directory)}
        atomic_json(directory / "intent.json", data)
        return cls(directory, token)

    def close(self):
        if self.lock is not None:
            os.close(self.lock)
            self.lock = None

    def _save(self, **changes):
        current = read_json(self.directory / "intent.json")
        require(current["revision"] == self.state["revision"], "Fixture state changed; reconcile instead of overwriting")
        updated = {**self.state, **changes, "revision": self.state["revision"] + 1}
        atomic_json(self.directory / "intent.json", updated)
        self.state = updated

    def _guard(self, allow_stop=False):
        require(self.lock is not None and identity(self.directory) == self.directory_identity == self.state["directory_identity"], "Controller/evidence identity changed")
        lock = (self.directory / "controller.lock").lstat()
        require(stat.S_ISREG(lock.st_mode) and (lock.st_dev, lock.st_ino) == (self.lock_identity.st_dev, self.lock_identity.st_ino) and self.state["lock_identity"] == {"device": lock.st_dev, "inode": lock.st_ino}, "Controller lock path identity changed")
        current = read_json(self.directory / "intent.json")
        require(current["revision"] == self.state["revision"] and all(current[key] == self.state[key] for key in ["generation", "unit", "token_hash", "helper", "helper_hash", "directory_identity"]), "Durable launch identity changed")
        require(Path("/proc/sys/kernel/random/boot_id").read_text().strip() == self.state["boot_id"], "Controller boot changed")
        require(digest(Path(self.state["helper"]).read_bytes()) == self.state["helper_hash"], "Fixture helper changed")
        parent = CGROUP_ROOT / self.state["parent_group"].lstrip("/")
        require(identity(parent) == self.state["parent_identity"] and stat.S_IMODE(parent.stat().st_mode) == self.state["parent_mode"] and parent.stat().st_uid == self.state["parent_uid"] and parent.stat().st_gid == self.state["parent_gid"] and sorted((parent / "cgroup.subtree_control").read_text().split()) == self.state["parent_controllers"], "Parent delegation changed; do not modify it")
        require(allow_stop or not (current["stop_requested"] or (self.directory / "STOP").exists() or Path.home().joinpath("repos/stop").exists()), "STOP blocks fixture lifecycle action")

    def launch(self):
        self._guard()
        require(self.state["state"] == "prepared" and self.token and digest(self.token.encode()) == self.state["token_hash"], "Uncertain or repeated launch must reconcile the existing intent; never duplicate")
        require(time.monotonic() < self.state["deadline"], "Fixture launch deadline elapsed")
        existing = properties(self.state["unit"])
        require(existing.get("LoadState") == "not-found", "Unit name already exists; do not adopt it")
        self._save(state="launching")  # durable before any launch request
        options = dict(self.REQUIRED)
        options.pop("Transient")
        options.pop("Type")
        options["Delegate"] = "cpu memory pids"
        options["WatchdogSec"] = options.pop("WatchdogUSec")
        options["RuntimeMaxSec"] = options.pop("RuntimeMaxUSec")
        options.update({name: "" for name in self.EMPTY})
        options.update({"StandardInput": "null", "StandardOutput": "null", "StandardError": "null"})
        argv = ["systemd-run", "--user", "--no-ask-password", "--service-type=exec", "--no-block", "--expand-environment=no", "--slice=-.slice", "--unit=" + self.state["unit"], "--description=" + self.state["description"]]
        argv += ["--property=" + key + "=" + value for key, value in options.items()]
        argv += ["--", self.state["python"], self.state["helper"], "--directory", str(self.directory), "--token", self.token, "--deadline", str(self.state["deadline"])]
        self._guard()
        result = subprocess.run(argv, capture_output=True, text=True, timeout=5)
        require(result.returncode == 0, "Transient launch failed or is uncertain; retain intent, do not retry")
        return self.recover()

    def _unit(self):
        self._guard(allow_stop=True)
        values = properties(self.state["unit"])
        require(values.get("Id") == self.state["unit"] and values.get("Description") == self.state["description"] and values.get("LoadState") == "loaded", "Unit ownership is not established")
        require(all(values.get(key) == value for key, value in self.REQUIRED.items()) and all(values.get(key, "") == "" for key in self.EMPTY), "Unsafe transient unit lifecycle properties")
        require(re.fullmatch(r"[0-9a-f]{32}", values.get("InvocationID", "")), "Unit invocation identity is missing")
        group = values.get("ControlGroup", "")
        require(group == self.state["parent_group"] + "/" + self.state["unit"], "Unit is not in its exclusive expected subtree")
        root = CGROUP_ROOT / group.lstrip("/")
        proof = {"invocation": values["InvocationID"], "group": group, "identity": identity(root)}
        if "scope" in self.state:
            require(proof == self.state["scope"], "Unit/cgroup identity changed")
        return values, root, proof

    def _claim(self, pid):
        claim = read_json(self.directory / f"claim-{pid}.json")
        require(claim["pid"] == pid and claim["token_hash"] == self.state["token_hash"] and claim["unit"] == self.state["unit"] and claim["role"] in ["main", "child", "grandchild", "detached"], "Process registration does not match launch intent")
        require(fingerprint(pid) == claim["start"], "PID was reused or exited")
        argv = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        argv = [value.decode() for value in argv if value]
        expected = [self.state["python"], self.state["helper"], "--directory", str(self.directory), "--token"]
        require(argv[:5] == expected and len(argv) == 8 and argv[6] == "--deadline" and digest(argv[5].encode()) == self.state["token_hash"], "Process executable/arguments are not the fixed owned fixture")
        require(float(argv[7]) == self.state["deadline"], "Fixture deadline changed")
        uid = next(line.split()[1:] for line in Path(f"/proc/{pid}/status").read_text().splitlines() if line.startswith("Uid:"))
        require(all(int(value) == os.getuid() for value in uid), "Fixture UID changed")
        group = next(line[3:] for line in Path(f"/proc/{pid}/cgroup").read_text().splitlines() if line.startswith("0::"))
        require(group == claim["cgroup"] and (group == self.state["scope"]["group"] or group.startswith(self.state["scope"]["group"] + "/")), "Process left its owned scope")
        self.token = argv[5]
        return claim

    def recover(self):
        self._guard()
        require(self.state["state"] != "prepared", "No launch was requested; lost credentials do not authorize another launch")
        end = min(time.monotonic() + 4, self.state["deadline"])
        while time.monotonic() < end:
            pending = properties(self.state["unit"])
            if pending.get("LoadState") == "not-found" or not pending.get("ControlGroup"):
                time.sleep(0.02)
                continue
            values, root, proof = self._unit()
            if "scope" not in self.state:
                self._save(scope=proof)
            pid = int(values.get("MainPID", "0"))
            if pid and (self.directory / f"claim-{pid}.json").exists():
                claim = self._claim(pid)
                require(claim["role"] == "main", "Bootstrap is not the recorded main process")
                if "bootstrap" in self.state:
                    require(claim == self.state["bootstrap"], "Bootstrap registration changed")
                self._save(bootstrap=claim, state=self.state["state"] if self.state["state"] == "released" else "held")
                return claim
            if not pid and "bootstrap" in self.state and self.state["state"] == "released":
                require(positively_exited(self.state["bootstrap"]), "Original main process exit is unknown")
                return self.snapshot()
            time.sleep(0.02)
        raise UnknownScope("Bootstrap is absent/uncertain; preserve intent and never relaunch")

    def snapshot(self):
        _, root, _ = self._unit()
        first = recursive_members(root, self.state["scope"]["identity"])
        claims = [self._claim(pid) for pid in first["pids"]]
        second = recursive_members(root, self.state["scope"]["identity"])
        require(first == second, "Membership changed during ownership verification")
        return {**first, "claims": claims}

    def release(self):
        self._guard()
        require(self.state["state"] in ["held", "released"] and time.monotonic() < self.state["deadline"], "Bootstrap is not held or deadline elapsed")
        release = {"generation": self.state["generation"], "token_hash": self.state["token_hash"]}
        if (self.directory / "release.json").exists():
            require(self.state["state"] == "released" and read_json(self.directory / "release.json") == release, "Release gate changed")
            self.snapshot()
            return
        current = self.snapshot()
        require(len(current["claims"]) == 1 and current["claims"][0] == self.state["bootstrap"], "Bootstrap scope contains unknown or additional work")
        self._guard()
        self._save(state="released")
        self._guard()
        atomic_json(self.directory / "release.json", release)

    def signal_owned(self, claim, sig=signal.SIGTERM):
        self._guard()
        require(sig in [0, signal.SIGTERM], "Only a bounded owned-fixture TERM is supported")
        ready = read_json(self.directory / "ready.json")
        require(self.state["state"] == "released" and ready == {"generation": self.state["generation"], "token_hash": self.state["token_hash"], "no_new_children": True}, "Fixture fork phase has not settled")
        fd = os.pidfd_open(claim["pid"])
        try:
            require(self._claim(claim["pid"]) == claim, "Recorded PID identity changed")
            snapshot = self.snapshot()
            require(claim in snapshot["claims"], "Process is not a positively owned member")
            self._guard()
            signal.pidfd_send_signal(fd, sig)
        finally:
            os.close(fd)

    def empty(self):
        _, root, _ = self._unit()
        current = recursive_members(root, self.state["scope"]["identity"])
        events = dict(line.split() for line in (root / "cgroup.events").read_text().splitlines())
        require(not current["pids"] and events.get("populated") == "0", "Whole scope is not positively empty")
        claims = list(self.directory.glob("claim-*.json"))
        require(len(claims) <= 12 and self.state.get("bootstrap"), "Bounded bootstrap/process evidence is missing")
        for path in claims:
            claim = read_json(path)
            require(claim.get("token_hash") == self.state["token_hash"] and claim.get("unit") == self.state["unit"] and positively_exited(claim), "A recorded fixture process has not conclusively exited")
        require(current == recursive_members(root, self.state["scope"]["identity"]), "Scope changed during empty proof")
        return current

    def cleanup(self):
        self._guard(allow_stop=True)
        self.empty()
        self._unit()
        self.empty()
        result = subprocess.run(["systemctl", "--user", "stop", "--", self.state["unit"]], capture_output=True, text=True, timeout=5)
        require(result.returncode == 0, "Could not retire exact empty fixture unit; preserve evidence")
        self._guard(allow_stop=True)
        self._save(state="cleaned")

    def request_stop(self):
        self._guard(allow_stop=True)
        self._save(stop_requested=True)
        (self.directory / "STOP").touch(mode=0o600, exist_ok=True)
