"""In-memory active run registry."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from uuid import uuid4

from .safety import resolve_project_dir, validate_agent_id, validate_run_id


class RunStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class Run:
    run_id: str
    agent_id: str
    agent_type: str
    project_dir: Path
    task: str
    status: RunStatus = RunStatus.PENDING
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


class RunRegistry:
    """Tracks live runs and allocates deterministic agent ids per registry."""

    def __init__(self) -> None:
        self._runs: dict[str, Run] = {}
        self._agent_counts: dict[str, int] = {}

    def create_run(
        self,
        *,
        agent_type: str,
        project_dir: str | Path,
        task: str,
        run_id: str | None = None,
    ) -> Run:
        normalized_agent_type = _normalize_agent_type(agent_type)
        self._agent_counts[normalized_agent_type] = (
            self._agent_counts.get(normalized_agent_type, 0) + 1
        )
        agent_id = validate_agent_id(
            f"{normalized_agent_type}-{self._agent_counts[normalized_agent_type]}"
        )
        allocated_run_id = validate_run_id(run_id or f"run_{uuid4().hex}")
        if allocated_run_id in self._runs:
            raise ValueError(f"Run already exists: {allocated_run_id}")

        now = datetime.now(timezone.utc)
        run = Run(
            run_id=allocated_run_id,
            agent_id=agent_id,
            agent_type=normalized_agent_type,
            project_dir=resolve_project_dir(project_dir),
            task=task,
            created_at=now,
            updated_at=now,
        )
        self._runs[run.run_id] = run
        return run

    def get(self, run_id: str) -> Run:
        return self._runs[validate_run_id(run_id)]

    def update_status(self, run_id: str, status: RunStatus) -> Run:
        current = self.get(run_id)
        updated = Run(
            run_id=current.run_id,
            agent_id=current.agent_id,
            agent_type=current.agent_type,
            project_dir=current.project_dir,
            task=current.task,
            status=status,
            created_at=current.created_at,
            updated_at=datetime.now(timezone.utc),
        )
        self._runs[run_id] = updated
        return updated

    def list_runs(self) -> list[Run]:
        return list(self._runs.values())


def _normalize_agent_type(agent_type: str) -> str:
    normalized = agent_type.strip().lower()
    if normalized not in {"codex", "opencode", "claude"}:
        raise ValueError(f"Unsupported agent type: {agent_type!r}")
    return normalized

