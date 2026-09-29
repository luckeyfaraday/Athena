"""Hermes Agent installation, command resolution, and one-shot asking."""

from __future__ import annotations

import base64
import json
import os
import platform
import re
import shutil
import signal
import sqlite3
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path


INSTALL_COMMAND = (
    "curl -fsSL "
    "https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh "
    "| bash"
)
HERMES_BIN_ENV = "HERMES_BIN"
HERMES_ASK_MODEL_ENV = "HERMES_ASK_MODEL"
HERMES_ASK_PROVIDER_ENV = "HERMES_ASK_PROVIDER"
# The assembled status is cheap once the pieces below are cached, but it still
# stats a handful of files; keep it briefly so bursts of callers share it.
STATUS_CACHE_TTL_SECONDS = 60.0
# Executable resolution walks PATH x PATHEXT (a stat storm on Windows), so it is
# reused for a few minutes. `status(refresh=True)` and install() bypass it.
COMMAND_RESOLUTION_TTL_SECONDS = 300.0
# A failed `--version` probe (for example a cold venv that exceeded the probe
# timeout) is retried after this long; a successful probe is kept until the
# executable itself changes.
FAILED_VERSION_RETRY_SECONDS = 300.0


@dataclass(frozen=True)
class HermesStatus:
    installed: bool
    command_path: str | None
    version: str | None
    hermes_home: Path
    config_exists: bool
    memory_path: Path | None
    native_windows: bool
    install_supported: bool
    setup_required: bool
    message: str


@dataclass(frozen=True)
class HermesInstallResult:
    returncode: int
    stdout: str
    stderr: str
    status: HermesStatus


@dataclass(frozen=True)
class HermesAskResult:
    answer: str
    project_dir: Path
    returncode: int
    stderr: str


def _default_hermes_home() -> Path:
    configured = os.environ.get("HERMES_HOME", "").strip()
    return Path(configured).expanduser() if configured else Path.home() / ".hermes"


def _resolve_hermes_command(hermes_home: Path) -> str | None:
    """Resolve Hermes from an explicit override, PATH, or managed venvs."""
    configured = os.environ.get(HERMES_BIN_ENV, "").strip()
    if configured:
        expanded = Path(configured).expanduser()
        if expanded.is_file():
            return str(expanded)
        resolved = shutil.which(configured)
        if resolved:
            return resolved
        # An explicit but invalid HERMES_BIN must not silently select a
        # different executable from PATH.
        return None

    names = ["hermes.exe", "hermes.cmd", "hermes"] if _is_native_windows() else ["hermes"]
    for name in names:
        resolved = shutil.which(name)
        if resolved:
            return resolved

    bin_dir = "Scripts" if _is_native_windows() else "bin"
    managed_roots = [
        hermes_home / "runtime-data" / "hermes-agent" / ".venv" / bin_dir,
        hermes_home / ".venv" / bin_dir,
        hermes_home.parent / "runtime-data" / "hermes-agent" / ".venv" / bin_dir,
    ]
    for root in managed_roots:
        for name in names:
            candidate = root / name
            if candidate.is_file():
                return str(candidate)
    return None


def _session_db_candidates(hermes_home: Path) -> list[Path]:
    return [hermes_home / "state.db", hermes_home / "runtime-data" / "state.db"]


def _normalize_session_path(value: str) -> str:
    """Normalize separators while preserving POSIX case sensitivity."""
    slashed = value.strip().replace("\\", "/").rstrip("/")
    if not slashed:
        return ""
    wsl_drive = re.fullmatch(r"/mnt/([A-Za-z])(?:/(.*))?", slashed)
    if wsl_drive:
        rest = wsl_drive.group(2) or ""
        return f"{wsl_drive.group(1)}:/{rest}".lower().rstrip("/")
    windows_drive = re.fullmatch(r"/?([A-Za-z]):/(.*)", slashed)
    if windows_drive:
        return f"{windows_drive.group(1)}:/{windows_drive.group(2)}".lower().rstrip("/")
    if slashed.startswith("//"):
        return slashed.lower()
    return slashed


