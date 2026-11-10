"""Bounded opt-in native Claude adapter for the disposable managed-recovery probe.

Importing this module performs no provider work. run(fixture) invokes real models
using existing authentication and the fixture's own scratch directory only. It
never controls another terminal, changes account settings, or approves requests.
"""
import json
import os
from pathlib import Path
import queue
import re
import signal
import subprocess
import threading
import time
import uuid


SUPPORTED_VERSION = '2.1.321'
MAX_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_LINE_BYTES = 2 * 1024 * 1024
TURN_TIMEOUT = 120


class ProbeFailure(RuntimeError):
    """A fixed diagnostic code safe to include in a sanitized report."""


def _private_diagnostic(code, value):
    """Optional bounded developer evidence; never included in the public report."""
    path = os.environ.get('SASSATO_PROBE_DIAGNOSTIC')
    if not path:
        return
    record = json.dumps({'code': code, 'value': str(value)[:2048]}) + '\n'
    try:
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            os.fchmod(fd, 0o600)
            if os.fstat(fd).st_size < 16384:
                os.write(fd, record.encode('utf8'))
        finally:
            os.close(fd)
    except OSError:
        pass


def _tool_failure_code(content):
    """Recognize the observed provider gate without mislabeling command errors."""
    if isinstance(content, list):
        content = '\n'.join(block.get('text', '') for block in content
                            if isinstance(block, dict) and isinstance(block.get('text'), str))
    if isinstance(content, str):
        message = content.lower()
        if ('permission for this tool use was denied' in message
                and 'no approval surface' in message):
            return 'provider-permission-denied-no-approval-surface'
    return 'provider-tool-error'


def _version():
    result = subprocess.run(['claude', '--version'], capture_output=True, text=True, timeout=10)
    match = re.search(r'\b(\d+\.\d+\.\d+)\b', result.stdout)
    if result.returncode != 0 or not match:
        raise ProbeFailure('unrecognized-provider-version')
    if match.group(1) != SUPPORTED_VERSION:
        raise ProbeFailure('unsupported-provider-version')
    return match.group(1)


def _close_owned(process):
    """Reap this adapter's process; never use registry metadata as exit proof."""
    def group_exists():
        try:
            os.killpg(process.pid, 0)
            return True
        except ProcessLookupError:
            return False

    def outcome(code, forced):
        if not group_exists():
            return {'exit_code': code, 'forced': forced, 'process_group_empty': True}
        # An exited parent is not enough when tool children can still act. Clean
        # only the group created by this adapter, and do not proceed to a handoff.
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 2
            while group_exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            if not group_exists():
                return {'exit_code': code, 'forced': True, 'process_group_empty': True}
        raise ProbeFailure('owned-process-group-exit-unconfirmed')

    try:
        if process.stdin and not process.stdin.closed:
            process.stdin.close()
    except (BrokenPipeError, ValueError):
        pass
    try:
        return outcome(process.wait(timeout=8), False)
    except subprocess.TimeoutExpired:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                pass
            try:
                return outcome(process.wait(timeout=8), True)
            except subprocess.TimeoutExpired:
                continue
        raise ProbeFailure('owned-process-exit-unconfirmed')


