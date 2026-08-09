"""Hermes Agent installation and configuration probing."""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path


INSTALL_COMMAND = (
    "curl -fsSL "
    "https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh "
    "| bash"
)

# Operators may pin the provider/model used for /hermes/ask one-shots. When
# either env var is unset, hermes falls back to the user's own config default,
# so a host without a key for a specific provider is not forced onto one it
# cannot reach.
HERMES_ASK_MODEL_ENV = "HERMES_ASK_MODEL"
HERMES_ASK_PROVIDER_ENV = "HERMES_ASK_PROVIDER"


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


def _session_db_candidates(hermes_home: Path) -> list[Path]:
    """Possible Hermes session database locations, most recent layout first.

    Current builds keep the database at ``HERMES_HOME/state.db``; the earliest
    builds used ``HERMES_HOME/runtime-data/state.db``.
    """
    return [hermes_home / "state.db", hermes_home / "runtime-data" / "state.db"]


def _normalize_path(path: str) -> str:
    """Lowercase and unify separators so Windows/Unix cwd values compare equal."""
    return path.strip().lower().replace("\\", "/").rstrip("/")


def _paths_overlap(a: str, b: str) -> bool:
    """True when one normalized path equals or contains the other."""
    return a == b or a.startswith(b + "/") or b.startswith(a + "/")


class HermesManager:
    def __init__(self, *, hermes_home: Path | None = None) -> None:
        self.hermes_home = hermes_home or Path.home() / ".hermes"
        self._cached_status: HermesStatus | None = None
        self._cached_at = 0.0

    def status(self) -> HermesStatus:
        now = time.monotonic()
        if self._cached_status is not None and now - self._cached_at < 60:
            return self._cached_status

        native_windows = _is_native_windows()
        command_path = shutil.which("hermes")
        version = _hermes_version() if command_path else None
        hermes_home = self.hermes_home
        config_exists = (hermes_home / "config.yaml").exists()
        memory_path = self._memory_path(hermes_home)
        # The bundled installer is a Unix bash/curl script. Native Windows now
        # ships its own Hermes build that users install separately, so the in-app
        # installer stays Unix-only while detection works on every platform.
        install_supported = not native_windows and shutil.which("bash") is not None and shutil.which("curl") is not None
        installed = command_path is not None and hermes_home.exists()
        setup_required = installed and not config_exists

        if installed and setup_required:
            message = "Hermes Agent is installed, but setup has not completed."
        elif installed:
            message = "Hermes Agent is installed."
        elif native_windows:
            message = "Hermes Agent is not installed. Install the native Windows build and make sure `hermes` is on your PATH."
        else:
            message = "Hermes Agent is not installed."

        status = HermesStatus(
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
        self._cached_status = status
        self._cached_at = now
        return status

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
        self._cached_status = None
        self._cached_at = 0.0
        return HermesInstallResult(
            returncode=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
            status=self.status(),
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
        if not status.installed:
            raise RuntimeError("Hermes Agent is not installed.")
        if status.setup_required:
            raise RuntimeError("Hermes Agent setup has not completed.")

        prompt = _ask_prompt(question, context)
        # Provider/model pinning is an operator choice via
        # HERMES_ASK_PROVIDER/HERMES_ASK_MODEL; when unset the one-shot uses
        # the user's own Hermes config default. The prompt must immediately
        # follow --oneshot: the CLI parses it as a value-taking option.
        cmd = ["hermes", "--oneshot", prompt]
        provider = os.environ.get(HERMES_ASK_PROVIDER_ENV, "").strip()
        if provider:
            cmd.extend(["--provider", provider])
        model = os.environ.get(HERMES_ASK_MODEL_ENV, "").strip()
        if model:
            cmd.extend(["--model", model])
        # Resume is opt-in: an explicit session_id is honored as-is; without
        # one we only resume a still-open session tied to this project, so the
        # one-shot never inherits context from an unrelated project.
        resume_id = session_id or self._active_session_id_for_project(project_dir)
        if resume_id:
            cmd.extend(["--resume", resume_id])
        completed = subprocess.run(
            cmd,
            cwd=project_dir,
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
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

    def _active_session_id_for_project(self, project_dir: Path) -> str | None:
        """Return the most recent still-open session id tied to ``project_dir``.

        Reads Hermes's own session database and matches on the session's
        recorded ``cwd`` or ``git_repo_root``, so a /hermes/ask one-shot can
        ``--resume`` the caller's live conversation without ever pulling a
        session from an unrelated project. ``None`` means "no resume": the
        caller then runs the one-shot without context.

        Deliberately defensive — missing database, unexpected schema, or a
        read error all degrade to ``None`` rather than failing the ask.
        """
        db = next(
            (candidate for candidate in _session_db_candidates(self.hermes_home) if candidate.is_file()),
            None,
        )
        if db is None:
            return None

        import sqlite3

        try:
            con = sqlite3.connect(str(db), timeout=5)
        except sqlite3.Error:
            return None
        try:
            columns = {row[1] for row in con.execute("PRAGMA table_info(sessions)").fetchall()}
            if not {"id", "cwd", "ended_at", "archived", "started_at"}.issubset(columns):
                return None
            select_cols = ["id", "cwd", "started_at"]
            if "git_repo_root" in columns:
                select_cols.append("git_repo_root")
            if "last_activity_at" in columns:
                select_cols.append("last_activity_at")
            rows = [
                {name: values[index] for index, name in enumerate(select_cols)}
                for values in con.execute(
                    "SELECT {} FROM sessions WHERE ended_at IS NULL AND archived = 0".format(
                        ", ".join(select_cols)
                    )
                ).fetchall()
            ]
        except (sqlite3.Error, OSError):
            return None
        finally:
            con.close()

        target = _normalize_path(str(project_dir))
        best_id: str | None = None
        best_activity: float | None = None
        for row in rows:
            cwd = _normalize_path(row["cwd"]) if row.get("cwd") else ""
            git_root = _normalize_path(row["git_repo_root"]) if row.get("git_repo_root") else ""
            if not (cwd and _paths_overlap(cwd, target)) and not (
                git_root and _paths_overlap(git_root, target)
            ):
                continue
            activity = row.get("last_activity_at") or row["started_at"]
            if best_id is None or (
                activity is not None and (best_activity is None or activity > best_activity)
            ):
                best_id = row["id"]
                best_activity = activity
        return best_id

    def _memory_path(self, hermes_home: Path) -> Path | None:
        candidates = [
            hermes_home / "memories" / "MEMORY.md",
            hermes_home / "profiles" / "default" / "memories" / "MEMORY.md",
        ]
        for path in candidates:
            if path.exists():
                return path
        return None


def _ask_prompt(question: str, context: str | None = None) -> str:
    cleaned_question = question.strip()
    cleaned_context = context.strip() if context else ""
    base = "\n\n".join(
        [
            "Answer the user question directly and concisely.",
            "If Athena context is provided below, use it as optional background context.",
            "Do not start an interactive chat. Do not try to rediscover Athena session recall when Athena has already provided it.",
            "User question:",
            cleaned_question,
        ]
    )
    if not cleaned_context:
        return base
    return "\n\n".join(
        [
            base,
            "Athena context:",
            cleaned_context,
        ]
    )


def _hermes_version() -> str | None:
    try:
        completed = subprocess.run(
            ["hermes", "--version"],
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
