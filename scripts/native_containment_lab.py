"""Explicit bounded real-kernel lab. Fixed fake helper only; no providers."""
import argparse
from pathlib import Path
import time
from native_containment import FixtureScope, UnknownScope, atomic_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-kernel-fixture", action="store_true", required=True)
    parser.add_argument("--evidence-parent", required=True)
    args = parser.parse_args()
    scope = FixtureScope.prepare(Path(args.evidence_parent), lifetime=20)
    report = {"kind": "fake-kernel-primitive-only", "unit": scope.state["unit"], "directory": str(scope.directory), "released": False, "provider_proof": False}
    print(str(scope.directory), flush=True)
    try:
        claim = scope.launch()
        report["bootstrap"] = claim
        current = scope.snapshot()
        if len(current["claims"]) != 1 or current["claims"][0] != claim or (scope.directory / "release.json").exists():
            raise UnknownScope("Held bootstrap invariant failed")
        scope.request_stop()
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
        report["result"] = "held-bootstrap-stop-empty-cleanup-passed"
    except BaseException as error:
        report["result"] = "blocked-preserve-evidence"
        report["error"] = type(error).__name__ + ": " + str(error)
        # No guessed stop/kill. Each inert fixture has its own short deadline.
        while time.monotonic() < scope.state["deadline"] + 1:
            time.sleep(0.05)
        raise
    finally:
        atomic_json(scope.directory / "lab-result.json", report)
        scope.close()


if __name__ == "__main__":
    main()