def _same_or_descendant(candidate: str, project: str) -> bool:
    return candidate == project or candidate.startswith(project + "/")


class HermesManager:
    def __init__(self, *, hermes_home: Path | None = None) -> None:
        self.hermes_home = (hermes_home or _default_hermes_home()).expanduser()
        # One lock serializes cache misses so concurrent callers share a single
        # PATH walk and `hermes --version` spawn instead of each starting one.
        self._status_lock = threading.Lock()
        self._cached_status: HermesStatus | None = None
        self._cached_at = 0.0
        # (environment key, resolved_at, command_path, install_supported)
        self._resolution_cache: tuple[tuple[str, ...], float, str | None, bool] | None = None
        # (executable fingerprint, version, probed_at)
        self._version_cache: tuple[tuple[str, int, int], str | None, float] | None = None

    def status(self, *, refresh: bool = False) -> HermesStatus:
        if not refresh:
            cached = self._fresh_cached_status()
            if cached is not None:
                return cached

        with self._status_lock:
            if refresh:
                self._clear_caches()
            else:
                # Another caller may have finished the same miss while this one
                # waited for the lock.
                cached = self._fresh_cached_status()
                if cached is not None:
                    return cached
            status = self._compute_status()
            self._cached_status = status
            # Stamp after the slow work so the TTL measures data age, not the
            # moment the probe started.
            self._cached_at = time.monotonic()
            return status

    def _fresh_cached_status(self) -> HermesStatus | None:
        status = self._cached_status
        if status is not None and time.monotonic() - self._cached_at < STATUS_CACHE_TTL_SECONDS:
            return status
        return None

    def _clear_caches(self) -> None:
        self._cached_status = None
        self._cached_at = 0.0
        self._resolution_cache = None
        self._version_cache = None

    def _resolve_command(self, hermes_home: Path) -> tuple[str | None, bool]:
        key = _command_resolution_key()
        cached = self._resolution_cache
        if cached is not None and cached[0] == key and time.monotonic() - cached[1] < COMMAND_RESOLUTION_TTL_SECONDS:
            return cached[2], cached[3]
        command_path = _resolve_hermes_command(hermes_home)
        install_supported = (
            not _is_native_windows() and shutil.which("bash") is not None and shutil.which("curl") is not None
        )
        self._resolution_cache = (key, time.monotonic(), command_path, install_supported)
        return command_path, install_supported

    def _version(self, command_path: str) -> str | None:
        fingerprint = _executable_fingerprint(command_path)
        cached = self._version_cache
        if fingerprint is not None and cached is not None and cached[0] == fingerprint:
            version, probed_at = cached[1], cached[2]
            if version is not None or time.monotonic() - probed_at < FAILED_VERSION_RETRY_SECONDS:
                return version
        version = _hermes_version(command_path)
        if fingerprint is not None:
            self._version_cache = (fingerprint, version, time.monotonic())
        return version

    def _compute_status(self) -> HermesStatus:
        native_windows = _is_native_windows()
        hermes_home = self.hermes_home
        command_path, install_supported = self._resolve_command(hermes_home)
        version = self._version(command_path) if command_path else None
        config_exists = (hermes_home / "config.yaml").exists()
        memory_path = self._memory_path(hermes_home)
        installed = command_path is not None and hermes_home.exists()
        setup_required = installed and not config_exists

        if installed and setup_required:
            message = "Hermes Agent is installed, but setup has not completed."
        elif installed:
            message = "Hermes Agent is installed."
        elif os.environ.get(HERMES_BIN_ENV, "").strip():
            message = f"Hermes Agent was not found at {HERMES_BIN_ENV}. Check the configured executable path."
        elif native_windows:
            message = (
                "Hermes Agent is not installed. Install the native Windows build, add `hermes` to PATH, "
                f"or set {HERMES_BIN_ENV} to hermes.exe."
            )
        else:
            message = "Hermes Agent is not installed."

        return HermesStatus(
            installed=installed,
            command_path=command_path,
            version=version,
            hermes_home=hermes_home,
            config_exists=config_exists,
            memory_path=memory_path,
            native_windows=native_windows,
            install_supported=install_supported,
            setup_required=setup_required,
            message=message,
        )

    def install(self, *, timeout_seconds: float = 600) -> HermesInstallResult:
        before = self.status()
        if not before.install_supported:
            if before.native_windows:
                raise RuntimeError("Install the native Windows Hermes build and make sure `hermes` is on your PATH.")
            raise RuntimeError("Hermes Agent install requires bash and curl.")

        completed = subprocess.run(
            ["bash", "-lc", INSTALL_COMMAND],
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
        return HermesInstallResult(
            returncode=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
            # The install changes PATH contents and the executable itself, so
            # every cached piece of status is stale.
            status=self.status(refresh=True),
        )

    def ask(
        self,
        *,
        project_dir: Path,
        question: str,
        context: str | None = None,
        timeout_seconds: float = 120,
        session_id: str | None = None,
    ) -> HermesAskResult:
        status = self.status()
        if not status.installed or not status.command_path:
            raise RuntimeError("Hermes Agent is not installed.")
        if status.setup_required:
            raise RuntimeError("Hermes Agent setup has not completed.")

        prompt = _ask_prompt(question, context)
        command = [status.command_path, "--oneshot", prompt]
        provider = os.environ.get(HERMES_ASK_PROVIDER_ENV, "").strip()
        if provider:
            command.extend(["--provider", provider])
        model = os.environ.get(HERMES_ASK_MODEL_ENV, "").strip()
        if model:
            command.extend(["--model", model])

        # Explicit identity is authoritative. Best-effort auto-resume is safe
        # only when exactly one live Hermes session belongs to this project.
        resume_id = session_id or self._sole_active_session_id_for_project(project_dir)
        if resume_id:
            command.extend(["--resume", resume_id])

        completed = _run_hermes_command(command, cwd=project_dir, timeout_seconds=timeout_seconds)
        answer = completed.stdout.strip()
        stderr = completed.stderr.strip()
        if completed.returncode != 0:
            detail = stderr or answer or f"hermes exited with status {completed.returncode}"
            raise RuntimeError(detail)
        return HermesAskResult(
            answer=answer,
            project_dir=project_dir,
            returncode=completed.returncode,
            stderr=stderr,
        )

    def _sole_active_session_id_for_project(self, project_dir: Path) -> str | None:
        """Return one unambiguous active session for this project, if present."""
        db = next((candidate for candidate in _session_db_candidates(self.hermes_home) if candidate.is_file()), None)
        if db is None:
            return None

        try:
            connection = sqlite3.connect(str(db), timeout=5)
        except sqlite3.Error:
            return None
        try:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(sessions)").fetchall()}
            required = {"id", "cwd", "ended_at", "archived"}
            if not required.issubset(columns):
                return None
            select_columns = ["id", "cwd"]
            if "git_repo_root" in columns:
                select_columns.append("git_repo_root")
            rows = [
                dict(zip(select_columns, values, strict=True))
                for values in connection.execute(
                    f"SELECT {', '.join(select_columns)} FROM sessions WHERE ended_at IS NULL AND archived = 0"
                ).fetchall()
            ]
        except (sqlite3.Error, OSError, TypeError, ValueError):
            return None
        finally:
            connection.close()

        target = _normalize_session_path(str(project_dir))
        matches: list[str] = []
        for row in rows:
            session_id = row.get("id")
            cwd = _normalize_session_path(str(row["cwd"])) if row.get("cwd") else ""
            git_root = _normalize_session_path(str(row["git_repo_root"])) if row.get("git_repo_root") else ""
            # A recorded repository root is stronger than cwd and must match
            # exactly. Fall back to cwd only for older schemas/rows.
            belongs = git_root == target if git_root else bool(cwd and _same_or_descendant(cwd, target))
            if belongs and isinstance(session_id, str) and session_id:
                matches.append(session_id)
        return matches[0] if len(matches) == 1 else None

    def _memory_path(self, hermes_home: Path) -> Path | None:
        candidates = [
            hermes_home / "memories" / "MEMORY.md",
            hermes_home / "profiles" / "default" / "memories" / "MEMORY.md",
        ]
        for path in candidates:
            if path.exists():
                return path
        return None


def _run_hermes_command(
    command: list[str],
    *,
    cwd: Path,
    timeout_seconds: float,
) -> subprocess.CompletedProcess[str]:
    """Run Hermes in an isolated process group and tear down retries on timeout."""
    invocation, invocation_env = _prepare_hermes_invocation(command)
    popen_options: dict[str, object] = {
        "cwd": cwd,
        "text": True,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
    }
    if invocation_env is not None:
        popen_options["env"] = invocation_env
    if _is_native_windows():
        popen_options["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        popen_options["start_new_session"] = True
    process = subprocess.Popen(invocation, **popen_options)  # type: ignore[arg-type]
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        _terminate_process_tree(process)
        stdout, stderr = process.communicate()
        raise subprocess.TimeoutExpired(command, timeout_seconds, output=stdout, stderr=stderr) from exc
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def _prepare_hermes_invocation(command: list[str]) -> tuple[list[str], dict[str, str] | None]:
    """Wrap Windows batch shims without interpolating user input into shell code."""
    if not _is_native_windows() or Path(command[0]).suffix.lower() not in {".cmd", ".bat"}:
        return command, None

    # CreateProcess cannot execute batch files directly. Transport every
    # argument through JSON environment data so prompts containing quotes or
    # cmd metacharacters never become PowerShell source text.
    script = (
        "$ErrorActionPreference = 'Stop'; "
        "$athenaArgs = @(ConvertFrom-Json -InputObject $env:ATHENA_HERMES_ARGS_JSON); "
        "& $env:ATHENA_HERMES_COMMAND @athenaArgs; "
        "exit $LASTEXITCODE"
    )
    encoded_script = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    powershell = shutil.which("pwsh.exe") or shutil.which("powershell.exe") or "powershell.exe"
    child_env = os.environ.copy()
    child_env["ATHENA_HERMES_COMMAND"] = command[0]
    child_env["ATHENA_HERMES_ARGS_JSON"] = json.dumps(command[1:])
    return (
        [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded_script],
        child_env,
    )


def _terminate_process_tree(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    if _is_native_windows():
        try:
            subprocess.run(
                ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            process.kill()
        if process.poll() is None:
            process.kill()
        return

    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=1)
    except (OSError, ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            process.kill()


def _ask_prompt(question: str, context: str | None = None) -> str:
    cleaned_question = question.strip()
    cleaned_context = context.strip() if context else ""
    base = "\n\n".join(
        [
            "Answer the user question directly and concisely.",
            "If Athena context is provided below, use it as optional background context.",
            "Do not start an interactive chat.",
            "User question:",
            cleaned_question,
        ]
    )
    if not cleaned_context:
        return base
    return "\n\n".join([base, "Athena context:", cleaned_context])


def _command_resolution_key() -> tuple[str, ...]:
    """Environment inputs that change which executable resolution would pick."""
    return (
        os.environ.get(HERMES_BIN_ENV, ""),
        os.environ.get("PATH", ""),
        os.environ.get("PATHEXT", ""),
    )


def _executable_fingerprint(command_path: str) -> tuple[str, int, int] | None:
    """Identify an executable build by its real path, mtime, and size."""
    try:
        real_path = os.path.realpath(command_path)
        stat = os.stat(real_path)
    except OSError:
        return None
    return (real_path, stat.st_mtime_ns, stat.st_size)


def _hermes_version(command_path: str) -> str | None:
    try:
        completed = subprocess.run(
            [command_path, "--version"],
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None

    output = (completed.stdout or completed.stderr).strip()
    if not output:
        return None
    return output.splitlines()[0].strip() or None


def _is_native_windows() -> bool:
    return platform.system().lower() == "windows"
