"""FastAPI app wiring for the backend-only MVP."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from .adapters.base import AgentAdapter
from .adapters.codex import CodexAdapter
from .executor import ExecutionResult, RunExecutor
from .memory import HermesMemoryStore
from .runs import Run, RunRegistry


class MemoryStoreRequest(BaseModel):
    text: str = Field(min_length=1)


class SpawnAgentRequest(BaseModel):
    agent_type: str = "codex"
    project_dir: str
    task: str = Field(min_length=1)
    memory_query: str | None = None
    timeout_seconds: float | None = Field(default=None, gt=0)


def create_app(
    *,
    memory: HermesMemoryStore | None = None,
    registry: RunRegistry | None = None,
    executor: RunExecutor | None = None,
    adapters: dict[str, AgentAdapter] | None = None,
    execute_inline: bool = False,
) -> FastAPI:
    app = FastAPI(title="Context Workspace Backend")
    app.state.memory = memory or HermesMemoryStore()
    app.state.registry = registry or RunRegistry()
    app.state.executor = executor or RunExecutor(registry=app.state.registry)
    app.state.adapters = adapters or {"codex": CodexAdapter()}
    app.state.pool = ThreadPoolExecutor(max_workers=4)
    app.state.execute_inline = execute_inline

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/memory/hermes", response_class=PlainTextResponse)
    def hermes_memory(
        q: str = Query(default=""),
        agent_id: str | None = Query(default=None),
        limit: int = Query(default=10, ge=1, le=100),
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

    @app.post("/agents/spawn", status_code=202)
    def spawn_agent(request: SpawnAgentRequest, background_tasks: BackgroundTasks) -> dict[str, Any]:
        adapter = app.state.adapters.get(request.agent_type.strip().lower())
        if adapter is None:
            raise HTTPException(status_code=400, detail=f"Unsupported agent type: {request.agent_type}")

        try:
            run = app.state.registry.create_run(
                agent_type=request.agent_type,
                project_dir=request.project_dir,
                task=request.task,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        memory_query = request.memory_query or request.task
        memory_excerpt = app.state.memory.format_query_response(memory_query, limit=10)
        app.state.memory.append(f"[{run.agent_id}] Task: {run.task} | Status: pending")

        if app.state.execute_inline:
            _execute_and_record(app.state.executor, app.state.memory, run, adapter, memory_excerpt, request.timeout_seconds)
        else:
            background_tasks.add_task(
                app.state.pool.submit,
                _execute_and_record,
                app.state.executor,
                app.state.memory,
                run,
                adapter,
                memory_excerpt,
                request.timeout_seconds,
            )

        return {"run": _run_payload(run)}

    @app.get("/agents/runs/{run_id}")
    def get_run(run_id: str) -> dict[str, Any]:
        try:
            run = app.state.registry.get(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Run not found: {run_id}") from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"run": _run_payload(run)}

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
