"""Opt-in Codex recovery adapter. Imported only by the disposable fixture harness.

No existing provider threads, credentials or settings are modified. This module
does not implement a supervisor and does not run models when imported.
"""
import json
import os
from pathlib import Path
import queue
import re
import shlex
import subprocess
import threading
import time

from managed_probe_config import CODEX_RESTRICTIONS, ConfigurationError, prepare


SUPPORTED_VERSIONS = {"0.167.0"}
CONFIG_FIELDS = ("model", "modelProvider", "cwd", "approvalPolicy",
                 "approvalsReviewer", "sandbox", "reasoningEffort", "serviceTier")


class ProbeFailure(RuntimeError):
    """Stable, non-sensitive failure code safe for the evidence report."""

    def __init__(self, code, diagnostic=None):
        super().__init__(code)
        self.diagnostic = diagnostic


def _tool_failure_diagnostic(output):
    # Recognize only the observed native launcher failure. Keep paths/output
    # private, and do not infer general provider incompatibility from this host.
    if isinstance(output, str) and len(output) <= 8192 and re.fullmatch(
            r"bwrap: execvp /[^\r\n]+/codex: No such file or directory\n?", output):
        return "sandbox-helper-unavailable"
    return None


def _version(policy, processes):
    result = processes.run([policy["executable"], "--version"], capture_output=True,
                           text=True, timeout=10, env=policy["env"])
    match = re.search(r"\b\d+\.\d+\.\d+\b", result.stdout)
    if result.returncode or not match:
        raise ProbeFailure("version_probe_failed")
    value = match.group(0)
    if value not in SUPPORTED_VERSIONS:
        raise ProbeFailure("unsupported_version")
    return value


def _command_tokens(command):
    """Unwrap an ordinary provider shell wrapper, never execute its contents."""
    parts = shlex.split(command)
    if (len(parts) == 3 and Path(parts[0]).name in ("bash", "sh", "zsh")
            and parts[1] in ("-c", "-lc")):
        return shlex.split(parts[2])
    return parts


