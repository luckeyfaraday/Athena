"""Native agent session discovery for Codex, OpenCode, Claude Code, and Hermes."""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import subprocess
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal


AgentSessionProvider = Literal["codex", "opencode", "claude", "hermes"]
AgentSessionStatus = Literal["historical"]


@dataclass(frozen=True)
class AgentSession:
    id: str
    provider: AgentSessionProvider
    title: str
    workspace: str
    branch: str | None
    model: str | None
    agent: str | None
    created_at: str
    updated_at: str
    status: AgentSessionStatus
    terminal_id: str | None
    pid: int | None
    resume_command: str | None
    metadata: dict[str, Any] = field(default_factory=dict)

    def payload(self) -> dict[str, Any]:
        return asdict(self)


def list_native_agent_sessions(
    project_dir: str | Path,
    *,
    home_dir: str | Path | None = None,
    provider: AgentSessionProvider | None = None,
    query: str = "",
    limit: int = 100,
) -> list[AgentSession]:
    """Return historical native agent sessions for a project directory."""
    workspace = Path(project_dir).expanduser().resolve()
    home = Path(home_dir).expanduser().resolve() if home_dir is not None else Path.home()
    providers = [provider] if provider else ["codex", "opencode", "claude", "hermes"]

    sessions: list[AgentSession] = []
    if "codex" in providers:
        sessions.extend(_read_codex_sessions(workspace, home))
    if "opencode" in providers:
        sessions.extend(_read_opencode_sessions(workspace, home))
    if "claude" in providers:
        sessions.extend(_read_claude_sessions(workspace, home))
    if "hermes" in providers:
        sessions.extend(_read_hermes_sessions(workspace, home))

    matches = [_session for _session in _merge_sessions(sessions) if _matches_query(_session, query)]
    return matches[: max(1, min(limit, 500))]


def format_agent_sessions_summary(sessions: list[AgentSession]) -> str:
    if not sessions:
        return "No native agent sessions were found for this workspace."

    lines = ["Native agent sessions for this workspace:"]
    for session in sessions:
        details = [session.provider, session.status]
        if session.model:
            details.append(session.model)
        if session.branch:
            details.append(f"branch {session.branch}")
        lines.append(f"- {session.updated_at} [{', '.join(details)}] {session.title} ({session.id})")
        if session.resume_command:
            lines.append(f"  resume: `{session.resume_command}`")
    return "\n".join(lines)


def read_agent_session_transcript(
    provider: AgentSessionProvider,
    session_id: str,
    *,
    home_dir: str | Path | None = None,
    max_bytes: int = 65536,
    tail: bool = True,
) -> str:
    """Return a provider-native session transcript as markdown."""
    normalized_id = session_id.strip()
    if not normalized_id:
        raise ValueError("session_id is required.")
    home = Path(home_dir).expanduser().resolve() if home_dir is not None else Path.home()
    if provider == "opencode":
        markdown = _read_opencode_transcript(normalized_id, home)
    elif provider == "claude":
        markdown = _read_claude_transcript(normalized_id, home)
    elif provider == "hermes":
        markdown = _read_hermes_transcript(normalized_id, home)
    elif provider == "codex":
        markdown = _read_codex_transcript(normalized_id, home)
    else:
        raise ValueError(f"Unsupported session provider: {provider}")
    if not markdown:
        raise FileNotFoundError(f"{provider} session not found: {normalized_id}")
    return _bounded_text(markdown, max_bytes=max_bytes, tail=tail)


