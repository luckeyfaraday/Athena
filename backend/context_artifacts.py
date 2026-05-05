"""Generated context and output artifact handling."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .runs import Run
from .safety import generated_run_dir


@dataclass(frozen=True)
class RunArtifacts:
    run_dir: Path
    context: Path
    stdout: Path
    stderr: Path
    result: Path


class ContextArtifactWriter:
    def paths_for(self, run: Run) -> RunArtifacts:
        run_dir = generated_run_dir(run.project_dir, run.run_id)
        return RunArtifacts(
            run_dir=run_dir,
            context=run_dir / "context.md",
            stdout=run_dir / "stdout.log",
            stderr=run_dir / "stderr.log",
            result=run_dir / "result.md",
        )

    def write_context(
        self,
        run: Run,
        *,
        memory_excerpt: str = "",
        dynamic_memory_url: str = "http://localhost:8000/memory/hermes",
    ) -> RunArtifacts:
        artifacts = self.paths_for(run)
        artifacts.run_dir.mkdir(parents=True, exist_ok=True)
        artifacts.context.write_text(
            _render_context(run, memory_excerpt, dynamic_memory_url),
            encoding="utf-8",
        )
        return artifacts

    def initialize_logs(self, run: Run) -> RunArtifacts:
        artifacts = self.paths_for(run)
        artifacts.run_dir.mkdir(parents=True, exist_ok=True)
        for path in (artifacts.stdout, artifacts.stderr, artifacts.result):
            path.touch(exist_ok=True)
        return artifacts


def _render_context(run: Run, memory_excerpt: str, dynamic_memory_url: str) -> str:
    memory = memory_excerpt.strip() or "No Hermes memory excerpt was provided."
    return "\n".join(
        [
            f"# Context Workspace Run: {run.run_id}",
            "",
            f"Project directory: `{run.project_dir}`",
            f"Agent: `{run.agent_id}` ({run.agent_type})",
            "",
            "## Current Task",
            "",
            run.task.strip(),
            "",
            "## Hermes Memory Excerpt",
            "",
            memory,
            "",
            "## Dynamic Memory Lookup",
            "",
            "If more context is needed, query Hermes with a focused URL-encoded query:",
            "",
            f'`curl -s "{dynamic_memory_url}?q=<query>"`',
            "",
        ]
    )

