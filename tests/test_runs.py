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



def test_registry_evicts_oldest_terminal_runs_when_capped(tmp_path: Path) -> None:
    registry = RunRegistry(max_retained_runs=3)
    created = []
    for index in range(5):
        run = registry.create_run(agent_type="codex", project_dir=tmp_path, task=f"Task {index}")
        registry.update_status(run.run_id, RunStatus.SUCCEEDED)
        created.append(run)

    listed = registry.list_runs()
    assert len(listed) == 3
    retained_ids = {run.run_id for run in listed}
    # Oldest two completed runs were evicted; newest three remain.
    assert created[0].run_id not in retained_ids
    assert created[1].run_id not in retained_ids
    assert created[4].run_id in retained_ids


def test_registry_never_evicts_active_runs(tmp_path: Path) -> None:
    registry = RunRegistry(max_retained_runs=2)
    active = [
        registry.create_run(agent_type="codex", project_dir=tmp_path, task=f"Active {index}")
        for index in range(4)
    ]

    # All four are still pending/running, so none may be dropped even past the cap.
    assert len(registry.list_runs()) == 4
    assert {run.run_id for run in registry.list_runs()} == {run.run_id for run in active}

    # Completing the oldest then adding more lets eviction reclaim only the terminal one.
    registry.update_status(active[0].run_id, RunStatus.SUCCEEDED)
    registry.create_run(agent_type="codex", project_dir=tmp_path, task="newer")
    assert active[0].run_id not in {run.run_id for run in registry.list_runs()}
    assert active[1].run_id in {run.run_id for run in registry.list_runs()}


def test_registry_drops_cancel_flag_on_eviction(tmp_path: Path) -> None:
    registry = RunRegistry(max_retained_runs=1)
    first = registry.create_run(agent_type="codex", project_dir=tmp_path, task="first")
    registry.request_cancel(first.run_id)
    assert registry.cancel_requested(first.run_id) is True

    second = registry.create_run(agent_type="codex", project_dir=tmp_path, task="second")
    registry.update_status(second.run_id, RunStatus.SUCCEEDED)
    # Adding/completing another run evicts the cancelled one and forgets its flag.
    assert first.run_id not in {run.run_id for run in registry.list_runs()}
    assert registry.cancel_requested(first.run_id) is False
