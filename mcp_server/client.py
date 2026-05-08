from __future__ import annotations

import json
from typing import Any

import httpx

from config import Settings


def get_backend_url(settings: Settings | None = None) -> str:
    settings = settings or Settings()
    if settings.backend_url:
        return settings.backend_url.rstrip("/")

    if settings.backend_state_path.exists():
        data = json.loads(settings.backend_state_path.read_text(encoding="utf-8"))
        url = data.get("baseUrl")
        if isinstance(url, str) and url.strip():
            return url.rstrip("/")

    return settings.default_backend_url.rstrip("/")


class ContextWorkspaceClient:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or Settings()
        self.base_url = get_backend_url(self.settings)

    async def get(self, path: str, **params: Any) -> Any:
        async with httpx.AsyncClient(timeout=self.settings.request_timeout_seconds) as client:
            response = await client.get(f"{self.base_url}{path}", params=_compact_params(params))
            response.raise_for_status()
            content_type = response.headers.get("content-type", "")
            if "text/plain" in content_type:
                return response.text
            return response.json()

    async def post(self, path: str, json_body: dict[str, Any] | None = None) -> Any:
        async with httpx.AsyncClient(timeout=self.settings.request_timeout_seconds) as client:
            response = await client.post(f"{self.base_url}{path}", json=json_body or {})
            response.raise_for_status()
            return response.json()


def _compact_params(params: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in params.items() if value is not None}