class Session:
    def __init__(self, fixture):
        self.fixture = fixture
        self.directory = Path(fixture['directory']).resolve()
        self.identity = str(uuid.uuid4())
        self.events = queue.Queue(maxsize=4096)
        self.transport_failure = None
        self.init = None
        self.tool_calls = {}
        self.successful_tools = set()
        self.tool_marker_seen = False
        self.interrupted = False
        self.output_bytes = 0
        self.hooks = []
        command = ['claude', '--print', '--input-format', 'stream-json', '--output-format',
                   'stream-json', '--verbose', '--include-partial-messages', '--include-hook-events',
                   '--session-id', self.identity, '--no-session-persistence', '--tools', 'Bash,Read',
                   '--permission-prompts', 'none']
        if fixture.get('model'):
            command += ['--model', fixture['model']]
        if fixture.get('permission_mode'):
            mode = fixture['permission_mode']
            if mode not in ('manual', 'plan', 'dontAsk', 'acceptEdits', 'auto'):
                raise ProbeFailure('unsupported-configured-permission-mode')
            command += ['--permission-mode', mode]
        if fixture.get('claude_settings_path'):
            settings = Path(fixture['claude_settings_path']).resolve()
            if not settings.is_relative_to(self.directory):
                raise ProbeFailure('settings-outside-disposable-fixture')
            command += ['--settings', str(settings)]
        self.process = subprocess.Popen(command, cwd=self.directory,
            env={**os.environ, **fixture.get('env', {})}, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
            start_new_session=True)
        self.readers = [threading.Thread(target=self._pump, daemon=True),
                        threading.Thread(target=self._discard_stderr, daemon=True)]
        for reader in self.readers:
            reader.start()

    def _put(self, value):
        try:
            self.events.put_nowait(value)
        except queue.Full:
            self.transport_failure = 'provider-event-queue-limit'

    def _pump(self):
        try:
            while True:
                line = self.process.stdout.readline(MAX_LINE_BYTES + 1)
                if not line:
                    break
                self.output_bytes += len(line.encode('utf8'))
                if len(line.encode('utf8')) > MAX_LINE_BYTES or self.output_bytes > MAX_OUTPUT_BYTES:
                    self.transport_failure = 'provider-output-limit'
                    break
                try:
                    item = json.loads(line)
                    if not isinstance(item, dict):
                        raise ValueError()
                except (ValueError, TypeError):
                    self.transport_failure = 'invalid-provider-json'
                    break
                self._put(item)
        except (OSError, ValueError):
            self.transport_failure = 'provider-output-read-failed'
        finally:
            self._put({'_exited': True})

    def _discard_stderr(self):
        # Never retain raw provider diagnostics: they may include account details.
        try:
            while self.process.stderr.read(4096):
                pass
        except (OSError, ValueError):
            pass

    def _receive(self, deadline):
        if self.transport_failure:
            raise ProbeFailure(self.transport_failure)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ProbeFailure('provider-event-deadline')
        try:
            event = self.events.get(timeout=remaining)
        except queue.Empty:
            raise ProbeFailure('provider-event-deadline') from None
        if self.transport_failure:
            raise ProbeFailure(self.transport_failure)
        if event.get('_exited'):
            raise ProbeFailure('provider-exited-before-result')
        if event.get('session_id') and event['session_id'] != self.identity:
            raise ProbeFailure('provider-session-identity-mismatch')
        if event.get('type') == 'control_request':
            raise ProbeFailure('provider-requested-control-or-permission')
        return event

    def _observe(self, event):
        kind, subtype = event.get('type'), event.get('subtype')
        if kind == 'system' and subtype == 'init':
            if event.get('session_id') != self.identity:
                raise ProbeFailure('missing-init-session-identity')
            if Path(event.get('cwd', '')).resolve() != self.directory:
                raise ProbeFailure('provider-working-directory-mismatch')
            if not isinstance(event.get('model'), str) or not isinstance(event.get('permissionMode'), str):
                raise ProbeFailure('missing-provider-settings-evidence')
            if event['permissionMode'] == 'bypassPermissions':
                raise ProbeFailure('inherited-permission-bypass-not-supported')
            tools = event.get('tools')
            if not isinstance(tools, list) or not all(isinstance(tool, str) for tool in tools):
                raise ProbeFailure('missing-provider-tools-evidence')
            self.init = {'model': event['model'], 'permission_mode': event['permissionMode'],
                         'tools': sorted(tools)}
        if kind == 'system' and subtype in ('hook_started', 'hook_progress', 'hook_response'):
            self.hooks.append({'subtype': subtype, 'event': event.get('hook_event')})
            if subtype == 'hook_response' and event.get('exit_code', 0) != 0:
                raise ProbeFailure('provider-hook-failed')
        if kind == 'assistant':
            for block in event.get('message', {}).get('content', []):
                if block.get('type') != 'tool_use':
                    continue
                ident, name, values = block.get('id'), block.get('name'), block.get('input', {})
                if not isinstance(ident, str) or not isinstance(values, dict):
                    raise ProbeFailure('malformed-tool-call')
                if name == 'Bash':
                    if values.get('command', '').strip() != self.fixture['required_tool_command']:
                        _private_diagnostic('unexpected-shell-command', values.get('command'))
                        raise ProbeFailure('unexpected-shell-command')
                elif name == 'Read':
                    requested = values.get('file_path')
                    if not isinstance(requested, str):
                        raise ProbeFailure('malformed-read-request')
                    path = Path(requested)
                    if not path.is_absolute():
                        path = self.directory / path
                    if not path.resolve().is_relative_to(self.directory):
                        raise ProbeFailure('read-outside-disposable-fixture')
                else:
                    raise ProbeFailure('unexpected-provider-tool')
                self.tool_calls[ident] = name
        if kind == 'user':
            content = event.get('message', {}).get('content', [])
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict) or block.get('type') != 'tool_result':
                        continue
                    ident = block.get('tool_use_id')
                    if ident not in self.tool_calls:
                        raise ProbeFailure('unmatched-provider-tool-result')
                    if block.get('is_error'):
                        _private_diagnostic('provider-tool-result-error', block.get('content'))
                        raise ProbeFailure(_tool_failure_code(block.get('content')))
                    self.successful_tools.add(ident)
                    if self.fixture['tool_marker'] in json.dumps(block.get('content'), ensure_ascii=False):
                        self.tool_marker_seen = True
        if kind == 'result' and event.get('permission_denials'):
            raise ProbeFailure('provider-permission-denied')

    def turn(self, prompt, expected=(), compact=False, interrupt=False):
        if not isinstance(prompt, str) or len(prompt.encode('utf8')) > 131072:
            raise ProbeFailure('invalid-or-oversized-prompt')
        request = {'type': 'user', 'message': {'role': 'user', 'content': prompt},
                   'parent_tool_use_id': None, 'session_id': self.identity}
        try:
            self.process.stdin.write(json.dumps(request) + '\n')
            self.process.stdin.flush()
        except (BrokenPipeError, ValueError):
            raise ProbeFailure('provider-input-closed') from None
        deadline = time.monotonic() + TURN_TIMEOUT
        boundary, signal_sent, interruption_evidence = False, False, False
        while True:
            event = self._receive(deadline)
            self._observe(event)
            if event.get('type') == 'system' and event.get('subtype') == 'compact_boundary':
                boundary = True
            # SIGINT is documented for ending a print-mode turn. Wait until a real
            # response is streaming, rather than treating an idle signal as proof.
            if interrupt and not signal_sent and event.get('type') == 'stream_event':
                stream = event.get('event', {})
                if stream.get('type') == 'content_block_delta':
                    self.process.send_signal(signal.SIGINT)
                    signal_sent = True
            if signal_sent and event.get('type') in ('system', 'user', 'result'):
                text = json.dumps(event.get('errors', event.get('message', event.get('result', '')))).lower()
                interruption_evidence = interruption_evidence or 'interrupt' in text
            if event.get('type') != 'result':
                continue
            if event.get('session_id') != self.identity or self.init is None:
                raise ProbeFailure('missing-result-session-identity')
            if interrupt:
                if not signal_sent or not interruption_evidence:
                    raise ProbeFailure('no-explicit-turn-interruption-evidence')
                self.interrupted = True
                return {'interrupted': True}
            if event.get('is_error') or event.get('subtype') != 'success':
                raise ProbeFailure('provider-result-failed')
            response = event.get('result', '')
            if not isinstance(response, str) or not all(token in response for token in expected):
                raise ProbeFailure('expected-recovery-token-missing')
            if compact and not boundary:
                raise ProbeFailure('success-without-compaction-boundary')
            return {'compact_boundary': boundary, 'reply_characters': len(response)}

    def close(self):
        outcome = _close_owned(self.process)
        for reader in self.readers:
            reader.join(timeout=2)
        for stream in (self.process.stdout, self.process.stderr):
            if stream:
                stream.close()
        return outcome


