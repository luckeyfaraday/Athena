"""Filesystem and identifier safety guards for generated run artifacts."""

from __future__ import annotations

import os
import re
from pathlib import Path


class SafetyError(ValueError):
    """Raised when a path or identifier is unsafe for workspace writes."""


RUN_ID_RE = re.compile(r"^run_[A-Za-z0-9_-]{8,80}$")
AGENT_ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}-[1-9][0-9]{0,5}$")


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


def validate_run_id(run_id: str) -> str:
    if not RUN_ID_RE.fullmatch(run_id):
        raise SafetyError(f"Invalid run_id: {run_id!r}")
    return run_id


def validate_agent_id(agent_id: str) -> str:
    if not AGENT_ID_RE.fullmatch(agent_id):
        raise SafetyError(f"Invalid agent_id: {agent_id!r}")
    return agent_id


def resolve_project_dir(project_dir: str | Path) -> Path:
    path = Path(project_dir).expanduser()
    if not path.is_absolute():
        raise SafetyError("Project directory must be an absolute path")

    resolved = path.resolve(strict=True)
    if not resolved.is_dir():
        raise SafetyError(f"Project directory is not a directory: {resolved}")

    if resolved in _DANGEROUS_ROOTS:
        raise SafetyError(f"Refusing to write into protected directory: {resolved}")

    home = Path.home().resolve()
    if resolved == home:
        raise SafetyError("Refusing to use the home directory as a project root")

    return resolved


def ensure_within_directory(parent: Path, child: Path) -> Path:
    resolved_parent = parent.resolve(strict=True)
    resolved_child = child.resolve(strict=False)

    try:
        common_path = Path(os.path.commonpath([resolved_parent, resolved_child]))
    except ValueError as exc:
        raise SafetyError(f"Path is outside parent directory: {child}") from exc

    if common_path != resolved_parent:
        raise SafetyError(f"Path is outside parent directory: {child}")

    return resolved_child


def generated_run_dir(project_dir: str | Path, run_id: str) -> Path:
    resolved_project = resolve_project_dir(project_dir)
    validated_run_id = validate_run_id(run_id)
    run_dir = resolved_project / ".context-workspace" / "runs" / validated_run_id
    return ensure_within_directory(resolved_project, run_dir)

