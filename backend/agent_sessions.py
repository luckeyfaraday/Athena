"""Native agent session discovery for Codex, OpenCode, and Claude Code."""

from __future__ import annotations

import json
import os
import re
import sqlite3
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal


AgentSessionProvider = Literal["codex", "opencode", "claude"]
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
    providers = [provider] if provider else ["codex", "opencode", "claude"]

    sessions: list[AgentSession] = []
    if "codex" in providers:
        sessions.extend(_read_codex_sessions(workspace, home))
    if "opencode" in providers:
        sessions.extend(_read_opencode_sessions(workspace, home))
    if "claude" in providers:
        sessions.extend(_read_claude_sessions(workspace, home))

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


def _read_codex_sessions(workspace: Path, home: Path) -> list[AgentSession]:
    db_path = home / ".codex" / "state_5.sqlite"
    if not db_path.exists():
        return []
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
    sessions: list[AgentSession] = []
    for row in rows:
        session_workspace = _string_value(row[1]) or str(workspace)
        if not _same_path(session_workspace, workspace):
            continue
        session_id = _string_value(row[0])
        if not session_id:
            continue
        title = _clean_session_title(_string_value(row[2]) or _string_value(row[7])) or "Codex session"
        sessions.append(
            AgentSession(
                id=session_id,
                provider="codex",
                title=title,
                workspace=session_workspace,
                branch=_nullable_string(row[5]),
                model=_nullable_string(row[8]),
                agent=_nullable_string(row[9]),
                created_at=_from_epoch(row[3]),
                updated_at=_from_epoch(row[4]),
                status="historical",
                terminal_id=None,
                pid=None,
                resume_command=f"codex resume --cd {_quote_shell_arg(str(workspace))} {_quote_shell_arg(session_id)}",
            )
        )
    return sessions


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


def _query_sqlite(db_path: Path, sql: str) -> list[tuple[Any, ...]]:
    try:
        connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=0.25)
        try:
            return list(connection.execute(sql))
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


def _object_property(value: dict[str, Any] | None, key: str) -> dict[str, Any] | None:
    item = value.get(key) if value else None
    return item if isinstance(item, dict) else None


def _string_property(value: dict[str, Any] | None, key: str) -> str | None:
    item = value.get(key) if value else None
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
