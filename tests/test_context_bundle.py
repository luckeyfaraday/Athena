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


def test_turns_file_is_trimmed_once_it_grows_past_the_cap(tmp_path: Path) -> None:
    store = ContextBundleStore()
    filler = "x" * 4096
    for index in range(80):
        store.record_turn(
            tmp_path,
            session_id=f"session-{index}",
            agent="Athena Code",
            mode="clean",
            user_message=f"turn {index} {filler}",
            assistant_message="ok",
        )

    turns_path = tmp_path / ".context-workspace" / "context" / "turns.jsonl"
    from backend.context_bundle import MAX_TURNS_FILE_BYTES, MAX_TURNS_KEPT_ON_TRIM

    lines = turns_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) <= MAX_TURNS_KEPT_ON_TRIM
    # The most recent turn is always retained.
    assert "turn 79" in lines[-1]
    assert turns_path.stat().st_size <= MAX_TURNS_FILE_BYTES + 8192


def test_old_context_bundles_are_pruned_on_create(tmp_path: Path) -> None:
    from backend.context_bundle import MAX_RETAINED_BUNDLES

    store = ContextBundleStore()
    created = [
        store.create(tmp_path, mode="immersive", agent="Athena Code")
        for _ in range(MAX_RETAINED_BUNDLES + 5)
    ]

    context_dir = tmp_path / ".context-workspace" / "context"
    remaining = [entry.name for entry in context_dir.iterdir() if entry.is_dir()]
    assert len(remaining) == MAX_RETAINED_BUNDLES
    # The newest bundle survives pruning and stays readable.
    newest = created[-1]
    assert newest.bundle_id in remaining
    assert store.read(tmp_path, newest.bundle_id).bundle_id == newest.bundle_id


def test_read_tolerates_extra_keys_in_stored_bundle_sources(tmp_path: Path) -> None:
    import json

    store = ContextBundleStore()
    bundle = store.create(tmp_path, mode="immersive", agent="Athena Code")
    bundle_path = Path(bundle.bundle_path)
    payload = json.loads(bundle_path.read_text(encoding="utf-8"))
    payload["sources"][0]["added_by_future_schema"] = True
    bundle_path.write_text(json.dumps(payload), encoding="utf-8")

    restored = store.read(tmp_path, bundle.bundle_id)

    assert restored.bundle_id == bundle.bundle_id
    assert restored.sources
