from pathlib import Path

from backend.context_artifacts import ContextArtifactWriter
from backend.runs import RunRegistry


def test_write_context_creates_deterministic_artifact(tmp_path: Path) -> None:
    registry = RunRegistry()
    run = registry.create_run(
        agent_type="codex",
        project_dir=tmp_path,
        task="Review the adapter design.",
        run_id="run_12345678",
    )

    artifacts = ContextArtifactWriter().write_context(
        run,
        memory_excerpt="Hermes remembers the adapter plan.",
    )

    assert artifacts.context == (
        tmp_path.resolve() / ".context-workspace" / "runs" / "run_12345678" / "context.md"
    )
    text = artifacts.context.read_text(encoding="utf-8")
    assert "Review the adapter design." in text
    assert "Hermes remembers the adapter plan." not in text
    assert "explicit immersive launch" in text


def test_write_context_does_not_include_hermes_session_recall_cache(tmp_path: Path) -> None:
    recall_dir = tmp_path / ".context-workspace" / "hermes"
    recall_dir.mkdir(parents=True)
    (recall_dir / "session-recall.md").write_text("Prior session found adapter edge cases.\n", encoding="utf-8")
    run = RunRegistry().create_run(
        agent_type="codex",
        project_dir=tmp_path,
        task="Use recall.",
        run_id="run_1234abcd",
    )

    artifacts = ContextArtifactWriter().write_context(run)

    text = artifacts.context.read_text(encoding="utf-8")
    assert "Hermes Session Recall Cache" not in text
    assert "Prior session found adapter edge cases." not in text


def test_write_context_states_that_legacy_runs_are_clean(tmp_path: Path) -> None:
    run = RunRegistry().create_run(
        agent_type="codex",
        project_dir=tmp_path,
        task="Start without prior context.",
        run_id="run_1234eeee",
    )

    artifacts = ContextArtifactWriter().write_context(run)

    text = artifacts.context.read_text(encoding="utf-8")
    assert "no Athena memory, recall, or project context attached" in text


def test_write_context_ignores_recall_from_all_projects(tmp_path: Path) -> None:
    workspace_a = tmp_path / "workspace-a"
    workspace_b = tmp_path / "workspace-b"
    recall_a = workspace_a / ".context-workspace" / "hermes"
    recall_b = workspace_b / ".context-workspace" / "hermes"
    recall_a.mkdir(parents=True)
    recall_b.mkdir(parents=True)
    (recall_a / "session-recall.md").write_text("WORKSPACE_A_RECALL_SENTINEL\n", encoding="utf-8")
    (recall_b / "session-recall.md").write_text("WORKSPACE_B_RECALL_SENTINEL\n", encoding="utf-8")
    run = RunRegistry().create_run(
        agent_type="codex",
        project_dir=workspace_b,
        task="Use workspace B only.",
        run_id="run_1234bbbb",
    )

    artifacts = ContextArtifactWriter().write_context(run)

    text = artifacts.context.read_text(encoding="utf-8")
    assert "WORKSPACE_B_RECALL_SENTINEL" not in text
    assert "WORKSPACE_A_RECALL_SENTINEL" not in text


def test_initialize_logs_creates_expected_files(tmp_path: Path) -> None:
    run = RunRegistry().create_run(
        agent_type="codex",
        project_dir=tmp_path,
        task="Run",
        run_id="run_abcdefgh",
    )

    artifacts = ContextArtifactWriter().initialize_logs(run)

    assert artifacts.stdout.exists()
    assert artifacts.stderr.exists()
    assert artifacts.result.exists()
