from __future__ import annotations

import asyncio
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from client import ContextWorkspaceClient, ContextWorkspaceElectronClient, get_electron_control_status

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.safety import SafetyError, resolve_project_dir


TERMINAL_STATUSES = {"succeeded", "failed", "cancelled"}


async def context_workspace_health() -> dict[str, Any]:
    """Check Context Workspace backend and Electron control health."""
    backend = await ContextWorkspaceClient().get("/health")
    return {
        "backend": backend,
        "electron_control": get_electron_control_status(),
    }


async def context_workspace_hermes_status() -> dict[str, Any]:
    """Return Hermes installation and memory status as the backend sees it."""
    return await ContextWorkspaceClient().get("/hermes/status")


async def context_workspace_query_memory(query: str, limit: int = 10) -> str:
    """Query Hermes memory through the Context Workspace backend."""
    return await ContextWorkspaceClient().get("/memory/hermes", q=query, limit=limit)


async def context_workspace_query_project_memory(project_dir: str, limit: int = 10) -> str:
    """Return Hermes project memory for a project directory.

    Use this when the current workspace/project is the context. Pass the real
    project directory path, not the user's question.
    """
    return await ContextWorkspaceClient().get("/memory/hermes/project", project_dir=project_dir, limit=limit)


async def context_workspace_create_context_bundle(
    project_dir: str,
    agent: str,
    mode: str = "immersive",
    task: str = "",
    context: str = "",
) -> dict[str, Any]:
    """Create an immutable opt-in Athena immersive context bundle.

    mode must be immersive or immersive_curated. Ordinary agent launches do
    not create or receive context bundles.
    """
    return await ContextWorkspaceClient().post(
        "/context/bundles",
        {
            "project_dir": project_dir,
            "agent": agent,
            "mode": mode,
            "task": task,
            "context": context,
        },
    )


async def context_workspace_get_context_bundle(project_dir: str, bundle_id: str) -> dict[str, Any]:
    """Read one immutable Athena context bundle by workspace and bundle id."""
    return await ContextWorkspaceClient().get(
        f"/context/bundles/{bundle_id}",
        project_dir=project_dir,
    )


async def context_workspace_ask_hermes(
    project_dir: str,
    question: str,
    context: str | None = None,
    timeout_seconds: float = 120,
) -> dict[str, Any]:
    """Ask Hermes directly and return its final answer.

    Use this for request/response questions such as "ask Hermes ...". This is
    not visible terminal steering: it runs Hermes in one-shot mode and returns a
    structured answer. Use context_workspace_inject_terminal_input only when the
    user wants a live visible Hermes terminal or cross-agent handoff.
    """
    return await ContextWorkspaceClient().post(
        "/hermes/ask",
        {
            "project_dir": project_dir,
            "question": question,
            "context": context,
            "timeout_seconds": timeout_seconds,
        },
    )


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
    """List native Codex, OpenCode, Athena Code, Claude Code, and Hermes sessions for a project."""
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


async def context_workspace_open_workspace(project_dir: str, select: bool = True) -> dict[str, Any]:
    """Open/add a workspace folder in the Athena desktop UI.

    Use this before visible terminal spawning when the user asks Hermes to work
    in a project that is not already open in Athena. The desktop app must be
    running because this routes through Athena's Electron control server.
    """
    return await ContextWorkspaceElectronClient().post(
        "/workspaces/open",
        {
            "project_dir": project_dir,
            "select": select,
        },
    )


