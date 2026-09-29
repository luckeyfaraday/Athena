"""FastAPI app wiring for the Athena desktop backend."""

from __future__ import annotations

import os
import re
import subprocess
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .agent_sessions import format_agent_sessions_summary, list_native_agent_sessions, read_agent_session_transcript
from .chat_messages import read_chat_messages
from .hermes import HermesManager
from .memory import HermesMemoryStore
from .runtime import AdapterStatusCache
from .safety import resolve_project_dir
from .usage import UsageService, create_default_usage_service


class MemoryStoreRequest(BaseModel):
    text: str = Field(min_length=1)
    project_dir: str | None = None


class MemoryDeleteRequest(BaseModel):
    text: str = Field(min_length=1)


class HermesInstallRequest(BaseModel):
    confirm: bool = False
    timeout_seconds: float = Field(default=600, gt=0, le=3600)


class HermesAskRequest(BaseModel):
    project_dir: str
    question: str = Field(min_length=1, max_length=20000)
    context: str | None = Field(default=None, max_length=100000)
    session_id: str | None = Field(default=None, max_length=200)
    timeout_seconds: float = Field(default=120, gt=0, le=600)


class UsageRefreshRequest(BaseModel):
    provider: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9_-]{0,31}$")
    account_key: str | None = Field(default=None, max_length=80)


ALL_SESSIONS_CACHE_TTL_SECONDS = float(os.environ.get("CONTEXT_WORKSPACE_SESSIONS_CACHE_TTL", "60"))
# The cache key includes the caller-supplied search query, so without a cap a
# client issuing many distinct queries would grow this dict without bound.
ALL_SESSIONS_CACHE_MAX_ENTRIES = 32


