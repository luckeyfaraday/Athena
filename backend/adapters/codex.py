"""Codex CLI adapter."""

from __future__ import annotations

from pathlib import Path

from .base import AdapterCommand
from backend.context_artifacts import RunArtifacts
from backend.runs import Run


class CodexAdapter:
    agent_type = "codex"

    def __init__(
        self,
        *,
        executable: str = "codex",
        use_json: bool = True,
        output_last_message: Path | None = None,
    ) -> None:
        self.executable = executable
        self.use_json = use_json
        self.output_last_message = output_last_message

    def build_command(self, run: Run, artifacts: RunArtifacts) -> AdapterCommand:
        argv = [self.executable, "exec", "--cd", str(run.project_dir)]
        if self.use_json:
            argv.append("--json")

        final_output = self.output_last_message or artifacts.result
        argv.extend(["--output-last-message", str(final_output)])

        return AdapterCommand(
            argv=argv,
            cwd=run.project_dir,
            stdin=_render_prompt(run, artifacts),
        )

    def summarize_result(self, run: Run, artifacts: RunArtifacts) -> str:
        if artifacts.result.exists():
            result = artifacts.result.read_text(encoding="utf-8").strip()
            if result:
                return result
        return f"{run.agent_id} completed without a captured final message."


def _render_prompt(run: Run, artifacts: RunArtifacts) -> str:
    return "\n".join(
        [
            "You are running under Context Workspace orchestration.",
            "",
            f"Agent id: {run.agent_id}",
            f"Run id: {run.run_id}",
            f"Project directory: {run.project_dir}",
            f"Generated context file: {artifacts.context}",
            "",
            "Read the generated context file before making decisions.",
            "Use the dynamic memory lookup instructions in that file if more context is needed.",
            "",
            "Task:",
            run.task.strip(),
            "",
        ]
    )

