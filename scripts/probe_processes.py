"""Source-only process ownership for opt-in probes; importing starts nothing."""
import os
import signal
import subprocess
import threading
import time


class ProbeCancelled(BaseException):
    def __init__(self, signum):
        self.signum = signum
        super().__init__('Probe cancelled')


class OwnedProcesses:
    """Own new POSIX process groups and finish cleanup before propagating a signal.

    Cancellation never approves tools or affects pre-existing process groups.
    Descendants that deliberately create a different group remain outside scope.
    """
    def __init__(self):
        self.processes = []
        self.signum = None
        self.cleanup_failures = []
        self.forced_cleanup = set()
        self._protected = 0
        self._previous_handlers = {}

    def __enter__(self):
        if os.name != 'posix' or threading.current_thread() is not threading.main_thread():
            raise RuntimeError('Probe process ownership requires the POSIX main thread')
        for sig in (signal.SIGINT, signal.SIGTERM):
            self._previous_handlers[sig] = signal.getsignal(sig)
            signal.signal(sig, self._signal)
        return self

    def _signal(self, signum, frame):
        if self.signum is not None:
            return  # Repeated signals must not interrupt cleanup of other groups.
        self.signum = signum
        if not self._protected:
            raise ProbeCancelled(signum)

    def _check_cancelled(self):
        if self.signum is not None:
            raise ProbeCancelled(self.signum)

    def popen(self, *args, **kwargs):
        self._check_cancelled()
        if kwargs.get('start_new_session') is False or 'preexec_fn' in kwargs or 'process_group' in kwargs:
            raise ValueError('Probe children require a new owned process group')
        kwargs['start_new_session'] = True
        # Defer the Python signal exception until registration. Blocking OS
        # signals here would pass the blocked mask to the provider child.
        self._protected += 1
        try:
            process = subprocess.Popen(*args, **kwargs)
            self.processes.append(process)
        finally:
            self._protected -= 1
        self._check_cancelled()
        return process

    def run(self, command, *, timeout, **kwargs):
        capture = kwargs.pop('capture_output', False)
        if capture:
            kwargs['stdout'] = subprocess.PIPE
            kwargs['stderr'] = subprocess.PIPE
        process = self.popen(command, **kwargs)
        try:
            stdout, stderr = process.communicate(timeout=timeout)
            return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
        finally:
            try:
                self.close(process)
            finally:
                # communicate() has no remaining reader on this POSIX path.
                for stream in (process.stdout, process.stderr):
                    if stream is not None:
                        stream.close()

    @staticmethod
    def _group_exists(process):
        try:
            os.killpg(process.pid, 0)
            return True
        except ProcessLookupError:
            return False

    @staticmethod
    def _signal_group(process, sig):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass

    def close(self, process):
        self._protected += 1
        try:
            try:
                if process.stdin and not process.stdin.closed:
                    # Keep close/flush bounded if cancellation interrupted a
                    # write into an unresponsive child's full pipe.
                    try:
                        os.set_blocking(process.stdin.fileno(), False)
                    except (OSError, ValueError):
                        pass
                    try:
                        process.stdin.close()
                    except (OSError, ValueError):
                        pass
            except (OSError, ValueError):
                pass
            try:
                exit_code = process.wait(timeout=0 if self.signum else 2)
            except subprocess.TimeoutExpired:
                exit_code = None
            for sig in (signal.SIGTERM, signal.SIGKILL):
                if exit_code is not None and not self._group_exists(process):
                    if process in self.processes:
                        self.processes.remove(process)
                    return exit_code
                self.forced_cleanup.add(process)
                self._signal_group(process, sig)
                deadline = time.monotonic()+1
                while time.monotonic() < deadline:
                    try:
                        exit_code = process.wait(timeout=0.05)
                    except subprocess.TimeoutExpired:
                        pass
                    if exit_code is not None and not self._group_exists(process):
                        if process in self.processes:
                            self.processes.remove(process)
                        return exit_code
                    time.sleep(0.01)
            raise RuntimeError('Owned process group cleanup could not be verified')
        finally:
            self._protected -= 1

    def close_all(self):
        self._protected += 1
        try:
            # Stop all quota-consuming processes promptly, before waiting on any.
            for process in list(self.processes):
                try:
                    if self._group_exists(process):
                        self.forced_cleanup.add(process)
                        self._signal_group(process, signal.SIGTERM)
                except Exception as error:
                    self.cleanup_failures.append(type(error).__name__)
            for process in list(self.processes):
                try:
                    self.close(process)
                except Exception as error:
                    self.cleanup_failures.append(type(error).__name__)
        finally:
            self._protected -= 1
        return self.cleanup_failures

    def __exit__(self, exc_type, exc, traceback):
        try:
            self.close_all()
        finally:
            for sig, handler in self._previous_handlers.items():
                signal.signal(sig, handler)
        if self.signum is not None:
            raise ProbeCancelled(self.signum)
        if self.cleanup_failures and exc_type is None:
            raise RuntimeError('Owned process cleanup failed')
        return False