def _read_codex_sessions(workspace: Path, home: Path) -> list[AgentSession]:
    jsonl_metadata = _read_codex_jsonl_metadata(workspace, home)
    db_path = home / ".codex" / "state_5.sqlite"
    sessions: list[AgentSession] = []
    seen_ids: set[str] = set()

    if db_path.exists():
        rows = _query_sqlite(
            db_path,
            """
            select id, cwd, title, created_at_ms, updated_at_ms, git_branch,
                   cli_version, first_user_message, model, agent_role
            from threads
            order by updated_at_ms desc
            limit 250
            """,
        )
        for row in rows:
            session_workspace = _string_value(row[1]) or str(workspace)
            if not _same_path(session_workspace, workspace):
                continue
            session_id = _string_value(row[0])
            if not session_id:
                continue
            metadata = jsonl_metadata.get(session_id, {})
            title = _clean_session_title(_string_value(row[2]) or _string_value(row[7]) or _metadata_string(metadata, "first_user_message")) or "Codex session"
            branch = _nullable_string(row[5]) or _metadata_string(metadata, "git_branch")
            model = _nullable_string(row[8]) or _metadata_string(metadata, "model")
            cli_version = _nullable_string(row[6]) or _metadata_string(metadata, "cli_version")
            enriched = {**metadata, "cli_version": cli_version} if cli_version else metadata
            sessions.append(
                AgentSession(
                    id=session_id,
                    provider="codex",
                    title=title,
                    workspace=session_workspace,
                    branch=branch,
                    model=model,
                    agent=_nullable_string(row[9]) or _metadata_string(metadata, "personality"),
                    created_at=_metadata_string(metadata, "created_at") or _from_epoch(row[3]),
                    updated_at=max((_metadata_string(metadata, "updated_at") or _from_epoch(row[4]), _from_epoch(row[4])), key=_date_sort_key),
                    status="historical",
                    terminal_id=None,
                    pid=None,
                    resume_command=f"codex resume --cd {_quote_shell_arg(str(workspace))} {_quote_shell_arg(session_id)}",
                    metadata=enriched,
                )
            )
            seen_ids.add(session_id)

    for session_id, metadata in jsonl_metadata.items():
        if session_id in seen_ids:
            continue
        session_workspace = _metadata_string(metadata, "cwd") or str(workspace)
        sessions.append(
            AgentSession(
                id=session_id,
                provider="codex",
                title=_clean_session_title(_metadata_string(metadata, "first_user_message")) or "Codex session",
                workspace=session_workspace,
                branch=_metadata_string(metadata, "git_branch"),
                model=_metadata_string(metadata, "model"),
                agent=_metadata_string(metadata, "personality"),
                created_at=_metadata_string(metadata, "created_at") or datetime.fromtimestamp(0, timezone.utc).isoformat().replace("+00:00", "Z"),
                updated_at=_metadata_string(metadata, "updated_at") or _metadata_string(metadata, "created_at") or datetime.fromtimestamp(0, timezone.utc).isoformat().replace("+00:00", "Z"),
                status="historical",
                terminal_id=None,
                pid=None,
                resume_command=f"codex resume --cd {_quote_shell_arg(str(workspace))} {_quote_shell_arg(session_id)}",
                metadata=metadata,
            )
        )
    return sessions


def _read_codex_jsonl_metadata(workspace: Path, home: Path) -> dict[str, dict[str, Any]]:
    sessions_dir = home / ".codex" / "sessions"
    if not sessions_dir.exists():
        return {}

    metadata_by_id: dict[str, dict[str, Any]] = {}
    for file_path in _recent_jsonl_files(sessions_dir, limit=400):
        metadata = _read_codex_jsonl_file_metadata(file_path)
        session_id = _metadata_string(metadata, "session_id")
        session_workspace = _metadata_string(metadata, "cwd")
        if not session_id or not session_workspace or not _same_path(session_workspace, workspace):
            continue
        metadata_by_id[session_id] = metadata
    return metadata_by_id


def _recent_jsonl_files(root: Path, *, limit: int) -> list[Path]:
    try:
        files = [path for path in root.rglob("*.jsonl") if path.is_file()]
    except OSError:
        return []
    return sorted(files, key=lambda path: path.stat().st_mtime if path.exists() else 0, reverse=True)[:limit]


def _read_codex_jsonl_file_metadata(file_path: Path) -> dict[str, Any]:
    metadata: dict[str, Any] = {"jsonl_path": str(file_path)}
    try:
        with file_path.open("r", encoding="utf-8", errors="replace") as handle:
            for index, line in enumerate(handle):
                if index >= 240:
                    break
                entry = _parse_json_object(line)
                if not entry:
                    continue
                timestamp = _string_property(entry, "timestamp")
                if timestamp:
                    metadata.setdefault("created_at", timestamp)
                    metadata["updated_at"] = timestamp
                entry_type = _string_property(entry, "type")
                payload = _object_property(entry, "payload")
                if entry_type == "session_meta":
                    _merge_codex_session_meta(metadata, payload)
                elif entry_type == "turn_context":
                    _merge_codex_turn_context(metadata, payload)
                elif entry_type == "event_msg" and not metadata.get("first_user_message"):
                    message_type = _string_property(payload, "type")
                    message = _string_property(payload, "message")
                    if message_type == "user_message" and message:
                        metadata["first_user_message"] = message
    except OSError:
        return metadata
    return metadata


