"""Confinement regressions: fake credentials and local processes, never models."""
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import managed_probe_config as config
import managed_claude_probe as claude
import managed_codex_probe as codex


class ConfinementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "auth"
        self.home.mkdir(mode=0o700)
        self.fixture = {"provider_home": str(self.home), "isolation_root": str(self.root / "isolation"),
                        "directory": str(self.root), "env": {}, "processes": Mock()}
        self.policy_paths = patch.dict(config.MANAGED_PATHS, {"claude": (), "codex": ()})
        self.policy_paths.start(); self.addCleanup(self.policy_paths.stop)
        executable = patch.object(config.shutil, "which", return_value="/fixture/provider")
        executable.start(); self.addCleanup(executable.stop)

    def credential(self, provider):
        path = self.home / ("auth.json" if provider == "codex" else ".credentials.json")
        path.write_text("OBVIOUSLY-FAKE-TEST-DATA")
        path.chmod(0o600)
        return path

    def test_missing_auth_home_rejects_before_discovery_or_start(self):
        for module in (codex, claude):
            with patch.object(module, "_version") as version:
                result = module.run({})
            self.assertFalse(result["ok"])
            self.assertEqual(result["failure"], "isolated-provider-home-required")
            version.assert_not_called()

    def test_environment_and_codex_home_are_isolated_without_copying_auth(self):
        original = self.credential("codex")
        with patch.dict(os.environ, {"OPENAI_API_KEY": "fake", "ANTHROPIC_BASE_URL": "invalid",
                                     "NODE_OPTIONS": "bad", "CLAUDE_CODE_OAUTH_TOKEN": "fake"}):
            policy = config.prepare(self.fixture, "codex")
        self.assertEqual(policy["model"], "gpt-6-luna")
        self.assertEqual(policy["max_turns"], 4)
        self.assertEqual(policy["env"]["CODEX_HOME"], str(self.home))
        self.assertNotEqual(policy["env"]["HOME"], str(Path.home()))
        self.assertNotIn("OPENAI_API_KEY", policy["env"])
        self.assertNotIn("NODE_OPTIONS", policy["env"])
        self.assertEqual(list(self.root.rglob("auth.json")), [original])

    def test_home_rejects_settings_symlinks_hardlinks_and_broad_modes(self):
        credential = self.credential("codex")
        settings = self.home / "config.toml"; settings.write_text("sandbox_mode='danger-full-access'")
        with self.assertRaisesRegex(config.ConfigurationError, "only-native-auth"):
            config.validate_home("codex", str(self.home))
        settings.unlink()
        credential.chmod(0o644)
        with self.assertRaisesRegex(config.ConfigurationError, "private-regular"):
            config.validate_home("codex", str(self.home))
        credential.chmod(0o600)
        os.link(credential, self.root / "linked-auth")
        with self.assertRaisesRegex(config.ConfigurationError, "private-regular"):
            config.validate_home("codex", str(self.home))
        (self.root / "linked-auth").unlink()
        credential.unlink(); credential.symlink_to(self.root / "outside")
        with self.assertRaisesRegex(config.ConfigurationError, "private-regular"):
            config.validate_home("codex", str(self.home))

    def test_managed_policy_and_ordinary_home_are_rejected(self):
        self.credential("claude")
        marker = self.root / "managed-settings.json"; marker.write_text("{}")
        with patch.dict(config.MANAGED_PATHS, {"claude": (str(marker),)}):
            with self.assertRaisesRegex(config.ConfigurationError, "managed-provider-policy"):
                config.prepare(self.fixture, "claude")
        with patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(self.home)}):
            with self.assertRaisesRegex(config.ConfigurationError, "ordinary-provider-home"):
                config.prepare(self.fixture, "claude")

    def test_claude_generated_guard_denies_nonexact_calls_before_execution(self):
        self.credential("claude")
        policy = config.prepare(self.fixture, "claude")
        settings = json.loads(policy["settings"])
        self.assertEqual(settings["permissions"]["allow"], ["Bash(node ./inspect-state.mjs)"])
        guard = Path(self.fixture["isolation_root"]) / "deny-unexpected-tool.py"
        attacks = ["node ./inspect-state.mjs; touch marker", "node ./inspect-state.mjs && pwd",
                   "node /elsewhere/inspect-state.mjs", "node ./inspect-state.mjs --extra",
                   "node ./inspect-state.mjs\npwd", "cat /private/file", "pwd"]
        for command in [config.INSPECT_COMMAND] + attacks:
            result = subprocess.run([sys.executable, str(guard)], input=json.dumps({
                "tool_name": "Bash", "tool_input": {"command": command}}),
                text=True, capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 0 if command == config.INSPECT_COMMAND else 2)
            self.assertEqual(result.stdout, "")  # Never responds with permission allow.
        for event in ({"tool_name": "Read", "tool_input": {}}, {}, {"tool_name": "Bash", "tool_input": []}):
            result = subprocess.run([sys.executable, str(guard)], input=json.dumps(event),
                                    text=True, capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 2)

    def test_unsafe_modes_and_turn_caps_rejected_before_start(self):
        self.credential("claude")
        for mode in ("acceptEdits", "auto", "bypassPermissions", "manual"):
            with self.subTest(mode=mode), self.assertRaisesRegex(config.ConfigurationError, "permission-mode"):
                config.prepare({**self.fixture, "permission_mode": mode}, "claude")
        for cap in (0, 9, -1, True, "4"):
            with self.subTest(cap=cap), self.assertRaisesRegex(config.ConfigurationError, "max-turns"):
                config.prepare({**self.fixture, "max_turns": cap}, "claude")

    def test_claude_startup_sets_tools_hook_isolation_model_and_turn_limit(self):
        self.credential("claude")
        policy = config.prepare(self.fixture, "claude")
        owner = Mock(); owner.popen.return_value = Mock(stdin=io.StringIO())
        with patch.object(claude.threading, "Thread"):
            claude.Session({**self.fixture, "policy": policy, "processes": owner})
        argv = owner.popen.call_args.args[0]
        self.assertEqual(argv[argv.index("--tools") + 1], "Bash")
        self.assertEqual(argv[argv.index("--allowedTools") + 1], "Bash(node ./inspect-state.mjs)")
        self.assertEqual(argv[argv.index("--setting-sources") + 1], "")
        self.assertEqual(argv[argv.index("--max-turns") + 1], "4")
        self.assertIn("--strict-mcp-config", argv)
        self.assertIn("claude-haiku-5-5", argv)
        session = claude.Session.__new__(claude.Session)
        session.identity = "fixture"; session.directory = self.root
        session.fixture = {"policy": policy}; session.hooks = []
        for mode in ("acceptEdits", "auto", "bypassPermissions", "default"):
            with self.assertRaisesRegex(claude.ProbeFailure, "inherited-permission-mode"):
                session._observe({"type": "system", "subtype": "init", "session_id": "fixture",
                                  "cwd": str(self.root), "model": policy["model"], "permissionMode": mode,
                                  "tools": ["Bash"]})

    def test_codex_startup_pins_policy_and_checks_auth_before_model(self):
        owner = Mock(); owner.popen.return_value = Mock(stdin=io.StringIO())
        with patch.object(codex.threading, "Thread"), patch.object(codex, "require_codex_read_confinement"):
            server = codex.AppServer(self.root, {"CODEX_HOME": str(self.home)}, "gpt-6-luna",
                                    processes=owner, executable="/fixture/codex", max_turns=1)
        argv = owner.popen.call_args.args[0]
        self.assertIn('sandbox_mode="read-only"', argv); self.assertIn("mcp_servers={}", argv)
        result = {"model": "gpt-6-luna", "cwd": str(self.root), "thread": {"id": "thread"},
                  "modelProvider": "openai", "approvalPolicy": "on-request", "approvalsReviewer": "user",
                  "sandbox": {"type": "readOnly", "networkAccess": False}, "reasoningEffort": None, "serviceTier": None}
        effective = {}
        for key, value in config.CODEX_RESTRICTIONS.items():
            target = effective
            parts = key.split('.')
            for part in parts[:-1]:target = target.setdefault(part, {})
            target[parts[-1]] = value
        server.call = Mock(side_effect=[{}, {"config": effective}, {"account": {"type": "chatgpt"}},
                                        {"data": [{"model": "gpt-6-luna"}]}, result])
        server.start()
        params = server.call.call_args.args[1]
        self.assertEqual(params["sandbox"], "read-only")
        self.assertEqual(params["approvalPolicy"], "on-request")
        self.assertEqual(params["approvalsReviewer"], "user")
        server.turn_count = 1; server.call.reset_mock()
        with self.assertRaisesRegex(codex.ProbeFailure, "turn_cap"):
            server.turn("no call", [config.INSPECT_COMMAND], "marker")
        server.call.assert_not_called()
        server.call = Mock(side_effect=[{}, {"config": effective}, {"account": {"type": "apiKey"}}])
        with self.assertRaisesRegex(codex.ProbeFailure, "chatgpt_authentication"):
            server.start()
        self.assertEqual(server.call.call_count, 3)

    def test_codex_live_probe_is_gated_before_any_provider_process_or_model(self):
        self.credential("codex")
        with patch.object(codex, "_version") as version:
            result = codex.run(self.fixture)
        self.assertEqual(result["failure"], "codex-readable-roots-confinement-unavailable")
        self.assertFalse(result["ok"])
        version.assert_not_called()
        self.fixture["processes"].popen.assert_not_called()
        self.fixture["processes"].run.assert_not_called()
        with self.assertRaisesRegex(config.ConfigurationError, "readable-roots-confinement"):
            codex.AppServer(self.root, {}, processes=self.fixture["processes"], executable="/fixture/codex")
        self.fixture["processes"].popen.assert_not_called()

    def test_claude_requires_all_advertised_flags_before_start(self):
        policy = {"executable": "/fixture/claude", "env": {}}
        for missing in claude.REQUIRED_FLAGS:
            owner = Mock()
            owner.run.side_effect = [
                subprocess.CompletedProcess([], 0, "Claude Code " + claude.SUPPORTED_VERSION),
                subprocess.CompletedProcess([], 0, "\n".join(flag for flag in claude.REQUIRED_FLAGS if flag != missing))]
            with self.subTest(missing=missing), self.assertRaisesRegex(claude.ProbeFailure, "confinement-flags-unavailable"):
                claude._version(policy, owner)
            owner.popen.assert_not_called()
        owner.run.side_effect = [
            subprocess.CompletedProcess([], 0, "Claude Code " + claude.SUPPORTED_VERSION),
            subprocess.CompletedProcess([], 0, "\n".join(claude.REQUIRED_FLAGS))]
        self.assertEqual(claude._version(policy, owner), claude.SUPPORTED_VERSION)

    def test_diagnostic_rejects_outside_paths_and_all_symlink_parents(self):
        outside = self.root / "outside"
        outside.mkdir()
        scratch = self.root / "scratch"
        scratch.mkdir()
        linked = scratch / "linked"
        linked.symlink_to(outside, target_is_directory=True)
        internal = scratch / "internal"
        internal.mkdir()
        internal_link = scratch / "internal-link"
        internal_link.symlink_to(internal, target_is_directory=True)
        targets = [outside / "diagnostic", scratch / ".." / "outside" / "diagnostic",
                   linked / "diagnostic", internal_link / "diagnostic"]
        for target in targets:
            with self.subTest(target=target), patch.dict(os.environ, {"SASSATO_PROBE_DIAGNOSTIC": str(target)}):
                claude._private_diagnostic("fixture", "private", scratch)
                self.assertFalse(target.exists())
        linked_root = self.root / "scratch-link"
        linked_root.symlink_to(scratch, target_is_directory=True)
        with patch.dict(os.environ, {"SASSATO_PROBE_DIAGNOSTIC": str(linked_root / "diagnostic")}):
            claude._private_diagnostic("fixture", "private", linked_root)
        self.assertFalse((scratch / "diagnostic").exists())
        with patch.dict(os.environ, {"SASSATO_PROBE_DIAGNOSTIC": "internal/diagnostic"}):
            claude._private_diagnostic("fixture", "allowed", scratch)
        self.assertEqual(json.loads((internal / "diagnostic").read_text())["value"], "allowed")

    def test_private_diagnostic_exclusive_regular_600_and_never_clobbers(self):
        path = self.root / "diagnostic.json"
        with patch.dict(os.environ, {"SASSATO_PROBE_DIAGNOSTIC": str(path)}):
            claude._private_diagnostic("fixture", "first", self.root)
            saved = path.read_bytes()
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            claude._private_diagnostic("fixture", "second", self.root)
            self.assertEqual(path.read_bytes(), saved)
            path.unlink(); target = self.root / "target"; target.write_text("keep")
            path.symlink_to(target); claude._private_diagnostic("fixture", "overwrite", self.root)
            self.assertEqual(target.read_text(), "keep")
            path.unlink(); os.mkfifo(path)
            claude._private_diagnostic("fixture", "never blocks", self.root)
            self.assertTrue(stat.S_ISFIFO(path.lstat().st_mode))


if __name__ == "__main__":
    unittest.main()
