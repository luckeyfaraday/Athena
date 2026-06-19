from pathlib import Path

from backend.adapters.grok import GrokAdapter
from backend.context_artifacts import ContextArtifactWriter
from backend.runs import RunRegistry


def test_grok_adapter_builds_supported_headless_command(tmp_path: Path) -> None:
    run = RunRegistry().create_run(
        agent_type="grok",
        project_dir=tmp_path,
        task="Inspect the project.",
        run_id="run_12345678",
    )
    artifacts = ContextArtifactWriter().write_context(run)

    command = GrokAdapter().build_command(run, artifacts)

    assert command.argv[:6] == [
        "grok",
        "--cwd",
        str(tmp_path.resolve()),
        "--output-format",
        "plain",
        "-p",
    ]
    assert "Generated context file:" in command.argv[6]
    assert str(artifacts.context) in command.argv[6]
    assert "Inspect the project." in command.argv[6]
    assert command.cwd == tmp_path.resolve()
    assert command.stdin == ""


def test_grok_adapter_summarizes_stdout(tmp_path: Path) -> None:
    run = RunRegistry().create_run(
        agent_type="grok",
        project_dir=tmp_path,
        task="Inspect.",
        run_id="run_12345678",
    )
    artifacts = ContextArtifactWriter().initialize_logs(run)
    artifacts.stdout.write_text("Final answer\n", encoding="utf-8")

    assert GrokAdapter().summarize_result(run, artifacts) == "Final answer"
