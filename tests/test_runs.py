from pathlib import Path

from backend.runs import RunRegistry, RunStatus


def test_registry_allocates_run_and_agent_ids(tmp_path: Path) -> None:
    registry = RunRegistry()

    first = registry.create_run(agent_type="codex", project_dir=tmp_path, task="Inspect")
    second = registry.create_run(agent_type="codex", project_dir=tmp_path, task="Test")

    assert first.run_id.startswith("run_")
    assert first.agent_id == "codex-1"
    assert second.agent_id == "codex-2"
    assert first.project_dir == tmp_path.resolve()


def test_registry_updates_status(tmp_path: Path) -> None:
    registry = RunRegistry()
    run = registry.create_run(agent_type="codex", project_dir=tmp_path, task="Inspect")

    updated = registry.update_status(run.run_id, RunStatus.RUNNING)

    assert updated.status == RunStatus.RUNNING
    assert updated.updated_at >= run.updated_at
    assert updated.started_at is not None


def test_registry_sets_completed_at_for_terminal_status(tmp_path: Path) -> None:
    registry = RunRegistry()
    run = registry.create_run(agent_type="codex", project_dir=tmp_path, task="Inspect")

    completed = registry.update_status(run.run_id, RunStatus.SUCCEEDED)

    assert completed.completed_at is not None


def test_registry_tracks_active_counts_by_project_and_agent_type(tmp_path: Path) -> None:
    other_project = tmp_path / "other"
    other_project.mkdir()
    registry = RunRegistry()
    first = registry.create_run(agent_type="codex", project_dir=tmp_path, task="Inspect")
    registry.create_run(agent_type="codex", project_dir=other_project, task="Inspect")
    registry.create_run(agent_type="opencode", project_dir=tmp_path, task="Inspect")

    registry.update_status(first.run_id, RunStatus.SUCCEEDED)

    assert registry.active_count() == 2
    assert registry.active_count(project_dir=tmp_path) == 1
    assert registry.active_count(agent_type="codex") == 1


def test_registry_request_cancel_marks_run_cancelled(tmp_path: Path) -> None:
    registry = RunRegistry()
    run = registry.create_run(agent_type="codex", project_dir=tmp_path, task="Inspect")

    cancelled = registry.request_cancel(run.run_id)

    assert cancelled.status == RunStatus.CANCELLED
    assert registry.cancel_requested(run.run_id) is True

