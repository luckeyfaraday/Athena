"""Filesystem safety guards for caller-supplied project directories."""

from __future__ import annotations

import os
from pathlib import Path


class SafetyError(ValueError):
    """Raised when a path is unsafe to use as a project directory."""


_DANGEROUS_ROOTS = {
    Path("/"),
    Path("/bin"),
    Path("/boot"),
    Path("/dev"),
    Path("/etc"),
    Path("/lib"),
    Path("/lib64"),
    Path("/proc"),
    Path("/root"),
    Path("/run"),
    Path("/sbin"),
    Path("/sys"),
    Path("/usr"),
    Path("/var"),
}


def _windows_dangerous_roots() -> set[Path]:
    if os.name != "nt":
        return set()
    roots: set[Path] = set()
    for env_name in ("SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"):
        value = os.environ.get(env_name, "").strip()
        if value:
            roots.add(Path(value))
    system_drive = os.environ.get("SystemDrive", "C:").strip() or "C:"
    roots.add(Path(f"{system_drive}\\"))
    return roots


def resolve_project_dir(project_dir: str | Path) -> Path:
    path = Path(project_dir).expanduser()
    if not path.is_absolute():
        raise SafetyError("Project directory must be an absolute path")

    resolved = path.resolve(strict=True)
    if not resolved.is_dir():
        raise SafetyError(f"Project directory is not a directory: {resolved}")

    if resolved in _DANGEROUS_ROOTS or resolved in _windows_dangerous_roots():
        raise SafetyError(f"Refusing to write into protected directory: {resolved}")

    # A filesystem/drive root is never a sane project directory on any platform.
    if resolved == Path(resolved.anchor):
        raise SafetyError(f"Refusing to use a filesystem root as a project directory: {resolved}")

    home = Path.home().resolve()
    if resolved == home:
        raise SafetyError("Refusing to use the home directory as a project root")

    return resolved