async def context_workspace_spawn_agent(
    project_dir: str,
    task: str,
    agent_type: str = "codex",
    memory_query: str | None = None,
    timeout_seconds: float | None = None,
    visible_terminal: bool = True,
    context_mode: str = "task",
    context: str | None = None,
    open_workspace: bool = False,
) -> dict[str, Any]:
    """Spawn Codex/OpenCode/Claude/Athena Code as a visible Athena terminal by default.

    This is the high-level tool Hermes should use when the user asks to start
    an agent. agent_type accepts codex, opencode, claude, athena/athena-code,
    or hermes. It routes through Athena's Electron control server, so the
    desktop app must be running. Visible spawns no longer receive Athena
    recall/memory automatically. Use context_mode=\"immersive\" or
    \"immersive_curated\" only when the user explicitly requests Athena's full
    context mode. Use context_mode=\"task\" for a compact task-only prompt,
    \"curated\" for only caller-selected background, or \"none\" for a clean
    launch. Set open_workspace=true when the target project is not already open
    in Athena. Set visible_terminal=false only for the legacy backend
    run/artifact path.
    """
    normalized_agent = _terminal_kind_for_agent(agent_type)
    if visible_terminal:
        return {
            "mode": "visible_terminal",
            **await context_workspace_spawn_terminal(
                project_dir=project_dir,
                kind=normalized_agent,
                count=1,
                title=_title_for_task(normalized_agent, task),
                session_label="New",
                task=task,
                context_mode=context_mode,
                context=context,
                open_workspace=open_workspace,
            ),
        }

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


async def context_workspace_spawn_terminal(
    project_dir: str,
    kind: str = "codex",
    count: int = 1,
    title: str | None = None,
    task: str | None = None,
    resume_session_id: str | None = None,
    session_label: str | None = None,
    context_mode: str | None = None,
    context: str | None = None,
    open_workspace: bool = False,
) -> dict[str, Any]:
    """Low-level visible terminal spawner using Athena's Electron control server.

    kind accepts shell, hermes, codex, opencode, claude, athena, or athena-code.
    context_mode accepts: none, task, curated, immersive, immersive_curated.
    Manual/clean launches should use none. Immersive modes are explicit opt-in.
    Set open_workspace=true to add/select the target workspace before spawning.
    """
    normalized_kind = _terminal_kind_for_terminal(kind)
    return await ContextWorkspaceElectronClient().post(
        "/terminals/spawn",
        {
            "project_dir": project_dir,
            "kind": normalized_kind,
            "count": count,
            "title": title,
            "task": task,
            "resume_session_id": resume_session_id,
            "session_label": session_label,
            "context_mode": context_mode,
            "context": context,
            "open_workspace": open_workspace,
        },
    )


async def context_workspace_spawn_terminals_batch(
    project_dir: str,
    specs: list[dict[str, Any]],
    open_workspace: bool = False,
) -> dict[str, Any]:
    """Spawn multiple visible Athena terminals with one MCP call.

    Use this when a task needs several agents at once, for example two
    OpenCode panes and one Athena Code pane. Each spec accepts kind, count, title,
    task, resume_session_id, session_label, context_mode, and context. Athena
    groups compatible same-provider specs into count-based spawn calls where
    possible and returns every created terminal id in one response. Set
    open_workspace=true to add/select the target workspace before spawning.
    """
    if not specs:
        raise ValueError("specs must include at least one terminal request.")

    grouped_requests = _group_batch_spawn_specs(specs)
    opened_workspace = await context_workspace_open_workspace(project_dir) if open_workspace else None
    results: list[dict[str, Any]] = []
    sessions: list[dict[str, Any]] = []
    for request in grouped_requests:
        payload = await context_workspace_spawn_terminal(project_dir=project_dir, **request)
        result_sessions = payload.get("sessions") if isinstance(payload, dict) else []
        if isinstance(result_sessions, list):
            sessions.extend([session for session in result_sessions if isinstance(session, dict)])
        results.append({"request": request, "result": payload})
    return {
        "mode": "visible_terminal_batch",
        "requested": specs,
        "spawn_calls": len(grouped_requests),
        "opened_workspace": opened_workspace,
        "sessions": sessions,
        "results": results,
    }


async def context_workspace_list_live_terminals(project_dir: str | None = None) -> dict[str, Any]:
    """List visible live Athena PTY sessions managed by the desktop app."""
    payload = await ContextWorkspaceElectronClient().get("/terminals")
    if not project_dir:
        return payload
    project = str(_resolve_recall_project(project_dir))
    terminals = payload.get("terminals") if isinstance(payload, dict) else []
    if not isinstance(terminals, list):
        return {"terminals": []}
    return {
        "terminals": [
            terminal
            for terminal in terminals
            if isinstance(terminal, dict) and terminal.get("workspace") == project
        ]
    }


