"""Subprocess execution for one-shot agent runs."""

from __future__ import annotations

import os
import subprocess
import threading
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
        self._processes: dict[str, subprocess.Popen[str]] = {}
        self._process_lock = threading.Lock()

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
        if self.registry.cancel_requested(run.run_id):
            cancelled = self.registry.update_status(run.run_id, RunStatus.CANCELLED)
            return ExecutionResult(
                run=cancelled,
                artifacts=artifacts,
                returncode=-2,
                summary=f"{run.agent_id} was cancelled before start.",
            )
        self.registry.update_status(run.run_id, RunStatus.RUNNING)

        try:
            process = subprocess.Popen(
                command.argv,
                cwd=command.cwd,
                env={**os.environ, **command.env},
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            with self._process_lock:
                self._processes[run.run_id] = process
            if self.registry.cancel_requested(run.run_id):
                process.terminate()
            stdout, stderr = process.communicate(
                input=command.stdin,
                timeout=timeout_seconds,
            )
            returncode = process.returncode
        except subprocess.TimeoutExpired as exc:
            process.terminate()
            try:
                stdout, stderr = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = process.communicate()
            artifacts.stdout.write_text(stdout or exc.stdout or "", encoding="utf-8")
            artifacts.stderr.write_text(stderr or exc.stderr or "Process timed out.", encoding="utf-8")
            failed = self.registry.update_status(run.run_id, RunStatus.FAILED)
            return ExecutionResult(
                run=failed,
                artifacts=artifacts,
                returncode=-1,
                summary=f"{run.agent_id} timed out.",
            )
        finally:
            with self._process_lock:
                self._processes.pop(run.run_id, None)

        artifacts.stdout.write_text(stdout, encoding="utf-8")
        artifacts.stderr.write_text(stderr, encoding="utf-8")

        if self.registry.cancel_requested(run.run_id):
            updated = self.registry.update_status(run.run_id, RunStatus.CANCELLED)
            return ExecutionResult(
                run=updated,
                artifacts=artifacts,
                returncode=-2,
                summary=f"{run.agent_id} was cancelled.",
            )

        status = RunStatus.SUCCEEDED if returncode == 0 else RunStatus.FAILED
        updated = self.registry.update_status(run.run_id, status)
        return ExecutionResult(
            run=updated,
            artifacts=artifacts,
            returncode=returncode,
            summary=adapter.summarize_result(updated, artifacts),
        )

    def cancel(self, run_id: str) -> bool:
        with self._process_lock:
            process = self._processes.get(run_id)
        if process is None or process.poll() is not None:
            return False
        process.terminate()
        return True