def create_app(
    *,
    memory: HermesMemoryStore | None = None,
    hermes: HermesManager | None = None,
    agent_executables: dict[str, str] | None = None,
    usage: UsageService | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        try:
            yield
        finally:
            # Stop scheduling usage probes and reap any codex app-server still running.
            application.state.usage.shutdown()

    app = FastAPI(title="Context Workspace Backend", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$",
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type"],
    )
    app.state.hermes = hermes or HermesManager()
    # Resolve memory from the configured Hermes home directly: status() probes
    # the Hermes executable, which must not block backend startup.
    app.state.memory = memory or HermesMemoryStore.from_hermes_home(app.state.hermes.hermes_home)
    app.state.adapter_statuses = AdapterStatusCache(agent_executables)
    app.state.all_sessions_cache = {}
    app.state.project_sessions_cache = {}
    # Both session endpoints traverse the same provider corpora. A shared lock
    # coalesces cold misses across project and all-workspace callers instead of
    # allowing each surface to duplicate the scan concurrently.
    app.state.session_scan_lock = threading.Lock()
    # Provider quota windows, shared by every client. Reads serve the cache and
    # schedule due probes in the background; credentials never leave the service.
    app.state.usage = usage or create_default_usage_service(
        codex_executable=(agent_executables or {}).get("codex"),
    )

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/hermes/status")
    def hermes_status(refresh: bool = Query(default=False)) -> dict[str, Any]:
        status = app.state.hermes.status(refresh=True) if refresh else app.state.hermes.status()
        return {"hermes": _hermes_status_payload(status)}

    @app.post("/hermes/install")
    def install_hermes(request: HermesInstallRequest) -> dict[str, Any]:
        if not request.confirm:
            raise HTTPException(
                status_code=400,
                detail="Set confirm=true to install Hermes Agent.",
            )
        try:
            result = app.state.hermes.install(timeout_seconds=request.timeout_seconds)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {
            "returncode": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "hermes": _hermes_status_payload(result.status),
        }

    @app.post("/hermes/ask")
    def ask_hermes(request: HermesAskRequest) -> dict[str, Any]:
        try:
            project = resolve_project_dir(request.project_dir)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        context = request.context.strip() if request.context and request.context.strip() else None
        try:
            result = app.state.hermes.ask(
                project_dir=project,
                question=request.question,
                context=context,
                session_id=request.session_id,
                timeout_seconds=request.timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            raise HTTPException(status_code=504, detail=f"Hermes ask timed out after {request.timeout_seconds:g}s.") from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except OSError as exc:
            raise HTTPException(status_code=503, detail=f"Hermes ask failed to start: {exc}") from exc
        return {
            "answer": result.answer,
            "project_dir": str(result.project_dir),
            "source": "hermes-oneshot",
            "returncode": result.returncode,
            "stderr": result.stderr,
        }

    @app.get("/memory/hermes", response_class=PlainTextResponse)
    def hermes_memory(
        q: str = Query(default=""),
        agent_id: str | None = Query(default=None),
        limit: int = Query(default=10, ge=1, le=1000),
    ) -> str:
        try:
            return app.state.memory.format_query_response(q, limit=limit)
        except OSError as exc:
            raise _memory_unavailable_exception(exc) from exc

    @app.get("/memory/hermes/project", response_class=PlainTextResponse)
    def hermes_project_memory(
        project_dir: str = Query(min_length=1),
        limit: int = Query(default=10, ge=1, le=100),
    ) -> str:
        try:
            return app.state.memory.format_project_context(project_dir, limit=limit)
        except OSError as exc:
            raise _memory_unavailable_exception(exc) from exc

    @app.get("/memory/recent")
    def recent_memory(limit: int = Query(default=10, ge=1, le=100)) -> dict[str, Any]:
        try:
            return {"entries": [entry.text for entry in app.state.memory.recent(limit=limit)]}
        except OSError as exc:
            raise _memory_unavailable_exception(exc) from exc

    @app.post("/memory/store")
    def store_memory(request: MemoryStoreRequest) -> dict[str, Any]:
        try:
            text = request.text
            project_dir = request.project_dir.strip() if request.project_dir else ""
            if project_dir:
                try:
                    project = resolve_project_dir(project_dir)
                except ValueError as exc:
                    raise HTTPException(status_code=400, detail=str(exc)) from exc
                text = _project_scoped_memory_text(project, text)
            entry = app.state.memory.append(text)
            return {"stored": True, "entry": entry.text}
        except OSError as exc:
            raise _memory_unavailable_exception(exc) from exc

    @app.post("/memory/delete")
    def delete_memory(request: MemoryDeleteRequest) -> dict[str, Any]:
        try:
            removed = app.state.memory.remove_exact(request.text)
            return {"deleted": removed > 0, "removed": removed}
        except OSError as exc:
            raise _memory_unavailable_exception(exc) from exc

    @app.get("/agents/adapters")
    def get_agent_adapters(refresh: bool = Query(default=False)) -> dict[str, Any]:
        return {"adapters": app.state.adapter_statuses.get(refresh=refresh)}

    @app.get("/agents/sessions")
    def list_agent_sessions(
        project_dir: str = Query(min_length=1),
        provider: str | None = Query(default=None),
        q: str = Query(default=""),
        limit: int = Query(default=100, ge=1, le=500),
        refresh: bool = Query(default=False),
    ) -> dict[str, Any]:
        try:
            project = _resolve_read_project_dir(project_dir)
            session_provider = _session_provider(provider)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        cache_key = (str(project), session_provider or "", q, limit)
        # Project-scoped MCP callers previously bypassed the only sessions
        # cache and could launch the same provider corpus scan concurrently.
        # Serialize cache misses so a burst coalesces into one bounded scan.
        with app.state.session_scan_lock:
            now = time.monotonic()
            cached = app.state.project_sessions_cache.get(cache_key)
            if (
                not refresh
                and cached is not None
                and now - cached["created_monotonic"] < ALL_SESSIONS_CACHE_TTL_SECONDS
            ):
                return dict(cached["payload"])
            sessions = list_native_agent_sessions(project, provider=session_provider, query=q, limit=limit)
            payload = {
                "project_dir": str(project),
                "sessions": [session.payload() for session in sessions],
                "summary": format_agent_sessions_summary(sessions),
            }
            app.state.project_sessions_cache[cache_key] = {"created_monotonic": now, "payload": payload}
            if len(app.state.project_sessions_cache) > ALL_SESSIONS_CACHE_MAX_ENTRIES:
                oldest_key = min(
                    app.state.project_sessions_cache,
                    key=lambda key: app.state.project_sessions_cache[key]["created_monotonic"],
                )
                del app.state.project_sessions_cache[oldest_key]
            return payload

    @app.get("/agents/sessions/all")
    def list_all_agent_sessions(
        provider: str | None = Query(default=None),
        q: str = Query(default=""),
        limit: int = Query(default=500, ge=1, le=500),
        refresh: bool = Query(default=False),
    ) -> dict[str, Any]:
        """List native sessions across every workspace, for project aggregation."""
        try:
            session_provider = _session_provider(provider)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        cache_key = (session_provider or "", q, limit)
        with app.state.session_scan_lock:
            # Recheck after acquiring the lock: another endpoint/request may
            # have populated the cache while this request was waiting.
            now = time.monotonic()
            cached = app.state.all_sessions_cache.get(cache_key)
            if (
                not refresh
                and cached is not None
                and now - cached["created_monotonic"] < ALL_SESSIONS_CACHE_TTL_SECONDS
            ):
                payload = dict(cached["payload"])
                payload["cache"] = {
                    "hit": True,
                    "ttl_seconds": ALL_SESSIONS_CACHE_TTL_SECONDS,
                    "age_seconds": now - cached["created_monotonic"],
                }
                return payload

            sessions = list_native_agent_sessions(None, provider=session_provider, query=q, limit=limit)
            payload = {
                "project_dir": None,
                "sessions": [session.payload() for session in sessions],
                "summary": format_agent_sessions_summary(sessions),
            }
            app.state.all_sessions_cache[cache_key] = {"created_monotonic": now, "payload": payload}
            if len(app.state.all_sessions_cache) > ALL_SESSIONS_CACHE_MAX_ENTRIES:
                oldest_key = min(
                    app.state.all_sessions_cache,
                    key=lambda key: app.state.all_sessions_cache[key]["created_monotonic"],
                )
                del app.state.all_sessions_cache[oldest_key]
            return {
                **payload,
                "cache": {"hit": False, "ttl_seconds": ALL_SESSIONS_CACHE_TTL_SECONDS, "age_seconds": 0.0},
            }

    @app.get("/agents/sessions/{provider}/{session_id}/transcript", response_class=PlainTextResponse)
    def get_agent_session_transcript(
        provider: str,
        session_id: str,
        max_bytes: int = Query(default=65536, ge=1, le=1048576),
        tail: bool = Query(default=True),
    ) -> str:
        try:
            session_provider = _session_provider(provider)
            if session_provider is None:
                raise ValueError("provider is required.")
            return read_agent_session_transcript(session_provider, session_id, max_bytes=max_bytes, tail=tail)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/agents/sessions/{provider}/{session_id}/chat")
    def get_agent_chat_messages(provider: str, session_id: str) -> dict[str, Any]:
        try:
            return read_chat_messages(provider, session_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/usage/accounts")
    def usage_accounts() -> dict[str, Any]:
        return app.state.usage.snapshot()

    @app.post("/usage/refresh")
    def refresh_usage(request: UsageRefreshRequest) -> dict[str, Any]:
        try:
            return app.state.usage.refresh(provider=request.provider, account_key=request.account_key)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Unknown usage account.") from exc

    return app


app = create_app()


def _memory_unavailable_exception(exc: OSError) -> HTTPException:
    return HTTPException(
        status_code=503,
        detail=f"Hermes memory is unavailable. Check Hermes status and memory path permissions: {exc}",
    )


def _project_scoped_memory_text(project: Path, text: str) -> str:
    stripped = text.strip()
    project_marker = f"Project {project}:"
    if stripped.startswith(project_marker):
        return stripped
    if str(project) in stripped:
        return stripped
    return f"{project_marker} {stripped}"


def _resolve_read_project_dir(project_dir: str) -> Path:
    try:
        return resolve_project_dir(project_dir)
    except ValueError:
        translated = _wsl_mount_to_windows_path(project_dir)
        if translated == project_dir:
            raise
        return resolve_project_dir(translated)


def _wsl_mount_to_windows_path(project_dir: str) -> str:
    if os.name != "nt":
        return project_dir
    match = re.match(r"^/mnt/([a-zA-Z])/(.+)$", project_dir.strip())
    if not match:
        return project_dir
    drive = match.group(1).upper()
    rest = match.group(2).replace("/", "\\")
    return f"{drive}:\\{rest}"


def _session_provider(provider: str | None) -> Any:
    if provider is None or not provider.strip():
        return None
    normalized = provider.strip().lower()
    if normalized not in {"codex", "opencode", "athena", "claude", "hermes", "grok"}:
        raise ValueError(f"Unsupported session provider: {provider}")
    return normalized


def _hermes_status_payload(status: Any) -> dict[str, Any]:
    return {
        "installed": status.installed,
        "command_path": status.command_path,
        "version": status.version,
        "hermes_home": str(status.hermes_home),
        "config_exists": status.config_exists,
        "memory_path": str(status.memory_path) if status.memory_path else None,
        "native_windows": status.native_windows,
        "install_supported": status.install_supported,
        "setup_required": status.setup_required,
        "message": status.message,
    }
