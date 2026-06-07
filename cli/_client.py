"""Thin synchronous bridge to the existing async backend client.

The MCP server already owns backend discovery (the ``~/.context-workspace/
backend.json`` file), WSL localhost translation, and the HTTP plumbing in
``mcp_server/client.py``. Rather than re-implement any of that here — which is
exactly the kind of drift to avoid — the CLI puts ``mcp_server`` on ``sys.path``
and reuses ``ContextWorkspaceClient``. The only thing added is a synchronous
wrapper, because a CLI command is a one-shot call and ``asyncio.run`` per call
matches how the async client already opens a fresh ``httpx.AsyncClient`` each
time.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MCP_SERVER = ROOT / "mcp_server"
for entry in (str(ROOT), str(MCP_SERVER)):
    if entry not in sys.path:
        sys.path.insert(0, entry)

# Imported after the path wiring above so the bare ``from config import Settings``
# inside client.py resolves to mcp_server/config.py.
from client import ContextWorkspaceClient, get_backend_status  # noqa: E402
from config import Settings  # noqa: E402


def backend_status(backend_url: str | None = None) -> dict[str, Any]:
    """Probe-backed backend discovery status (running / stale / not configured),
    used to fail the TUI with an actionable message instead of a dead port."""
    settings = Settings(backend_url=backend_url) if backend_url else Settings()
    return get_backend_status(settings)


class Backend:
    """Synchronous facade over the shared async backend client."""

    def __init__(self, backend_url: str | None = None) -> None:
        settings = Settings(backend_url=backend_url) if backend_url else Settings()
        self._client = ContextWorkspaceClient(settings)

    @property
    def base_url(self) -> str:
        return self._client.base_url

    def get(self, path: str, **params: Any) -> Any:
        return asyncio.run(self._client.get(path, **params))

    def post(self, path: str, body: dict[str, Any] | None = None) -> Any:
        return asyncio.run(self._client.post(path, body))
