"""Explicit bounded native controller-death lab; fixed inert fixtures only."""
import argparse
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time
import uuid

import native_containment as native

SCRIPT = Path(__file__).resolve()
PYTHON = str(Path(sys.executable).resolve())
CASES = {"binding-intent": 81, "sealed": 82}


def wait_for(predicate, deadline, message):
    while not predicate():
        native.require(time.monotonic() < deadline, message)
        native.require(not Path.home().joinpath("repos/stop").exists(), "Host STOP blocks crash lab")
        time.sleep(0.02)


def controller_claim():
    return {"pid": os.getpid(), "parent": os.getppid(), "start": native.fingerprint(os.getpid()), "uid": os.getuid()}


def checked_scenario(path):
    path = Path(path).resolve(strict=True)
    info = path.stat()
    native.require(info.st_uid == os.getuid() and info.st_mode & 0o777 == 0o700, "Scenario is not private and owned")
    state = native.read_json(path / "scenario.json")
    native.require(state["case"] in CASES and state["script_hash"] == native.digest(SCRIPT.read_bytes()), "Scenario source/case changed")
    native.require(time.monotonic() < state["deadline"], "Scenario deadline elapsed")
    return path, state


def crash_receipt(scope, path, state):
    durable = native.read_json(scope.directory / "intent.json")
    native.require(durable["binding_started"], "Crash point lacks durable binding intent")
    if state["case"] == "binding-intent":
        native.require(scope.retained is None and durable["state"] == "held" and not durable.get("retained_binding"), "Binding crash point is not before construction")
    else:
        native.require(scope.retained is not None and durable["state"] == "released" and durable["inventory"]["phase"] == "ready", "Sealed crash point is not established")
    native.atomic_json(path / "injection.json", {"controller": controller_claim(), "case": state["case"], "scope_directory": str(scope.directory), "durable_intent": durable, "exit_code": CASES[state["case"]], "cleanup_attempted": False})
    # Abrupt actual process exit: no Python finally, explicit close, or unlock.
    os._exit(CASES[state["case"]])


def inject(path, state):
    scope = native.FixtureScope.prepare(path, lifetime=20)
    native.atomic_json(path / "scope.json", {"directory": str(scope.directory), "directory_identity": native.identity(scope.directory), "unit": scope.state["unit"], "generation": scope.state["generation"], "token_hash": scope.state["token_hash"]})
    if state["case"] == "binding-intent":
        # The real _retain persists binding_started, then calls this constructor.
        # Patch only this disposable process, never production or another worker.
        native.RetainedScope = lambda *args: crash_receipt(scope, path, state)
    scope.launch()
    if state["case"] == "sealed":
        scope.release()
        wait_for(lambda: (scope.directory / "ready.json").exists(), scope.state["deadline"], "Fixture fork barrier did not settle")
        scope.seal_idle_inventory()
        crash_receipt(scope, path, state)
    raise native.UnknownScope("Crash injection was not reached")


def rejection(action, expected, report, name):
    try:
        action()
    except native.UnknownScope as error:
        native.require(expected in str(error), "Unexpected rejection for " + name + ": " + str(error))
        report.setdefault("blocked_actions", {})[name] = str(error)
    else:
        raise native.UnknownScope("Expected rejection did not occur: " + name)


