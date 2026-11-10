"""Deterministic adapter checks; never starts a provider or makes model calls."""
import io
import json
from pathlib import Path
import queue
import signal
import subprocess
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

import managed_codex_probe as adapter


class RunTests(unittest.TestCase):
    def setUp(self):
        # Protocol orchestration stays testable while real launches are gated.
        gate = patch.object(adapter, "require_codex_read_confinement")
        gate.start(); self.addCleanup(gate.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.events = []
        self.servers = []
        self.old_exit = 0
        self.drift = False
        self.cleanup_error = False
        owner = self

        class FakeServer:
            def __init__(self, cwd, env, model, **kwargs):
                self.thread_id = "private-thread-" + str(len(owner.servers))
                self.index = len(owner.servers)
                self.closed = False
                owner.servers.append(self)
                owner.events.append("start" + str(self.index))

            def start(self):
                return {
                    "model": "different" if owner.drift and self.index else "model",
                    "modelProvider": "provider", "cwd": owner.temp.name,
                    "approvalPolicy": "on-request", "approvalsReviewer": "user",
                    "sandbox": {"type": "readOnly"}, "reasoningEffort": None,
                    "serviceTier": None,
                }

            def turn(self, prompt, commands, marker):
                owner.events.append("turn" + str(self.index))
                return {"text": "TASK INSTRUCTION private-answer",
                        "completed_commands": 1, "tool_marker_observed": True,
                        "turn_completed": True}

            def close(self):
                owner.events.append("close" + str(self.index))
                if owner.cleanup_error and self.index == 0:
                    raise RuntimeError("private cleanup details")
                return owner.old_exit if self.index == 0 else 0

        self.server_patch = patch.object(adapter, "AppServer", FakeServer)
        self.server_patch.start()
        self.addCleanup(self.server_patch.stop)
        self.version_patch = patch.object(adapter, "_version", return_value="0.167.0")
        self.version_patch.start()
        self.addCleanup(self.version_patch.stop)
        mocked=patch.object(adapter, "prepare", return_value={"env":{},"model":"model","max_turns":4,"executable":"/fixture/codex"})
        mocked.start();self.addCleanup(mocked.stop)
        self.fixture = {"processes": Mock(),
            "directory": self.temp.name, "env": {}, "initial_prompt": "inspect",
            "expected_initial_tokens": ["TASK"], "instruction_marker": "INSTRUCTION",
            "tool_marker": "OUTPUT", "required_tool_command": "node ./inspect-state.mjs",
            "before_fresh": self.before_fresh,
        }

    def before_fresh(self):
        self.events.append("checkpoint")
        return {"recovery_prompt": "recover", "expected_recovery_tokens": ["TASK"]}

    def test_success_exits_old_before_checkpoint_and_fresh(self):
        result = adapter.run(self.fixture)
        self.assertTrue(result["ok"], result)
        self.assertLess(self.events.index("close0"), self.events.index("checkpoint"))
        self.assertLess(self.events.index("checkpoint"), self.events.index("start1"))
        self.assertEqual(result["process_exit_codes"], [0, 0])
        serialized = json.dumps(result)
        for private in ("private-thread", "private-answer", self.temp.name):
            self.assertNotIn(private, serialized)

    def test_old_exit_failure_prevents_callback_and_replacement(self):
        self.old_exit = 1
        result = adapter.run(self.fixture)
        self.assertFalse(result["ok"])
        self.assertEqual(result["failure"], "old_process_exit_unsuccessful")
        self.assertNotIn("checkpoint", self.events)
        self.assertEqual(len(self.servers), 1)

    def test_forced_descendant_cleanup_blocks_handoff_even_with_leader_exit_zero(self):
        with patch.object(adapter.AppServer, "close", side_effect=adapter.ProbeFailure("owned_process_required_forced_cleanup")):
            result = adapter.run(self.fixture)
        self.assertFalse(result["ok"])
        self.assertEqual(result["failure"], "owned_process_required_forced_cleanup")
        self.assertNotIn("checkpoint", self.events)
        self.assertEqual(len(self.servers), 1)
        self.assertNotIn("old_process_exited_before_replacement", result)

    def test_settings_drift_stops_before_fresh_turn(self):
        self.drift = True
        result = adapter.run(self.fixture)
        self.assertFalse(result["ok"])
        self.assertEqual(result["failure"], "fresh_identity_or_settings_mismatch")
        self.assertNotIn("turn1", self.events)
        self.assertIn("close1", self.events)

    def test_cleanup_error_is_sanitized(self):
        self.cleanup_error = True
        result = adapter.run(self.fixture)
        self.assertFalse(result["ok"])
        self.assertNotIn("private cleanup details", json.dumps(result))
        self.assertNotIn("checkpoint", self.events)

    def test_final_cleanup_attempts_both_children_after_error(self):
        def before():
            self.cleanup_error = True
            return self.before_fresh()
        self.fixture["before_fresh"] = before
        result = adapter.run(self.fixture)
        self.assertFalse(result["ok"])
        self.assertIn("close1", self.events)
        self.assertEqual(result["cleanup_failures"], ["RuntimeError"])

    def test_unknown_version_prevents_process_start(self):
        with patch.object(adapter, "_version", side_effect=adapter.ProbeFailure("unsupported_version")):
            result = adapter.run(self.fixture)
        self.assertFalse(result["ok"])
        self.assertEqual(result["failure"], "unsupported_version")
        self.assertEqual(self.servers, [])

    def test_tool_diagnostic_preserves_failed_report(self):
        error = adapter.ProbeFailure("tool_did_not_complete_successfully",
                                     "sandbox-helper-unavailable")
        with patch.object(adapter.AppServer, "turn", side_effect=error):
            result = adapter.run(self.fixture)
        self.assertFalse(result["ok"])
        self.assertEqual(result["failure"], "tool_did_not_complete_successfully")
        self.assertEqual(result["diagnostic"], "sandbox-helper-unavailable")
        self.assertNotIn("checkpoint", self.events)


class ProtocolTests(unittest.TestCase):
    def server(self, events):
        server = adapter.AppServer.__new__(adapter.AppServer)
        server.thread_id = "thread"
        server.cwd = str(Path.cwd())
        server.pending = events
        server.queue = queue.Queue()
        server.call = Mock(return_value={"turn": {"id": "turn"}})
        server._receive = Mock(side_effect=adapter.ProbeFailure("unexpected_wait"))
        return server

    def item(self, kind="commandExecution", **overrides):
        item = {"type": kind, "id":"command", "command": "node ./inspect-state.mjs",
                "cwd": str(Path.cwd()), "status": "completed", "exitCode": 0,
                "aggregatedOutput": "OUTPUT"}
        item.update(overrides)
        return {"method": "item/completed", "params": {
            "threadId": "thread", "turnId": "turn", "item": item}}

    def done(self):
        return {"method": "turn/completed", "params": {
            "threadId": "thread", "turn": {"id": "turn", "status": "completed"}}}

    def turn(self, events):
        return self.server(events).turn("inspect", ["node ./inspect-state.mjs"], "OUTPUT")

    def test_real_command_marker_and_completion_required(self):
        result = self.turn([self.item(), self.done()])
        self.assertTrue(result["tool_marker_observed"])
        for events in ([self.done()], [self.item(aggregatedOutput="other"), self.done()],
                       [self.item("agentMessage", text="OUTPUT"), self.done()]):
            with self.subTest(events=events), self.assertRaisesRegex(
                    adapter.ProbeFailure, "missing_read_only_tool_evidence"):
                self.turn(events)

    def test_failed_command_rejected(self):
        with self.assertRaisesRegex(adapter.ProbeFailure, "tool_did_not_complete"):
            self.turn([self.item(exitCode=1), self.done()])

    def test_native_sandbox_failure_is_classified_without_output(self):
        private = "bwrap: execvp /private/install/bin/codex: No such file or directory\n"
        with self.assertRaises(adapter.ProbeFailure) as raised:
            self.turn([self.item(exitCode=1, status="failed", aggregatedOutput=private)])
        self.assertEqual(str(raised.exception), "tool_did_not_complete_successfully")
        self.assertEqual(raised.exception.diagnostic, "sandbox-helper-unavailable")
        self.assertNotIn("/private", str(raised.exception))
        for output in ("SQLite: attempt to write a readonly database", "bwrap: permission denied",
                       private + "more output", "x" * 8193, None):
            self.assertIsNone(adapter._tool_failure_diagnostic(output))

    def test_extra_commands_rejected_and_shell_wrapper_supported(self):
        for command in ("node ./inspect-state.mjs; touch leak", "node ./inspect-state.mjs && pwd",
                        "node ./inspect-state.mjs > output", "node ./inspect-state.mjs --other"):
            with self.subTest(command=command), self.assertRaisesRegex(
                    adapter.ProbeFailure, "unexpected_tool_command"):
                self.turn([self.item(command=command), self.done()])
        self.assertTrue(self.turn([
            self.item(command="/bin/bash -lc 'node ./inspect-state.mjs'"), self.done()
        ])["turn_completed"])

    def test_mismatched_thread_and_turn_rejected(self):
        for field, value, code in (("threadId", "other", "unexpected_thread_identity"),
                                   ("turnId", "other", "unexpected_turn_identity"),
                                   ("turnId", None, "missing_or_mismatched_item_turn_identity")):
            event = self.item()
            event["params"][field] = value
            with self.subTest(field=field, value=value), self.assertRaisesRegex(adapter.ProbeFailure, code):
                self.turn([event, self.done()])
        event = self.done()
        event["params"]["turn"]["id"] = "other"
        with self.assertRaisesRegex(adapter.ProbeFailure, "turn_did_not_complete"):
            self.turn([self.item(), event])

    def test_approval_and_control_requests_fail_closed(self):
        for method in ("item/commandExecution/requestApproval", "item/tool/call", "unknown/control"):
            server = adapter.AppServer.__new__(adapter.AppServer)
            server.queue = queue.Queue()
            server.queue.put({"id": 12, "method": method, "params": {}})
            with self.subTest(method=method), self.assertRaisesRegex(
                    adapter.ProbeFailure, "unsupported_provider_control_request"):
                server._receive(time.monotonic() + 1)

    def test_unknown_version_rejected_before_provider_start(self):
        with patch.object(adapter.subprocess, "run", return_value=subprocess.CompletedProcess(
                ["codex", "--version"], 0, "codex-cli 999.0.0", "")):
            with self.assertRaisesRegex(adapter.ProbeFailure, "unsupported_version"):
                adapter._version({"executable":"codex","env":{}}, type("Owner",(),{"run":lambda self,*args,**kwargs:adapter.subprocess.run(*args,**kwargs)})())


class CleanupTests(unittest.TestCase):
    def test_shared_owner_forced_cleanup_is_not_clean_handoff(self):
        server=adapter.AppServer.__new__(adapter.AppServer)
        server.process=Mock();server.closed=False
        server.processes=Mock(forced_cleanup={server.process})
        server.processes.close.return_value=0
        with self.assertRaisesRegex(adapter.ProbeFailure,'owned_process_required_forced_cleanup'):
            server.close()

    def test_clean_close_is_idempotent(self):
        server=adapter.AppServer.__new__(adapter.AppServer)
        server.process=Mock();server.closed=False
        server.processes=Mock(forced_cleanup=set())
        server.processes.close.return_value=0
        self.assertEqual(server.close(),0);self.assertEqual(server.close(),0)
        server.processes.close.assert_called_once_with(server.process)


if __name__ == "__main__":
    unittest.main()