class AppServer:
    def __init__(self, cwd, env, model=None, *, processes=None, max_turns=4, executable=None):
        self.cwd = str(Path(cwd).resolve())
        self.model = model
        self.processes = processes
        self.max_turns = max_turns
        self.turn_count = 0
        if processes is None or not executable:
            raise ProbeFailure("isolated_process_owner_required")
        restrictions = [arg for key, value in CODEX_RESTRICTIONS.items()
                        for arg in ("-c", key + "=" + json.dumps(value))]
        self.process = processes.popen(
            [executable, *restrictions, "app-server", "--stdio"], cwd=self.cwd, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1, start_new_session=True)
        self.queue = queue.Queue()
        self.pending = []
        self.sequence = 0
        self.thread_id = None
        self.exit_code = None
        self.closed = False
        try:
            threading.Thread(target=self._pump, daemon=True).start()
            threading.Thread(target=self._discard_errors, daemon=True).start()
        except BaseException:
            self.processes.close(self.process)
            raise

    def _pump(self):
        try:
            for line in self.process.stdout:
                try:
                    self.queue.put(json.loads(line))
                except (ValueError, TypeError):
                    self.queue.put({"_invalid_json": True})
        finally:
            self.queue.put({"_exited": True})

    def _discard_errors(self):
        for _ in self.process.stderr:
            pass

    def _receive(self, deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ProbeFailure("provider_timeout")
        try:
            message = self.queue.get(timeout=remaining)
        except queue.Empty:
            raise ProbeFailure("provider_timeout") from None
        if not isinstance(message, dict) or message.get("_invalid_json"):
            raise ProbeFailure("invalid_provider_message")
        if message.get("_exited"):
            raise ProbeFailure("unexpected_process_exit")
        if "id" in message and "method" in message:
            # Approval/tool/control requests need a real supported client. Never
            # silently approve or fabricate an answer to keep this probe moving.
            raise ProbeFailure("unsupported_provider_control_request")
        return message

    def call(self, method, params):
        self.sequence += 1
        request_id = self.sequence
        self.process.stdin.write(json.dumps({"id": request_id, "method": method,
                                            "params": params}) + "\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + 45
        while True:
            message = self._receive(deadline)
            if message.get("id") == request_id:
                if "error" in message:
                    raise ProbeFailure("provider_request_rejected")
                return message.get("result", {})
            self.pending.append(message)

    def start(self):
        self.call("initialize", {"clientInfo": {
            "name": "sassato-managed-recovery-probe", "version": "0.1.2"}})
        self.process.stdin.write(json.dumps({"method": "initialized", "params": {}}) + "\n")
        self.process.stdin.flush()
        config = self.call("config/read", {"includeLayers": False}).get("config", {})
        for key, expected in CODEX_RESTRICTIONS.items():
            value = config
            for part in key.split("."):
                value = value.get(part) if isinstance(value, dict) else None
            if value != expected:
                raise ProbeFailure("effective_provider_confinement_unverified")
        account = self.call("account/read", {"refreshToken": False}).get("account")
        if not isinstance(account, dict) or account.get("type") != "chatgpt":
            raise ProbeFailure("isolated_chatgpt_authentication_required")
        catalog = self.call("model/list", {"limit": 100, "includeHidden": False})
        if not any(item.get("model") == self.model for item in catalog.get("data", [])):
            raise ProbeFailure("requested_model_unavailable_no_fallback")
        params = {"cwd": self.cwd, "ephemeral": True, "sandbox": "read-only",
                  "approvalPolicy": "on-request", "approvalsReviewer": "user"}
        if self.model is not None:
            params["model"] = self.model
        result = self.call("thread/start", params)
        self.thread_id = result["thread"]["id"]
        if not self.thread_id or result.get("cwd") != self.cwd:
            raise ProbeFailure("thread_identity_or_cwd_mismatch")
        if any(field not in result for field in CONFIG_FIELDS):
            raise ProbeFailure("missing_effective_settings")
        sandbox = result.get("sandbox", {})
        if sandbox.get("type") != "readOnly" or sandbox.get("networkAccess", False):
            raise ProbeFailure("unsupported_default_sandbox")
        if result["approvalPolicy"] != "on-request" or result["approvalsReviewer"] != "user" or result["model"] != self.model:
            raise ProbeFailure("explicit_startup_policy_not_retained")
        return result

    def turn(self, prompt, allowed_commands, tool_marker):
        self.turn_count = getattr(self, "turn_count", 0) + 1
        if self.turn_count > getattr(self, "max_turns", 4):
            raise ProbeFailure("provider_turn_cap_exceeded")
        result = self.call("turn/start", {"threadId": self.thread_id,
                                         "input": [{"type": "text", "text": prompt}]})
        turn_id = result["turn"]["id"]
        deadline = time.monotonic() + 120
        texts = []
        commands = 0
        marker_seen = False
        started_commands = set()
        allowed = [_command_tokens(value) for value in allowed_commands]
        while True:
            if time.monotonic() >= deadline:
                raise ProbeFailure("provider_turn_timeout")
            message = self.pending.pop(0) if self.pending else self._receive(deadline)
            params = message.get("params", {})
            if params.get("threadId") and params["threadId"] != self.thread_id:
                raise ProbeFailure("unexpected_thread_identity")
            if params.get("threadId") != self.thread_id:
                continue
            if params.get("turnId") and params["turnId"] != turn_id:
                raise ProbeFailure("unexpected_turn_identity")
            method = message.get("method")
            if method in ("item/started", "item/completed"):
                if params.get("turnId") != turn_id:
                    raise ProbeFailure("missing_or_mismatched_item_turn_identity")
                item = params.get("item", {})
                kind = item.get("type")
                if kind not in ("userMessage", "agentMessage", "reasoning", "plan", "commandExecution"):
                    raise ProbeFailure("unsupported_provider_item")
                if kind == "commandExecution":
                    command_id = item.get("id")
                    if not isinstance(command_id, str) or not command_id:
                        raise ProbeFailure("missing_tool_call_identity")
                    started_commands.add(command_id)
                    if len(started_commands) > getattr(self, "max_turns", 4):
                        raise ProbeFailure("provider_tool_turn_cap_exceeded")
                    if _command_tokens(item.get("command", "")) not in allowed:
                        raise ProbeFailure("unexpected_tool_command")
                    if str(Path(item.get("cwd", "")).resolve()) != self.cwd:
                        raise ProbeFailure("unexpected_tool_cwd")
                    if method == "item/completed":
                        if item.get("status") != "completed" or item.get("exitCode") != 0:
                            raise ProbeFailure("tool_did_not_complete_successfully",
                                               _tool_failure_diagnostic(item.get("aggregatedOutput")))
                        commands += 1
                        marker_seen |= tool_marker in (item.get("aggregatedOutput") or "")
                elif kind == "agentMessage" and method == "item/completed":
                    texts.append(item.get("text", ""))
            if method == "turn/completed":
                turn = params.get("turn", {})
                if turn.get("id") != turn_id or turn.get("status") != "completed":
                    raise ProbeFailure("turn_did_not_complete_successfully")
                if not commands or not marker_seen:
                    raise ProbeFailure("missing_read_only_tool_evidence")
                return {"text": "\n".join(texts), "completed_commands": commands,
                        "tool_marker_observed": marker_seen, "turn_completed": True}

    def close(self):
        if not self.closed:
            self.exit_code = self.processes.close(self.process)
            self.closed = True
            if self.process in self.processes.forced_cleanup:
                raise ProbeFailure("owned_process_required_forced_cleanup")
        return self.exit_code


def run(fixture):
    """Run two owned processes around the caller's real Sassato checkpoint.

    fixture supplies directory, env, initial_prompt, expected_initial_tokens,
    instruction_marker, tool_marker, required_tool_command, and before_fresh.
    before_fresh runs only after verified old-process exit; it returns a
    recovery_prompt and expected_recovery_tokens. Optional codex_model pins an
    explicitly selected model; otherwise a documented efficient model is selected explicitly.
    The caller owns fixture cleanup and independent DB/file mutation checks.
    """
    report = {"provider": "codex", "ok": False, "process_exit_codes": [],
              "ephemeral_threads": True, "stage": "preflight",
              "unsupported_gaps": ["hooks_continuity", "interactive_ui_reconnection",
                                   "supervisor_crash_reconciliation",
                                   "arbitrary_existing_session_adoption",
                                   "detached_descendants_outside_owned_process_group"]}
    servers = []
    try:
        if os.name != "posix":
            raise ProbeFailure("unsupported_process_cleanup_platform")
        policy = prepare(fixture, "codex")
        processes = fixture["processes"]
        report["version"] = _version(policy, processes)
        report["requested_model"] = policy["model"]
        report["max_turns_per_process"] = policy["max_turns"]
        report["authentication"] = "operator-provisioned isolated ChatGPT login"
        report["confinement"] = "isolated CODEX_HOME; read-only; on-request user approvals; no MCP"
        directory = Path(fixture["directory"]).resolve()
        if not directory.is_dir():
            raise ProbeFailure("missing_fixture_directory")
        env = policy["env"]
        instruction_marker = fixture["instruction_marker"]
        tool_marker = fixture["tool_marker"]
        initial_prompt = fixture["initial_prompt"]
        if (not instruction_marker or not tool_marker
                or instruction_marker in initial_prompt or tool_marker in initial_prompt):
            raise ProbeFailure("fixture_marker_leaked_or_empty")
        command = fixture["required_tool_command"]
        if command != "node ./inspect-state.mjs":
            raise ProbeFailure("unsupported_fixture_tool_command")
        report["stage"] = "initial_process"
        old = AppServer(directory, env, policy["model"], processes=processes,
                        max_turns=policy["max_turns"], executable=policy["executable"])
        servers.append(old)
        settings = old.start()
        report["model"] = settings["model"]
        report["model_provider"] = settings["modelProvider"]
        report["approval_policy"] = settings["approvalPolicy"]
        report["approval_reviewer"] = settings["approvalsReviewer"]
        report["sandbox_type"] = settings["sandbox"]["type"]
        report["initial_project_instruction_source"] = str(directory / "AGENTS.md") in settings.get("instructionSources", [])
        initial = old.turn(initial_prompt, [command], tool_marker)
        report["initial"] = {key: value for key, value in initial.items() if key != "text"}
        report["initial"]["expected_tokens_observed"] = all(
            token in initial["text"] for token in fixture["expected_initial_tokens"])
        report["initial"]["instruction_marker_observed"] = instruction_marker in initial["text"]
        if not report["initial"]["expected_tokens_observed"] or not report["initial"]["instruction_marker_observed"]:
            raise ProbeFailure("initial_recovery_facts_missing")
        report["stage"] = "old_process_exit"
        if old.close() != 0:
            raise ProbeFailure("old_process_exit_unsuccessful")
        report["old_process_exited_before_replacement"] = True
        report["stage"] = "checkpoint_callback"
        recovery = fixture["before_fresh"]()
        recovery_prompt = recovery["recovery_prompt"]
        if instruction_marker in recovery_prompt or tool_marker in recovery_prompt:
            raise ProbeFailure("recovery_marker_leaked")
        report["stage"] = "fresh_process"
        fresh = AppServer(directory, env, policy["model"], processes=processes,
                        max_turns=policy["max_turns"], executable=policy["executable"])
        servers.append(fresh)
        fresh_settings = fresh.start()
        report["distinct_provider_identity"] = old.thread_id != fresh.thread_id
        report["effective_settings_continuity"] = {
            field: settings[field] == fresh_settings[field] for field in CONFIG_FIELDS}
        report["fresh_project_instruction_source"] = str(directory / "AGENTS.md") in fresh_settings.get("instructionSources", [])
        if not report["distinct_provider_identity"] or not all(report["effective_settings_continuity"].values()):
            raise ProbeFailure("fresh_identity_or_settings_mismatch")
        recovered = fresh.turn(recovery_prompt, [command], tool_marker)
        report["fresh"] = {key: value for key, value in recovered.items() if key != "text"}
        report["fresh"]["expected_tokens_observed"] = all(
            token in recovered["text"] for token in recovery["expected_recovery_tokens"])
        report["fresh"]["instruction_marker_observed"] = instruction_marker in recovered["text"]
        if not report["fresh"]["expected_tokens_observed"] or not report["fresh"]["instruction_marker_observed"]:
            raise ProbeFailure("fresh_recovery_facts_missing")
        report["ok"] = True
        report["stage"] = "completed"
    except Exception as error:
        report["failure"] = str(error) if isinstance(error, (ProbeFailure, ConfigurationError)) else type(error).__name__
        if isinstance(error, ProbeFailure) and error.diagnostic:
            report["diagnostic"] = error.diagnostic
    finally:
        for server in servers:
            try:
                report["process_exit_codes"].append(server.close())
            except Exception as error:
                report.setdefault("cleanup_failures", []).append(type(error).__name__)
        report["ok"] = bool(report["ok"] and len(servers) == 2
                            and report["process_exit_codes"] == [0, 0]
                            and not report.get("cleanup_failures"))
    return report
