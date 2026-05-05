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
    assert "Hermes remembers the adapter plan." in text
    assert "curl -s" in text


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

