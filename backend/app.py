"""FastAPI app wiring for the backend-only MVP."""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
from fastapi.responses import PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .adapters.base import AgentAdapter
from .agent_sessions import format_agent_sessions_summary, list_native_agent_sessions, read_agent_session_transcript
from .adapters.codex import CodexAdapter
from .context_bundle import ContextBundleStore
from .context_artifacts import RunArtifacts
from .executor import ExecutionResult, RunExecutor
from .hermes import HermesManager
from .memory import HermesMemoryStore
from .runs import Run, RunRegistry, RunStatus
from .runtime import RuntimeLimits, adapter_statuses, check_runtime_limits
from .safety import resolve_project_dir


class MemoryStoreRequest(BaseModel):
    text: str = Field(min_length=1)
    project_dir: str | None = None


class MemoryDeleteRequest(BaseModel):
    text: str = Field(min_length=1)


class SpawnAgentRequest(BaseModel):
    agent_type: str = "codex"
    project_dir: str
    task: str = Field(min_length=1)
    memory_query: str | None = None
    timeout_seconds: float | None = Field(default=None, gt=0)


class HermesInstallRequest(BaseModel):
    confirm: bool = False
    timeout_seconds: float = Field(default=600, gt=0, le=3600)


class HermesAskRequest(BaseModel):
    project_dir: str
    question: str = Field(min_length=1, max_length=20000)
    context: str | None = Field(default=None, max_length=100000)
    timeout_seconds: float = Field(default=120, gt=0, le=600)


class HermesRecallRefreshRequest(BaseModel):
    project_dir: str
    task_hint: str | None = None
    timeout_seconds: float = Field(default=120, gt=0, le=600)


class HermesRecallWriteRequest(BaseModel):
    project_dir: str
    markdown: str = Field(min_length=1, max_length=131072)
    source: str = Field(default="athena-session-handoff", min_length=1, max_length=120)
    source_count: int | None = Field(default=None, ge=0, le=500)
    source_titles: list[str] = Field(default_factory=list, max_length=500)


class HermesRecallMarkUsedRequest(BaseModel):
    project_dir: str
    agent: str = Field(min_length=1, max_length=80)


class ContextBundleCreateRequest(BaseModel):
    project_dir: str
    mode: str = Field(pattern=r"^immersive(?:_curated)?$")
    agent: str = Field(min_length=1, max_length=80)
    task: str = Field(default="", max_length=20000)
    context: str = Field(default="", max_length=100000)


class ContextTurnRecordRequest(BaseModel):
    project_dir: str
    session_id: str = Field(min_length=1, max_length=200)
    agent: str = Field(min_length=1, max_length=80)
    mode: str = Field(pattern=r"^(?:clean|immersive)$")
    user_message: str = Field(min_length=1, max_length=100000)
    assistant_message: str = Field(min_length=1, max_length=200000)


RECALL_STALE_AFTER_SECONDS = 24 * 60 * 60
ALL_SESSIONS_CACHE_TTL_SECONDS = float(os.environ.get("CONTEXT_WORKSPACE_SESSIONS_CACHE_TTL", "60"))
# The cache key includes the caller-supplied search query, so without a cap a
# client issuing many distinct queries would grow this dict without bound.
ALL_SESSIONS_CACHE_MAX_ENTRIES = 32
HERMES_REFRESH_COMMAND_ENV = "CONTEXT_WORKSPACE_HERMES_REFRESH_CMD"
BACKEND_URL_ENV = "CONTEXT_WORKSPACE_BACKEND_URL"
BACKEND_PORT_ENV = "CONTEXT_WORKSPACE_BACKEND_PORT"