def run(fixture):
    """Run a real disposable handoff; before_fresh executes only after old exit."""
    report = {'provider': 'claude', 'ok': False, 'adapter': 'native-stream-json',
              'version': None, 'stages': [], 'tools_restricted_to': ['Bash', 'Read'],
              'permission_prompts': 'none', 'authentication': 'inherited',
              'hook_continuity': 'unproved', 'interruption': 'not-run',
              'ui_reconnection': 'unproved', 'supervisor_supported': False,
              'cleanup_scope': 'owned process and process group; detached descendants remain unproved'}
    sessions = []
    try:
        if os.name != 'posix':
            raise ProbeFailure('unsupported-process-platform')
        report['version'] = _version()
        if not callable(fixture.get('before_fresh')) or fixture.get('required_tool_command') != 'node ./inspect-state.mjs':
            raise ProbeFailure('invalid-managed-recovery-fixture')
        old = Session(fixture)
        sessions.append(old)
        report['stages'].append('initial-recovery')
        old.turn(fixture['initial_prompt'], fixture['expected_initial_tokens'] + [fixture['instruction_marker']])
        if not old.tool_marker_seen or not any(old.tool_calls[i] == 'Bash' for i in old.successful_tools):
            raise ProbeFailure('initial-read-only-tool-proof-missing')
        report['initial_tool_recovery_passed'] = True
        report['stages'].append('old-process-exit')
        exited = old.close()
        sessions.remove(old)
        report['old_exit'] = exited
        if exited['forced'] or exited['exit_code'] != 0 or not exited.get('process_group_empty') or old.process.poll() is None:
            raise ProbeFailure('old-process-did-not-exit-cleanly')
        report['old_exit_verified_before_fresh'] = True
        handoff = fixture['before_fresh']()
        report['stages'].append('fresh-recovery')
        fresh = Session(fixture)
        sessions.append(fresh)
        fresh.turn(handoff['recovery_prompt'], handoff['expected_recovery_tokens'] + [fixture['instruction_marker']])
        if not fresh.tool_marker_seen or not any(fresh.tool_calls[i] == 'Bash' for i in fresh.successful_tools):
            raise ProbeFailure('fresh-read-only-tool-proof-missing')
        report['distinct_fresh_identity'] = old.identity != fresh.identity
        report['settings_continuity'] = old.init == fresh.init
        report['model'] = old.init['model']
        report['permission_mode'] = old.init['permission_mode']
        report['project_instructions_continued'] = True
        report['fresh_tool_recovery_passed'] = True
        if not report['distinct_fresh_identity'] or not report['settings_continuity']:
            raise ProbeFailure('fresh-identity-or-settings-continuity-failed')
        if fixture.get('interruption_probe'):
            report['stages'].append('interrupt')
            fresh.turn('Without tools, write a long numbered explanation of 200 distinct parser validation considerations. This is only an interruption probe; do not act on tasks.', interrupt=True)
            fresh.turn('Without tools, respond exactly INTERRUPTION-RECOVERED.', ['INTERRUPTION-RECOVERED'])
            report['interruption'] = 'explicit-result-and-continued-turn'
        report['stages'].append('fresh-process-exit')
        exited = fresh.close()
        sessions.remove(fresh)
        report['fresh_exit'] = exited
        if exited['forced'] or exited['exit_code'] != 0 or not exited.get('process_group_empty'):
            raise ProbeFailure('fresh-process-did-not-exit-cleanly')
        report['ok'] = True
    except Exception as error:
        report['failure'] = str(error) if isinstance(error, ProbeFailure) else type(error).__name__
    finally:
        for session in sessions:
            try:
                outcome = session.close()
                report.setdefault('cleanup', []).append(outcome)
                if outcome['forced'] or outcome['exit_code'] != 0 or not outcome.get('process_group_empty'):
                    report['ok'] = False
            except Exception as error:
                report.setdefault('cleanup_failures', []).append(type(error).__name__)
                report['ok'] = False
    return report
