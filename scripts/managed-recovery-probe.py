#!/usr/bin/env python3
"""Opt-in real Sassato recovery proof, using existing provider authentication.

Requires a source checkout built with npm run build, Python 3 and POSIX. Invokes
real models unless --fixture-only is supplied, spending quota on the currently
authenticated account and potentially incurring charges. Model runs never belong in
CI. Never controls existing sessions.
"""
import argparse
import importlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time


HELPER = Path(__file__).with_name('managed-recovery-fixture.mjs')


def fixture_call(action, root, value=None):
    command = ['node', str(HELPER), action, str(root)]
    if value is not None:
        command.append(str(value))
    result = subprocess.run(command, capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise RuntimeError('fixture_' + action + '_failed')
    return json.loads(result.stdout)


def close_job(process):
    if process.stdin and not process.stdin.closed:
        process.stdin.close()
    try:
        return process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)
        raise RuntimeError('fixture_job_required_forced_cleanup')


def run(provider, fixture_only=False):
    report = {'provider': provider, 'scope': 'disposable_real_sassato_recovery',
              'fixture_only': fixture_only, 'ok': False,
              'started_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'production_supervisor_enabled': False}
    job = None
    with tempfile.TemporaryDirectory(prefix='sassato-managed-recovery-') as root:
        try:
            fixture = fixture_call('create', root, provider)
            # A harmless owned child survives the initial provider turn and must
            # be reaped before the checkpoint claims that it finished.
            job = subprocess.Popen([sys.executable, '-c',
                                    'import sys; sys.stdin.buffer.read()'],
                                   stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, start_new_session=True)
            fixture['env'] = {'SASSATO_DB': fixture.pop('database'),
                              'SASSATO_WORKSPACE': 'recovery-probe',
                              'SASSATO_ROLE': 'builder'}
            fixture['required_tool_command'] = 'node ./inspect-state.mjs'
            handoffs = 0

            def before_fresh():
                nonlocal handoffs
                if handoffs or job.poll() is not None:
                    raise RuntimeError('fixture_job_or_handoff_state_invalid')
                handoffs += 1
                report['fixture_job_exit_code'] = close_job(job)
                if report['fixture_job_exit_code'] != 0:
                    raise RuntimeError('fixture_job_failed')
                report['fixture_job_settled_before_fresh'] = True
                return fixture_call('handoff', root, 0)

            fixture['before_fresh'] = before_fresh
            if fixture_only:
                fixture_call('inspect', root)
                before_fresh()
                fixture_call('inspect', root)
                report['provider_validation'] = {'ok': False, 'not_run': True}
            else:
                adapter = importlib.import_module('managed_' + provider + '_probe')
                report['provider_validation'] = adapter.run(fixture)
            if handoffs:
                report['state_validation'] = fixture_call('verify', root)
            report['ok'] = bool(handoffs == 1 and report.get('state_validation')
                                and (fixture_only or report['provider_validation']['ok']))
        except Exception as error:
            # Never publish stderr, paths, provider IDs or raw model output.
            report['failure'] = str(error) if type(error) is RuntimeError else type(error).__name__
        finally:
            if job is not None:
                try:
                    code = close_job(job)
                    report['fixture_job_cleanup_exit_code'] = code
                    if code != 0:
                        report['ok'] = False
                except Exception as error:
                    report['ok'] = False
                    report['cleanup_failure'] = type(error).__name__
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--provider', choices=['codex', 'claude'], required=True)
    parser.add_argument('--fixture-only', action='store_true',
                        help='Test only disposable Sassato state, without provider calls')
    args = parser.parse_args()
    if os.name != 'posix':
        parser.error('POSIX is required for owned process-group cleanup')
    result = run(args.provider, args.fixture_only)
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result['ok'] else 1)
