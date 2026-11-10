"""Deterministic confinement tests: no installed provider or model is invoked."""
import importlib.util
import io
import json
from pathlib import Path
import signal
import subprocess
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('provider_live_probe', Path(__file__).with_name('provider-live-probe.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def result(self, data, code=0):
        return subprocess.CompletedProcess([], code, json.dumps(data), '')

    def test_unknown_version_stops_before_provider_launch(self):
        with patch.object(probe.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'codex-cli 9.0.0', '')), patch.object(probe.subprocess, 'Popen') as launch:
            with self.assertRaisesRegex(RuntimeError, 'Unsupported provider version'):
                probe.run_codex()
            launch.assert_not_called()

    def test_codex_disables_every_discovered_mcp_server_then_rechecks(self):
        initial = [{'name': 'local-server', 'enabled': True}, {'name': 'remote', 'enabled': False}]
        disabled = [{**row, 'enabled': False} for row in initial]
        with patch.object(probe.subprocess, 'run', side_effect=[self.result(initial), self.result(disabled)]) as run:
            command, settings = probe.codex_command('/temporary/probe')
        self.assertEqual(run.call_count, 2)
        for call in run.call_args_list:
            self.assertEqual(call.args[0][-3:], ['mcp', 'list', '--json'])
            self.assertEqual(call.kwargs['cwd'], '/temporary/probe')
        for name in ('local-server', 'remote'):
            self.assertIs(settings[f'mcp_servers.{name}.enabled'], False)
            self.assertIn(f'mcp_servers.{name}.enabled=false', command)
        for key in ('shell_tool', 'hooks', 'apps', 'plugins', 'multi_agent',
                    'browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
                    'computer_use', 'image_generation', 'in_app_browser', 'code_mode'):
            self.assertIn(f'features.{key}=false', command)
        self.assertIn('sandbox_mode="read-only"', command)
        self.assertIn('approval_policy="on-request"', command)
        self.assertIn('approvals_reviewer="user"', command)
        self.assertIn('agents.enabled=false', command)
        self.assertIn('web_search="disabled"', command)
        self.assertIn('notify=[]', command)

    def test_mcp_discovery_fails_closed(self):
        for data in ({}, [{'name': 'bad.name', 'enabled': True}], [{'name': 'missing-state'}], [{'name': 'a', 'enabled': True}]*2):
            with self.subTest(data=data), patch.object(probe.subprocess, 'run', return_value=self.result(data)):
                with self.assertRaisesRegex(RuntimeError, 'confinement'):
                    probe.codex_command('/temporary/probe')
        with patch.object(probe.subprocess, 'run', side_effect=[self.result([]), self.result([{'name': 'late', 'enabled': True}])]):
            with self.assertRaisesRegex(RuntimeError, 'remains enabled'):
                probe.codex_command('/temporary/probe')

    def test_effective_codex_config_and_thread_must_match(self):
        config = {'features': {'hooks': False}, 'sandbox_mode': 'read-only'}
        restrictions = {'features.hooks': False, 'sandbox_mode': 'read-only'}
        probe.validate_codex_config(config, restrictions)
        with self.assertRaises(RuntimeError):
            probe.validate_codex_config({'features': {'hooks': True}}, restrictions)
        valid = {'sandbox': {'type': 'readOnly', 'networkAccess': False}, 'approvalPolicy': 'on-request', 'approvalsReviewer': 'user'}
        probe.validate_codex_thread(valid)
        for changed in ({'sandbox': {'type': 'dangerFullAccess'}}, {'sandbox': {'type': 'readOnly', 'networkAccess': True}}, {'approvalPolicy': 'never'}, {'approvalsReviewer': 'guardian_subagent'}):
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                probe.validate_codex_thread({**valid, **changed})

    def test_codex_rejects_bad_config_before_any_thread_or_turn(self):
        process = Mock()
        process.stdin = io.StringIO()
        process.stdout = iter([json.dumps({'id': 1, 'result': {}})+'\n', json.dumps({'id': 2, 'result': {'config': {}}})+'\n'])
        process.stderr = iter([])
        with patch.object(probe, 'version', return_value='0.167.0'), patch.object(probe, 'codex_command', return_value=(['fake'], probe.CODEX_RESTRICTIONS)), patch.object(probe.subprocess, 'Popen', return_value=process), patch.object(probe, 'close_owned', return_value=0):
            report = probe.run_codex()
        self.assertFalse(report['ok'])
        requests = [json.loads(line)['method'] for line in process.stdin.getvalue().splitlines()]
        self.assertEqual(requests, ['initialize', 'initialized', 'config/read'])

    def test_claude_flags_confine_before_start(self):
        with patch.object(probe.sys, 'platform', 'linux'), patch.object(probe.Path, 'exists', return_value=False):
            args = probe.claude_command('session-id')
        self.assertEqual(args[args.index('--tools')+1], '')
        self.assertEqual(args[args.index('--disallowedTools')+1], 'mcp__*')
        self.assertIn('--strict-mcp-config', args)
        self.assertIn('--safe-mode', args)
        self.assertEqual(json.loads(args[args.index('--mcp-config')+1]), {'mcpServers': {}})
        self.assertTrue(json.loads(args[args.index('--settings')+1])['disableAllHooks'])
        self.assertEqual(args[args.index('--permission-prompts')+1], 'none')
        self.assertEqual(args[args.index('--permission-mode')+1], 'default')
        self.assertEqual(args[args.index('--max-turns')+1], '1')
        self.assertNotIn('--bare', args)
        self.assertNotIn('--dangerously-skip-permissions', args)

    def test_claude_managed_policy_fails_before_start(self):
        with patch.object(probe.sys, 'platform', 'linux'), patch.object(probe.Path, 'exists', return_value=True):
            with self.assertRaisesRegex(RuntimeError, 'Managed Claude policy'):
                probe.claude_command('session-id')

    def test_claude_rejects_unvalidated_host_before_start(self):
        for platform in ('darwin', 'win32', 'freebsd'):
            with self.subTest(platform=platform), patch.object(probe.sys, 'platform', platform), patch.object(probe.Path, 'exists', return_value=False):
                with self.assertRaisesRegex(RuntimeError, 'Linux only'):
                    probe.claude_command('session-id')

    def test_external_tools_and_notify_are_checked_in_effective_config(self):
        restrictions = {key: value for key, value in probe.CODEX_RESTRICTIONS.items()
                        if key.startswith('features.') or key == 'notify'}
        config = {'features': {key.removeprefix('features.'): value for key, value in restrictions.items() if key.startswith('features.')}, 'notify': []}
        probe.validate_codex_config(config, restrictions)
        for key in ('browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
                    'computer_use', 'image_generation', 'in_app_browser', 'code_mode'):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                probe.validate_codex_config({**config, 'features': {**config['features'], key: True}}, restrictions)
        with self.assertRaises(RuntimeError):
            probe.validate_codex_config({**config, 'notify': ['unexpected-command']}, restrictions)

    def test_claude_init_requires_empty_tools_and_mcp(self):
        valid = {'tools': [], 'mcp_servers': [], 'permissionMode': 'default'}
        probe.validate_claude_init(valid)
        for changed in ({'tools': ['Bash']}, {'mcp_servers': [{'name': 'external'}]}, {'tools': None}, {'permissionMode': 'bypassPermissions'}):
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                probe.validate_claude_init({**valid, **changed})
        with self.assertRaises(RuntimeError):
            probe.validate_claude_init({})

    def test_cleanup_checks_children_after_successful_leader_exit(self):
        process = Mock(pid=54321)
        process.wait.return_value = 0
        with patch.object(probe.os, 'killpg', side_effect=[None, None, ProcessLookupError]) as kill:
            self.assertEqual(probe.close_owned(process), 0)
        self.assertEqual(kill.call_args_list[0].args, (54321, 0))
        self.assertEqual(kill.call_args_list[1].args, (54321, signal.SIGTERM))

    def test_cleanup_escalates_surviving_group_and_reports_failure(self):
        process = Mock(pid=54321)
        process.wait.return_value = 0
        with patch.object(probe.os, 'killpg') as kill, patch.object(probe.time, 'monotonic', side_effect=range(0, 100, 3)):
            with self.assertRaisesRegex(RuntimeError, 'group cleanup'):
                probe.close_owned(process)
        self.assertIn((54321, signal.SIGKILL), [call.args for call in kill.call_args_list])

    def test_cleanup_failure_never_becomes_success(self):
        result = probe.sanitized({'ok': True, 'thread_id': 'old', 'fresh_thread_id': 'new', 'process_exit_code': 0, 'cleanup_failures': ['RuntimeError']})
        self.assertFalse(result['ok'])
        self.assertNotIn('thread_id', result)


if __name__ == '__main__':
    unittest.main()
