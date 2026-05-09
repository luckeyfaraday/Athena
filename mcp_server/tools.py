from __future__ import annotations

import asyncio
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from client import ContextWorkspaceClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.safety import SafetyError, resolve_project_dir


TERMINAL_STATUSES = {"succeeded", "failed", "cancelled"}


async def context_workspace_health() -> dict[str, Any]:
    """Check Context Workspace backend health."""
    return await ContextWorkspaceClient().get("/health")


async def context_workspace_hermes_status() -> dict[str, Any]:
    """Return Hermes installation and memory status as the backend sees it."""
    return await ContextWorkspaceClient().get("/hermes/status")


async def context_workspace_query_memory(query: str, limit: int = 10) -> str:
    """Query Hermes memory through the Context Workspace backend."""
    return await ContextWorkspaceClient().get("/memory/hermes", q=query, limit=limit)


async def context_workspace_query_project_memory(project_dir: str, limit: int = 10) -> str:
    """Return Hermes project memory for a project directory."""
    return await ContextWorkspaceClient().get("/memory/hermes/project", project_dir=project_dir, limit=limit)


async def context_workspace_store_memory(text: str) -> dict[str, Any]:
    """Append text to Hermes memory through Context Workspace."""
    return await ContextWorkspaceClient().post("/memory/store", {"text": text})


async def context_workspace_delete_memory(text: str) -> dict[str, Any]:
    """Delete exact matching text from Hermes memory through Context Workspace."""
    return await ContextWorkspaceClient().post("/memory/delete", {"text": text})


async def context_workspace_recent_memory(limit: int = 10) -> dict[str, Any]:
    """Return recent Hermes memory entries."""
    return await ContextWorkspaceClient().get("/memory/recent", limit=limit)


async def context_workspace_list_agent_sessions(
    project_dir: str,
    provider: str | None = None,
    query: str = "",
    limit: int = 100,
) -> dict[str, Any]:
    """List native Codex, OpenCode, and Claude Code sessions for a project."""
    return await ContextWorkspaceClient().get(
        "/agents/sessions",
        project_dir=project_dir,
        provider=provider,
        q=query,
        limit=limit,
    )


async def context_workspace_summarize_agent_sessions(
    project_dir: str,
    provider: str | None = None,
    query: str = "",
    limit: int = 25,
) -> str:
    """Return a compact text summary of native agent sessions for recall work."""
    payload = await context_workspace_list_agent_sessions(
        project_dir,
        provider=provider,
        query=query,
        limit=limit,
    )
    summary = payload.get("summary") if isinstance(payload, dict) else None
    return summary if isinstance(summary, str) else ""


async def context_workspace_spawn_agent(
    project_dir: str,
    task: str,
    agent_type: str = "codex",
    memory_query: str | None = None,
    timeout_seconds: float | None = None,
) -> dict[str, Any]:
    """Spawn a Context Workspace agent run."""
    return await ContextWorkspaceClient().post(
        "/agents/spawn",
        {
            "project_dir": project_dir,
            "task": task,
            "agent_type": agent_type,
            "memory_query": memory_query,
            "timeout_seconds": timeout_seconds,
        },
    )


async def context_workspace_list_runs() -> dict[str, Any]:
    """List Context Workspace agent runs."""
    return await ContextWorkspaceClient().get("/agents/runs")


async def context_workspace_get_run(run_id: str) -> dict[str, Any]:
    """Return a Context Workspace run and its artifact metadata."""
    return await ContextWorkspaceClient().get(f"/agents/runs/{run_id}")


async def context_workspace_cancel_run(run_id: str) -> dict[str, Any]:
    """Request cancellation for a Context Workspace run."""
    return await ContextWorkspaceClient().post(f"/agents/runs/{run_id}/cancel")


async def context_workspace_read_artifact(
    run_id: str,
    artifact_name: str,
    max_bytes: int = 65536,
    tail: bool = True,
) -> str:
    """Read a run artifact: context, stdout, stderr, or result."""
    return await ContextWorkspaceClient().get(
        f"/agents/runs/{run_id}/artifacts/{artifact_name}",
        max_bytes=max_bytes,
        tail=str(tail).lower(),
    )


async def context_workspace_wait_for_run(
    run_id: str,
    timeout_seconds: float = 600,
    poll_interval: float = 2,
) -> dict[str, Any]:
    """Poll a Context Workspace run until it reaches a terminal status."""
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    while True:
        payload = await context_workspace_get_run(run_id)
        status = payload.get("run", {}).get("status")
        if status in TERMINAL_STATUSES:
            return payload
        if asyncio.get_running_loop().time() >= deadline:
            return {"timed_out": True, **payload}
        await asyncio.sleep(poll_interval)


async def context_workspace_write_recall_cache(project_dir: str, markdown: str) -> dict[str, Any]:
    """Write Hermes session recall into the project's local recall cache."""
    project = _resolve_recall_project(project_dir)
    cache_dir = _recall_cache_dir(project)
    cache_dir.mkdir(parents=True, exist_ok=True)

    recall_path = cache_dir / "session-recall.md"
    metadata_path = cache_dir / "last-refresh.json"
    text = markdown.strip() + "\n" if markdown.strip() else ""
    recall_path.write_text(text, encoding="utf-8")
    metadata = {
        "refreshed_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "source": "hermes-session-search",
        "bytes": len(text.encode("utf-8")),
    }
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")

    return {"written": True, "path": str(recall_path), **metadata}


async def context_workspace_read_recall_cache(project_dir: str) -> dict[str, Any]:
    """Read the project's Hermes session recall cache."""
    recall_path = _recall_cache_dir(_resolve_recall_project(project_dir)) / "session-recall.md"
    if not recall_path.exists():
        return {"exists": False, "path": str(recall_path), "markdown": ""}
    markdown = recall_path.read_text(encoding="utf-8")
    return {
        "exists": True,
        "path": str(recall_path),
        "bytes": len(markdown.encode("utf-8")),
        "markdown": markdown,
    }


async def context_workspace_clear_recall_cache(project_dir: str) -> dict[str, Any]:
    """Clear the project's Hermes session recall cache."""
    cache_dir = _recall_cache_dir(_resolve_recall_project(project_dir))
    removed: list[str] = []
    for name in ("session-recall.md", "last-refresh.json", "control-state.json"):
        path = cache_dir / name
        if path.exists():
            path.unlink()
            removed.append(str(path))
    return {"cleared": True, "removed": removed}


def register_tools(mcp: Any) -> None:
    for tool in (
        context_workspace_health,
        context_workspace_hermes_status,
        context_workspace_query_memory,
        context_workspace_query_project_memory,
        context_workspace_store_memory,
        context_workspace_delete_memory,
        context_workspace_recent_memory,
        context_workspace_list_agent_sessions,
        context_workspace_summarize_agent_sessions,
        context_workspace_spawn_agent,
        context_workspace_list_runs,
        context_workspace_get_run,
        context_workspace_cancel_run,
        context_workspace_read_artifact,
        context_workspace_wait_for_run,
        context_workspace_write_recall_cache,
        context_workspace_read_recall_cache,
        context_workspace_clear_recall_cache,
    ):
        mcp.tool()(tool)


def _recall_cache_dir(project_dir: Path) -> Path:
    return project_dir / ".context-workspace" / "hermes"


def _resolve_recall_project(project_dir: str) -> Path:
    try:
        return resolve_project_dir(project_dir)
    except OSError as exc:
        raise SafetyError(f"Project directory cannot be resolved: {project_dir}") from exc