def create_app(
    *,
    memory: HermesMemoryStore | None = None,
    hermes: HermesManager | None = None,
    registry: RunRegistry | None = None,
    executor: RunExecutor | None = None,
    adapters: dict[str, AgentAdapter] | None = None,
    limits: RuntimeLimits | None = None,
    execute_inline: bool = False,
) -> FastAPI:
    app = FastAPI(title="Context Workspace Backend")
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$",
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type"],
    )
    app.state.hermes = hermes or HermesManager()
    app.state.memory = memory or HermesMemoryStore.from_hermes_home(app.state.hermes.status().hermes_home)
    app.state.registry = registry or RunRegistry()
    app.state.executor = executor or RunExecutor(registry=app.state.registry)
    app.state.context_bundles = ContextBundleStore()
    app.state.adapters = adapters or {"codex": CodexAdapter()}
    app.state.limits = limits or RuntimeLimits()
    app.state.pool = ThreadPoolExecutor(max_workers=4)
    app.state.execute_inline = execute_inline
    app.state.all_sessions_cache = {}

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/context/bundles")
    def create_context_bundle(request: ContextBundleCreateRequest) -> dict[str, Any]:
        try:
            project = resolve_project_dir(request.project_dir)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        try:
            memory_excerpt = app.state.memory.format_project_context(project, limit=10)
        except OSError:
            memory_excerpt = ""
        bundle = app.state.context_bundles.create(
            project,
            mode=request.mode,
            agent=request.agent,
            task=request.task,
            curated_context=request.context if request.mode == "immersive_curated" else "",
            memory_excerpt=memory_excerpt,
            recall_metadata=_recall_status_payload(project),
        )
        return {"bundle": bundle.payload()}

    @app.get("/context/bundles/{bundle_id}")
    def get_context_bundle(bundle_id: str, project_dir: str = Query(min_length=1)) -> dict[str, Any]:
        try:
            project = resolve_project_dir(project_dir)
            bundle = app.state.context_bundles.read(project, bundle_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"bundle": bundle.payload()}

    @app.post("/context/turns")
    def record_context_turn(request: ContextTurnRecordRequest) -> dict[str, Any]:
        try:
            project = resolve_project_dir(request.project_dir)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        turn = app.state.context_bundles.record_turn(
            project,
            session_id=request.session_id,
            agent=request.agent,
            mode=request.mode,
            user_message=request.user_message,
            assistant_message=request.assistant_message,
        )
        return {"turn": turn}

    @app.get("/hermes/status")
    def hermes_status() -> dict[str, Any]:
        return {"hermes": _hermes_status_payload(app.state.hermes.status())}

    @app.get("/hermes/recall/status")
    def hermes_recall_status(project_dir: str = Query(min_length=1)) -> dict[str, Any]:
        try:
            project = resolve_project_dir(project_dir)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"recall": _recall_status_payload(project)}

    @app.post("/hermes/recall/refresh")
    def refresh_hermes_recall(request: HermesRecallRefreshRequest) -> dict[str, Any]:
        try:
            project = resolve_project_dir(request.project_dir)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        command = os.environ.get(HERMES_REFRESH_COMMAND_ENV, "").strip()
        if not command:
            raise HTTPException(
                status_code=409,
                detail=f"Set {HERMES_REFRESH_COMMAND_ENV} to enable Hermes recall refresh.",
            )

        result = _run_recall_refresh_command(
            command,
            project_dir=project,
            task_hint=request.task_hint or "",
            timeout_seconds=request.timeout_seconds,
        )
        recall = _recall_status_payload(project)
        return {"refresh": result, "recall": recall}

    @app.post("/hermes/recall/write")
    def write_hermes_recall(request: HermesRecallWriteRequest) -> dict[str, Any]:
        try:
            project = resolve_project_dir(request.project_dir)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        markdown = request.markdown.strip()
        if not markdown:
            raise HTTPException(status_code=400, detail="Recall markdown cannot be empty.")

        recall = _write_recall_cache(
            project,
            markdown,
            source=request.source.strip(),
            source_count=request.source_count,
            source_titles=request.source_titles,
        )
        return {"recall": recall}

    @app.post("/hermes/recall/mark-used")
    def mark_hermes_recall_used(request: HermesRecallMarkUsedRequest) -> dict[str, Any]:
        try:
            project = resolve_project_dir(request.project_dir)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        recall = _mark_recall_used(project, agent=request.agent.strip())
        return {"recall": recall}

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

        recall_answer = _direct_recall_answer(project, request.question)
        if recall_answer is not None:
            return recall_answer

        context = _hermes_ask_context(project, request.context)
        try:
            result = app.state.hermes.ask(
                project_dir=project,
                question=request.question,
                context=context,
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
    def get_agent_adapters() -> dict[str, Any]:
        return {"adapters": adapter_statuses(app.state.adapters)}

    @app.get("/agents/sessions")
    def list_agent_sessions(
        project_dir: str = Query(min_length=1),
        provider: str | None = Query(default=None),
        q: str = Query(default=""),
        limit: int = Query(default=100, ge=1, le=500),
    ) -> dict[str, Any]:
        try:
            project = _resolve_read_project_dir(project_dir)
            session_provider = _session_provider(provider)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        sessions = list_native_agent_sessions(project, provider=session_provider, query=q, limit=limit)
        return {
            "project_dir": str(project),
            "sessions": [session.payload() for session in sessions],
            "summary": format_agent_sessions_summary(sessions),
        }

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

    @app.post("/agents/spawn", status_code=202)
    def spawn_agent(request: SpawnAgentRequest, background_tasks: BackgroundTasks) -> dict[str, Any]:
        agent_type = request.agent_type.strip().lower()
        adapter = app.state.adapters.get(agent_type)
        if adapter is None:
            raise HTTPException(status_code=400, detail=f"Unsupported agent type: {request.agent_type}")

        try:
            limit_decision = check_runtime_limits(
                app.state.registry,
                app.state.limits,
                project_dir=request.project_dir,
                agent_type=agent_type,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not limit_decision.allowed:
            raise HTTPException(status_code=429, detail=limit_decision.reason)

        try:
            run = app.state.registry.create_run(
                agent_type=agent_type,
                project_dir=request.project_dir,
                task=request.task,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        memory_excerpt = ""
        _try_append_memory(app.state.memory, f"[{run.agent_id}] Task: {run.task} | Status: pending")
        timeout_seconds = request.timeout_seconds
        if timeout_seconds is None:
            timeout_seconds = app.state.limits.default_timeout_seconds

        if app.state.execute_inline:
            _execute_and_record(app.state.executor, app.state.memory, run, adapter, memory_excerpt, timeout_seconds)
        else:
            background_tasks.add_task(
                app.state.pool.submit,
                _execute_and_record,
                app.state.executor,
                app.state.memory,
                run,
                adapter,
                memory_excerpt,
                timeout_seconds,
            )

        return {"run": _run_payload(run)}

    @app.get("/agents/runs")
    def list_runs() -> dict[str, Any]:
        return {"runs": [_run_payload(run) for run in app.state.registry.list_runs()]}

    @app.get("/agents/runs/{run_id}")
    def get_run(run_id: str) -> dict[str, Any]:
        run = _get_run_or_404(app.state.registry, run_id)
        artifacts = app.state.executor.artifacts.paths_for(run)
        return {"run": _run_payload(run), "artifacts": _artifacts_payload(run.run_id, artifacts)}

    @app.post("/agents/runs/{run_id}/cancel")
    def cancel_run(run_id: str) -> dict[str, Any]:
        run = _get_run_or_404(app.state.registry, run_id)
        if run.status in {RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED}:
            return {"cancelled": False, "run": _run_payload(run)}

        updated = app.state.registry.request_cancel(run.run_id)
        terminated = app.state.executor.cancel(run.run_id)
        _try_append_memory(app.state.memory, f"[{updated.agent_id}] cancellation requested for task: {updated.task}")
        return {"cancelled": True, "terminated_process": terminated, "run": _run_payload(updated)}

    @app.get("/agents/runs/{run_id}/artifacts/{artifact_name}", response_class=PlainTextResponse)
    def get_run_artifact(
        run_id: str,
        artifact_name: str,
        max_bytes: int = Query(default=65536, ge=1, le=1048576),
        tail: bool = Query(default=True),
    ) -> str:
        run = _get_run_or_404(app.state.registry, run_id)
        artifacts = app.state.executor.artifacts.paths_for(run)
        path = _artifact_path(artifacts, artifact_name)
        if path is None:
            raise HTTPException(status_code=404, detail=f"Unknown artifact: {artifact_name}")
        if not path.exists():
            raise HTTPException(status_code=404, detail=f"Artifact not found: {artifact_name}")
        return _read_bounded_text(path, max_bytes=max_bytes, tail=tail)

    return app


app = create_app()


def _execute_and_record(
    executor: RunExecutor,
    memory: HermesMemoryStore,
    run: Run,
    adapter: AgentAdapter,
    memory_excerpt: str,
    timeout_seconds: float | None,
) -> ExecutionResult:
    try:
        result = executor.execute(
            run,
            adapter,
            memory_excerpt=memory_excerpt,
            timeout_seconds=timeout_seconds,
        )
    except Exception as exc:
        # Last-resort backstop: this runs on the thread pool, where the
        # submitted Future is never inspected, so an escaping exception would
        # vanish and leave the run active forever.
        failed = executor.registry.fail(run.run_id, str(exc))
        _try_append_memory(
            memory,
            f"[{failed.agent_id}] failed task: {failed.task} | Error: {exc}",
        )
        raise
    _try_append_memory(
        memory,
        f"[{result.run.agent_id}] completed task: {result.run.task} | "
        f"Status: {result.run.status.value} | Summary: {result.summary}",
    )
    return result


def _memory_unavailable_exception(exc: OSError) -> HTTPException:
    return HTTPException(
        status_code=503,
        detail=f"Hermes memory is unavailable. Check Hermes status and memory path permissions: {exc}",
    )


def _try_append_memory(memory: HermesMemoryStore, text: str) -> None:
    try:
        memory.append(text)
    except OSError:
        return


def _project_scoped_memory_text(project: Path, text: str) -> str:
    stripped = text.strip()
    project_marker = f"Project {project}:"
    if stripped.startswith(project_marker):
        return stripped
    if str(project) in stripped:
        return stripped
    return f"{project_marker} {stripped}"


def _run_payload(run: Run) -> dict[str, Any]:
    payload = asdict(run)
    payload["project_dir"] = str(run.project_dir)
    payload["status"] = run.status.value
    for key in ("created_at", "updated_at"):
        value = payload[key]
        if isinstance(value, datetime):
            payload[key] = value.isoformat()
    return payload


def _get_run_or_404(registry: RunRegistry, run_id: str) -> Run:
    try:
        return registry.get(run_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Run not found: {run_id}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _artifacts_payload(run_id: str, artifacts: RunArtifacts) -> dict[str, Any]:
    return {
        name: {
            "name": name,
            "exists": path.exists(),
            "size_bytes": path.stat().st_size if path.exists() else 0,
            "url": f"/agents/runs/{run_id}/artifacts/{name}",
        }
        for name, path in _artifact_paths(artifacts).items()
    }


def _artifact_paths(artifacts: RunArtifacts) -> dict[str, Path]:
    return {
        "context": artifacts.context,
        "stdout": artifacts.stdout,
        "stderr": artifacts.stderr,
        "result": artifacts.result,
    }


def _artifact_path(artifacts: RunArtifacts, artifact_name: str) -> Path | None:
    return _artifact_paths(artifacts).get(artifact_name.strip().lower())


def _read_bounded_text(path: Path, *, max_bytes: int, tail: bool) -> str:
    size = path.stat().st_size
    with path.open("rb") as handle:
        if tail and size > max_bytes:
            handle.seek(size - max_bytes)
        data = handle.read(max_bytes)
    return data.decode("utf-8", errors="replace")


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
    if normalized not in {"codex", "opencode", "claude", "hermes"}:
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


def _recall_status_payload(project_dir: Path) -> dict[str, Any]:
    cache_dir = project_dir / ".context-workspace" / "hermes"
    recall_path = cache_dir / "session-recall.md"
    metadata_path = cache_dir / "last-refresh.json"
    exists = recall_path.exists()
    metadata = _read_json_object(metadata_path)
    refreshed_at = _metadata_refreshed_at(metadata)
    now = datetime.now(timezone.utc)
    age_seconds = max(0.0, (now - refreshed_at).total_seconds()) if refreshed_at else None
    stale = not exists or refreshed_at is None or (age_seconds is not None and age_seconds > RECALL_STALE_AFTER_SECONDS)
    if not exists:
        status = "missing"
    elif stale:
        status = "stale"
    else:
        status = "fresh"
    return {
        "project_dir": str(project_dir),
        "exists": exists,
        "status": status,
        "stale": stale,
        "path": str(recall_path),
        "metadata_path": str(metadata_path),
        "bytes": recall_path.stat().st_size if exists else 0,
        "refreshed_at": refreshed_at.isoformat().replace("+00:00", "Z") if refreshed_at else None,
        "age_seconds": age_seconds,
        "stale_after_seconds": RECALL_STALE_AFTER_SECONDS,
        "source": metadata.get("source") if isinstance(metadata.get("source"), str) else None,
        "source_count": metadata.get("source_count") if isinstance(metadata.get("source_count"), int) else None,
        "source_titles": metadata.get("source_titles") if isinstance(metadata.get("source_titles"), list) else [],
        "used_for_launch_at": metadata.get("used_for_launch_at") if isinstance(metadata.get("used_for_launch_at"), str) else None,
        "last_launch_agent": metadata.get("last_launch_agent") if isinstance(metadata.get("last_launch_agent"), str) else None,
        "refresh_configured": bool(os.environ.get(HERMES_REFRESH_COMMAND_ENV, "").strip()),
    }


def _direct_recall_answer(project_dir: Path, question: str) -> dict[str, Any] | None:
    if not _looks_like_recall_context_request(question):
        return None

    status = _recall_status_payload(project_dir)
    recall = _read_recall_markdown(project_dir)
    if not recall:
        answer = (
            f"No Athena session recall cache exists for `{project_dir}` yet. "
            "Refresh session recall from Athena/Hermes first, then ask again."
        )
    else:
        answer = "\n\n".join(
            [
                f"Athena session recall cache for `{project_dir}`:",
                recall,
            ]
        )
    return {
        "answer": answer,
        "project_dir": str(project_dir),
        "source": "athena-recall-cache",
        "returncode": 0,
        "stderr": "",
        "recall": status,
    }


def _looks_like_recall_context_request(question: str) -> bool:
    normalized = question.strip().lower()
    if not normalized:
        return False
    has_recall = "session recall" in normalized or "recall cache" in normalized or "athena recall" in normalized
    has_context_intent = any(
        token in normalized
        for token in ("context", "use", "read", "show", "get", "summarize", "summarise", "refresh")
    )
    return has_recall and has_context_intent


def _hermes_ask_context(project_dir: Path, context: str | None) -> str | None:
    parts: list[str] = []
    recall = _read_recall_markdown(project_dir)
    if recall:
        parts.extend(
            [
                "Athena session recall cache for this workspace:",
                _bounded_text(recall, max_chars=12000),
            ]
        )
    if context and context.strip():
        parts.extend(["Caller-provided context:", context.strip()])
    return "\n\n".join(parts) if parts else None


def _read_recall_markdown(project_dir: Path) -> str:
    recall_path = project_dir / ".context-workspace" / "hermes" / "session-recall.md"
    if not recall_path.exists():
        return ""
    try:
        return recall_path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _bounded_text(text: str, *, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return "[truncated]\n" + text[-max_chars:]


def _write_recall_cache(
    project_dir: Path,
    markdown: str,
    *,
    source: str,
    source_count: int | None = None,
    source_titles: list[str] | None = None,
) -> dict[str, Any]:
    cache_dir = project_dir / ".context-workspace" / "hermes"
    cache_dir.mkdir(parents=True, exist_ok=True)
    recall_path = cache_dir / "session-recall.md"
    metadata_path = cache_dir / "last-refresh.json"
    text = markdown.rstrip() + "\n"
    written_bytes = len(text.encode("utf-8"))
    metadata = {
        "refreshed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": source or "athena-session-handoff",
        "bytes": written_bytes,
    }
    if source_count is not None:
        metadata["source_count"] = source_count
    if source_titles:
        metadata["source_titles"] = [str(title)[:160] for title in source_titles[:20]]
    _atomic_write_text(recall_path, text)
    _atomic_write_text(metadata_path, json.dumps(metadata, indent=2) + "\n")
    return _recall_status_payload(project_dir)


def _mark_recall_used(project_dir: Path, *, agent: str) -> dict[str, Any]:
    cache_dir = project_dir / ".context-workspace" / "hermes"
    metadata_path = cache_dir / "last-refresh.json"
    metadata = _read_json_object(metadata_path)
    metadata["used_for_launch_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    metadata["last_launch_agent"] = agent
    cache_dir.mkdir(parents=True, exist_ok=True)
    _atomic_write_text(metadata_path, json.dumps(metadata, indent=2) + "\n")
    return _recall_status_payload(project_dir)


def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
            temporary_path = Path(handle.name)
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()


def _read_json_object(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _metadata_refreshed_at(metadata: dict[str, Any]) -> datetime | None:
    value = metadata.get("refreshed_at")
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _run_recall_refresh_command(
    command: str,
    *,
    project_dir: Path,
    task_hint: str,
    timeout_seconds: float,
) -> dict[str, Any]:
    env = {
        **os.environ,
        "CONTEXT_WORKSPACE_PROJECT_DIR": str(project_dir),
        "CONTEXT_WORKSPACE_TASK_HINT": task_hint,
    }
    if BACKEND_URL_ENV not in env:
        port = env.get(BACKEND_PORT_ENV, "8000")
        env[BACKEND_URL_ENV] = f"http://127.0.0.1:{port}"
    try:
        completed = subprocess.run(
            command,
            cwd=project_dir,
            env=env,
            shell=True,
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail=f"Hermes recall refresh timed out after {timeout_seconds:g}s.") from exc
    except OSError as exc:
        raise HTTPException(status_code=502, detail=f"Hermes recall refresh failed to start: {exc}") from exc

    payload = {
        "configured": True,
        "returncode": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
    }
    if completed.returncode != 0:
        raise HTTPException(status_code=502, detail=payload)
    return payload
