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

