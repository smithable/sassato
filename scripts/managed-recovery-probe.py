#!/usr/bin/env python3
"""Opt-in recovery proof: real quota/charges; requires operator-provisioned isolated auth.

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

from managed_probe_config import DEFAULT_MODELS
from probe_processes import OwnedProcesses, ProbeCancelled


HELPER = Path(__file__).with_name('managed-recovery-fixture.mjs')


def fixture_call(action, root, value=None, processes=None):
    command = ['node', str(HELPER), action, str(root)]
    if value is not None:
        command.append(str(value))
    result = processes.run(command, capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise RuntimeError('fixture_' + action + '_failed')
    return json.loads(result.stdout)


def close_job(process, processes):
    code = processes.close(process)
    if code != 0 or process in processes.forced_cleanup:
        raise RuntimeError('fixture_job_required_forced_cleanup')
    return code


def _run(provider, fixture_only, provider_home, model, max_turns, processes):
    report = {'provider': provider, 'scope': 'disposable_real_sassato_recovery',
              'fixture_only': fixture_only, 'ok': False,
              'started_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'production_supervisor_enabled': False}
    job = None
    with tempfile.TemporaryDirectory(prefix='sassato-managed-recovery-') as root:
        try:
            fixture = fixture_call('create', root, provider, processes)
            # A harmless owned child survives the initial provider turn and must
            # be reaped before the checkpoint claims that it finished.
            job = processes.popen([sys.executable, '-c',
                                    'import sys; sys.stdin.buffer.read()'],
                                   stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, start_new_session=True)
            fixture['env'] = {'SASSATO_DB': fixture.pop('database'),
                              'SASSATO_WORKSPACE': 'recovery-probe',
                              'SASSATO_ROLE': 'builder'}
            fixture.update({'processes': processes, 'provider_home': provider_home,
                            'model': model or DEFAULT_MODELS[provider], 'max_turns': max_turns,
                            'isolation_root': str(Path(root) / 'confinement')})
            fixture['required_tool_command'] = 'node ./inspect-state.mjs'
            handoffs = 0

            def before_fresh():
                nonlocal handoffs
                if handoffs or job.poll() is not None:
                    raise RuntimeError('fixture_job_or_handoff_state_invalid')
                handoffs += 1
                report['fixture_job_exit_code'] = close_job(job, processes)
                if report['fixture_job_exit_code'] != 0:
                    raise RuntimeError('fixture_job_failed')
                report['fixture_job_settled_before_fresh'] = True
                return fixture_call('handoff', root, 0, processes)

            fixture['before_fresh'] = before_fresh
            if fixture_only:
                fixture_call('inspect', root, processes=processes)
                before_fresh()
                fixture_call('inspect', root, processes=processes)
                report['provider_validation'] = {'ok': False, 'not_run': True}
            else:
                adapter = importlib.import_module('managed_' + provider + '_probe')
                report['provider_validation'] = adapter.run(fixture)
            if handoffs:
                report['state_validation'] = fixture_call('verify', root, processes=processes)
            report['ok'] = bool(handoffs == 1 and report.get('state_validation')
                                and (fixture_only or report['provider_validation']['ok']))
        except Exception as error:
            # Never publish stderr, paths, provider IDs or raw model output.
            report['failure'] = type(error).__name__
        finally:
            if job is not None:
                try:
                    code = close_job(job, processes)
                    report['fixture_job_cleanup_exit_code'] = code
                    if code != 0:
                        report['ok'] = False
                except Exception as error:
                    report['ok'] = False
                    report['cleanup_failure'] = type(error).__name__
    return report


def run(provider, fixture_only=False, provider_home=None, model=None, max_turns=4):
    processes = OwnedProcesses()
    report = {'provider': provider, 'ok': False}
    try:
        with processes:
            report = _run(provider, fixture_only, provider_home, model, max_turns, processes)
    except ProbeCancelled as error:
        report.update({'ok': False, 'cancelled_signal': error.signum})
    except Exception as error:
        report.update({'ok': False, 'failure': type(error).__name__})
    if processes.cleanup_failures:
        report.update({'ok': False, 'cleanup_failures': processes.cleanup_failures})
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--provider', choices=['codex', 'claude'], required=True)
    parser.add_argument('--provider-home', help='Dedicated directory provisioned by the operator with native subscription login; never copies credentials')
    parser.add_argument('--model', help='Explicit model; defaults: codex gpt-6-luna, claude claude-haiku-5-5; no fallback')
    parser.add_argument('--max-turns', type=int, choices=range(1,9), default=4, help='Per-process turn/tool cap, default 4; not a monetary cap')
    parser.add_argument('--fixture-only', action='store_true',
                        help='Test only disposable Sassato state, without provider calls')
    args = parser.parse_args()
    if os.name != 'posix':
        parser.error('POSIX is required for owned process-group cleanup')
    result = run(args.provider, args.fixture_only, args.provider_home, args.model, args.max_turns)
    print(json.dumps(result, indent=2))
    raise SystemExit(128 + result['cancelled_signal'] if result.get('cancelled_signal') else 0 if result['ok'] else 1)