def reconcile(path, state):
    injected = native.read_json(path / "injection.json")
    recorded = native.read_json(path / "scope.json")
    directory = path / Path(recorded["directory"]).name
    native.require(str(directory) == recorded["directory"] and native.identity(directory) == recorded["directory_identity"], "Not this scenario's new scope")
    before = native.read_json(directory / "intent.json")
    native.require(before == injected["durable_intent"], "State did not survive death exactly")
    report = {"controller": controller_claim(), "case": state["case"], "unit": recorded["unit"], "durable_state_survived": True, "cleanup_attempted": False}
    # A new process must acquire the old file's OS lock without replacement.
    scope = native.FixtureScope(directory)
    try:
        native.require(scope.state["lock_identity"] == before["lock_identity"], "OS lock path was replaced")
        report["original_os_lock_acquired"] = True
        native.require(scope.retained is None and scope.state["binding_started"], "Reconciler unexpectedly retained or reset history")
        for key in ["unit", "generation", "token_hash"]:
            native.require(scope.state[key] == recorded[key], "Launch identity changed")
        metadata = scope._unit_metadata()
        native.require(metadata["InvocationID"] == before["scope"]["invocation"], "Unit invocation changed")
        report["invocation"] = metadata["InvocationID"]
        rejection(scope.launch, "never duplicate", report, "duplicate_launch")
        root = native.CGROUP_ROOT / before["scope"]["group"].lstrip("/")
        rejection(lambda: scope._retain(root, before["scope"]), "lost or uncertain", report, "replacement_binding")
        rejection(scope.release, "retained scope proof is missing", report, "release_without_original_handles")
        if state["case"] == "binding-intent":
            rejection(scope.recover, "lost or uncertain", report, "recover_cannot_reset_binding")
        scope.request_stop()
        for name, action in [("launch_after_stop", scope.launch), ("release_after_stop", scope.release), ("recover_after_stop", scope.recover)]:
            rejection(action, "STOP", report, name)
        claims = before.get("inventory", {}).get("claims", [before["bootstrap"]])
        # In the binding-intent window no retained inventory was saved yet.
        if state["case"] == "binding-intent":
            claims = [before["bootstrap"]]
        native.require(1 <= len(claims) <= 4, "Fixture process count exceeds bound")
        exits = []
        for claim in claims:
            def exited():
                try:
                    return native.positively_exited(claim)
                except (OSError, native.UnknownScope):
                    return False  # Unknown/error is not positive exit evidence.
            wait_for(exited, min(scope.state["deadline"] + 2, state["deadline"]), "Fixture exit remains unknown")
            exits.append({"pid": claim["pid"], "start": claim["start"], "positive_exit": True})
        report["process_exits"] = exits
        rejection(scope.cleanup, "Original retained scope proof was lost", report, "cleanup_without_original_handles")
        after = native.read_json(directory / "intent.json")
        native.require(after["binding_started"] and after["scope"] == before["scope"] and not after.get("exit_proof") and (directory / "release.json").exists() == (state["case"] == "sealed"), "Reconciliation changed ownership/history or release state")
        report["preserved_unit_metadata"] = True
        report["result"] = "actual-controller-death-reconciliation-failed-closed-passed"
        native.atomic_json(path / "reconciliation.json", report)
    finally:
        scope.close()


def child(path, mode):
    path, state = checked_scenario(path)
    # Only this new disposable process arms its own finite watchdog.
    signal.alarm(35)
    claim = controller_claim()
    native.atomic_json(path / (mode + "-controller.json"), claim)
    def released():
        gate = path / (mode + "-release.json")
        return gate.exists() and native.read_json(gate) == claim
    wait_for(released, min(state["deadline"], time.monotonic() + 5), "Parent did not release verified controller")
    if mode == "inject":
        inject(path, state)
    else:
        reconcile(path, state)


def run_controller(path, mode, deadline):
    native.require(not Path.home().joinpath("repos/stop").exists() and time.monotonic() < deadline, "STOP or deadline blocks a new disposable controller")
    argv = [PYTHON, "-B", str(SCRIPT), "--controller", mode, "--scenario", str(path)]
    report = {"argv": argv, "mode": mode}
    native.atomic_json(path / (mode + "-launch-intent.json"), report)
    with (path / (mode + "-controller.log")).open("xb") as log:
        native.require(not Path.home().joinpath("repos/stop").exists(), "Host STOP blocks a new disposable controller")
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        # The child waits for the exact parent-approved live identity before work.
        try:
            report["pid"] = process.pid
            report["start"] = native.fingerprint(process.pid)
            wait_for(lambda: (path / (mode + "-controller.json")).exists(), min(deadline, time.monotonic() + 5), "Controller did not register")
            claim = native.read_json(path / (mode + "-controller.json"))
            native.require(claim == {"pid": process.pid, "parent": os.getpid(), "start": report["start"], "uid": os.getuid()}, "Controller identity/parent changed")
            actual = Path(f"/proc/{process.pid}/cmdline").read_bytes().split(b"\0")
            native.require([part.decode() for part in actual if part] == argv and native.fingerprint(process.pid) == report["start"], "Controller executable/start changed")
            status = Path(f"/proc/{process.pid}/status").read_text().splitlines()
            native.require(all(int(uid) == os.getuid() for line in status if line.startswith("Uid:") for uid in line.split()[1:]), "Controller actual UID changed")
            native.require(next(int(line.split()[1]) for line in status if line.startswith("PPid:")) == os.getpid(), "Controller actual parent changed")
            fd = os.pidfd_open(process.pid)
            try:
                native.require(native.fingerprint(process.pid) == report["start"], "Controller changed before pinning")
                native.atomic_json(path / (mode + "-owned.json"), report)
                native.atomic_json(path / (mode + "-release.json"), claim)
                code = process.wait(timeout=38)
                poll = select.poll()
                poll.register(fd, select.POLLIN)
                observed = poll.poll(0)
                native.require(observed and observed[0][1] & select.POLLIN and not observed[0][1] & (select.POLLNVAL | select.POLLERR), "Controller pidfd exit is unknown")
                report.update({"exit_code": code, "wait_reaped": True, "owned_pidfd_pollin": True})
                native.atomic_json(path / (mode + "-exit.json"), report)
                return report
            finally:
                os.close(fd)
        finally:
            # No guessed signals. The child's own watchdog bounds even error paths.
            if process.poll() is None:
                process.wait(timeout=38)


