from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

import backend.agent_sessions as agent_sessions
from backend.agent_sessions import format_agent_sessions_summary, list_native_agent_sessions, read_agent_session_transcript


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


def test_lists_codex_sessions_from_jsonl_context(tmp_path: Path) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "project"
    workspace.mkdir()
    session_id = "codex-jsonl-1"
    session_file = home / ".codex" / "sessions" / "2026" / "05" / "15" / f"rollout-{session_id}.jsonl"
    session_file.parent.mkdir(parents=True)
    session_file.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "timestamp": "2026-05-15T10:00:00Z",
                        "type": "session_meta",
                        "payload": {
                            "id": session_id,
                            "timestamp": "2026-05-15T09:59:59Z",
                            "cwd": str(workspace),
                            "cli_version": "0.130.0",
                            "model_provider": "openai",
                            "base_instructions": {"text": "Full system prompt and personality."},
                        },
                    }
                ),
                json.dumps(
                    {
                        "timestamp": "2026-05-15T10:00:01Z",
                        "type": "turn_context",
                        "payload": {
                            "cwd": str(workspace),
                            "model": "gpt-5.5",
                            "personality": "pragmatic",
                            "approval_policy": "on-request",
                            "sandbox_policy": {"type": "workspace-write"},
                            "collaboration_mode": {"mode": "default"},
                            "git": {"branch": "jsonl-branch", "commit_hash": "abc123"},
                        },
                    }
                ),
                json.dumps(
                    {
                        "timestamp": "2026-05-15T10:00:02Z",
                        "type": "event_msg",
                        "payload": {"type": "user_message", "message": "Close the JSONL session gap"},
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )

    sessions = list_native_agent_sessions(workspace, home_dir=home, provider="codex")
    transcript = read_agent_session_transcript("codex", session_id, home_dir=home)

    assert [session.id for session in sessions] == [session_id]
    assert sessions[0].title == "Close the JSONL session gap"
    assert sessions[0].branch == "jsonl-branch"
    assert sessions[0].model == "gpt-5.5"
    assert sessions[0].metadata["cli_version"] == "0.130.0"
    assert sessions[0].metadata["model_provider"] == "openai"
    assert sessions[0].metadata["collaboration_mode"] == "default"
    assert "Full system prompt and personality." in transcript
    assert "Close the JSONL session gap" in transcript


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


def test_reads_opencode_transcript_from_message_parts(tmp_path: Path) -> None:
    home = tmp_path / "home"
    db_path = home / ".local" / "share" / "opencode" / "opencode.db"
    db_path.parent.mkdir(parents=True)
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            "create table session (id text primary key, title text, directory text, agent text, model text, time_created integer, time_updated integer)"
        )
        connection.execute("create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text)")
        connection.execute("create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text)")
        connection.execute(
            "insert into session values (?, ?, ?, ?, ?, ?, ?)",
            ("ses_test", "SEO plan", str(tmp_path / "project"), "build", json.dumps({"providerID": "test", "id": "model"}), 1, 2),
        )
        connection.execute(
            "insert into message values (?, ?, ?, ?, ?)",
            ("msg_user", "ses_test", 3, 3, json.dumps({"role": "user", "agent": "build"})),
        )
        connection.execute(
            "insert into part values (?, ?, ?, ?, ?, ?)",
            ("part_user", "msg_user", "ses_test", 4, 4, json.dumps({"type": "text", "text": "optimize the repo about"})),
        )
        connection.execute(
            "insert into message values (?, ?, ?, ?, ?)",
            ("msg_assistant", "ses_test", 5, 5, json.dumps({"role": "assistant", "modelID": "MiniMax-M2.7"})),
        )
        connection.execute(
            "insert into part values (?, ?, ?, ?, ?, ?)",
            ("part_assistant", "msg_assistant", "ses_test", 6, 6, json.dumps({"type": "text", "text": "Here is the SEO plan."})),
        )

    transcript = read_agent_session_transcript("opencode", "ses_test", home_dir=home)

    assert "# OpenCode Session Transcript" in transcript
    assert "optimize the repo about" in transcript
    assert "Here is the SEO plan." in transcript


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


def test_lists_hermes_sessions_from_wsl_fallback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "project"
    workspace.mkdir()
    hermes_home = tmp_path / "wsl-home" / ".hermes"
    sessions_dir = hermes_home / "sessions"
    sessions_dir.mkdir(parents=True)
    (sessions_dir / "session_h1.json").write_text(
        json.dumps(
            {
                "model": "hermes-model",
                "platform": "cli",
                "session_start": "2026-05-12T10:00:00Z",
                "last_updated": "2026-05-12T10:05:00Z",
                "messages": [{"role": "user", "content": "Review the Athena sessions"}],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(agent_sessions, "_probe_wsl_hermes_dir", lambda: hermes_home)

    sessions = list_native_agent_sessions(workspace, home_dir=home, provider="hermes")
    transcript = read_agent_session_transcript("hermes", "h1", home_dir=home)

    assert [session.id for session in sessions] == ["h1"]
    assert sessions[0].provider == "hermes"
    assert sessions[0].title == "Review the Athena sessions"
    assert "Review the Athena sessions" in transcript


def test_formats_empty_and_populated_summary(tmp_path: Path) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "project"
    workspace.mkdir()

    assert format_agent_sessions_summary([]) == "No native agent sessions were found for this workspace."
    assert list_native_agent_sessions(workspace, home_dir=home) == []
