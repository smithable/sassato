"""Offline controller protocol: temporary files and a fixed inert stub, no unit."""
import fcntl
import io
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
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
        for case, code in lab.CASES.items():
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix="sassato-crash-receipt-") as name:
                path = Path(name)
                scope_dir = path / "new-scope"
                scope_dir.mkdir()
                intent = {"binding_started": True, "state": "held" if case == "binding-intent" else "released", "bootstrap": {"pid": 11, "role": "main"}}
                native.atomic_json(scope_dir / "claim-11.json", intent["bootstrap"])
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

    def test_wrong_injection_phase_cannot_emit_receipt_or_exit(self):
        for case in lab.CASES:
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix="sassato-wrong-phase-") as name:
                path = Path(name)
                native.atomic_json(path / "intent.json", {"binding_started": True, "state": "held"})
                scope = SimpleNamespace(directory=path, retained=object())
                with patch.object(lab.os, "_exit") as abrupt:
                    with self.assertRaises(native.UnknownScope):
                        lab.crash_receipt(scope, path, {"case": case})
                    abrupt.assert_not_called()
                self.assertFalse((path / "injection.json").exists())

    def test_reconciliation_guards_never_execute_manager_mutation_or_constructor(self):
        with patch.object(native.subprocess, "run", return_value="readonly") as run, patch.object(native, "RetainedScope") as constructor:
            with lab.reconciliation_guards("owned.service"):
                self.assertEqual(native.subprocess.run(["systemctl", "--user", "show", "--no-pager", "--", "owned.service"]), "readonly")
                for argv in [["systemctl", "--user", "stop", "--", "owned.service"], ["systemd-run", "--user"], ["systemctl", "--user", "show", "--no-pager", "--", "other.service"]]:
                    with self.assertRaises(native.UnknownScope):
                        native.subprocess.run(argv)
                with self.assertRaises(native.UnknownScope):
                    native.RetainedScope()
            run.assert_called_once()
            constructor.assert_not_called()

    def test_unknown_identity_never_signals_and_preserves_unreaped_diagnostic(self):
        with tempfile.TemporaryDirectory(prefix="sassato-unknown-controller-") as name:
            path = Path(name)
            process = SimpleNamespace(pid=123, returncode=None, poll=lambda: None)
            real_close = os.close
            with patch.object(lab.subprocess, "Popen", return_value=process), patch.object(lab.os, "pidfd_open", return_value=777), patch.object(lab, "pidfd_exited", return_value=False), patch.object(native, "fingerprint", return_value="owned"), patch.object(lab, "verify_process", side_effect=native.UnknownScope("identity mismatch")), patch.object(lab.signal, "pidfd_send_signal") as send, patch.object(lab.os, "close", side_effect=lambda fd: None if fd == 777 else real_close(fd)):
                with self.assertRaisesRegex(native.UnknownScope, "identity mismatch"):
                    lab.run_controller(path, "inject", time.monotonic() + 10)
                send.assert_not_called()
            report = native.read_json(path / "inject-exit.json")
            self.assertTrue(report["unreaped_controller"])
            self.assertFalse(report["verified_ownership"])
            self.assertIn("ownership unknown", report["reap_error"])

    def test_summary_preserves_primary_error_even_when_settling_also_fails(self):
        with tempfile.TemporaryDirectory(prefix="sassato-summary-error-") as name:
            path = Path(name)
            summary = {"result": "blocked-preserve-evidence", "error": "primary"}
            original = RuntimeError("primary")
            with patch.object(lab, "settle_failed_helpers", side_effect=OSError("secondary")):
                lab.save_summary(path, summary, original)
            saved = native.read_json(path / "crash-lab-result.json")
            self.assertEqual(saved["error"], "primary")
            self.assertIn("secondary", saved["preserve_errors"][0]["error"])
            with patch.object(native, "atomic_json", side_effect=OSError("storage")):
                lab.save_summary(path, summary, original)
            self.assertIn("storage", original.__notes__[0])

    def test_timeout_is_bounded_and_reaps_only_the_verified_new_controller(self):
        with tempfile.TemporaryDirectory(prefix="sassato-timeout-controller-") as name:
            path = Path(name)
            stub = path / "fixed_hanging_stub.py"
            stub.write_text("import sys\nsys.path.insert(0, " + repr(str(Path(native.__file__).parent)) + ")\n" + '''import signal, time
from pathlib import Path
import native_containment as native
from native_containment_crash_lab import controller_claim
signal.alarm(8)
path = Path(sys.argv[sys.argv.index("--scenario") + 1])
mode = sys.argv[sys.argv.index("--controller") + 1]
native.atomic_json(path / (mode + "-controller.json"), controller_claim())
while True:
    time.sleep(0.01)
''')
            start = time.monotonic()
            with patch.object(lab, "SCRIPT", stub), patch.object(lab, "CONTROLLER_SECONDS", 2), patch.object(lab, "REAP_SECONDS", 1):
                with self.assertRaises(lab.subprocess.TimeoutExpired):
                    lab.run_controller(path, "inject", time.monotonic() + 10)
            self.assertLess(time.monotonic() - start, 5)
            report = native.read_json(path / "inject-exit.json")
            self.assertTrue(report["owned_controller_timeout_or_error_kill"])
            self.assertTrue(report["wait_reaped"] and report["owned_pidfd_pollin"])
            self.assertEqual(report["exit_code"], -lab.signal.SIGKILL)
            with self.assertRaises(ChildProcessError):
                os.waitpid(report["pid"], os.WNOHANG)

    def test_startup_waits_out_an_unset_cmdline_but_never_accepts_another(self):
        import subprocess
        argv = [lab.PYTHON, "-B", "-c", "import time; time.sleep(5)"]
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL)
        try:
            start = native.fingerprint(process.pid)
            raw = [os.fsencode(part) for part in argv]
            # Right after Popen the kernel may not have set the argument area yet (the T906 race itself).
            deadline = time.monotonic() + 2
            while not lab.cmdline(process.pid) and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(lab.cmdline(process.pid), raw)
            with patch.object(lab, "cmdline", side_effect=[[], [], raw]):
                lab.verify_process(process, argv, start, settle=2)
            with patch.object(lab, "cmdline", side_effect=[[], [b"other"]]), self.assertRaisesRegex(native.UnknownScope, "executable changed"):
                lab.verify_process(process, argv, start, settle=2)
            with patch.object(lab, "cmdline", return_value=[]), self.assertRaisesRegex(native.UnknownScope, "executable changed"):
                lab.verify_process(process, argv, start)
            # A replacement character never stands in for other bytes.
            with patch.object(lab, "cmdline", return_value=[*raw[:-1], b"\xff"]), self.assertRaisesRegex(native.UnknownScope, "executable changed"):
                lab.verify_process(process, [*argv[:-1], "\ufffd"], start)
            # The wait is bounded by settle on the lab's own clock.
            clock = [0.0]
            fake = SimpleNamespace(monotonic=lambda: clock[0], sleep=lambda s: clock.__setitem__(0, clock[0] + s))
            reads = []
            with patch.object(lab, "time", fake), patch.object(lab, "cmdline", side_effect=lambda pid: reads.append(pid) or []), self.assertRaisesRegex(native.UnknownScope, "executable changed"):
                lab.verify_process(process, argv, start, settle=0.2)
            self.assertGreaterEqual(clock[0], 0.2)
            self.assertLess(clock[0], 0.25)
            self.assertLessEqual(len(reads), 22)
        finally:
            process.kill()
            process.wait()

    def test_parent_primary_failure_and_secondary_preservation_error_are_both_saved(self):
        with tempfile.TemporaryDirectory(prefix="sassato-parent-failure-") as name:
            path = Path(name)
            with patch.object(lab, "run_controller", side_effect=RuntimeError("primary failure")), patch.object(lab, "settle_failed_helpers", side_effect=OSError("secondary preservation")):
                with self.assertRaisesRegex(RuntimeError, "primary failure"):
                    lab.run_parent(path)
            saved = native.read_json(next(path.glob("controller-crash-*/crash-lab-result.json")))
            self.assertEqual(saved["result"], "blocked-preserve-evidence")
            self.assertIn("primary failure", saved["error"])
            self.assertIn("secondary preservation", saved["preserve_errors"][0]["error"])

    def test_changed_scenario_source_or_nonprivate_directory_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="sassato-scenario-fault-") as name:
            path = Path(name)
            native.atomic_json(path / "scenario.json", {"case": "sealed", "script_hash": "wrong", "deadline": time.monotonic() + 10})
            with self.assertRaises(native.UnknownScope):
                lab.checked_scenario(path)
            path.chmod(0o755)
            with self.assertRaises(native.UnknownScope):
                lab.checked_scenario(path)

    def test_exit_during_identity_recheck_reaps_original_pidfd_without_signaling(self):
        process = SimpleNamespace(pid=123, returncode=None, poll=lambda: None)
        def wait(**kwargs):
            process.returncode = 0
        process.wait = wait
        report = {"verified_ownership": True, "start": "owned"}
        with patch.object(lab, "pidfd_exited", side_effect=[False, True, True]), patch.object(lab, "verify_process", side_effect=native.UnknownScope("Controller executable changed")), patch.object(lab.signal, "pidfd_send_signal") as send:
            lab.reap_controller(process, 777, ["fixed"], report, time.monotonic() + 1)
            send.assert_not_called()
        self.assertTrue(report["wait_reaped"] and report["owned_pidfd_pollin"])
        self.assertEqual(report["exit_code"], 0)

    def test_nearly_expired_case_budget_cannot_spawn_a_controller(self):
        with patch.object(lab.subprocess, "Popen") as spawn:
            with self.assertRaises(native.UnknownScope):
                lab.run_controller(Path("/no-scenario-needed"), "reconcile", time.monotonic() + lab.REAP_SECONDS + 0.1)
            spawn.assert_not_called()

    def test_abbreviated_controller_flag_cannot_reach_child_mode(self):
        with patch.object(sys, "argv", [str(lab.SCRIPT), "--contr", "inject", "--scenario", "/unused"]), patch.object(lab, "child") as child, patch.object(sys, "stderr", io.StringIO()):
            with self.assertRaises(SystemExit) as error:
                lab.main()
            self.assertEqual(error.exception.code, 2)
            child.assert_not_called()
        for argv in [["--controller", "inject"], ["--controller=inject"]]:
            with patch.object(sys, "argv", [str(lab.SCRIPT), *argv, "--scenario", "/unused"]), patch.object(lab, "child") as child:
                lab.main()
                child.assert_called_once_with("/unused", "inject")


if __name__ == "__main__":
    unittest.main()
