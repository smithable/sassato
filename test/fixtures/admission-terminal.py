#!/usr/bin/python3
"""Test Windows Terminal transport: pause dispatch before the native child starts."""
import os
import subprocess
import sys
import time
from pathlib import Path

barrier = Path(os.environ['ATTENDED_FIXTURE_TERMINAL_BARRIER'])
Path(str(barrier) + '.ready').write_text('terminal dispatched')
deadline = time.monotonic() + 15
while not barrier.exists():
    if time.monotonic() > deadline:
        raise RuntimeError('Fixture terminal barrier elapsed')
    time.sleep(0.01)
args = sys.argv[1:]
at = args.index('--exec')
subprocess.Popen(args[at + 1:], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                 stderr=subprocess.DEVNULL, env=dict(os.environ), start_new_session=True)
