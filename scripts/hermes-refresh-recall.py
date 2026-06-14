"""Refresh the project-local Hermes recall cache for Context Workspace.

This script is the default command behind CONTEXT_WORKSPACE_HERMES_REFRESH_CMD.
It intentionally writes the short-lived project recall cache directly so the
desktop app can refresh context even when Hermes-in-WSL cannot reach the
Windows backend loopback URL.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.agent_sessions import AgentSession, list_native_agent_sessions
from backend.safety import SafetyError, resolve_project_dir


SOURCE = "context-workspace-refresh-script"
SCHEMA_VERSION = 2
MAX_RECALL_SESSIONS = 5
MAX_SESSION_TITLE_CHARS = 120


def main() -> int:
    raw_project = os.environ.get("CONTEXT_WORKSPACE_PROJECT_DIR", "").strip()
    if not raw_project:
        print("CONTEXT_WORKSPACE_PROJECT_DIR is required.", file=sys.stderr)
        return 2

    try:
        project = _resolve_project(raw_project)
    except (OSError, SafetyError, ValueError) as exc:
        print(f"Invalid project directory: {exc}", file=sys.stderr)
        return 2

    task_hint = os.environ.get("CONTEXT_WORKSPACE_TASK_HINT", "").strip()
    backend_url = os.environ.get("CONTEXT_WORKSPACE_BACKEND_URL", "").strip()
    session_query = "" if _is_generic_task_hint(task_hint) else task_hint
    sessions = list_native_agent_sessions(project, query=session_query, limit=25)
    if not sessions:
        sessions = list_native_agent_sessions(project, limit=10)

    curated_sessions = _curate_sessions(project, sessions)
    handoff_id = _handoff_id(project)
    markdown = _render_recall(project, task_hint=task_hint, backend_url=backend_url, sessions=curated_sessions, handoff_id=handoff_id)
    cache_dir = project / ".context-workspace" / "hermes"
    recall_path = cache_dir / "session-recall.md"
    metadata_path = cache_dir / "last-refresh.json"
    cache_dir.mkdir(parents=True, exist_ok=True)
    recall_path.write_text(markdown, encoding="utf-8")

    metadata: dict[str, Any] = {
        "refreshed_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "source": SOURCE,
        "schema_version": SCHEMA_VERSION,
        "handoff_id": handoff_id,
        "confidence": "low" if not curated_sessions else "medium",
        "source_count": len(curated_sessions),
        "source_titles": [session.title[:160] for session in curated_sessions[:20]],
        "source_workspaces": [str(project)],
        "source_sessions": [_session_metadata(session) for session in curated_sessions],
        "bytes": len(markdown.encode("utf-8")),
        "task_hint": task_hint or None,
    }
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")

    if not recall_path.exists() or not metadata_path.exists():
        print("Recall refresh did not produce expected cache files.", file=sys.stderr)
        return 1

    print(f"Recall refreshed: {recall_path}")
    print(f"Bytes: {metadata['bytes']}")
    return 0


def _resolve_project(project_dir: str) -> Path:
    try:
        return resolve_project_dir(project_dir)
    except SafetyError:
        translated = _wsl_mount_to_windows_path(project_dir)
        if translated == project_dir:
            raise
        return resolve_project_dir(translated)


def _wsl_mount_to_windows_path(project_dir: str) -> str:
    if os.name != "nt":
        return project_dir
    normalized = project_dir.replace("\\", "/")
    if not normalized.startswith("/mnt/") or len(normalized) < 8:
        return project_dir
    drive = normalized[5]
    if normalized[6] != "/" or not drive.isalpha():
        return project_dir
    rest = normalized[7:].replace("/", "\\")
    return f"{drive.upper()}:\\{rest}"


def _render_recall(project: Path, *, task_hint: str, backend_url: str, sessions: list[AgentSession], handoff_id: str) -> str:
    now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    lines = [
        "# Athena Handoff",
        "",
        "---",
        f"schema_version: {SCHEMA_VERSION}",
        f"handoff_id: {handoff_id}",
        f"generated_at: {now}",
        f"target_workspace: {project}",
        f"source: {SOURCE}",
        f"confidence: {'low' if not sessions else 'medium'}",
        f"source_count: {len(sessions)}",
        "source_workspace_count: 1",
        "---",
    ]
    lines.extend(
        [
            "",
            "## Mission",
            "- Provide a compact recent-session recall cache for the next Athena agent.",
            f"- Target workspace: {project}",
            f"- Task hint: {task_hint}" if task_hint and not _is_generic_task_hint(task_hint) else "- Task hint: none",
            "",
            "## Current State",
            "- Git snapshot: not captured by automatic recall refresh.",
            "- Required first action: verify current git status, branch, and recent file changes before editing.",
            "",
            "## Handoff Quality",
            f"- Confidence: {'low' if not sessions else 'medium'}",
            f"- Source sessions: {len(sessions)}",
            "- Automatic refresh includes session titles and metadata, not full transcripts.",
            "",
            "## Source Map",
            f"- {project.name} (target): {project} ({len(sessions)} source{'s' if len(sessions) != 1 else ''})",
            "",
            "## Source Sessions",
            _format_compact_sessions(sessions),
            "",
            "## Evidence",
            "- No raw transcript evidence is included in automatic recall refresh.",
            "- Use Reviews handoff generation for source excerpts, commands, decisions, and blockers.",
            "",
            "## Instructions For The Next Agent",
            "- Current user instruction has priority.",
            "- Treat this as short-lived background context, not durable truth.",
            "- Verify current git status before editing.",
            "- If this automatic recall is too thin, ask the user to create a Reviews handoff from specific sessions.",
            "",
        ]
    )
    return "\n".join(lines)


def _handoff_id(project: Path) -> str:
    now = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    seed = f"{project}:{now}"
    hash_value = 2166136261
    for char in seed:
        hash_value ^= ord(char)
        hash_value = (hash_value * 16777619) & 0xFFFFFFFF
    return f"handoff-{now.lower()}-{hash_value:x}"


def _session_metadata(session: AgentSession) -> dict[str, Any]:
    return {
        "kind": "native",
        "provider": session.provider,
        "title": session.title[:160],
        "workspace": session.workspace,
        "id": session.id,
        "status": session.status,
        "branch": session.branch,
        "model": session.model,
    }


def _curate_sessions(project: Path, sessions: list[AgentSession]) -> list[AgentSession]:
    project_tokens = _project_tokens(project)
    curated: list[AgentSession] = []
    for session in sessions:
        if session.provider == "hermes" and not _session_mentions_project(session, project_tokens):
            continue
        curated.append(session)
        if len(curated) >= MAX_RECALL_SESSIONS:
            break
    return curated


def _format_compact_sessions(sessions: list[AgentSession]) -> str:
    if not sessions:
        return "No relevant native agent sessions were found for this workspace."
    lines: list[str] = []
    for session in sessions:
        details = [session.provider]
        if session.model:
            details.append(session.model)
        title = " ".join(session.title.split())
        if len(title) > MAX_SESSION_TITLE_CHARS:
            title = f"{title[:MAX_SESSION_TITLE_CHARS].rstrip()}..."
        lines.append(f"- {session.updated_at} [{', '.join(details)}] {title}")
    return "\n".join(lines)


def _is_generic_task_hint(task_hint: str) -> bool:
    normalized = " ".join(task_hint.lower().split())
    return normalized in {"", "workspace selected", "manual recall refresh", "manual launch"}


def _project_tokens(project: Path) -> set[str]:
    tokens: set[str] = set()
    for part in (project.name, project.parent.name):
        for token in part.replace("_", "-").split("-"):
            cleaned = token.strip().lower()
            if len(cleaned) >= 4:
                tokens.add(cleaned)
    tokens.update({"context", "workspace", "athena"})
    return tokens


def _session_mentions_project(session: AgentSession, project_tokens: set[str]) -> bool:
    haystack = " ".join(
        value
        for value in (
            session.title,
            session.workspace,
            session.branch or "",
            session.agent or "",
        )
        if value
    ).lower()
    return any(token in haystack for token in project_tokens)


if __name__ == "__main__":
    raise SystemExit(main())
