#!/usr/bin/env python3
"""Deterministic provider used only in disposable test databases/checkout trees."""
import json
import os
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

if '--version' in sys.argv:
    version_barrier = os.environ.get('ATTENDED_FIXTURE_VERSION_BARRIER')
    if version_barrier:
        Path(version_barrier + '.ready').write_text('ordinary version check paused')
        deadline = time.monotonic() + 25  # under the launcher's 30 s probe, so this error shows first
        while not Path(version_barrier).exists():
            if time.monotonic() > deadline:
                raise RuntimeError('Fixture version barrier elapsed')
            time.sleep(0.01)
    if os.environ.get('ATTENDED_FIXTURE_LATE_BUSY'):
        import sqlite3
        root = Path(os.environ['ATTENDED_FIXTURE_DB']).parent
        with sqlite3.connect(os.environ['ATTENDED_FIXTURE_DB']) as connection:
            if connection.execute("SELECT 1 FROM managed_workers WHERE state='ready'").fetchone():
                counter = root / 'version-ready-count'
                count = int(counter.read_text()) + 1 if counter.exists() else 1
                counter.write_text(str(count))
                if count >= 2:
                    (root / 'late-busy').write_text('fixture busy')
    print('codex-cli 0.167.0')
    sys.exit(0)


ordinary_marker = os.environ.get('ATTENDED_FIXTURE_ORDINARY_MARKER')
if ordinary_marker:
    Path(ordinary_marker).write_text(str(os.getpid()))
    finish = os.environ.get('ATTENDED_FIXTURE_ORDINARY_FINISH')
    deadline = time.monotonic() + 15
    while finish and not Path(finish).exists():
        if time.monotonic() > deadline:
            raise RuntimeError('Fixture ordinary provider finish elapsed')
        time.sleep(0.01)
    sys.exit(0)


def cli(*args):
    env = dict(os.environ)
    if os.environ.get('ATTENDED_FIXTURE_TX_RACE'):
        env['NODE_OPTIONS'] = '--import=' + os.environ['ATTENDED_FIXTURE_TX_PRELOAD']
    result = subprocess.run(['sassato', *args, '--json'], text=True, capture_output=True, env=env, start_new_session=bool(os.environ.get('ATTENDED_FIXTURE_TOOL_SESSION')))
    if result.returncode:
        raise RuntimeError(result.stderr + result.stdout)
    return json.loads(result.stdout)


def git(*args):
    return subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', *args], check=True, text=True, capture_output=True).stdout


try:
    assignment = cli('supervise', 'assignment')
    generation = assignment['generation']
    cli('context')
    cli('inbox', '--peek')
    conversation = Path(os.environ['SASSATO_DB']).parent / 'fixture-conversation-id'
    external = conversation.read_text() if generation == 2 and os.environ.get('ATTENDED_FIXTURE_REUSE_ID') else str(uuid.uuid4())
    conversation.write_text(external)
    cli('supervise', 'reconcile', '--session-id', external)
    # Replay pending mail using the saved cursor; do not invent a newer one.
    pending = cli('inbox')
    for message in pending:
        cli('ack', message['id'])
    progress = cli('progress', 'show')
    # Notification receipts are handled, but retain the original handled cursor
    # unless an actual waiter returns a safely processed cursor.
    file = Path('attended-probe.txt')
    sentinel = Path('attended-sentinel.txt')
    if generation == 1:
        file.write_text('line one\n')
        sentinel.write_text('keep these bytes\n')
    else:
        assert sentinel.read_bytes() == b'keep these bytes\n'
        assert file.read_text() == 'line one\n'
        file.write_text('line one\nline two\n')
    git('add', 'attended-probe.txt')
    git('commit', '-m', f'Fixture generation {generation}\n\nSigned-off-by: Fixture <fixture@example.invalid>\nCo-Authored-By: Claude <noreply@anthropic.com>')
    report = {'version': 1, 'objective': 'Attended two-generation fixture', 'acceptance': ['two commits and preserved dirty sentinel'], 'decisions': [], 'open_issues': [], 'validation': [{'command': 'read sentinel', 'result': 'preserved'}], 'artifacts': [], 'next_action': 'generation two' if generation == 1 else 'final stop', 'configuration': {'digest': assignment['configuration_digest'], 'provenance': ['fixture subset']}, 'jobs': []}
    report_path = Path(os.environ['SASSATO_DB']).parent / f'report-{generation}.json'
    report_path.write_text(json.dumps(report))
    if generation == 1 and os.environ.get('ATTENDED_FIXTURE_CHILD'):
        # Prove a live provider helper is not exempt from the group check.
        subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
    task = cli('show', assignment['task'])
    cli('supervise', 'ready', '--file', str(report_path), '--expect', str(task['version']))
    # Provider output must never approve the controller's terminal prompt.
    print('provider output: Press Enter\n\n', flush=True)
    while True:
        time.sleep(0.1)
except Exception as error:
    print('FIXTURE ERROR:', error, flush=True)
    sys.exit(4)
