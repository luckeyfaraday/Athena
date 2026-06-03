"""Hermes Agent installation and configuration probing."""

from __future__ import annotations

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
    ) -> HermesAskResult:
        status = self.status()
        if not status.installed:
            raise RuntimeError("Hermes Agent is not installed.")
        if status.setup_required:
            raise RuntimeError("Hermes Agent setup has not completed.")

        prompt = _ask_prompt(question, context)
        completed = subprocess.run(
            ["hermes", "--oneshot", prompt],
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
