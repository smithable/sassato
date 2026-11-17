#!/usr/bin/python3
"""Test-only barrier before the newly owned PTY holder can register a bootstrap."""
import os
import sys
import time
from pathlib import Path

barrier = Path(os.environ['ATTENDED_FIXTURE_HOLDER_BARRIER'])
if 'holder' in sys.argv and any(arg.endswith('attended-pty.py') for arg in sys.argv):
    Path(str(barrier) + '.ready').write_text('owned holder paused')
    deadline = time.monotonic() + 20
    while not barrier.exists():
        if time.monotonic() > deadline:
            raise RuntimeError('Fixture holder barrier elapsed')
        time.sleep(0.01)
os.execv(os.environ['ATTENDED_FIXTURE_REAL_PYTHON'], [os.environ['ATTENDED_FIXTURE_REAL_PYTHON'], *sys.argv[1:]])
