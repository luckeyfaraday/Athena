from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse
from urllib.request import Request, urlopen

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


def get_electron_control_url(settings: Settings | None = None) -> str:
    settings = settings or Settings()
    if settings.electron_control_url:
        control_url = settings.electron_control_url.rstrip("/")
        healthy, detail = probe_electron_control_health(control_url, settings)
        if healthy:
            return control_url
        raise RuntimeError(
            "Context Workspace Electron control server is configured but not reachable. "
            f"{control_url}/health failed: {detail}. "
            "Restart Athena or reopen the desktop app before using visible terminal tools."
        )

    if settings.electron_control_state_path.exists():
        data = json.loads(settings.electron_control_state_path.read_text(encoding="utf-8"))
        url = data.get("baseUrl")
        running = data.get("running")
        if isinstance(url, str) and url.strip():
            control_url = _translate_backend_url_for_wsl(url.rstrip("/"), settings)
            healthy, detail = probe_electron_control_health(control_url, settings)
            if healthy:
                return control_url
            discovery_note = " Discovery file reports running:false." if running is False else ""
            raise RuntimeError(
                "Context Workspace Electron control server discovery is stale. "
                f"{settings.electron_control_state_path} points to {control_url}, but /health failed: {detail}.{discovery_note} "
                "Restart Athena or reopen the desktop app before using visible terminal tools."
            )

    raise RuntimeError("Context Workspace Electron control server is not available. Start the desktop app first.")


def get_electron_control_token(settings: Settings | None = None) -> str | None:
    """Return the shared secret the Electron control server requires.

    Prefers an explicit env override, then the token published in the 0600
    discovery file by the running desktop app. Returns None when neither is
    available (callers then send no Authorization header and the server rejects
    the request with 401, surfacing a clear "restart Athena" style error).
    """
    settings = settings or Settings()
    if settings.electron_control_token:
        return settings.electron_control_token
    try:
        if settings.electron_control_state_path.exists():
            data = json.loads(settings.electron_control_state_path.read_text(encoding="utf-8"))
            token = data.get("token")
            if isinstance(token, str) and token.strip():
                return token.strip()
    except (OSError, json.JSONDecodeError):
        return None
    return None


def get_electron_control_status(settings: Settings | None = None) -> dict[str, Any]:
    settings = settings or Settings()
    if settings.electron_control_url:
        url = settings.electron_control_url.rstrip("/")
        healthy, detail = probe_electron_control_health(url, settings)
        return {"configured": True, "baseUrl": url, "running": healthy, "stale": not healthy, "detail": detail}

    if not settings.electron_control_state_path.exists():
        return {
            "configured": False,
            "baseUrl": None,
            "running": False,
            "stale": False,
            "detail": f"Discovery file does not exist: {settings.electron_control_state_path}",
        }

    try:
        data = json.loads(settings.electron_control_state_path.read_text(encoding="utf-8"))
    except OSError as exc:
        return {"configured": False, "baseUrl": None, "running": False, "stale": False, "detail": str(exc)}

    url = data.get("baseUrl")
    running = data.get("running")
    if not isinstance(url, str) or not url.strip():
        return {"configured": False, "baseUrl": None, "running": False, "stale": False, "detail": "Discovery file has no baseUrl."}
    control_url = _translate_backend_url_for_wsl(url.rstrip("/"), settings)
    healthy, detail = probe_electron_control_health(control_url, settings)
    if running is False and not healthy:
        detail = f"{detail}. Discovery file reports running:false."
    return {"configured": True, "baseUrl": control_url, "running": healthy, "stale": not healthy, "detail": detail}


def probe_electron_control_health(base_url: str, settings: Settings | None = None) -> tuple[bool, str]:
    settings = settings or Settings()
    timeout = min(settings.request_timeout_seconds, 2.0)
    request = Request(f"{base_url.rstrip('/')}/health", method="GET")
    try:
        with urlopen(request, timeout=timeout) as response:
            status = getattr(response, "status", response.getcode())
            if 200 <= int(status) < 300:
                return True, "ok"
            return False, f"HTTP {status}"
    except Exception as exc:
        return False, str(exc)


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


class ContextWorkspaceElectronClient:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or Settings()
        self.base_url = get_electron_control_url(self.settings)
        self.headers = _control_auth_headers(get_electron_control_token(self.settings))

    async def get(self, path: str, **params: Any) -> Any:
        async with httpx.AsyncClient(timeout=self.settings.request_timeout_seconds) as client:
            response = await client.get(f"{self.base_url}{path}", params=_compact_params(params), headers=self.headers)
            response.raise_for_status()
            return response.json()

    async def post(self, path: str, json_body: dict[str, Any] | None = None) -> Any:
        async with httpx.AsyncClient(timeout=self.settings.request_timeout_seconds) as client:
            response = await client.post(f"{self.base_url}{path}", json=json_body or {}, headers=self.headers)
            response.raise_for_status()
            return response.json()


def _compact_params(params: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in params.items() if value is not None}


def _control_auth_headers(token: str | None) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"} if token else {}


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
