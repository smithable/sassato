"""Inert, bounded fixture only. No provider, shell, network, or configuration calls."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time


def identity(pid):
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip() + ":" + fields[19]


def cgroup():
    return next(line[3:] for line in Path("/proc/self/cgroup").read_text().splitlines() if line.startswith("0::"))


def write(path, value):
    temporary = path.with_name(path.name + f".{os.getpid()}.new")
    with temporary.open("x") as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--deadline", required=True, type=float)
    args = parser.parse_args()
    directory = Path(args.directory)
    intent = json.loads((directory / "intent.json").read_text())
    digest = hashlib.sha256(args.token.encode()).hexdigest()
    if digest != intent["token_hash"]:
        raise RuntimeError("Fixture token mismatch")
    children = []

    def stopped():
        return (directory / "STOP").exists() or json.loads((directory / "intent.json").read_text())["stop_requested"] or Path.home().joinpath("repos/stop").exists() or time.monotonic() >= args.deadline

    def register(role):
        write(directory / f"claim-{os.getpid()}.json", {"pid": os.getpid(), "start": identity(os.getpid()), "role": role, "token_hash": digest, "cgroup": cgroup(), "unit": intent["unit"]})

    def idle(role):
        register(role)
        while not stopped() and not (directory / "EXIT-ALL").exists():
            time.sleep(0.02)
        os._exit(0)

    register("main")
    while not stopped() and not (directory / "release.json").exists():
        time.sleep(0.02)
    if stopped():
        return
    release = json.loads((directory / "release.json").read_text())
    if release.get("token_hash") != digest or release.get("generation") != intent["generation"] or json.loads((directory / "intent.json").read_text())["state"] != "released" or stopped():
        return
    # This fixed fixture has exactly one fork phase, followed by a no-new-child barrier.
    child = os.fork()
    if child == 0:
        grandchild = os.fork()
        if grandchild == 0:
            idle("grandchild")
        idle("child")
    children.append(child)
    detacher = os.fork()
    if detacher == 0:
        os.setsid()
        detached = os.fork()
        if detached == 0:
            idle("detached")
        os._exit(0)
    os.waitpid(detacher, 0)
    while not stopped():
        claims = [json.loads(path.read_text()) for path in directory.glob("claim-*.json")]
        if {claim["role"] for claim in claims} == {"main", "child", "grandchild", "detached"}:
            write(directory / "ready.json", {"generation": intent["generation"], "token_hash": digest, "no_new_children": True})
            break
        time.sleep(0.02)
    while not stopped() and not (directory / "EXIT-ALL").exists():
        if (directory / "EXIT-MAIN").exists():
            return
        time.sleep(0.02)
    # Children independently obey the same finite deadline and exit marker.
    for child in children:
        while time.monotonic() < args.deadline:
            result, _ = os.waitpid(child, os.WNOHANG)
            if result:
                break
            time.sleep(0.02)


if __name__ == "__main__":
    main()