def _merge_codex_session_meta(metadata: dict[str, Any], payload: dict[str, Any] | None) -> None:
    if not payload:
        return
    _copy_string_fields(
        metadata,
        payload,
        {
            "id": "session_id",
            "cwd": "cwd",
            "cli_version": "cli_version",
            "model_provider": "model_provider",
            "originator": "originator",
            "source": "source",
            "thread_source": "thread_source",
            "timestamp": "created_at",
        },
    )
    base_instructions = _object_property(payload, "base_instructions")
    base_text = _string_property(base_instructions, "text")
    if base_text:
        metadata["system_prompt_excerpt"] = _bounded_text(base_text, max_bytes=4096, tail=False)


def _merge_codex_turn_context(metadata: dict[str, Any], payload: dict[str, Any] | None) -> None:
    if not payload:
        return
    _copy_string_fields(
        metadata,
        payload,
        {
            "cwd": "cwd",
            "model": "model",
            "personality": "personality",
            "approval_policy": "approval_policy",
            "timezone": "timezone",
            "current_date": "current_date",
        },
    )
    sandbox = _object_property(payload, "sandbox_policy")
    sandbox_type = _string_property(sandbox, "type")
    if sandbox_type:
        metadata["sandbox_policy"] = sandbox_type
    collaboration = _object_property(payload, "collaboration_mode")
    collaboration_mode = _string_property(collaboration, "mode")
    if collaboration_mode:
        metadata["collaboration_mode"] = collaboration_mode
    git = _object_property(payload, "git")
    _copy_string_fields(metadata, git, {"branch": "git_branch", "commit_hash": "git_commit_hash", "commit": "git_commit_hash"})


def _copy_string_fields(metadata: dict[str, Any], source: dict[str, Any] | None, mapping: dict[str, str]) -> None:
    if not source:
        return
    for source_key, target_key in mapping.items():
        value = _string_property(source, source_key)
        if value:
            metadata[target_key] = value


def _read_codex_transcript(session_id: str, home: Path) -> str:
    metadata_by_id = _read_codex_jsonl_metadata_for_all(home)
    metadata = metadata_by_id.get(session_id)
    file_path_text = _metadata_string(metadata or {}, "jsonl_path")
    if not file_path_text:
        return ""
    file_path = Path(file_path_text)
    if not file_path.exists():
        return ""

    lines = [f"# Codex Session Transcript\n\n- session: {session_id}"]
    for label, key in (
        ("workspace", "cwd"),
        ("model", "model"),
        ("model provider", "model_provider"),
        ("cli version", "cli_version"),
        ("personality", "personality"),
        ("collaboration mode", "collaboration_mode"),
        ("approval policy", "approval_policy"),
        ("sandbox", "sandbox_policy"),
        ("git branch", "git_branch"),
        ("git commit", "git_commit_hash"),
        ("jsonl", "jsonl_path"),
    ):
        value = _metadata_string(metadata or {}, key)
        if value:
            lines.append(f"- {label}: {value}")
    system_prompt = _metadata_string(metadata or {}, "system_prompt_excerpt")
    if system_prompt:
        lines.extend(["", "## System Prompt Excerpt", "", system_prompt])
    lines.extend(["", "## Events", ""])
    try:
        with file_path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                entry = _parse_json_object(line)
                if not entry:
                    continue
                rendered = _render_codex_event(entry)
                if rendered:
                    lines.append(rendered)
    except OSError:
        return ""
    return "\n\n".join(lines)


