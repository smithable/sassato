"""Offline fault-injection tests. Never creates a unit or launches a provider."""
import json
import errno
import os
from pathlib import Path
import signal
import stat
import sys
import tempfile
import time
import unittest
import struct
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import native_containment as native
import native_containment_events as events


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
        self.scope.retained = SimpleNamespace(assert_continuous=lambda: None, close=lambda: None)
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
        self.scope._save(state="released", inventory={"claims": [{"pid": os.getpid(), "start": "wrong"}]})
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
        proof = {"identity": native.identity(group), "group": self.scope.state["parent_group"] + "/" + self.scope.state["unit"], "invocation": "fixture"}
        self.scope.state["scope"] = proof
        self.scope._unit = lambda: ({}, group, proof)
        self.scope._unit_metadata = lambda: {"ControlGroup": proof["group"]}
        claim = {"pid": 123, "role": "main", "start": "fixture"}
        native.atomic_json(self.directory / "claim-123.json", claim)
        self.scope.state["bootstrap"] = claim
        self.scope.state["inventory"] = {"phase": "held", "claims": [claim], "generation": 1, "token_hash": self.scope.state["token_hash"]}
        self.scope.state["state"] = "held"
        self.scope.retained = SimpleNamespace(assert_continuous=lambda: None, close=lambda: None, drain=lambda: False, event_file_observation=lambda: {"populated": "1"})
        with patch.object(native, "positively_exited", return_value=True):
            with self.assertRaisesRegex(native.UnknownScope, "not positively empty"):
                self.scope.cleanup()
            self.scope.state["scope"] = {**proof, "identity": {**proof["identity"], "inode": 0}}
            with self.assertRaisesRegex(native.UnknownScope, "identity changed"):
                self.scope.cleanup()

    def test_surviving_recorded_process_blocks_even_with_an_empty_path_inventory(self):
        self.scope.state["scope"] = {"group": self.scope.state["parent_group"] + "/" + self.scope.state["unit"], "identity": {"device": 0, "inode": 0}, "invocation": "a" * 32}
        self.scope._unit_metadata = lambda: {"ControlGroup": ""}
        claim = {"pid": os.getpid(), "role": "main", "start": native.fingerprint(os.getpid())}
        native.atomic_json(self.directory / f"claim-{claim['pid']}.json", claim)
        self.scope.state.update({"state": "held", "bootstrap": claim, "inventory": {"phase": "held", "claims": [claim], "generation": 1, "token_hash": self.scope.state["token_hash"]}})
        self.scope.retained = SimpleNamespace(assert_continuous=lambda: None, close=lambda: None)
        with self.assertRaisesRegex(native.UnknownScope, "not conclusively exited"):
            self.scope.cleanup()

    def test_changed_unit_invocation_and_lost_handle_block_cleanup(self):
        self.scope.state["scope"] = {"invocation": "a" * 32}
        values = {**native.FixtureScope.REQUIRED, **{key: "" for key in native.FixtureScope.EMPTY}, "Id": self.scope.state["unit"], "Description": self.scope.state["description"], "LoadState": "loaded", "InvocationID": "b" * 32}
        with patch.object(native, "properties", return_value=values):
            with self.assertRaisesRegex(native.UnknownScope, "invocation changed"):
                self.scope.cleanup()
        self.scope._unit_metadata = lambda: {}
        with self.assertRaisesRegex(native.UnknownScope, "retained scope proof was lost"):
            self.scope.cleanup()


def event_bytes(watch, mask, name="owned.service"):
    raw = name.encode() + b"\0"
    raw += b"\0" * (-len(raw) % 4)
    return struct.pack("iIII", watch, mask, 0, len(raw)) + raw


