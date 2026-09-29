from pathlib import Path

import pytest

from backend.safety import SafetyError, resolve_project_dir


def test_resolve_project_dir_requires_absolute_path() -> None:
    with pytest.raises(SafetyError):
        resolve_project_dir("relative/project")


def test_resolve_project_dir_rejects_dangerous_root() -> None:
    with pytest.raises(SafetyError):
        resolve_project_dir("/")


def test_resolve_project_dir_accepts_existing_directory(tmp_path: Path) -> None:
    assert resolve_project_dir(tmp_path) == tmp_path.resolve()
