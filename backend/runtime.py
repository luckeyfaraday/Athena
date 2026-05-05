"""Runtime policy helpers for agent orchestration."""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path

from .adapters.base import AgentAdapter
from .runs import RunRegistry


@dataclass(frozen=True)
class RuntimeLimits:
    max_global: int = 4
    max_per_project: int = 2
    max_per_agent_type: dict[str, int] = field(default_factory=lambda: {"codex": 2})
    default_timeout_seconds: float | None = 600


@dataclass(frozen=True)
class LimitDecision:
    allowed: bool
    reason: str | None = None


def check_runtime_limits(
    registry: RunRegistry,
    limits: RuntimeLimits,
    *,
    project_dir: str | Path,
    agent_type: str,
) -> LimitDecision:
    if registry.active_count() >= limits.max_global:
        return LimitDecision(False, f"Global concurrency limit reached: {limits.max_global}")
    if registry.active_count(project_dir=project_dir) >= limits.max_per_project:
        return LimitDecision(False, f"Project concurrency limit reached: {limits.max_per_project}")

    agent_limit = limits.max_per_agent_type.get(agent_type.strip().lower())
    if agent_limit is not None and registry.active_count(agent_type=agent_type) >= agent_limit:
        return LimitDecision(False, f"Agent-type concurrency limit reached for {agent_type}: {agent_limit}")

    return LimitDecision(True)


def adapter_statuses(adapters: dict[str, AgentAdapter]) -> dict[str, dict[str, object]]:
    statuses = {}
    for agent_type in ("codex", "opencode", "claude"):
        adapter = adapters.get(agent_type)
        executable = getattr(adapter, "executable", agent_type) if adapter is not None else agent_type
        command_path = shutil.which(str(executable))
        statuses[agent_type] = {
            "agent_type": agent_type,
            "configured": adapter is not None,
            "executable": str(executable),
            "installed": command_path is not None,
            "command_path": command_path,
        }
    return statuses