class RemovalLedgerTests(unittest.TestCase):
    def test_only_positive_exact_directory_delete_is_evidence(self):
        ledger = events.NamespaceLedger(7, "owned.service")
        ledger.feed(event_bytes(7, events.DELETE | events.ISDIR, "unrelated.service"))
        self.assertFalse(ledger.deleted)
        ledger.feed(event_bytes(7, events.DELETE | events.ISDIR))
        self.assertTrue(ledger.deleted)

    def test_replacement_move_overflow_watch_loss_and_truncation_poison_history(self):
        for data in [event_bytes(7, events.CREATE | events.ISDIR), event_bytes(7, events.MOVE | events.ISDIR), event_bytes(-1, 0x4000), event_bytes(7, 0x8000, ""), event_bytes(8, events.DELETE | events.ISDIR), b"short"]:
            with self.subTest(data=data):
                ledger = events.NamespaceLedger(7, "owned.service")
                with self.assertRaises(events.UnprovenRemoval):
                    ledger.feed(data)
                with self.assertRaises(events.UnprovenRemoval):
                    ledger.feed(event_bytes(7, events.DELETE | events.ISDIR))

    def test_delete_then_recreated_name_is_not_accepted(self):
        ledger = events.NamespaceLedger(7, "owned.service")
        ledger.feed(event_bytes(7, events.DELETE | events.ISDIR))
        with self.assertRaises(events.UnprovenRemoval):
            ledger.feed(event_bytes(7, events.CREATE | events.ISDIR))


class RetainedHandleTests(unittest.TestCase):
    """Real temporary filesystem watches, mocked cgroup type; never native units."""
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="sassato-retained-fs-")
        self.parent = Path(self.temporary.name)
        self.root = self.parent / "owned.service"
        self.root.mkdir()
        (self.root / "cgroup.events").write_text("populated 1\nfrozen 0\n")
        (self.root / "cgroup.type").write_text("domain\n")
        self.magic = patch.object(events, "filesystem_magic", return_value=events.CGROUP2_MAGIC)
        self.kernel = patch.object(events, "SUPPORTED_KERNEL", os.uname().release)
        self.magic.start()
        self.kernel.start()
        self.retained = events.RetainedScope(self.root, native.identity(self.root), self.parent, native.identity(self.parent))

    def tearDown(self):
        self.retained.close()
        self.kernel.stop()
        self.magic.stop()
        self.temporary.cleanup()

    def remove(self):
        (self.root / "cgroup.events").unlink()
        (self.root / "cgroup.type").unlink()
        self.root.rmdir()

    def test_positive_event_ties_removed_name_to_continuously_retained_identity(self):
        before = self.retained.root_meta
        self.remove()
        proof = self.retained.deletion_evidence()
        self.assertEqual(proof["before"]["root_fd"], before)
        self.assertEqual(proof["after"]["root_fd"], before)
        self.assertTrue(proof["events"][0]["mask"] & events.DELETE)

    def test_absence_without_event_lost_handle_and_replacement_fail(self):
        with self.assertRaises(events.UnprovenRemoval):
            self.retained.deletion_evidence()
        self.remove()
        self.root.mkdir()
        with self.assertRaises(events.UnprovenRemoval):
            self.retained.deletion_evidence()
        self.retained.close()
        with self.assertRaises(events.UnprovenRemoval):
            self.retained.deletion_evidence()

    def test_permission_read_failure_and_changed_mount_are_not_deletion_proof(self):
        with patch.object(events.os, "pread", side_effect=PermissionError("denied")):
            with self.assertRaises(PermissionError):
                self.retained.event_file_observation()
        with self.assertRaises(events.UnprovenRemoval):
            self.retained.deletion_evidence()
        # A fresh object is required after a permission/identity failure.
        self.retained.close()
        self.retained = events.RetainedScope(self.root, native.identity(self.root), self.parent, native.identity(self.parent))
        with patch.object(events, "filesystem_magic", return_value=0):
            with self.assertRaises(events.UnprovenRemoval):
                self.retained.assert_continuous()

    def test_lost_or_reused_descriptor_does_not_become_proof_or_close_a_foreign_file(self):
        fd = self.retained.events_fd
        os.close(fd)
        other = os.open(self.parent / "foreign", os.O_RDWR | os.O_CREAT, 0o600)
        try:
            with self.assertRaises((events.UnprovenRemoval, OSError)):
                self.retained.deletion_evidence()
            self.retained.close()
            os.fstat(other)
        finally:
            os.close(other)

    def test_transient_read_error_poisoned_even_if_a_later_delete_arrives(self):
        with patch.object(events.os, "read", side_effect=OSError(errno.EIO, "transient")):
            with self.assertRaises(OSError):
                self.retained.drain()
        self.remove()
        with self.assertRaises(events.UnprovenRemoval):
            self.retained.deletion_evidence()


if __name__ == "__main__":
    unittest.main()
