"""Runner cancellation integration with local fake providers; no model calls."""
import json
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from probe_processes import OwnedProcesses

spec = importlib.util.spec_from_file_location("runner", Path(__file__).with_name("managed-recovery-probe.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


@unittest.skipUnless(sys.platform == "linux", "owned process groups require Linux")
class RunnerProcessTests(unittest.TestCase):
    def test_fixture_helper_starts_in_scratch_without_node_preloads(self):
        with tempfile.TemporaryDirectory(prefix="sassato-helper-test-") as outer:
            root = Path(outer) / 'scratch'
            root.mkdir()
            marker = Path(outer) / 'preload-ran'
            preload = Path(outer) / 'preload.cjs'
            preload.write_text("require('node:fs').writeFileSync(" + json.dumps(str(marker)) + ", 'bad');")
            with patch.dict(os.environ, {'NODE_OPTIONS': '--require=' + str(preload),
                                        'SASSATO_DB': str(Path(outer) / 'production.db')}):
                with OwnedProcesses() as processes:
                    original = processes.run
                    calls = []
                    def checked(*args, **kwargs):
                        calls.append(kwargs)
                        self.assertEqual(kwargs['cwd'], str(root))
                        self.assertEqual(kwargs['env']['HOME'], str(root))
                        self.assertNotIn('NODE_OPTIONS', kwargs['env'])
                        self.assertNotIn('SASSATO_DB', kwargs['env'])
                        return original(*args, **kwargs)
                    with patch.object(processes, 'run', side_effect=checked):
                        fixture = runner.fixture_call('create', root, 'codex', processes)
            self.assertEqual(len(calls), 1)
            self.assertEqual(fixture['directory'], str(root / 'repo'))
            self.assertFalse(marker.exists())
            self.assertFalse((Path(outer) / 'production.db').exists())

    def test_sigterm_reaps_fixture_job_and_every_registered_provider(self):
        with tempfile.TemporaryDirectory(prefix="sassato-runner-test-") as root:
            marker = Path(root) / "pids.json"
            script_dir = str(Path(__file__).resolve().parent)
            program = '''import importlib.util,json,pathlib,sys,time,types,subprocess
sys.path.insert(0,SCRIPT_DIR)
spec=importlib.util.spec_from_file_location('runner',pathlib.Path(SCRIPT_DIR)/'managed-recovery-probe.py')
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
def fixture(action,root,value=None,processes=None):
    if action=='create':
        directory=pathlib.Path(root)/'repo';directory.mkdir()
        return {'directory':str(directory),'database':str(pathlib.Path(root)/'fake.db')}
    return {}
def provider(fixture):
    owner=fixture['processes']
    for _ in range(2):
        owner.popen([sys.executable,'-c','import time; time.sleep(30)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    pathlib.Path(MARKER).write_text(json.dumps([process.pid for process in owner.processes]))
    time.sleep(30)
runner.fixture_call=fixture
runner.importlib.import_module=lambda _:types.SimpleNamespace(run=provider)
result=runner.run('codex')
print(json.dumps(result))
sys.exit(128+result['cancelled_signal'] if result.get('cancelled_signal') else 1)
'''
            program = "SCRIPT_DIR=" + repr(script_dir) + "\nMARKER=" + repr(str(marker)) + "\n" + program
            process = subprocess.Popen([sys.executable, "-B", "-c", program],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            pids = []
            try:
                deadline = time.monotonic() + 5
                while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(marker.exists(), "runner did not reach the owned-provider phase")
                pids = json.loads(marker.read_text())
                self.assertEqual(len(pids), 3)  # Fixture job plus two fake providers.
                for pid in pids:
                    os.kill(pid, 0)  # Assert actual PIDs exist, not just assumed PGIDs.
                    self.assertEqual(os.getpgid(pid), pid, 'fake must lead an owned group')
                    self.assertNotEqual(pid, os.getpgrp())
                process.send_signal(signal.SIGTERM)
                stdout, stderr = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 143, stderr)
                report = json.loads(stdout)
                self.assertFalse(report["ok"])
                self.assertEqual(report["cancelled_signal"], signal.SIGTERM)
                for pid in pids:
                    with self.assertRaises(ProcessLookupError):
                        os.kill(pid, 0)
                    with self.assertRaises(ProcessLookupError):
                        os.killpg(pid, 0)
            finally:
                if process.poll() is None:
                    process.kill(); process.communicate(timeout=5)
                for pid in pids:
                    try:
                        os.killpg(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                for stream in (process.stdout, process.stderr):
                    stream.close()


if __name__ == "__main__":
    unittest.main()
