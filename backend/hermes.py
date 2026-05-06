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
        wsl_probe = _probe_wsl_hermes() if native_windows else None
        command_path = shutil.which("hermes")
        version = _hermes_version() if command_path else None
        hermes_home = self.hermes_home
        if wsl_probe is not None:
            command_path = wsl_probe.command_path
            version = wsl_probe.version
            hermes_home = wsl_probe.hermes_home
        config_exists = (hermes_home / "config.yaml").exists()
        memory_path = self._memory_path(hermes_home)
        install_supported = not native_windows and shutil.which("bash") is not None and shutil.which("curl") is not None
        installed = command_path is not None and hermes_home.exists()
        setup_required = installed and not config_exists

        if native_windows and wsl_probe is not None:
            message = "Hermes Agent is installed in WSL2."
        elif native_windows:
            message = "Hermes Agent is not supported on native Windows. Install it inside WSL2."
        elif not installed:
            message = "Hermes Agent is not installed."
        elif setup_required:
            message = "Hermes Agent is installed, but setup has not completed."
        else:
            message = "Hermes Agent is installed."

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
        self._cached_status = None
        self._cached_at = 0.0
        return HermesInstallResult(
            returncode=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
            status=self.status(),
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


@dataclass(frozen=True)
class WslHermesProbe:
    command_path: str
    version: str | None
    hermes_home: Path


def _probe_wsl_hermes() -> WslHermesProbe | None:
    if shutil.which("wsl.exe") is None:
        return None

    script = "\n".join(
        [
            "command_path=$(command -v hermes) || exit 127",
            'printf "__HERMES_COMMAND__%s\\n" "$command_path"',
            'hermes --version 2>&1 | head -n 1 | sed "s/^/__HERMES_VERSION__/"',
            'printf "__HERMES_HOME__%s\\n" "$(wslpath -w "$HOME/.hermes")"',
        ]
    )
    try:
        completed = subprocess.run(
            ["wsl.exe", "-e", "sh", "-lc", script],
            text=True,
            capture_output=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None

    command_path: str | None = None
    version: str | None = None
    hermes_home: Path | None = None
    for line in completed.stdout.splitlines():
        if line.startswith("__HERMES_COMMAND__"):
            command_path = line.removeprefix("__HERMES_COMMAND__").strip()
        elif line.startswith("__HERMES_VERSION__"):
            version = line.removeprefix("__HERMES_VERSION__").strip() or None
        elif line.startswith("__HERMES_HOME__"):
            home = line.removeprefix("__HERMES_HOME__").strip()
            hermes_home = Path(home) if home else None

    if command_path is None or hermes_home is None:
        return None
    return WslHermesProbe(command_path=f"wsl:{command_path}", version=version, hermes_home=hermes_home)
