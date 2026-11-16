"""Explicit bounded real-kernel lab. Fixed fake helper only; no providers."""
import argparse
import os
from pathlib import Path
import select
import time
from native_containment import FixtureScope, UnknownScope, atomic_json, positively_exited


def must_block(action, report, name):
    try:
        action()
    except UnknownScope as error:
        report.setdefault("blocked_actions", {})[name] = str(error)
    else:
        raise UnknownScope("Expected lifecycle rejection did not occur: " + name)


def lost_handle_reconnect(scope, report):
    """Drop the original controller handles, reconnect; never reset history."""
    directory = scope.directory
    scope.close()
    replacement = FixtureScope(directory)
    try:
        must_block(replacement.launch, report, "duplicate_launch")
        must_block(replacement.recover, report, "replacement_binding")
        replacement.request_stop()
        must_block(replacement.release, report, "release_after_stop")
        must_block(replacement.recover, report, "recover_after_stop")
        while not positively_exited(replacement.state["bootstrap"]):
            if time.monotonic() >= replacement.state["deadline"] + 1:
                raise UnknownScope("Reconnect fixture did not positively exit")
            time.sleep(0.02)
        must_block(replacement.cleanup, report, "cleanup_without_original_handles")
        report["positive_bootstrap_exit"] = True
        report["result"] = "lost-handle-reconnect-rejected-preserve-unit-passed"
    finally:
        replacement.close()


def full_tree(scope, report):
    scope.release()
    report["released"] = True
    while not (scope.directory / "ready.json").exists():
        scope._guard()
        if time.monotonic() >= scope.state["deadline"]:
            raise UnknownScope("Fork barrier deadline elapsed")
        time.sleep(0.02)
    report["sealed_inventory"] = scope.seal_idle_inventory()
    # The fixed helper has no fork path after ready.json. Let only main exit,
    # retaining the original controller and cgroup handles throughout.
    claim = scope.state["bootstrap"]
    main_fd = os.pidfd_open(claim["pid"])
    try:
        if scope._claim(claim["pid"]) != claim:
            raise UnknownScope("Main identity changed before pinning its exit handle")
        poll = select.poll()
        poll.register(main_fd, select.POLLIN)
        scope._guard()
        (scope.directory / "EXIT-MAIN").touch(mode=0o600)
        while True:
            events = poll.poll(0)
            if events:
                if len(events) != 1 or events[0][0] != main_fd or not events[0][1] & select.POLLIN or events[0][1] & (select.POLLERR | select.POLLNVAL):
                    raise UnknownScope("Main pidfd exit observation is invalid")
                report["main_exit"] = {"pid": claim["pid"], "start": claim["start"], "retained_pidfd_pollin": True}
                break
            scope._guard()
            if time.monotonic() >= scope.state["deadline"]:
                raise UnknownScope("Main exit deadline elapsed")
            time.sleep(0.02)
    finally:
        os.close(main_fd)
    current = scope.snapshot()
    if sorted(claim["role"] for claim in current["claims"]) != ["child", "detached", "grandchild"]:
        raise UnknownScope("Detached descendants did not remain in the owned scope after main exit")
    report["after_main_exit"] = current
    report["signals"] = []
    for claim in current["claims"]:
        if not positively_exited(claim):
            scope.signal_owned(claim)
            report["signals"].append({"pid": claim["pid"], "start": claim["start"], "signal": "pidfd-SIGTERM"})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-kernel-fixture", action="store_true", required=True)
    parser.add_argument("--evidence-parent", required=True)
    parser.add_argument("--full-tree", action="store_true", help="Separate explicit bounded fork/owned-pidfd experiment")
    parser.add_argument("--fault-case", choices=["stop-held", "lost-handle-reconnect"])
    args = parser.parse_args()
    if args.full_tree and args.fault_case:
        parser.error("Select one bounded experiment per invocation")
    scope = FixtureScope.prepare(Path(args.evidence_parent), lifetime=20)
    report = {"kind": "fake-kernel-primitive-only", "unit": scope.state["unit"], "directory": str(scope.directory), "released": False, "provider_proof": False}
    print(str(scope.directory), flush=True)
    try:
        claim = scope.launch()
        report["bootstrap"] = claim
        current = scope.snapshot()
        if len(current["claims"]) != 1 or current["claims"][0] != claim or (scope.directory / "release.json").exists():
            raise UnknownScope("Held bootstrap invariant failed")
        if args.fault_case == "lost-handle-reconnect":
            lost_handle_reconnect(scope, report)
            return
        if args.full_tree:
            full_tree(scope, report)
        scope.request_stop()
        if args.fault_case == "stop-held":
            must_block(scope.release, report, "release_after_stop")
            must_block(scope.recover, report, "recover_after_stop")
        end = scope.state["deadline"] + 2
        while True:
            try:
                report["empty"] = scope.empty()
                break
            except (UnknownScope, OSError):
                if time.monotonic() >= end:
                    raise
                time.sleep(0.05)
        scope.cleanup()
        report["result"] = "full-tree-main-exit-pidfd-empty-cleanup-passed" if args.full_tree else "held-bootstrap-stop-empty-cleanup-passed"
    except BaseException as error:
        report["result"] = "blocked-preserve-evidence"
        report["error"] = type(error).__name__ + ": " + str(error)
        # No guessed stop/kill. Each inert fixture has its own short deadline.
        while time.monotonic() < scope.state["deadline"] + 1:
            time.sleep(0.05)
        raise
    finally:
        if scope.retained is not None:
            report["retained_observations"] = scope.retained.diagnostics()
        atomic_json(scope.directory / "lab-result.json", report)
        scope.close()


if __name__ == "__main__":
    main()
