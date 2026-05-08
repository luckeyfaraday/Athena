from __future__ import annotations

import os
from pathlib import Path

from pydantic import BaseModel


class Settings(BaseModel):
    backend_url: str | None = os.environ.get("CONTEXT_WORKSPACE_BACKEND_URL")
    backend_state_path: Path = Path(
        os.environ.get("CONTEXT_WORKSPACE_BACKEND_STATE", Path.home() / ".context-workspace" / "backend.json")
    )
    default_backend_url: str = "http://127.0.0.1:8000"
    request_timeout_seconds: float = float(os.environ.get("CONTEXT_WORKSPACE_MCP_HTTP_TIMEOUT", "60"))

