from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

import httpx

from config import Settings

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def get_backend_url(settings: Settings | None = None) -> str:
    settings = settings or Settings()
    if settings.backend_url:
        return settings.backend_url.rstrip("/")

    if settings.backend_state_path.exists():
        data = json.loads(settings.backend_state_path.read_text(encoding="utf-8"))
        url = data.get("baseUrl")
        if isinstance(url, str) and url.strip():
            return _translate_backend_url_for_wsl(url.rstrip("/"), settings)

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


def _translate_backend_url_for_wsl(url: str, settings: Settings) -> str:
    """Translate Windows localhost discovery only for MCP servers running in WSL."""
    parsed = urlparse(url)
    if not _running_under_wsl() or parsed.hostname not in LOOPBACK_HOSTS:
        return url

    windows_host = settings.windows_host or _windows_host_from_resolv_conf()
    if not windows_host:
        return url

    netloc = windows_host
    if parsed.port:
        host = f"[{windows_host}]" if ":" in windows_host and not windows_host.startswith("[") else windows_host
        netloc = f"{host}:{parsed.port}"
    return urlunparse(parsed._replace(netloc=netloc))


def _running_under_wsl() -> bool:
    if os.environ.get("WSL_INTEROP") or os.environ.get("WSL_DISTRO_NAME"):
        return True

    osrelease = Path("/proc/sys/kernel/osrelease")
    try:
        return "microsoft" in osrelease.read_text(encoding="utf-8").lower()
    except OSError:
        return False


def _windows_host_from_resolv_conf(path: Path = Path("/etc/resolv.conf")) -> str | None:
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            parts = line.strip().split()
            if len(parts) == 2 and parts[0] == "nameserver":
                return parts[1]
    except OSError:
        return None
    return None

