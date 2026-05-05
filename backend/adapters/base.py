"""Base protocol for CLI agent adapters."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from backend.context_artifacts import RunArtifacts
from backend.runs import Run


@dataclass(frozen=True)
class AdapterCommand:
    argv: list[str]
    cwd: Path
    stdin: str
    env: dict[str, str] = field(default_factory=dict)


class AgentAdapter(Protocol):
    agent_type: str

    def build_command(self, run: Run, artifacts: RunArtifacts) -> AdapterCommand:
        """Build the process command for a run without executing it."""

    def summarize_result(self, run: Run, artifacts: RunArtifacts) -> str:
        """Produce a compact summary from run artifacts."""

