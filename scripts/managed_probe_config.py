"""Fail-closed startup policy for the opt-in, source-only managed probes."""
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import sys

DEFAULT_MODELS = {"codex": "gpt-6-luna", "claude": "claude-haiku-5-5"}
INSPECT_COMMAND = "node ./inspect-state.mjs"
CODEX_RESTRICTIONS = {
    "sandbox_mode": "read-only", "approval_policy": "on-request", "approvals_reviewer": "user",
    "web_search": "disabled", "agents.enabled": False, "notify": [], "mcp_servers": {},
    "features.shell_tool": True,
    **{f"features.{name}": False for name in (
        "shell_snapshot", "hooks", "apps", "plugins", "multi_agent", "view_image",
        "skill_mcp_dependency_install", "goals", "browser_use", "browser_use_external",
        "browser_use_full_cdp_access", "computer_use", "image_generation", "in_app_browser", "code_mode")},
}
MANAGED_PATHS = {
    "codex": ("/etc/codex/managed_config.toml", "/etc/codex/requirements.toml"),
    "claude": ("/etc/claude-code/managed-settings.json", "/etc/claude-code/managed-settings.d",
               "/etc/claude-code/managed-mcp.json", "/etc/claude-code/server-managed-settings.json"),
}
GUARD_SOURCE = '''import json,sys
try:
    raw=sys.stdin.buffer.read(65537)
    if len(raw)>65536: raise ValueError()
    event=json.loads(raw)
    allowed=(event.get("tool_name")=="Bash" and
             event.get("tool_input",{}).get("command")=="node ./inspect-state.mjs")
except Exception:
    allowed=False
if not allowed:
    print("Managed probe permits only its exact read-only inspector.",file=sys.stderr)
sys.exit(0 if allowed else 2)
'''


class ConfigurationError(RuntimeError):
    pass


def require_codex_read_confinement():
    """No validated read-root sandbox is available in this native adapter.

    HOME/CODEX_HOME isolation avoids inherited configuration; read-only limits
    writes, not reads. Post-execution command inspection cannot protect secrets.
    Keep live runs disabled until an enforceable read boundary is implemented
    and tested. There is deliberately no environment/fixture override.
    """
    raise ConfigurationError("codex-readable-roots-confinement-unavailable")


def write_private_diagnostic(scratch_directory, requested_path, record):
    """Create one private scratch file without following any parent symlinks.

    Walk from / using directory descriptors: checking resolve() alone leaves
    a symlink-swap window. The final exclusive open rejects files, links, FIFOs
    and overwrite attempts alike. No directories outside the fixture are made.
    """
    root = Path(scratch_directory).absolute()
    path = Path(requested_path)
    if ".." in root.parts or ".." in path.parts:
        raise ValueError("diagnostic-parent-traversal")
    if not path.is_absolute():
        path = root / path
    relative = path.relative_to(root)
    if not relative.parts:
        raise ValueError("diagnostic-file-required")
    descriptors = []
    try:
        current = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
        descriptors.append(current)
        for part in (*root.parts[1:], *relative.parts[:-1]):
            current = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                              dir_fd=current)
            descriptors.append(current)
        fd = os.open(relative.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=current)
        try:
            os.fchmod(fd, 0o600)
            os.write(fd, record)
        finally:
            os.close(fd)
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def validate_home(provider, value):
    if not value:
        raise ConfigurationError("isolated-provider-home-required")
    path = Path(value).absolute()
    if path != path.resolve() or not path.is_dir():
        raise ConfigurationError("provider-home-must-be-real-directory")
    forbidden = [Path.home(), Path.home() / ".codex", Path.home() / ".claude"]
    for key in ("CODEX_HOME", "CLAUDE_CONFIG_DIR"):
        if os.environ.get(key):
            forbidden.append(Path(os.environ[key]).resolve())
    if path in forbidden:
        raise ConfigurationError("ordinary-provider-home-not-isolated")
    metadata = path.stat()
    if metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
        raise ConfigurationError("provider-home-must-be-owned-mode-700")
    auth_name = "auth.json" if provider == "codex" else ".credentials.json"
    # No credentials are opened or copied. Native provider login must have been
    # provisioned explicitly by the operator, outside this harness.
    if {entry.name for entry in path.iterdir()} != {auth_name}:
        raise ConfigurationError("provider-home-must-contain-only-native-auth-file")
    auth = (path / auth_name).lstat()
    if not stat.S_ISREG(auth.st_mode) or auth.st_nlink != 1 or auth.st_uid != os.getuid() or auth.st_mode & 0o077:
        raise ConfigurationError("native-auth-file-must-be-private-regular-file")
    if any(Path(entry).exists() for entry in MANAGED_PATHS[provider]):
        raise ConfigurationError("managed-provider-policy-cannot-be-isolated")
    return path


def prepare(fixture, provider):
    if sys.platform != "linux":
        raise ConfigurationError("provider-policy-isolation-only-validated-for-linux")
    home = validate_home(provider, fixture.get("provider_home"))
    root = Path(fixture["isolation_root"]).resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    runtime_home = root / "home"
    runtime_home.mkdir(mode=0o700, exist_ok=True)
    model = fixture.get("model") or DEFAULT_MODELS[provider]
    if not isinstance(model, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}", model):
        raise ConfigurationError("invalid-probe-model")
    turns = fixture.get("max_turns", 4)
    if type(turns) is not int or not 1 <= turns <= 8:
        raise ConfigurationError("max-turns-must-be-between-1-and-8")
    if fixture.get("permission_mode") not in (None, "dontAsk"):
        raise ConfigurationError("unsupported-configured-permission-mode")
    env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TERM") if key in os.environ}
    env.update({"HOME": str(runtime_home), "XDG_CONFIG_HOME": str(runtime_home / ".config"),
                "XDG_CACHE_HOME": str(runtime_home / ".cache"), "XDG_DATA_HOME": str(runtime_home / ".local/share")})
    env.update({key: value for key, value in fixture.get("env", {}).items()
                if key in ("SASSATO_DB", "SASSATO_WORKSPACE", "SASSATO_ROLE")})
    env["CODEX_HOME" if provider == "codex" else "CLAUDE_CONFIG_DIR"] = str(home)
    executable = shutil.which(provider)
    if not executable:
        raise ConfigurationError("provider-executable-unavailable")
    result = {"env": env, "executable": str(Path(executable).resolve()),
              "model": model, "max_turns": turns, "provider_home": home}
    if provider == "claude":
        guard = root / "deny-unexpected-tool.py"
        # Exclusive creation avoids silently replacing anything in the fixture.
        with guard.open("x", encoding="utf8") as output:
            output.write(GUARD_SOURCE)
        guard.chmod(0o600)
        hook = shlex.join([sys.executable, str(guard)])
        settings = {"availableModels": [model], "fallbackModel": [],
                    "permissions": {"defaultMode": "dontAsk",
                                    "allow": ["Bash(" + INSPECT_COMMAND + ")"]},
                    "hooks": {"PreToolUse": [{"matcher": ".*", "hooks": [
                        {"type": "command", "command": hook, "timeout": 5}]}]},
                    "autoMemoryEnabled": False, "enableAllProjectMcpServers": False,
                    "disableClaudeAiConnectors": True, "disableSkillShellExecution": True}
        result["settings"] = json.dumps(settings, separators=(",", ":"))
        env.update({"DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"})
    return result
