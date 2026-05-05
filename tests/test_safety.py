from pathlib import Path

import pytest

from backend.safety import SafetyError, generated_run_dir, resolve_project_dir


def test_resolve_project_dir_requires_absolute_path() -> None:
    with pytest.raises(SafetyError):
        resolve_project_dir("relative/project")


def test_resolve_project_dir_rejects_dangerous_root() -> None:
    with pytest.raises(SafetyError):
        resolve_project_dir("/")


def test_generated_run_dir_stays_under_project(tmp_path: Path) -> None:
    run_dir = generated_run_dir(tmp_path, "run_12345678")

    assert run_dir == tmp_path.resolve() / ".context-workspace" / "runs" / "run_12345678"


def test_generated_run_dir_rejects_path_traversal_run_id(tmp_path: Path) -> None:
    with pytest.raises(SafetyError):
        generated_run_dir(tmp_path, "run_../../etc")

