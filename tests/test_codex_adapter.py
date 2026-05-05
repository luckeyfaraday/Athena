from pathlib import Path

from backend.adapters.codex import CodexAdapter
from backend.context_artifacts import ContextArtifactWriter
from backend.runs import RunRegistry


def test_codex_adapter_builds_non_interactive_command(tmp_path: Path) -> None:
    run = RunRegistry().create_run(
        agent_type="codex",
        project_dir=tmp_path,
        task="Inspect the project.",
        run_id="run_12345678",
    )
    artifacts = ContextArtifactWriter().write_context(run)

    command = CodexAdapter().build_command(run, artifacts)

    assert command.argv == [
        "codex",
        "exec",
        "--cd",
        str(tmp_path.resolve()),
        "--json",
        "--output-last-message",
        str(artifacts.result),
    ]
    assert command.cwd == tmp_path.resolve()
    assert "Generated context file:" in command.stdin
    assert str(artifacts.context) in command.stdin
    assert "Inspect the project." in command.stdin


def test_codex_adapter_summarizes_result_file(tmp_path: Path) -> None:
    run = RunRegistry().create_run(
        agent_type="codex",
        project_dir=tmp_path,
        task="Inspect.",
        run_id="run_12345678",
    )
    artifacts = ContextArtifactWriter().initialize_logs(run)
    artifacts.result.write_text("Final answer", encoding="utf-8")

    assert CodexAdapter().summarize_result(run, artifacts) == "Final answer"