def _read_codex_jsonl_metadata_for_all(home: Path) -> dict[str, dict[str, Any]]:
    sessions_dir = home / ".codex" / "sessions"
    if not sessions_dir.exists():
        return {}
    metadata_by_id: dict[str, dict[str, Any]] = {}
    for file_path in _recent_jsonl_files(sessions_dir, limit=800):
        metadata = _read_codex_jsonl_file_metadata(file_path)
        session_id = _metadata_string(metadata, "session_id")
        if session_id:
            metadata_by_id[session_id] = metadata
    return metadata_by_id


def _render_codex_event(entry: dict[str, Any]) -> str | None:
    timestamp = _string_property(entry, "timestamp")
    entry_type = _string_property(entry, "type") or "event"
    payload = _object_property(entry, "payload")
    prefix = f"### {timestamp} {entry_type}" if timestamp else f"### {entry_type}"
    if entry_type == "event_msg":
        message_type = _string_property(payload, "type")
        message = _string_property(payload, "message")
        if message:
            return f"{prefix}: {message_type or 'message'}\n\n{message}"
    if entry_type == "response_item":
        item_type = _string_property(payload, "type")
        if item_type == "message":
            content = payload.get("content") if payload else None
            if isinstance(content, list):
                text = "\n".join(_string_property(item, "text") or _string_property(item, "output_text") or "" for item in content if isinstance(item, dict))
                if text.strip():
                    return f"{prefix}: assistant\n\n{text.strip()}"
        name = _string_property(payload, "name")
        arguments = _string_property(payload, "arguments")
        output = _string_property(payload, "output")
        if name or arguments or output:
            body = "\n".join(part for part in (f"tool: {name}" if name else "", arguments or "", output or "") if part)
            return f"{prefix}: {item_type or 'response'}\n\n{body}"
    if entry_type in {"session_meta", "turn_context"}:
        return ""
    return None


def _read_opencode_sessions(workspace: Path, home: Path) -> list[AgentSession]:
    db_path = home / ".local" / "share" / "opencode" / "opencode.db"
    if not db_path.exists():
        return []
    rows = _query_sqlite(
        db_path,
        """
        select s.id, coalesce(s.directory, p.worktree), s.title, s.time_created,
               s.time_updated, s.agent, s.model, p.worktree
        from session s
        left join project p on s.project_id = p.id
        order by s.time_updated desc
        limit 250
        """,
    )
    sessions: list[AgentSession] = []
    for row in rows:
        session_workspace = _string_value(row[1]) or _string_value(row[7]) or str(workspace)
        if not _same_path(session_workspace, workspace):
            continue
        session_id = _string_value(row[0])
        if not session_id:
            continue
        sessions.append(
            AgentSession(
                id=session_id,
                provider="opencode",
                title=_clean_session_title(_string_value(row[2])) or "OpenCode session",
                workspace=session_workspace,
                branch=None,
                model=_parse_opencode_model(_nullable_string(row[6])),
                agent=_nullable_string(row[5]),
                created_at=_from_epoch(row[3]),
                updated_at=_from_epoch(row[4]),
                status="historical",
                terminal_id=None,
                pid=None,
                resume_command=f"opencode {_quote_shell_arg(str(workspace))} --session {_quote_shell_arg(session_id)}",
            )
        )
    return sessions


def _read_opencode_transcript(session_id: str, home: Path) -> str:
    db_path = home / ".local" / "share" / "opencode" / "opencode.db"
    if not db_path.exists():
        return ""
    session_rows = _query_sqlite(
        db_path,
        """
        select id, title, directory, agent, model, time_created, time_updated
        from session
        where id = ?
        limit 1
        """,
        (session_id,),
    )
    if not session_rows:
        return ""

    rows = _query_sqlite(
        db_path,
        """
        select m.id, m.data, p.id, p.data, coalesce(p.time_created, m.time_created)
        from message m
        left join part p on p.message_id = m.id
        where m.session_id = ?
        order by coalesce(p.time_created, m.time_created), m.id, p.id
        """,
        (session_id,),
    )
    header = _opencode_transcript_header(session_rows[0])
    lines = [header, ""]
    current_message = ""
    for message_id, message_data, _part_id, part_data, _time in rows:
        msg_id = _string_value(message_id)
        if msg_id and msg_id != current_message:
            current_message = msg_id
            role = _json_string(message_data, "role") or "message"
            agent = _json_string(message_data, "agent")
            model = _json_string(message_data, "modelID") or _json_nested_string(message_data, "model", "modelID")
            details = " / ".join(value for value in (agent, model) if value)
            lines.append(f"## {role.title()}{f' ({details})' if details else ''}")
            lines.append("")
        rendered = _render_opencode_part(part_data)
        if rendered:
            lines.append(rendered)
            lines.append("")
    return "\n".join(lines).strip() + "\n"


