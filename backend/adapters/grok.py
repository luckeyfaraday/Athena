"""Grok (xAI Grok Build) CLI adapter."""

from __future__ import annotations

from .base import AdapterCommand
from backend.context_artifacts import RunArtifacts
from backend.runs import Run


class GrokAdapter:
    agent_type = "grok"

    def __init__(self, *, executable: str = "grok", output_format: str = "plain") -> None:
        self.executable = executable
        self.output_format = output_format

    def build_command(self, run: Run, artifacts: RunArtifacts) -> AdapterCommand:
        # Grok Build's single-turn headless mode (`-p/--single`) prints the final
        # response to stdout and exits, so the prompt is passed as an argv value and
        # the result is read back from the captured stdout (no --output-last-message
        # equivalent exists). `--cwd` scopes file operations to the project dir.
        argv = [
            self.executable,
            "--cwd",
            str(run.project_dir),
            "--output-format",
            self.output_format,
            "-p",
            _render_prompt(run, artifacts),
        ]
        return AdapterCommand(argv=argv, cwd=run.project_dir, stdin="")

    def summarize_result(self, run: Run, artifacts: RunArtifacts) -> str:
        if artifacts.stdout.exists():
            result = artifacts.stdout.read_text(encoding="utf-8").strip()
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