async def context_workspace_kill_terminal(target: str) -> dict[str, Any]:
    """Kill a live Athena PTY by terminal id or provider session id.

    Use context_workspace_list_live_terminals first to find the target. This
    removes the terminal from Athena's restore state and stops its process.
    """
    return await ContextWorkspaceElectronClient().post(
        "/terminals/kill",
        {
            "target": target,
        },
    )


async def context_workspace_close_workspace(project_dir: str) -> dict[str, Any]:
    """Close a workspace tab in Athena and kill its live embedded terminals."""
    return await ContextWorkspaceElectronClient().post(
        "/workspaces/close",
        {
            "project_dir": project_dir,
        },
    )


async def context_workspace_inject_terminal_input(
    target: str,
    text: str,
) -> dict[str, Any]:
    """Submit input to a live Athena PTY by terminal id or provider session id.

    Use this for agent-to-agent conversations: first call
    context_workspace_list_live_terminals to find the target terminal id (e.g.
    Hermes), then inject a message. Include the caller's own terminal id from
    the CONTEXT_WORKSPACE_TERMINAL_ID env var so the recipient can inject its
    response back. The desktop app must be running because this routes through
    Athena's Electron control server.
    """
    return await ContextWorkspaceElectronClient().post(
        "/terminals/write",
        {
            "target": target,
            "text": text,
        },
    )


async def context_workspace_send_message(
    to: str,
    text: str,
    project_dir: str | None = None,
    from_terminal_id: str | None = None,
    thread_id: str | None = None,
    reply_requested: bool = True,
    hop_count: int = 0,
) -> dict[str, Any]:
    """Send a structured Athena agent message to a live terminal.

    Prefer this over context_workspace_inject_terminal_input for agent-to-agent
    communication. Athena records the message in its server-side message store,
    stamps a structured envelope, resolves stable handles such as codex#1 or
    claude#1, and queues instead of injecting when the target appears busy.
    Pass project_dir to scope handles and CONTEXT_WORKSPACE_TERMINAL_ID as
    from_terminal_id when available.
    """
    return await ContextWorkspaceElectronClient().post(
        "/agent-messages/send",
        {
            "to": to,
            "text": text,
            "project_dir": project_dir,
            "from_terminal_id": from_terminal_id,
            "thread_id": thread_id,
            "reply_requested": reply_requested,
            "hop_count": hop_count,
        },
    )


