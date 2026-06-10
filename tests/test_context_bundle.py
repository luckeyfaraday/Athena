from pathlib import Path

import pytest

from backend.context_bundle import ContextBundleStore


def test_create_context_bundle_writes_immutable_artifacts(tmp_path: Path) -> None:
    (tmp_path / "AGENTS.md").write_text("Follow the project rules.\n", encoding="utf-8")
    recall_dir = tmp_path / ".context-workspace" / "hermes"
    recall_dir.mkdir(parents=True)
    (recall_dir / "session-recall.md").write_text("Prior session context.\n", encoding="utf-8")

    bundle = ContextBundleStore().create(
        tmp_path,
        mode="immersive",
        agent="Codex",
        task="Implement the scaffold.",
        memory_excerpt="Project memory.",
        recall_metadata={"status": "fresh"},
    )

    assert bundle.bundle_id.startswith("ctx_")
    assert Path(bundle.bundle_path).is_file()
    assert Path(bundle.context_path).is_file()
    context = Path(bundle.context_path).read_text(encoding="utf-8")
    assert "Follow the project rules." in context
    assert "Project memory." in context
    assert "Prior session context." in context


def test_read_context_bundle_is_workspace_scoped(tmp_path: Path) -> None:
    workspace_a = tmp_path / "a"
    workspace_b = tmp_path / "b"
    workspace_a.mkdir()
    workspace_b.mkdir()
    bundle = ContextBundleStore().create(workspace_a, mode="immersive", agent="Claude Code")

    with pytest.raises(FileNotFoundError):
        ContextBundleStore().read(workspace_b, bundle.bundle_id)


def test_recorded_runtime_turns_are_included_in_next_bundle(tmp_path: Path) -> None:
    store = ContextBundleStore()
    turn = store.record_turn(
        tmp_path,
        session_id="session-1",
        agent="Athena Code",
        mode="clean",
        user_message="Keep the default launch clean.",
        assistant_message="Implemented the clean default.",
    )

    bundle = store.create(tmp_path, mode="immersive", agent="Athena Claude")
    context = Path(bundle.context_path).read_text(encoding="utf-8")

    assert turn["turn_id"].startswith("turn_")
    assert "Recent Athena Runtime Turns" in context
    assert "Keep the default launch clean." in context
    assert "Implemented the clean default." in context
