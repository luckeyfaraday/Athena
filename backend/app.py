"""FastAPI app wiring for the backend-only MVP."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
from fastapi.responses import PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .adapters.base import AgentAdapter
from .adapters.codex import CodexAdapter
from .context_artifacts import RunArtifacts
from .executor import ExecutionResult, RunExecutor
from .hermes import HermesManager
from .memory import HermesMemoryStore
from .runs import Run, RunRegistry, RunStatus
from .runtime import RuntimeLimits, adapter_statuses, check_runtime_limits


class MemoryStoreRequest(BaseModel):
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
    app.state.adapters = adapters or {"codex": CodexAdapter()}
    app.state.limits = limits or RuntimeLimits()
    app.state.pool = ThreadPoolExecutor(max_workers=4)
    app.state.execute_inline = execute_inline

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/hermes/status")
    def hermes_status() -> dict[str, Any]:
        return {"hermes": _hermes_status_payload(app.state.hermes.status())}

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

    @app.get("/memory/hermes", response_class=PlainTextResponse)
    def hermes_memory(
        q: str = Query(default=""),
        agent_id: str | None = Query(default=None),
        limit: int = Query(default=10, ge=1, le=1000),
    ) -> str:
        response = app.state.memory.format_query_response(q, limit=limit)
        if q.strip():
            app.state.memory.log_query(agent_id, q)
        return response

    @app.get("/memory/recent")
    def recent_memory(limit: int = Query(default=10, ge=1, le=100)) -> dict[str, Any]:
        return {"entries": [entry.text for entry in app.state.memory.recent(limit=limit)]}

    @app.post("/memory/store")
    def store_memory(request: MemoryStoreRequest) -> dict[str, Any]:
        entry = app.state.memory.append(request.text)
        return {"stored": True, "entry": entry.text}

    @app.get("/agents/adapters")
    def get_agent_adapters() -> dict[str, Any]:
        return {"adapters": adapter_statuses(app.state.adapters)}

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

        memory_query = request.memory_query or request.task
        memory_excerpt = app.state.memory.format_query_response(memory_query, limit=10)
        app.state.memory.append(f"[{run.agent_id}] Task: {run.task} | Status: pending")
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
        app.state.memory.append(f"[{updated.agent_id}] cancellation requested for task: {updated.task}")
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
    result = executor.execute(
        run,
        adapter,
        memory_excerpt=memory_excerpt,
        timeout_seconds=timeout_seconds,
    )
    memory.append(
        f"[{result.run.agent_id}] completed task: {result.run.task} | "
        f"Status: {result.run.status.value} | Summary: {result.summary}"
    )
    return result


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
