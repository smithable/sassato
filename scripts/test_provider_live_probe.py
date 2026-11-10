"""Deterministic confinement tests: no installed provider or model is invoked."""
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

from probe_processes import OwnedProcesses, ProbeCancelled

spec = importlib.util.spec_from_file_location('provider_live_probe', Path(__file__).with_name('provider-live-probe.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def result(self, data, code=0):
        return subprocess.CompletedProcess([], code, json.dumps(data), '')

    def test_unknown_version_stops_before_provider_launch(self):
        with patch.object(probe.PROCESSES, 'run', return_value=subprocess.CompletedProcess([], 0, 'codex-cli 9.0.0', '')), patch.object(probe.subprocess, 'Popen') as launch:
            with self.assertRaisesRegex(RuntimeError, 'Unsupported provider version'):
                probe.run_codex()
            launch.assert_not_called()

    def test_codex_disables_every_discovered_mcp_server_then_rechecks(self):
        initial = [{'name': 'local-server', 'enabled': True}, {'name': 'remote', 'enabled': False}]
        disabled = [{**row, 'enabled': False} for row in initial]
        with patch.object(probe.PROCESSES, 'run', side_effect=[self.result(initial), self.result(disabled)]) as run:
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
            with self.subTest(data=data), patch.object(probe.PROCESSES, 'run', return_value=self.result(data)):
                with self.assertRaisesRegex(RuntimeError, 'confinement'):
                    probe.codex_command('/temporary/probe')
        with patch.object(probe.PROCESSES, 'run', side_effect=[self.result([]), self.result([{'name': 'late', 'enabled': True}])]):
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
        with patch.object(probe, 'version', return_value='0.167.0'), patch.object(probe, 'codex_command', return_value=(['fake'], probe.CODEX_RESTRICTIONS)), patch.object(probe.PROCESSES, 'popen', return_value=process), patch.object(probe, 'close_owned', return_value=0):
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


@unittest.skipUnless(sys.platform == 'linux', 'Actual process-group assertions use Linux /proc')
class ProcessLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.record = self.root/'groups.jsonl'
        self.fake = self.root/'codex'
        self.fake.write_text("#!/usr/bin/env python3\nimport json, os, signal, subprocess, sys, time\nfrom pathlib import Path\nstage=os.environ.get('FIXTURE_STAGE')\nif '--version' in sys.argv and stage!='version':\n print('codex-cli 0.167.0');sys.exit(0)\nif 'mcp' in sys.argv and stage!='mcp':\n print('[]');sys.exit(0)\nchild=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'])\ndef stop(sig,frame):\n signal.signal(signal.SIGTERM,signal.SIG_IGN)\n signal.signal(signal.SIGINT,signal.SIG_IGN)\n try: child.terminate()\n except ProcessLookupError: pass\n child.wait(timeout=2)\n time.sleep(0.2)\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nsignal.signal(signal.SIGINT,stop)\nwith open(os.environ['FIXTURE_RECORD'],'a') as out:\n out.write(json.dumps({'parent':os.getpid(),'child':child.pid,'group':os.getpgrp()})+'\\n');out.flush()\nwhile True: time.sleep(0.05)\n")
        self.fake.chmod(0o700)
        self.env = {**os.environ, 'PATH': str(self.root)+os.pathsep+os.environ.get('PATH',''),
                    'FIXTURE_RECORD': str(self.record)}

    def records(self):
        if not self.record.exists():
            return []
        return [json.loads(line) for line in self.record.read_text().splitlines()]

    def await_groups(self, process, count):
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            if len(self.records())>=count:
                return self.records()
            if process.poll() is not None:
                self.fail('Fixture runner exited before creating owned groups')
            time.sleep(0.01)
        self.fail('Fixture groups did not become ready')

    def ensure_cleanup(self, process):
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        for row in self.records():
            try: os.killpg(row['group'],signal.SIGKILL)
            except ProcessLookupError: pass
        for stream in (process.stdout,process.stderr):
            if stream: stream.close()

    def assert_groups_gone(self, rows):
        for row in rows:
            for key in ('parent','child'):
                self.assertFalse(Path('/proc',str(row[key])).exists(), f'{key} process survived cancellation')
            with self.assertRaises(ProcessLookupError):
                os.killpg(row['group'],0)

    def test_cli_cancellation_cleans_discovery_and_provider_groups(self):
        for stage in ('version','mcp','provider'):
            for sig in (signal.SIGTERM,signal.SIGINT):
                with self.subTest(stage=stage,signal=sig):
                    self.record.unlink(missing_ok=True)
                    process=subprocess.Popen([sys.executable,str(Path(probe.__file__)),'--provider','codex'],
                        env={**self.env,'FIXTURE_STAGE':stage},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
                    try:
                        rows=self.await_groups(process,1)
                        self.assertNotEqual(rows[0]['group'],os.getpgrp())
                        process.send_signal(sig)
                        time.sleep(0.04)
                        # A second, different termination request cannot interrupt
                        # cleanup or replace the original termination result.
                        process.send_signal(signal.SIGINT if sig==signal.SIGTERM else signal.SIGTERM)
                        stdout,stderr=process.communicate(timeout=8)
                        self.assertEqual(process.returncode,128+sig,stderr)
                        report=json.loads(stdout)
                        self.assertTrue(report['cancelled']);self.assertFalse(report['ok'])
                        self.assertEqual(report['signal'],sig)
                        self.assertNotIn('cleanup_failures',report)
                        self.assert_groups_gone(rows)
                    finally:
                        self.ensure_cleanup(process)

    def test_cancellation_cleans_all_provider_and_discovery_groups(self):
        harness=self.root/'runner.py'
        harness.write_text('import sys,signal\nfrom probe_processes import OwnedProcesses, ProbeCancelled\njobs=OwnedProcesses()\ntry:\n with jobs:\n  jobs.popen([sys.executable,sys.argv[1]])\n  jobs.popen([sys.executable,sys.argv[1]])\n  jobs.run([sys.executable,sys.argv[1]],timeout=60,capture_output=True,text=True)\nexcept ProbeCancelled as error:\n sys.exit(128+error.signum)\nsys.exit(1)\n')
        process=subprocess.Popen([sys.executable,str(harness),str(self.fake)],
            env={**self.env,'PYTHONPATH':str(Path(probe.__file__).parent),'FIXTURE_STAGE':'provider'},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            rows=self.await_groups(process,3)
            self.assertEqual(len({row['group'] for row in rows}),3)
            process.terminate()
            time.sleep(0.04);process.send_signal(signal.SIGINT)
            stdout,stderr=process.communicate(timeout=8)
            self.assertEqual(process.returncode,128+signal.SIGTERM,stderr)
            self.assert_groups_gone(rows)
        finally:
            self.ensure_cleanup(process)

    def test_discovery_timeout_reaps_process_group(self):
        with OwnedProcesses() as jobs:
            with self.assertRaises(subprocess.TimeoutExpired):
                jobs.run([sys.executable,str(self.fake)],timeout=0.15,
                    env={**self.env,'FIXTURE_STAGE':'version'},capture_output=True,text=True)
            self.assertEqual(jobs.processes,[])
        self.assert_groups_gone(self.records())


class OwnershipRaceTests(unittest.TestCase):
    def test_signal_during_spawn_registers_child_before_cancelling(self):
        jobs=OwnedProcesses(); process=Mock(pid=1234)
        def spawn(*args,**kwargs):
            self.assertTrue(kwargs['start_new_session'])
            jobs._signal(signal.SIGTERM,None)
            return process
        with patch('probe_processes.subprocess.Popen',side_effect=spawn):
            with self.assertRaises(ProbeCancelled) as raised:
                jobs.popen(['fixture'])
        self.assertEqual(raised.exception.signum,signal.SIGTERM)
        self.assertEqual(jobs.processes,[process])
        with patch('probe_processes.subprocess.Popen') as launch:
            with self.assertRaises(ProbeCancelled): jobs.popen(['must-not-start'])
            launch.assert_not_called()

    def test_first_signal_during_cleanup_is_deferred_and_preserved(self):
        jobs=OwnedProcesses();first=Mock(pid=1);second=Mock(pid=2)
        jobs.processes=[first,second]
        calls=[]
        def close(process):
            calls.append(process)
            if process is first:
                jobs._signal(signal.SIGINT,None)
                jobs._signal(signal.SIGTERM,None)
            return 0
        with patch.object(jobs,'_group_exists',return_value=True),patch.object(jobs,'_signal_group'),patch.object(jobs,'close',side_effect=close):
            with self.assertRaises(ProbeCancelled) as raised:
                with jobs:
                    pass
        self.assertEqual(calls,[first,second])
        self.assertEqual(raised.exception.signum,signal.SIGINT)

    def test_full_stdin_pipe_cannot_block_cleanup_flush(self):
        read_fd,write_fd=os.pipe()
        os.set_blocking(write_fd,False)
        try:
            while True: os.write(write_fd,b'x'*4096)
        except BlockingIOError:
            pass
        stream=os.fdopen(write_fd,'wb',buffering=4096)
        stream.write(b'pending')
        process=Mock(pid=1234,stdin=stream);process.wait.return_value=0
        jobs=OwnedProcesses()
        try:
            with patch.object(jobs,'_group_exists',return_value=False):
                self.assertEqual(jobs.close(process),0)
            self.assertTrue(stream.closed)
        finally:
            os.close(read_fd)
            if not stream.closed: stream.close()

    def test_forced_cleanup_is_visible_to_managed_handoff_callers(self):
        process=Mock(pid=1234,stdin=io.StringIO());process.wait.return_value=0
        jobs=OwnedProcesses()
        with patch.object(jobs,'_group_exists',side_effect=[True,False]),patch.object(jobs,'_signal_group'):
            self.assertEqual(jobs.close(process),0)
        self.assertIn(process,jobs.forced_cleanup)

    def test_cleanup_failure_does_not_skip_other_owned_processes(self):
        jobs=OwnedProcesses();first=Mock(pid=1);second=Mock(pid=2)
        jobs.processes=[first,second]
        with patch.object(jobs,'_group_exists',return_value=True),patch.object(jobs,'_signal_group'),patch.object(jobs,'close',side_effect=[RuntimeError('private'),0]) as close:
            jobs.close_all()
        self.assertEqual([call.args[0] for call in close.call_args_list],[first,second])
        self.assertEqual(jobs.cleanup_failures,['RuntimeError'])


if __name__ == '__main__':
    unittest.main()
