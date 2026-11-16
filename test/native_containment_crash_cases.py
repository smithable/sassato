"""Offline controller protocol: temporary files and a fixed inert stub, no unit."""
import fcntl
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import native_containment as native
import native_containment_crash_lab as lab


class ControllerProtocolTests(unittest.TestCase):
    def test_actual_abrupt_child_exit_is_owned_reaped_and_releases_its_os_lock(self):
        with tempfile.TemporaryDirectory(prefix="sassato-offline-crash-") as name:
            path = Path(name)
            stub = path / "fixed_stub.py"
            stub.write_text("import sys\n" + "sys.path.insert(0, " + repr(str(Path(native.__file__).parent)) + ")\n" + '''import fcntl, os, signal, time
from pathlib import Path
import native_containment as native
from native_containment_crash_lab import controller_claim
signal.alarm(8)
path = Path(sys.argv[sys.argv.index("--scenario") + 1])
mode = sys.argv[sys.argv.index("--controller") + 1]
lock = os.open(path / "held.lock", os.O_RDWR | os.O_CREAT, 0o600)
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
claim = controller_claim()
native.atomic_json(path / (mode + "-controller.json"), claim)
while not (path / (mode + "-release.json")).exists():
    time.sleep(0.01)
assert native.read_json(path / (mode + "-release.json")) == claim
native.atomic_json(path / "state-before-death.json", {"binding_started": True})
os._exit(81)
''')
            with patch.object(lab, "SCRIPT", stub):
                report = lab.run_controller(path, "inject", time.monotonic() + 10)
            self.assertEqual(report["exit_code"], 81)
            self.assertTrue(report["wait_reaped"] and report["owned_pidfd_pollin"])
            self.assertEqual(native.read_json(path / "state-before-death.json"), {"binding_started": True})
            with self.assertRaises(ChildProcessError):
                os.waitpid(report["pid"], os.WNOHANG)
            fd = os.open(path / "held.lock", os.O_RDWR)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(fd)

    def test_rejection_needs_exact_expected_failure_and_does_not_accept_success(self):
        report = {}
        def blocked():
            raise native.UnknownScope("STOP blocks action")
        lab.rejection(blocked, "STOP", report, "release")
        self.assertIn("release", report["blocked_actions"])
        for action in [lambda: None, lambda: (_ for _ in ()).throw(native.UnknownScope("unrelated"))]:
            with self.assertRaises(native.UnknownScope):
                lab.rejection(action, "STOP", {}, "release")

    def test_injection_receipt_is_durable_before_abrupt_exit_at_each_exact_phase(self):
        from types import SimpleNamespace
        for case, code in lab.CASES.items():
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix="sassato-crash-receipt-") as name:
                path = Path(name)
                scope_dir = path / "new-scope"
                scope_dir.mkdir()
                intent = {"binding_started": True, "state": "held" if case == "binding-intent" else "released"}
                if case == "sealed":
                    intent["inventory"] = {"phase": "ready"}
                native.atomic_json(scope_dir / "intent.json", intent)
                scope = SimpleNamespace(directory=scope_dir, retained=None if case == "binding-intent" else object())
                def abrupt(value):
                    self.assertEqual(value, code)
                    receipt = native.read_json(path / "injection.json")
                    self.assertEqual(receipt["durable_intent"], intent)
                    self.assertEqual(receipt["controller"]["pid"], os.getpid())
                    raise SystemExit(value)
                with patch.object(lab.os, "_exit", side_effect=abrupt):
                    with self.assertRaises(SystemExit):
                        lab.crash_receipt(scope, path, {"case": case})

    def test_expired_parent_deadline_cannot_spawn_a_controller(self):
        with patch.object(lab.subprocess, "Popen") as spawn:
            with self.assertRaises(native.UnknownScope):
                lab.run_controller(Path("/no-scenario-needed"), "inject", time.monotonic() - 1)
            spawn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
