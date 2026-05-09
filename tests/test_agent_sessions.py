from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from backend.agent_sessions import format_agent_sessions_summary, list_native_agent_sessions


def test_lists_codex_sessions_for_workspace(tmp_path: Path) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "project"
    workspace.mkdir()
    db_path = home / ".codex" / "state_5.sqlite"
    db_path.parent.mkdir(parents=True)
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            """
            create table threads (
              id text, cwd text, title text, created_at_ms integer,
              updated_at_ms integer, git_branch text, cli_version text,
              first_user_message text, model text, agent_role text
            )
            """
        )
        connection.execute(
            "insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "codex-session-1",
                str(workspace),
                "Fix recall workflow",
                1_700_000_000_000,
                1_700_000_060_000,
                "feature/hermes",
                "codex 1",
                "",
                "gpt-5",
                "worker",
            ),
        )
        connection.execute(
            "insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("other", str(tmp_path / "other"), "Ignore", 1, 2, None, None, None, None, None),
        )

    sessions = list_native_agent_sessions(workspace, home_dir=home)

    assert [session.id for session in sessions] == ["codex-session-1"]
    assert sessions[0].provider == "codex"
    assert sessions[0].branch == "feature/hermes"
    assert sessions[0].resume_command is not None


def test_lists_opencode_and_filters_query(tmp_path: Path) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "project"
    workspace.mkdir()
    db_path = home / ".local" / "share" / "opencode" / "opencode.db"
    db_path.parent.mkdir(parents=True)
    with sqlite3.connect(db_path) as connection:
        connection.execute("create table project (id text, worktree text)")
        connection.execute("create table session (id text, project_id text, directory text, title text, time_created integer, time_updated integer, agent text, model text)")
        connection.execute("insert into project values (?, ?)", ("project-1", str(workspace)))
        connection.execute(
            "insert into session values (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "opencode-session-1",
                "project-1",
                None,
                "Investigate terminal resume",
                1_700_000_000,
                1_700_000_100,
                "build",
                json.dumps({"providerID": "anthropic", "id": "claude-sonnet"}),
            ),
        )

    sessions = list_native_agent_sessions(workspace, home_dir=home, query="terminal")

    assert [session.id for session in sessions] == ["opencode-session-1"]
    assert sessions[0].model == "anthropic/claude-sonnet"


def test_lists_claude_jsonl_sessions(tmp_path: Path) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "project"
    workspace.mkdir()
    session_dir = home / ".claude" / "projects" / str(workspace).replace(":", "").replace("\\", "-").replace("/", "-")
    session_dir.mkdir(parents=True)
    (session_dir / "claude-session-1.jsonl").write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "sessionId": "claude-session-1",
                        "cwd": str(workspace),
                        "gitBranch": "main",
                        "timestamp": "2026-05-09T12:00:00Z",
                        "message": {"role": "user", "content": [{"type": "text", "text": "Polish the UI"}]},
                    }
                ),
                json.dumps(
                    {
                        "sessionId": "claude-session-1",
                        "cwd": str(workspace),
                        "timestamp": "2026-05-09T12:05:00Z",
                        "message": {"role": "assistant", "model": "claude-code"},
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )

    sessions = list_native_agent_sessions(workspace, home_dir=home, provider="claude")

    assert [session.id for session in sessions] == ["claude-session-1"]
    assert sessions[0].title == "Polish the UI"
    assert sessions[0].updated_at == "2026-05-09T12:05:00Z"


def test_formats_empty_and_populated_summary(tmp_path: Path) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "project"
    workspace.mkdir()

    assert format_agent_sessions_summary([]) == "No native agent sessions were found for this workspace."
    assert list_native_agent_sessions(workspace, home_dir=home) == []