def run_parent(parent):
    parent = Path(parent).resolve(strict=True)
    suite = parent / ("controller-crash-" + uuid.uuid4().hex)
    suite.mkdir(mode=0o700)
    summary = {"kind": "fake-controller-os-crash-only", "provider_proof": False, "cases": [], "directory": str(suite)}
    print(suite, flush=True)
    try:
        for case in CASES:
            native.require(not Path.home().joinpath("repos/stop").exists(), "Host STOP blocks new crash case")
            path = suite / case
            path.mkdir(mode=0o700)
            state = {"case": case, "deadline": time.monotonic() + 70, "script_hash": native.digest(SCRIPT.read_bytes()), "parent": controller_claim()}
            native.atomic_json(path / "scenario.json", state)
            injection = run_controller(path, "inject", state["deadline"])
            native.require(injection["exit_code"] == CASES[case] and (path / "injection.json").exists(), "Actual abrupt controller injection did not complete")
            native.require(native.read_json(path / "injection.json")["controller"]["pid"] == injection["pid"], "Injection receipt is not from the owned controller")
            reconciliation = run_controller(path, "reconcile", state["deadline"])
            native.require(reconciliation["exit_code"] == 0, "Fresh controller reconciliation failed; preserve unit/evidence")
            result = native.read_json(path / "reconciliation.json")
            summary["cases"].append({"case": case, "injection": injection, "reconciliation": reconciliation, "result": result})
            native.atomic_json(suite / "crash-lab-result.json", summary)
        summary["result"] = "both-actual-controller-crash-cases-passed"
    except BaseException as error:
        summary["result"] = "blocked-preserve-evidence"
        summary["error"] = type(error).__name__ + ": " + str(error)
        raise
    finally:
        if summary.get("result") == "blocked-preserve-evidence":
            # Only scopes just created by this bounded invocation are examined.
            # Even on failure, wait out their fixed self-exit deadlines; never
            # signal, adopt or retrospectively clean any unknown unit.
            deadlines = []
            for case in CASES:
                recorded = suite / case / "scope.json"
                if recorded.exists():
                    scope_directory = Path(native.read_json(recorded)["directory"])
                    native.require(scope_directory.parent == suite / case, "Unexpected scope outside this invocation")
                    intent = native.read_json(scope_directory / "intent.json")
                    deadlines.append(intent["deadline"])
            if deadlines:
                native.require(max(deadlines) <= time.monotonic() + 21, "Fixture deadline exceeds the fixed bound")
                while time.monotonic() < max(deadlines) + 1:
                    time.sleep(0.05)
                summary["bounded_helper_deadlines_elapsed"] = True
        native.atomic_json(suite / "crash-lab-result.json", summary)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-kernel-crash-fixture", action="store_true")
    parser.add_argument("--evidence-parent")
    parser.add_argument("--controller", choices=["inject", "reconcile"])
    parser.add_argument("--scenario")
    args = parser.parse_args()
    if args.controller and args.scenario and not args.run_kernel_crash_fixture and not args.evidence_parent:
        child(args.scenario, args.controller)
    elif args.run_kernel_crash_fixture and args.evidence_parent and not args.controller and not args.scenario:
        run_parent(args.evidence_parent)
    else:
        parser.error("Select explicit bounded parent experiment or its fixed controller mode")


if __name__ == "__main__":
    main()
