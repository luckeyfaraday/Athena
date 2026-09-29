"""Agent CLI detection for the desktop Settings page."""

from __future__ import annotations

import os
import shutil
import threading
import time
from collections.abc import Mapping

# Agent CLIs Athena launches in visible terminals, keyed by agent type.
DEFAULT_AGENT_EXECUTABLES: dict[str, str] = {
    "codex": "codex",
    "opencode": "opencode",
    "claude": "claude",
    "grok": "grok",
    "athena": "athena-code",
}
# Each lookup walks PATH (x PATHEXT on Windows), so results are reused for a few
# minutes. Callers pass refresh=True after installing a CLI.
ADAPTER_STATUS_TTL_SECONDS = 300.0


def adapter_statuses(executables: Mapping[str, str] | None = None) -> dict[str, dict[str, object]]:
    """Report whether each supported agent CLI is installed on PATH."""
    resolved = {**DEFAULT_AGENT_EXECUTABLES, **(executables or {})}
    statuses: dict[str, dict[str, object]] = {}
    for agent_type, executable in resolved.items():
        command_path = shutil.which(executable)
        statuses[agent_type] = {
            "agent_type": agent_type,
            "configured": True,
            "executable": executable,
            "installed": command_path is not None,
            "command_path": command_path,
        }
    return statuses


class AdapterStatusCache:
    """Serve adapter_statuses() from a short-lived cache keyed on PATH/PATHEXT."""

    def __init__(
        self,
        executables: Mapping[str, str] | None = None,
        *,
        ttl_seconds: float = ADAPTER_STATUS_TTL_SECONDS,
    ) -> None:
        self._executables = dict(executables or {})
        self._ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        # (environment key, computed_at, statuses)
        self._cached: tuple[tuple[str, str], float, dict[str, dict[str, object]]] | None = None

    def get(self, *, refresh: bool = False) -> dict[str, dict[str, object]]:
        with self._lock:
            key = (os.environ.get("PATH", ""), os.environ.get("PATHEXT", ""))
            cached = self._cached
            if (
                not refresh
                and cached is not None
                and cached[0] == key
                and time.monotonic() - cached[1] < self._ttl_seconds
            ):
                statuses = cached[2]
            else:
                statuses = adapter_statuses(self._executables)
                self._cached = (key, time.monotonic(), statuses)
        # Hand out copies so a caller mutating its result cannot poison the cache.
        return {agent_type: dict(status) for agent_type, status in statuses.items()}