def _opencode_transcript_header(row: tuple[Any, ...]) -> str:
    title = _clean_session_title(_string_value(row[1])) or "OpenCode session"
    model = _parse_opencode_model(_nullable_string(row[4]))
    details = [
        f"session: {_string_value(row[0])}",
        f"title: {title}",
        f"workspace: {_string_value(row[2])}" if _string_value(row[2]) else "",
        f"agent: {_string_value(row[3])}" if _string_value(row[3]) else "",
        f"model: {model}" if model else "",
        f"created: {_from_epoch(row[5])}",
        f"updated: {_from_epoch(row[6])}",
    ]
    return "# OpenCode Session Transcript\n\n" + "\n".join(f"- {item}" for item in details if item)


def _render_opencode_part(value: Any) -> str:
    data = _json_object(value)
    if not data:
        return _string_value(value)
    part_type = _string_property(data, "type")
    if part_type == "text":
        return _string_property(data, "text") or ""
    if part_type == "reasoning":
        text = _string_property(data, "text")
        return f"**Reasoning**\n\n{text}" if text else ""
    if part_type == "tool":
        tool = _string_property(data, "tool") or "tool"
        state = data.get("state")
        if isinstance(state, dict):
            title = _string_property(state, "title") or tool
            status = _string_property(state, "status")
            output = _string_property(state, "output")
            body = f"**Tool: {title}{f' ({status})' if status else ''}**"
            return f"{body}\n\n```text\n{output}\n```" if output else body
        return f"**Tool: {tool}**"
    return ""


def _read_claude_transcript(session_id: str, home: Path) -> str:
    projects_dir = home / ".claude" / "projects"
    if not projects_dir.exists():
        return ""
    matches = list(projects_dir.glob(f"*/{session_id}.jsonl"))
    if not matches:
        return ""
    lines = [f"# Claude Code Session Transcript\n\n- session: {session_id}", ""]
    for raw in matches[0].read_text(encoding="utf-8", errors="replace").splitlines():
        data = _json_object(raw)
        message = data.get("message") if isinstance(data, dict) else None
        if not isinstance(message, dict):
            continue
        role = _string_property(message, "role") or "message"
        text = _message_content(message)
        if text:
            lines.extend([f"## {role.title()}", "", text, ""])
    return "\n".join(lines).strip() + "\n"


def _read_hermes_transcript(session_id: str, home: Path) -> str:
    hermes_dir = _resolve_hermes_dir(home)
    if hermes_dir is None:
        return ""
    file_path = hermes_dir / "sessions" / f"session_{session_id}.json"
    if not file_path.exists():
        return ""
    data = _json_object(file_path.read_text(encoding="utf-8", errors="replace"))
    lines = [f"# Hermes Session Transcript\n\n- session: {session_id}", ""]
    messages = data.get("messages")
    if isinstance(messages, list):
        for item in messages:
            if not isinstance(item, dict):
                continue
            role = _string_property(item, "role") or _string_property(item, "type") or "message"
            text = _message_content(item)
            if text:
                lines.extend([f"## {role.title()}", "", text, ""])
    return "\n".join(lines).strip() + "\n"


def _read_claude_sessions(workspace: Path, home: Path) -> list[AgentSession]:
    projects_dir = home / ".claude" / "projects"
    if not projects_dir.exists():
        return []

    candidate_dirs = [projects_dir / _encode_claude_project_path(workspace)]
    try:
        candidate_dirs.extend(path for path in projects_dir.iterdir() if path.is_dir())
    except OSError:
        return []

    seen: set[Path] = set()
    sessions: list[AgentSession] = []
    for directory in candidate_dirs:
        if directory in seen or not directory.exists():
            continue
        seen.add(directory)
        for file_path in sorted(directory.glob("*.jsonl")):
            session = _read_claude_session_file(file_path, workspace)
            if session:
                sessions.append(session)
    return sessions


