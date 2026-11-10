"""Deterministic Claude adapter tests: no CLI/model/auth calls are made."""
import importlib.util
import io
import json
from pathlib import Path
import queue
import signal
import types
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('managed_claude_probe', Path(__file__).with_name('managed_claude_probe.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class AdapterTest(unittest.TestCase):
    def setUp(self):
        policy={'executable':'/fixture/claude','env':{},'model':'test-model','max_turns':4,'settings':'{}'}
        self.policy=policy
        # These tests exercise the transport after a hypothetical future guard
        # proof. Dedicated startup tests below keep the actual live gate closed.
        gate = patch.object(probe, '_require_loaded_guard')
        gate.start(); self.addCleanup(gate.stop)
        self.close_outcome=Mock(return_value={'exit_code':0,'forced':False,'process_group_empty':True})
        mocked=patch.object(probe,'prepare',return_value=policy);mocked.start();self.addCleanup(mocked.stop)

    def owner(self):
        test=self
        class Owner:
            forced_cleanup=()
            def run(self, args, **kwargs):
                if args[-1:] == ['--help']:
                    return types.SimpleNamespace(returncode=0, stdout='\n'.join(probe.REQUIRED_FLAGS))
                if args[-2:]==['auth','status']:
                    return types.SimpleNamespace(returncode=0,stdout=json.dumps({'loggedIn':True,'authMethod':'claude.ai'}))
                return probe.subprocess.run(args,**kwargs)
            def popen(self,*args,**kwargs):return probe.subprocess.Popen(*args,**kwargs)
            def close(self,process):return test.close_outcome(process)['exit_code']
        return Owner()

    def fixture(self, events):
        def handoff():
            events.append('handoff')
            return {'recovery_prompt': 'fresh prompt', 'expected_recovery_tokens': ['fresh-token']}
        return {'directory': '/tmp/sassato-test-fixture', 'env': {}, 'processes':self.owner(), 'policy':self.policy,
                'required_tool_command': 'node ./inspect-state.mjs',
                'initial_prompt': 'initial prompt', 'expected_initial_tokens': ['initial-token'],
                'instruction_marker': 'project-marker', 'tool_marker': 'real-tool-marker',
                'before_fresh': handoff}

    def fake_session(self, label, events, exit_code=0, forced=False, model='test-model', tool_proof=True):
        session = types.SimpleNamespace(identity=label, tool_marker_seen=tool_proof,
            tool_calls={'tool': 'Bash'}, successful_tools={'tool'} if tool_proof else set(),
            init={'model': model, 'permission_mode': 'dontAsk', 'tools': ['Bash']},
            process=types.SimpleNamespace(poll=lambda: exit_code))
        def turn(prompt, expected):
            events.append(label + '-turn')
            self.assertIn('project-marker', expected)
            return {'reply_characters': 100}
        def close():
            events.append(label + '-exit')
            return {'exit_code': exit_code, 'forced': forced, 'process_group_empty': True}
        session.turn, session.close = turn, close
        return session

    def invoke(self, sessions, fixture):
        with patch.object(probe, '_version', return_value=probe.SUPPORTED_VERSION), patch.object(probe, 'Session', side_effect=sessions) as create:
            report = probe.run(fixture)
            return report, create.call_count

    def test_success_orders_verified_old_exit_before_handoff_and_new_process(self):
        events = []
        old, fresh = [self.fake_session(label, events) for label in ('old', 'fresh')]
        report, count = self.invoke([old, fresh], self.fixture(events))
        self.assertTrue(report['ok']); self.assertEqual(count, 2)
        self.assertEqual(events, ['old-turn', 'old-exit', 'handoff', 'fresh-turn', 'fresh-exit'])
        self.assertTrue(report['old_exit_verified_before_fresh']); self.assertTrue(report['settings_continuity'])
        self.assertFalse(report['supervisor_supported']); self.assertEqual(report['hook_continuity'], 'unproved')

    def test_nonzero_or_forced_old_exit_never_calls_handoff_or_starts_fresh(self):
        for code, forced in ((1, False), (0, True)):
            with self.subTest(code=code, forced=forced):
                events = []
                report, count = self.invoke([self.fake_session('old', events, code, forced)], self.fixture(events))
                self.assertFalse(report['ok']); self.assertEqual(count, 1); self.assertNotIn('handoff', events)
                self.assertEqual(report['failure'], 'old-process-did-not-exit-cleanly')

    def test_settings_drift_fails_even_when_recovery_response_matches(self):
        events = []
        report, _ = self.invoke([self.fake_session('old', events), self.fake_session('fresh', events, model='changed-model')], self.fixture(events))
        self.assertFalse(report['ok']); self.assertFalse(report['settings_continuity'])
        self.assertEqual(report['failure'], 'fresh-identity-or-settings-continuity-failed')
        self.assertIn('fresh-exit', events)

    def test_reported_tokens_without_real_tool_output_cannot_pass(self):
        events = []
        report, count = self.invoke([self.fake_session('old', events, tool_proof=False)], self.fixture(events))
        self.assertFalse(report['ok']); self.assertEqual(count, 1); self.assertNotIn('handoff', events)
        self.assertEqual(report['failure'], 'initial-read-only-tool-proof-missing')

    def test_unknown_version_starts_no_session(self):
        with patch.object(probe.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0, stdout='3.0.0')), patch.object(probe, 'Session') as create:
            report = probe.run(self.fixture([]))
            self.assertFalse(report['ok']); create.assert_not_called()
            self.assertEqual(report['failure'], 'unsupported-provider-version')

    def test_reader_start_failure_cleans_owned_process_before_failed_construction_returns(self):
        for failed_reader in (0, 1):
            with self.subTest(failed_reader=failed_reader):
                events = []
                process = types.SimpleNamespace(stdin=io.StringIO(), stdout=io.StringIO(), stderr=io.StringIO())
                readers = [Mock(ident=None), Mock(ident=None)]
                failure = RuntimeError('private reader startup failure')
                readers[failed_reader].start.side_effect = failure
                if failed_reader:
                    readers[0].ident = 1
                with patch.object(probe, '_version', return_value=probe.SUPPORTED_VERSION), patch.object(probe.subprocess, 'Popen', return_value=process) as launch, patch.object(probe.threading, 'Thread', side_effect=readers), patch.object(self, 'close_outcome', return_value={'exit_code': 0, 'forced': False, 'process_group_empty': True}) as close:
                    report = probe.run(self.fixture(events))
                close.assert_called_once_with(process)
                self.assertEqual(launch.call_count, 1)
                self.assertFalse(report['ok']); self.assertEqual(report['failure'], 'RuntimeError')
                self.assertNotIn('handoff', events)
                self.assertTrue(process.stdout.closed); self.assertTrue(process.stderr.closed)
                readers[failed_reader].join.assert_not_called()
                if failed_reader:
                    readers[0].join.assert_called_once_with(timeout=2)
                self.assertNotIn('private reader', json.dumps(report))

    def test_interrupted_reader_start_also_cleans_owned_group(self):
        process = types.SimpleNamespace(stdin=io.StringIO(), stdout=io.StringIO(), stderr=io.StringIO())
        reader = Mock(ident=None); reader.start.side_effect = KeyboardInterrupt()
        with patch.object(probe.subprocess, 'Popen', return_value=process), patch.object(probe.threading, 'Thread', return_value=reader), patch.object(self, 'close_outcome', return_value={'exit_code': 0, 'forced': False, 'process_group_empty': True}) as close:
            with self.assertRaises(KeyboardInterrupt):
                probe.Session(self.fixture([]))
        close.assert_called_once_with(process)
        self.assertTrue(process.stdout.closed); self.assertTrue(process.stderr.closed)

    def test_reader_start_failure_retained_when_group_cleanup_also_fails(self):
        events = []
        process = types.SimpleNamespace(stdin=io.StringIO(), stdout=io.StringIO(), stderr=io.StringIO())
        reader = Mock(ident=None); reader.start.side_effect = ValueError('private startup error')
        with patch.object(probe, '_version', return_value=probe.SUPPORTED_VERSION), patch.object(probe.subprocess, 'Popen', return_value=process), patch.object(probe.threading, 'Thread', return_value=reader), patch.object(self, 'close_outcome', side_effect=RuntimeError('private cleanup error')) as close:
            report = probe.run(self.fixture(events))
        close.assert_called_once_with(process)
        self.assertEqual(report['failure'], 'ValueError')
        self.assertEqual(report['cleanup_failures'], ['RuntimeError'])
        self.assertFalse(report['ok']); self.assertNotIn('handoff', events)
        self.assertNotIn('private', json.dumps(report))

    def transport(self):
        session = probe.Session.__new__(probe.Session)
        session.fixture = self.fixture([]); session.directory = Path(session.fixture['directory'])
        session.identity = 'session-1'; session.events = queue.Queue(); session.transport_failure = None
        session.init = None; session.tool_calls = {}; session.successful_tools = set()
        session.tool_marker_seen = False; session.hooks = []; session.interrupted = False
        session.process = types.SimpleNamespace(stdin=io.StringIO(), send_signal=lambda sig: None)
        return session

    def init(self, session):
        return {'type': 'system', 'subtype': 'init', 'session_id': session.identity,
                'cwd': str(session.directory), 'model': 'test-model', 'permissionMode': 'dontAsk', 'tools': ['Bash']}

    def result(self, session, text='initial-token project-marker'):
        return {'type': 'result', 'subtype': 'success', 'is_error': False, 'session_id': session.identity, 'result': text}

    def test_control_request_and_permission_denial_fail_closed(self):
        session = self.transport(); session.events.put({'type': 'control_request', 'session_id': session.identity})
        with self.assertRaisesRegex(probe.ProbeFailure, 'control-or-permission'):
            session.turn('prompt')
        session = self.transport(); session.events.put(self.init(session))
        denied = self.result(session); denied['permission_denials'] = [{'tool_name': 'Bash'}]; session.events.put(denied)
        with self.assertRaisesRegex(probe.ProbeFailure, 'permission-denied'):
            session.turn('prompt')

    def test_wrong_identity_bad_result_and_missing_expected_tokens_fail(self):
        for change, expected in (({'session_id': 'another-session'}, 'identity-mismatch'),
                                 ({'is_error': True}, 'result-failed'),
                                 ({'result': 'plausible narrative'}, 'recovery-token-missing')):
            with self.subTest(change=change):
                session = self.transport(); session.events.put(self.init(session))
                result = self.result(session); result.update(change); session.events.put(result)
                with self.assertRaisesRegex(probe.ProbeFailure, expected):
                    session.turn('prompt', ['initial-token'])

    def test_assistant_text_spoofing_tool_marker_does_not_count_as_tool_evidence(self):
        session = self.transport(); session.events.put(self.init(session))
        session.events.put({'type': 'assistant', 'session_id': session.identity, 'message': {'content': [{'type': 'text', 'text': 'real-tool-marker'}]}})
        session.events.put(self.result(session))
        session.turn('prompt', ['initial-token'])
        self.assertFalse(session.tool_marker_seen); self.assertEqual(session.successful_tools, set())

    def test_only_matching_successful_inspector_result_proves_real_tool_execution(self):
        session = self.transport(); session._observe(self.init(session))
        call = {'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'id': 'tool1', 'name': 'Bash', 'input': {'command': 'node ./inspect-state.mjs'}}]}}
        session._observe(call)
        session._observe({'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': 'tool1', 'content': 'real-tool-marker'}]}})
        self.assertTrue(session.tool_marker_seen); self.assertEqual(session.successful_tools, {'tool1'})
        with self.assertRaisesRegex(probe.ProbeFailure, 'unmatched-provider-tool-result'):
            session._observe({'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': 'unknown', 'content': 'real-tool-marker'}]}})
        with self.assertRaisesRegex(probe.ProbeFailure, 'provider-tool-error'):
            session._observe({'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': 'tool1', 'is_error': True, 'content': 'real-tool-marker'}]}})

    def test_permission_gate_is_distinct_from_command_errors_and_never_tool_proof(self):
        denial = 'Permission for this tool use was denied. This session has no approval surface.'
        for content, expected in (
                (denial, 'provider-permission-denied-no-approval-surface'),
                ([{'type': 'text', 'text': denial}], 'provider-permission-denied-no-approval-surface'),
                ('Error: SQLITE_CANTOPEN: permission denied', 'provider-tool-error'),
                ('Permission denied', 'provider-tool-error'),
                (None, 'provider-tool-error')):
            with self.subTest(content=content):
                session = self.transport()
                session._observe({'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'id': 'tool1', 'name': 'Bash', 'input': {'command': 'node ./inspect-state.mjs'}}]}})
                with self.assertRaisesRegex(probe.ProbeFailure, '^' + expected + '$'):
                    session._observe({'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': 'tool1', 'is_error': True, 'content': content}]}})
                self.assertFalse(session.tool_marker_seen)
                self.assertEqual(session.successful_tools, set())

    def test_unexpected_commands_and_outside_reads_are_rejected(self):
        session = self.transport()
        for name, values in (('Bash', {'command': 'node ./inspect-state.mjs; touch other'}),
                             ('Read', {'file_path': '/etc/passwd'}), ('Write', {'file_path': 'anything'})):
            with self.subTest(name=name), self.assertRaises(probe.ProbeFailure):
                session._observe({'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'id': 'tool1', 'name': name, 'input': values}]}})

    def test_success_without_compaction_boundary_is_not_compaction(self):
        session = self.transport(); session.events.put(self.init(session)); session.events.put(self.result(session))
        with self.assertRaisesRegex(probe.ProbeFailure, 'success-without-compaction-boundary'):
            session.turn('/compact', compact=True)

    def test_shared_owner_forced_cleanup_is_not_clean_handoff(self):
        session=probe.Session.__new__(probe.Session)
        session.process=Mock(stdout=io.StringIO(),stderr=io.StringIO())
        session.processes=Mock(forced_cleanup={session.process})
        session.processes.close.return_value=0
        session.readers=[]
        self.assertTrue(session.close()['forced'])


class StartupTests(unittest.TestCase):
    """Exercise actual startup refusal without the protocol-test gate mock."""

    def session(self):
        session = probe.Session.__new__(probe.Session)
        session.fixture = {'policy': {'model': 'test-model', 'max_turns': 4}}
        session.directory = Path('/fixture')
        session.identity = 'fixture-session'
        session.events = queue.Queue()
        session.transport_failure = None
        session.init = None
        session.hooks = []
        session.process = types.SimpleNamespace(stdin=io.StringIO())
        return session

    def init(self, session, **changes):
        return {'type': 'system', 'subtype': 'init', 'session_id': session.identity,
                'cwd': str(session.directory), 'model': 'test-model', 'permissionMode': 'dontAsk',
                'tools': ['Bash'], **changes}

    def test_unverified_guard_blocks_prompt_even_with_valid_init_and_startup_hook(self):
        session = self.session()
        session.events.put({'type': 'system', 'subtype': 'hook_response',
                            'hook_event': 'SessionStart', 'exit_code': 0})
        session.events.put(self.init(session))
        with self.assertRaisesRegex(probe.ProbeFailure, 'provider-guard-loading-unverified'):
            session.turn('must never reach a model')
        self.assertEqual(session.process.stdin.getvalue(), '')
        self.assertIsNotNone(session.init)

    def test_missing_init_times_out_without_sending_prompt(self):
        session = self.session()
        with patch.object(probe, 'STARTUP_TIMEOUT', 0):
            with self.assertRaisesRegex(probe.ProbeFailure, 'provider-pre-prompt-init-unavailable'):
                session.turn('must never reach a model')
        self.assertEqual(session.process.stdin.getvalue(), '')

    def test_unsafe_init_is_rejected_before_guard_check_or_prompt(self):
        cases = [({'permissionMode': 'bypassPermissions'}, 'inherited-permission-mode'),
                 ({'tools': ['Bash', 'Read']}, 'unexpected-provider-integrations'),
                 ({'mcp_servers': [{}]}, 'unexpected-provider-integrations'),
                 ({'model': 'other'}, 'requested-model-not-retained'),
                 ({'cwd': '/outside'}, 'working-directory-mismatch')]
        for changes, failure in cases:
            session = self.session()
            session.events.put(self.init(session, **changes))
            with self.subTest(changes=changes), patch.object(probe, '_require_loaded_guard') as guard:
                with self.assertRaisesRegex(probe.ProbeFailure, failure):
                    session.turn('must never reach a model')
                guard.assert_not_called()
                self.assertEqual(session.process.stdin.getvalue(), '')

    def test_unexpected_model_event_cannot_replace_startup_evidence(self):
        session = self.session()
        session.events.put({'type': 'assistant', 'message': {'content': []}})
        with self.assertRaisesRegex(probe.ProbeFailure, 'unexpected-provider-event-before-prompt'):
            session.turn('must never reach a model')
        self.assertEqual(session.process.stdin.getvalue(), '')

    def test_future_verified_guard_must_follow_init_before_prompt(self):
        session = self.session()
        session.events.put(self.init(session))
        session.events.put({'type': 'result', 'subtype': 'success', 'is_error': False,
                            'session_id': session.identity, 'result': 'fixture'})
        order = []
        def verify():
            self.assertIsNotNone(session.init)
            self.assertEqual(session.process.stdin.getvalue(), '')
            order.append('init-then-guard')
        with patch.object(probe, '_require_loaded_guard', side_effect=verify):
            session.turn('simulated prompt', ['fixture'])
        self.assertEqual(order, ['init-then-guard'])
        self.assertIn('simulated prompt', session.process.stdin.getvalue())


if __name__ == '__main__':
    unittest.main()
