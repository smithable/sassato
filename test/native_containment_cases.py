"""Offline fault-injection tests. Never creates a unit or launches a provider."""
import json
import os
from pathlib import Path
import signal
import stat
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import native_containment as native


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="sassato-native-offline-")
        self.root = Path(self.temporary.name)
        (self.root / "cgroup.procs").write_text("11\n")
        self.expected = native.identity(self.root)

    def tearDown(self):
        self.temporary.cleanup()

    def test_recursive_inventory_and_explicit_bounds(self):
        child = self.root / "nested"
        child.mkdir()
        (child / "cgroup.procs").write_text("22\n33\n")
        self.assertEqual(native.recursive_members(self.root, self.expected)["pids"], [11, 22, 33])
        with self.assertRaises(native.UnknownScope):
            native.recursive_members(self.root, self.expected, max_processes=2)
        with self.assertRaises(native.UnknownScope):
            native.recursive_members(self.root, self.expected, max_directories=1)

    def test_missing_malformed_and_symlink_observations_are_not_empty(self):
        (self.root / "cgroup.procs").unlink()
        with self.assertRaises(FileNotFoundError):
            native.recursive_members(self.root, self.expected)
        (self.root / "cgroup.procs").write_text("not-a-pid")
        with self.assertRaises(native.UnknownScope):
            native.recursive_members(self.root, self.expected)
        (self.root / "cgroup.procs").write_text("")
        (self.root / "alias").symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(native.UnknownScope):
            native.recursive_members(self.root, self.expected)

    def test_replaced_path_rejects_old_identity(self):
        with self.assertRaises(native.UnknownScope):
            native.recursive_members(self.root, {**self.expected, "inode": self.expected["inode"] + 1})


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="sassato-native-protocol-")
        self.root = Path(self.temporary.name)
        self.directory = self.root / "evidence"
        self.directory.mkdir(mode=0o700)
        self.parent = self.root / "kernel" / "user.slice" / "user-test.service"
        self.parent.mkdir(parents=True)
        (self.parent / "cgroup.subtree_control").write_text("cpu memory pids")
        helper = Path(native.__file__).with_name("native_containment_helper.py").resolve()
        self.state = {"version": 1, "revision": 0, "unit": "sassato-fixture-" + "a" * 32 + ".service", "generation": 1, "description": "offline", "state": "prepared", "token_hash": native.digest(b"fixture-token"), "helper": str(helper), "helper_hash": native.digest(helper.read_bytes()), "python": str(Path(sys.executable).resolve()), "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(), "parent_group": "/user.slice/user-test.service", "parent_identity": native.identity(self.parent), "parent_mode": stat.S_IMODE(self.parent.stat().st_mode), "parent_uid": self.parent.stat().st_uid, "parent_gid": self.parent.stat().st_gid, "parent_controllers": ["cpu", "memory", "pids"], "deadline": time.monotonic() + 20, "stop_requested": False, "directory_identity": native.identity(self.directory)}
        native.atomic_json(self.directory / "intent.json", self.state)
        self.kernel = patch.object(native, "CGROUP_ROOT", self.root / "kernel")
        self.kernel.start()
        self.scope = native.FixtureScope(self.directory, "fixture-token")
        self.run = patch.object(native.subprocess, "run", side_effect=AssertionError("Offline tests must not operate a real unit"))
        self.run.start()

    def tearDown(self):
        self.run.stop()
        self.scope.close()
        self.kernel.stop()
        self.temporary.cleanup()

    def held(self):
        self.scope._save(state="held", bootstrap={"pid": 123, "role": "main"})
        self.scope.snapshot = lambda: {"claims": [self.scope.state["bootstrap"]]}

    def test_duplicate_uncertain_launch_never_calls_manager(self):
        self.scope._save(state="launching")
        with self.assertRaisesRegex(native.UnknownScope, "never duplicate"):
            self.scope.launch()

    def test_stop_precedes_launch_release_and_recovery(self):
        self.scope.request_stop()
        for action in [self.scope.launch, self.scope.release, self.scope.recover]:
            with self.assertRaisesRegex(native.UnknownScope, "STOP"):
                action()

    def test_durable_stop_observed_without_reusing_cached_value(self):
        state = native.read_json(self.directory / "intent.json")
        state["stop_requested"] = True
        native.atomic_json(self.directory / "intent.json", state)
        with self.assertRaisesRegex(native.UnknownScope, "STOP"):
            self.scope.launch()

    def test_replaced_controller_lock_blocks_old_and_new_connections(self):
        lock = self.directory / "controller.lock"
        lock.rename(lock.with_suffix(".old"))
        lock.touch(mode=0o600)
        with self.assertRaisesRegex(native.UnknownScope, "lock path identity"):
            self.scope._guard()
        with self.assertRaisesRegex(native.UnknownScope, "lock was replaced"):
            native.FixtureScope(self.directory)

    def test_competing_controller_cannot_take_live_lock(self):
        with self.assertRaises(BlockingIOError):
            native.FixtureScope(self.directory)

    def test_release_is_durable_before_gate_and_recovery_completes_once(self):
        self.held()
        real = native.atomic_json
        def crash(path, value):
            if path.name == "release.json":
                raise OSError("simulated crash before gate write")
            real(path, value)
        with patch.object(native, "atomic_json", side_effect=crash):
            with self.assertRaises(OSError):
                self.scope.release()
        self.assertEqual(native.read_json(self.directory / "intent.json")["state"], "released")
        self.assertFalse((self.directory / "release.json").exists())
        self.scope.release()
        before = (self.directory / "release.json").read_text()
        self.scope.release()
        self.assertEqual((self.directory / "release.json").read_text(), before)

    def test_stop_between_release_intent_and_gate_prevents_action(self):
        self.held()
        save = self.scope._save
        def stop_after_save(**changes):
            save(**changes)
            (self.directory / "STOP").touch()
        self.scope._save = stop_after_save
        with self.assertRaisesRegex(native.UnknownScope, "STOP"):
            self.scope.release()
        self.assertFalse((self.directory / "release.json").exists())

    def test_pid_reuse_rejection_never_sends_signal(self):
        self.scope._save(state="released")
        native.atomic_json(self.directory / "ready.json", {"generation": 1, "token_hash": self.scope.state["token_hash"], "no_new_children": True})
        self.scope._claim = lambda pid: (_ for _ in ()).throw(native.UnknownScope("PID was reused"))
        with patch.object(native.signal, "pidfd_send_signal") as send:
            with self.assertRaisesRegex(native.UnknownScope, "reused"):
                self.scope.signal_owned({"pid": os.getpid(), "start": "wrong"})
            send.assert_not_called()

    def test_nonempty_or_changed_scope_never_requests_unit_stop(self):
        group = self.parent / self.scope.state["unit"]
        group.mkdir()
        (group / "cgroup.procs").write_text("123\n")
        (group / "cgroup.events").write_text("populated 1\n")
        proof = {"identity": native.identity(group)}
        self.scope.state["scope"] = proof
        self.scope._unit = lambda: ({}, group, proof)
        with self.assertRaisesRegex(native.UnknownScope, "not positively empty"):
            self.scope.cleanup()
        self.scope.state["scope"] = {"identity": {**proof["identity"], "inode": 0}}
        with self.assertRaisesRegex(native.UnknownScope, "identity changed"):
            self.scope.cleanup()


if __name__ == "__main__":
    unittest.main()