def _read_claude_session_file(file_path: Path, workspace: Path) -> AgentSession | None:
    try:
        stat = file_path.stat()
        lines = file_path.read_text(encoding="utf-8", errors="replace").splitlines()[:200]
    except OSError:
        return None

    session_id = file_path.stem
    created_at: str | None = None
    updated_at: str | None = None
    cwd: str | None = None
    branch: str | None = None
    model: str | None = None
    title: str | None = None

    for line in lines:
        entry = _parse_json_object(line)
        if not entry:
            continue
        session_id = _string_property(entry, "sessionId") or session_id
        cwd = _string_property(entry, "cwd") or cwd
        branch = _string_property(entry, "gitBranch") or branch
        timestamp = _string_property(entry, "timestamp")
        if timestamp:
            created_at = created_at or timestamp
            updated_at = timestamp
        message = _object_property(entry, "message")
        model = _string_property(message, "model") or model
        if not title and _string_property(message, "role") == "user":
            title = _clean_session_title(_message_content(message))

    if cwd and not _same_path(cwd, workspace):
        return None
    return AgentSession(
        id=session_id,
        provider="claude",
        title=title or "Claude Code session",
        workspace=cwd or str(workspace),
        branch=branch,
        model=model,
        agent=None,
        created_at=created_at or stat.st_ctime_ns and _from_epoch(stat.st_ctime_ns // 1_000_000),
        updated_at=updated_at or _from_epoch(stat.st_mtime_ns // 1_000_000),
        status="historical",
        terminal_id=None,
        pid=None,
        resume_command=f"claude --resume {_quote_shell_arg(session_id)}",
    )


def _read_hermes_sessions(workspace: Path, home: Path) -> list[AgentSession]:
    hermes_dir = _resolve_hermes_dir(home)
    if hermes_dir is None:
        return []
    sessions_dir = hermes_dir / "sessions"
    db_path = hermes_dir / "state.db"
    manifest = _read_hermes_manifest(sessions_dir / "sessions.json")
    sessions_by_id: dict[str, AgentSession] = {}

    if db_path.exists():
        rows = _query_sqlite(
            db_path,
            """
            select id, source, model, started_at, ended_at, message_count, title
            from sessions
            order by coalesce(ended_at, started_at) desc
            limit 250
            """,
        )
        for row in rows:
            session_id = _string_value(row[0])
            if not session_id:
                continue
            file_metadata = (
                {}
                if _nullable_string(row[2]) and _nullable_string(row[6]) and row[4]
                else _read_hermes_session_file(sessions_dir / f"session_{session_id}.json")
            )
            manifest_entry = manifest.get(session_id, {})
            created_at = _from_epoch(row[3])
            updated_at = _from_epoch(row[4]) if row[4] else file_metadata.get("updated_at") or manifest_entry.get("updated_at") or created_at
            sessions_by_id[session_id] = AgentSession(
                id=session_id,
                provider="hermes",
                title=_clean_session_title(_nullable_string(row[6]) or file_metadata.get("title") or manifest_entry.get("title")) or "Hermes session",
                workspace=str(workspace),
                branch=None,
                model=_nullable_string(row[2]) or file_metadata.get("model"),
                agent=_hermes_agent_label(_nullable_string(row[1]), manifest_entry, file_metadata),
                created_at=file_metadata.get("created_at") or manifest_entry.get("created_at") or created_at,
                updated_at=updated_at,
                status="historical",
                terminal_id=None,
                pid=None,
                resume_command=f"hermes --resume {_quote_shell_arg(session_id)}",
            )

    if not sessions_by_id and sessions_dir.exists():
        for file_path in sessions_dir.glob("session_*.json"):
            match = re.match(r"^session_(.+)\.json$", file_path.name)
            if not match:
                continue
            session_id = match.group(1)
            if session_id in sessions_by_id:
                continue
            file_metadata = _read_hermes_session_file(file_path)
            if not file_metadata:
                continue
            manifest_entry = manifest.get(session_id, {})
            try:
                stat = file_path.stat()
            except OSError:
                continue
            sessions_by_id[session_id] = AgentSession(
                id=session_id,
                provider="hermes",
                title=_clean_session_title(file_metadata.get("title") or manifest_entry.get("title")) or "Hermes session",
                workspace=str(workspace),
                branch=None,
                model=file_metadata.get("model"),
                agent=_hermes_agent_label(file_metadata.get("platform"), manifest_entry, file_metadata),
                created_at=file_metadata.get("created_at") or manifest_entry.get("created_at") or _from_epoch(stat.st_ctime_ns // 1_000_000),
                updated_at=file_metadata.get("updated_at") or manifest_entry.get("updated_at") or _from_epoch(stat.st_mtime_ns // 1_000_000),
                status="historical",
                terminal_id=None,
                pid=None,
                resume_command=f"hermes --resume {_quote_shell_arg(session_id)}",
            )

    return sorted(sessions_by_id.values(), key=lambda session: _date_sort_key(session.updated_at), reverse=True)[:100]


def _resolve_hermes_dir(home: Path) -> Path | None:
    native = home / ".hermes"
    if native.exists():
        return native
    return _probe_wsl_hermes_dir()


def _probe_wsl_hermes_dir() -> Path | None:
    if os.name != "nt" or shutil.which("wsl.exe") is None:
        return None
    try:
        completed = subprocess.run(
            ["wsl.exe", "-e", "sh", "-lc", 'wslpath -w "$HOME/.hermes"'],
            check=False,
            capture_output=True,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    candidate = completed.stdout.strip().splitlines()[0] if completed.stdout.strip() else ""
    if not candidate:
        return None
    path = Path(candidate)
    return path if path.exists() else None


def _read_hermes_manifest(file_path: Path) -> dict[str, dict[str, str | None]]:
    parsed = _read_json_object(file_path)
    if not parsed:
        return {}
    manifest: dict[str, dict[str, str | None]] = {}
    for value in parsed.values():
        if not isinstance(value, dict):
            continue
        session_id = _string_property(value, "session_id")
        if not session_id:
            continue
        origin = _object_property(value, "origin")
        manifest[session_id] = {
            "title": _string_property(value, "display_name") or _string_property(origin, "chat_name") or _string_property(value, "session_key"),
            "created_at": _string_property(value, "created_at"),
            "updated_at": _string_property(value, "updated_at"),
            "platform": _string_property(value, "platform") or _string_property(origin, "platform"),
            "chat_type": _string_property(value, "chat_type") or _string_property(origin, "chat_type"),
        }
    return manifest


def _read_hermes_session_file(file_path: Path) -> dict[str, str | None]:
    parsed = _read_json_object(file_path)
    if not parsed:
        return {}
    return {
        "title": _first_hermes_user_message(parsed),
        "model": _string_property(parsed, "model"),
        "platform": _string_property(parsed, "platform"),
        "created_at": _string_property(parsed, "session_start"),
        "updated_at": _string_property(parsed, "last_updated"),
    }


def _read_json_object(file_path: Path) -> dict[str, Any] | None:
    try:
        return _parse_json_object(file_path.read_text(encoding="utf-8", errors="replace"))
    except OSError:
        return None


def _first_hermes_user_message(session: dict[str, Any]) -> str | None:
    messages = session.get("messages")
    if not isinstance(messages, list):
        return None
    for item in messages:
        if not isinstance(item, dict) or _string_property(item, "role") != "user":
            continue
        return _clean_session_title(_message_content(item))
    return None


def _hermes_agent_label(source: str | None, manifest_entry: dict[str, str | None], file_metadata: dict[str, str | None]) -> str | None:
    platform = manifest_entry.get("platform") or file_metadata.get("platform") or source
    chat_type = manifest_entry.get("chat_type")
    parts = [part for part in (platform, chat_type) if part]
    return " / ".join(parts) if parts else None


def _query_sqlite(db_path: Path, sql: str, params: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
    try:
        connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=0.25)
        try:
            return list(connection.execute(sql, params))
        finally:
            connection.close()
    except sqlite3.Error:
        return []


def _merge_sessions(sessions: list[AgentSession]) -> list[AgentSession]:
    by_key: dict[str, AgentSession] = {}
    for session in sessions:
        by_key[f"{session.provider}:{session.id}"] = session
    return sorted(by_key.values(), key=lambda session: _date_sort_key(session.updated_at), reverse=True)


def _matches_query(session: AgentSession, query: str) -> bool:
    terms = [term.lower() for term in re.findall(r"\w+", query)]
    if not terms:
        return True
    haystack = " ".join(
        value
        for value in (
            session.id,
            session.provider,
            session.title,
            session.workspace,
            session.branch or "",
            session.model or "",
            session.agent or "",
            " ".join(str(item) for item in session.metadata.values() if isinstance(item, (str, int, float))),
        )
        if value
    ).lower()
    return all(term in haystack for term in terms)


def _same_path(left: str | Path, right: str | Path) -> bool:
    return _normalize_path(left) == _normalize_path(right)


def _normalize_path(value: str | Path) -> str:
    text = str(value).replace("\\", "/").rstrip("/").lower()
    match = re.match(r"^/mnt/([a-z])/(.+)$", text)
    if match:
        text = f"{match.group(1)}:/{match.group(2)}"
    if os.name == "nt" and text.startswith("/") and re.match(r"^/[a-z]:/", text):
        text = text[1:]
    return text


def _date_sort_key(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.fromtimestamp(0, timezone.utc)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _from_epoch(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = 0
    if number <= 0:
        return datetime.fromtimestamp(0, timezone.utc).isoformat().replace("+00:00", "Z")
    seconds = number / 1000 if number >= 10_000_000_000 else number
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_opencode_model(value: str | None) -> str | None:
    if not value:
        return None
    parsed = _parse_json_object(value)
    provider = _string_property(parsed, "providerID")
    model_id = _string_property(parsed, "id")
    if provider and model_id:
        return f"{provider}/{model_id}"
    return model_id or value


def _parse_json_object(value: str | None) -> dict[str, Any] | None:
    if not value:
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _json_object(value: Any) -> dict[str, Any] | None:
    return _parse_json_object(value if isinstance(value, str) else None)


def _json_string(value: Any, key: str) -> str | None:
    return _string_property(_json_object(value), key)


def _json_nested_string(value: Any, parent: str, key: str) -> str | None:
    return _string_property(_object_property(_json_object(value), parent), key)


def _object_property(value: dict[str, Any] | None, key: str) -> dict[str, Any] | None:
    item = value.get(key) if value else None
    return item if isinstance(item, dict) else None


def _string_property(value: dict[str, Any] | None, key: str) -> str | None:
    item = value.get(key) if value else None
    return item.strip() if isinstance(item, str) and item.strip() else None


def _metadata_string(metadata: dict[str, Any], key: str) -> str | None:
    item = metadata.get(key)
    return item.strip() if isinstance(item, str) and item.strip() else None


def _message_content(message: dict[str, Any] | None) -> str | None:
    content = message.get("content") if message else None
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(parts)
    return None


def _bounded_text(text: str, *, max_bytes: int, tail: bool) -> str:
    data = text.encode("utf-8")
    if len(data) <= max_bytes:
        return text
    chunk = data[-max_bytes:] if tail else data[:max_bytes]
    return chunk.decode("utf-8", errors="replace")


def _nullable_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _string_value(value: Any) -> str:
    return value if isinstance(value, str) else "" if value is None else str(value)


def _first_line(value: str | None) -> str:
    return next((line.strip() for line in (value or "").splitlines() if line.strip()), "")[:120]


def _clean_session_title(value: str | None) -> str:
    text = value or ""
    pane = re.search(r"^Pane:\s*(.+)$", text, flags=re.MULTILINE)
    if pane:
        return pane.group(1).strip()[:120]
    agent = re.search(r"^Agent:\s*(.+)$", text, flags=re.MULTILINE)
    if agent:
        return f"{agent.group(1).strip()} session"[:120]
    return _first_line(text)


def _quote_shell_arg(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$").replace("`", "\\`") + '"'


def _encode_claude_project_path(workspace: Path) -> str:
    return str(workspace).replace(":", "").replace("\\", "-").replace("/", "-")
