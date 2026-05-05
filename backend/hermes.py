"""Hermes Agent installation and configuration probing."""

from __future__ import annotations

import platform
import shutil
import subprocess
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


class HermesManager:
    def __init__(self, *, hermes_home: Path | None = None) -> None:
        self.hermes_home = hermes_home or Path.home() / ".hermes"

    def status(self) -> HermesStatus:
        command_path = shutil.which("hermes")
        version = _hermes_version() if command_path else None
        config_exists = (self.hermes_home / "config.yaml").exists()
        memory_path = self._memory_path()
        native_windows = _is_native_windows()
        install_supported = not native_windows and shutil.which("bash") is not None and shutil.which("curl") is not None
        installed = command_path is not None and self.hermes_home.exists()
        setup_required = installed and not config_exists

        if native_windows:
            message = "Hermes Agent is not supported on native Windows. Install it inside WSL2."
        elif not installed:
            message = "Hermes Agent is not installed."
        elif setup_required:
            message = "Hermes Agent is installed, but setup has not completed."
        else:
            message = "Hermes Agent is installed."

        return HermesStatus(
            installed=installed,
            command_path=command_path,
            version=version,
            hermes_home=self.hermes_home,
            config_exists=config_exists,
            memory_path=memory_path,
            native_windows=native_windows,
            install_supported=install_supported,
            setup_required=setup_required,
            message=message,
        )

    def install(self, *, timeout_seconds: float = 600) -> HermesInstallResult:
        before = self.status()
        if before.native_windows:
            raise RuntimeError("Hermes Agent must be installed inside WSL2 on Windows.")
        if not before.install_supported:
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
            status=self.status(),
        )

    def _memory_path(self) -> Path | None:
        candidates = [
            self.hermes_home / "memories" / "MEMORY.md",
            self.hermes_home / "profiles" / "default" / "memories" / "MEMORY.md",
        ]
        for path in candidates:
            if path.exists():
                return path
        return None


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
    return output or None


def _is_native_windows() -> bool:
    return platform.system().lower() == "windows"
