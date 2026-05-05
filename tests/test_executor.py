from __future__ import annotations

import sys
from pathlib import Path

from backend.adapters.base import AdapterCommand
from backend.context_artifacts import RunArtifacts
from backend.executor import RunExecutor
from backend.runs import Run, RunRegistry, RunStatus


class FakeAdapter:
    agent_type = "codex"

    def __init__(self, fixture: Path, *, exit_code: int = 0) -> None:
        self.fixture = fixture
        self.exit_code = exit_code

    def build_command(self, run: Run, artifacts: RunArtifacts) -> AdapterCommand:
        return AdapterCommand(
            argv=[
                sys.executable,
                str(self.fixture),
                "--output-last-message",
                str(artifacts.result),
                "--exit-code",
                str(self.exit_code),
                "--stderr",
                "fake stderr",
            ],
            cwd=run.project_dir,
            stdin=f"run={run.run_id}\ncontext={artifacts.context}\n",
        )

    def summarize_result(self, run: Run, artifacts: RunArtifacts) -> str:
        return artifacts.result.read_text(encoding="utf-8").strip()


def test_executor_captures_successful_fake_agent(tmp_path: Path) -> None:
    registry = RunRegistry()
    run = registry.create_run(
        agent_type="codex",
        project_dir=tmp_path,
        task="Run fake agent.",
        run_id="run_12345678",
    )
    fixture = Path(__file__).parent / "fixtures" / "fake_agent.py"

    result = RunExecutor(registry=registry).execute(
        run,
        FakeAdapter(fixture),
        memory_excerpt="Relevant memory.",
    )

    assert result.run.status == RunStatus.SUCCEEDED
    assert result.returncode == 0
    assert "fake final message" in result.summary
    assert result.artifacts.context.exists()
    assert result.artifacts.stdout.read_text(encoding="utf-8") == "fake stdout\n"
    assert result.artifacts.stderr.read_text(encoding="utf-8") == "fake stderr\n"
    assert registry.get(run.run_id).status == RunStatus.SUCCEEDED


def test_executor_marks_nonzero_exit_failed(tmp_path: Path) -> None:
    registry = RunRegistry()
    run = registry.create_run(
        agent_type="codex",
        project_dir=tmp_path,
        task="Run fake agent.",
        run_id="run_abcdefgh",
    )
    fixture = Path(__file__).parent / "fixtures" / "fake_agent.py"

    result = RunExecutor(registry=registry).execute(run, FakeAdapter(fixture, exit_code=7))

    assert result.run.status == RunStatus.FAILED
    assert result.returncode == 7
    assert registry.get(run.run_id).status == RunStatus.FAILED

