"""Subprocess execution for one-shot agent runs."""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass

from .adapters.base import AgentAdapter
from .context_artifacts import ContextArtifactWriter, RunArtifacts
from .runs import Run, RunRegistry, RunStatus


@dataclass(frozen=True)
class ExecutionResult:
    run: Run
    artifacts: RunArtifacts
    returncode: int
    summary: str


class RunExecutor:
    def __init__(
        self,
        *,
        registry: RunRegistry,
        artifacts: ContextArtifactWriter | None = None,
    ) -> None:
        self.registry = registry
        self.artifacts = artifacts or ContextArtifactWriter()

    def execute(
        self,
        run: Run,
        adapter: AgentAdapter,
        *,
        memory_excerpt: str = "",
        timeout_seconds: float | None = None,
    ) -> ExecutionResult:
        artifacts = self.artifacts.write_context(run, memory_excerpt=memory_excerpt)
        self.artifacts.initialize_logs(run)
        command = adapter.build_command(run, artifacts)
        self.registry.update_status(run.run_id, RunStatus.RUNNING)

        try:
            completed = subprocess.run(
                command.argv,
                cwd=command.cwd,
                env={**os.environ, **command.env},
                input=command.stdin,
                text=True,
                capture_output=True,
                timeout=timeout_seconds,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            artifacts.stdout.write_text(exc.stdout or "", encoding="utf-8")
            artifacts.stderr.write_text(exc.stderr or "Process timed out.", encoding="utf-8")
            failed = self.registry.update_status(run.run_id, RunStatus.FAILED)
            return ExecutionResult(
                run=failed,
                artifacts=artifacts,
                returncode=-1,
                summary=f"{run.agent_id} timed out.",
            )

        artifacts.stdout.write_text(completed.stdout, encoding="utf-8")
        artifacts.stderr.write_text(completed.stderr, encoding="utf-8")

        status = RunStatus.SUCCEEDED if completed.returncode == 0 else RunStatus.FAILED
        updated = self.registry.update_status(run.run_id, status)
        return ExecutionResult(
            run=updated,
            artifacts=artifacts,
            returncode=completed.returncode,
            summary=adapter.summarize_result(updated, artifacts),
        )