async def context_workspace_list_messages(
    project_dir: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    """List Athena's recent structured agent messages."""
    params: dict[str, Any] = {"limit": limit}
    if project_dir:
        params["project_dir"] = project_dir
    return await ContextWorkspaceElectronClient().get("/agent-messages", **params)


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
    """Read legacy backend run artifacts; OpenCode ses_* IDs fall back to session transcripts."""
    try:
        return await ContextWorkspaceClient().get(
            f"/agents/runs/{run_id}/artifacts/{artifact_name}",
            max_bytes=max_bytes,
            tail=str(tail).lower(),
        )
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code in {400, 404} and run_id.startswith("ses_"):
            return await context_workspace_read_agent_session("opencode", run_id, max_bytes=max_bytes, tail=tail)
        raise


async def context_workspace_read_agent_session(
    provider: str,
    session_id: str,
    max_bytes: int = 65536,
    tail: bool = True,
) -> str:
    """Read a provider-native transcript such as an OpenCode SQLite session."""
    return await ContextWorkspaceClient().get(
        f"/agents/sessions/{provider}/{session_id}/transcript",
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
        context_workspace_create_context_bundle,
        context_workspace_get_context_bundle,
        context_workspace_store_memory,
        context_workspace_delete_memory,
        context_workspace_recent_memory,
        context_workspace_list_agent_sessions,
        context_workspace_summarize_agent_sessions,
        context_workspace_open_workspace,
        context_workspace_spawn_agent,
        context_workspace_spawn_terminal,
        context_workspace_spawn_terminals_batch,
        context_workspace_list_live_terminals,
        context_workspace_kill_terminal,
        context_workspace_close_workspace,
        context_workspace_inject_terminal_input,
        context_workspace_send_message,
        context_workspace_list_messages,
        context_workspace_list_runs,
        context_workspace_get_run,
        context_workspace_cancel_run,
        context_workspace_read_artifact,
        context_workspace_read_agent_session,
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


def _terminal_kind_for_agent(agent_type: str) -> str:
    normalized = "-".join(agent_type.strip().lower().replace("_", "-").split())
    aliases = {
        "codex": "codex",
        "opencode": "opencode",
        "open-code": "opencode",
        "claude": "claude",
        "claude-code": "claude",
        "hermes": "hermes",
        "athena": "athena",
        "athena-code": "athena",
        "athenacode": "athena",
    }
    if normalized not in aliases:
        raise ValueError(f"Unsupported agent type: {agent_type}")
    return aliases[normalized]


def _terminal_kind_for_terminal(kind: str) -> str:
    normalized = "-".join(kind.strip().lower().replace("_", "-").split())
    if normalized == "shell":
        return "shell"
    return _terminal_kind_for_agent(kind)


def _group_batch_spawn_specs(specs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for spec in specs:
        request = _normalize_batch_spawn_spec(spec)
        if (
            current
            and _can_merge_batch_spawn_requests(current, request)
        ):
            current["count"] += request["count"]
            continue
        current = request
        grouped.append(current)
    return grouped


def _normalize_batch_spawn_spec(spec: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(spec, dict):
        raise ValueError("Each batch spawn spec must be an object.")
    kind = _terminal_kind_for_agent(str(spec.get("kind") or spec.get("agent_type") or "codex"))
    count = int(spec.get("count") or 1)
    if count < 1:
        raise ValueError("Batch spawn spec count must be at least 1.")
    task = _string_or_none(spec.get("task"))
    title = _string_or_none(spec.get("title"))
    session_label = _string_or_none(spec.get("session_label"))
    context = _string_or_none(spec.get("context")) or _string_or_none(spec.get("context_text"))
    if session_label is None and kind in {"codex", "opencode", "claude", "athena"}:
        session_label = "New"
    return {
        "kind": kind,
        "count": count,
        "title": title,
        "task": task,
        "resume_session_id": _string_or_none(spec.get("resume_session_id")),
        "session_label": session_label,
        "context_mode": _batch_context_mode(spec.get("context_mode"), task, context),
        "context": context,
    }


def _can_merge_batch_spawn_requests(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return (
        left["kind"] == right["kind"]
        and left.get("task") == right.get("task")
        and left.get("title") is None
        and right.get("title") is None
        and left.get("resume_session_id") is None
        and right.get("resume_session_id") is None
        and left.get("session_label") == right.get("session_label")
        and left.get("context_mode") == right.get("context_mode")
        and left.get("context") == right.get("context")
    )


def _string_or_none(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _context_mode_or_none(value: Any) -> str | None:
    mode = _string_or_none(value)
    if mode is None:
        return None
    normalized = mode.lower()
    if normalized not in {"none", "task", "curated"}:
        raise ValueError(f"Unsupported context_mode: {value}")
    return normalized


def _batch_context_mode(value: Any, task: str | None, context: str | None) -> str | None:
    explicit = _context_mode_or_none(value)
    if explicit is not None:
        return explicit
    if context is not None:
        return "curated"
    if task is not None:
        return "task"
    return None


def _title_for_task(kind: str, task: str) -> str:
    prefix = {
        "codex": "Codex",
        "opencode": "OpenCode",
        "claude": "Claude",
        "hermes": "Hermes",
        "athena": "Athena Code",
    }.get(kind, "Agent")
    first_line = next((line.strip() for line in task.splitlines() if line.strip()), "")
    return f"{prefix}: {first_line[:48]}" if first_line else prefix
