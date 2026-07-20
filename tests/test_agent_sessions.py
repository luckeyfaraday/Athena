from __future__ import annotations

import json
import os
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
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


def test_lists_codex_sessions_from_workspace_descendants(tmp_path: Path) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "project"
    child_workspace = workspace / "client"
    sibling_workspace = tmp_path / "project-other"
    child_workspace.mkdir(parents=True)
    sibling_workspace.mkdir()
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
            ("child-codex", str(child_workspace), "Child session", 1, 2, None, None, None, None, None),
        )
        connection.execute(
            "insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("sibling-codex", str(sibling_workspace), "Sibling session", 1, 3, None, None, None, None, None),
        )

    sessions = list_native_agent_sessions(workspace, home_dir=home, provider="codex")

    assert [session.id for session in sessions] == ["child-codex"]


def test_codex_filters_workspace_before_provider_limit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "project"
    workspace.mkdir()
    db_path = home / ".codex" / "state_5.sqlite"
    db_path.parent.mkdir(parents=True)
    monkeypatch.setattr(agent_sessions, "MAX_PROVIDER_ROWS", 2)
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
            ("wanted-old", str(workspace), "Wanted", 1, 1, None, None, None, None, None),
        )
        for index in range(3):
            connection.execute(
                "insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (f"other-{index}", str(tmp_path / "other"), "Other", 1, 100 + index, None, None, None, None, None),
            )

    sessions = list_native_agent_sessions(workspace, home_dir=home, provider="codex")

    assert [session.id for session in sessions] == ["wanted-old"]


def test_lists_codex_sessions_across_all_workspaces(tmp_path: Path) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "project"
    sibling_workspace = tmp_path / "project-other"
    workspace.mkdir()
    sibling_workspace.mkdir()
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
            ("here-codex", str(workspace), "Here session", 1, 2, None, None, None, None, None),
        )
        connection.execute(
            "insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("there-codex", str(sibling_workspace), "There session", 1, 3, None, None, None, None, None),
        )

    # project_dir=None aggregates across every workspace, and each resume
    # command is anchored to the session's own workspace, not the query.
    sessions = list_native_agent_sessions(None, home_dir=home, provider="codex")

    by_id = {session.id: session for session in sessions}
    assert {"here-codex", "there-codex"} <= set(by_id)
    assert by_id["there-codex"].workspace == str(sibling_workspace)
    assert str(sibling_workspace) in (by_id["there-codex"].resume_command or "")


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


def test_lists_opencode_sessions_from_workspace_descendants(tmp_path: Path) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "project"
    child_workspace = workspace / "service"
    sibling_workspace = tmp_path / "project-other"
    child_workspace.mkdir(parents=True)
    sibling_workspace.mkdir()
    db_path = home / ".local" / "share" / "opencode" / "opencode.db"
    db_path.parent.mkdir(parents=True)
    with sqlite3.connect(db_path) as connection:
        connection.execute("create table project (id text, worktree text)")
        connection.execute("create table session (id text, project_id text, directory text, title text, time_created integer, time_updated integer, agent text, model text)")
        connection.execute(
            "insert into session values (?, ?, ?, ?, ?, ?, ?, ?)",
            ("opencode-child", None, str(child_workspace), "Child OpenCode", 1, 2, "build", None),
        )
        connection.execute(
            "insert into session values (?, ?, ?, ?, ?, ?, ?, ?)",
            ("opencode-sibling", None, str(sibling_workspace), "Sibling OpenCode", 1, 3, "build", None),
        )

    sessions = list_native_agent_sessions(workspace, home_dir=home, provider="opencode")

    assert [session.id for session in sessions] == ["opencode-child"]


def test_opencode_filters_workspace_before_provider_limit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "project"
    workspace.mkdir()
    db_path = home / ".local" / "share" / "opencode" / "opencode.db"
    db_path.parent.mkdir(parents=True)
    monkeypatch.setattr(agent_sessions, "MAX_PROVIDER_ROWS", 2)
    with sqlite3.connect(db_path) as connection:
        connection.execute("create table project (id text, worktree text)")
        connection.execute(
            "create table session (id text, project_id text, directory text, title text, "
            "time_created integer, time_updated integer, agent text, model text)"
        )
        connection.execute(
            "insert into session values (?, ?, ?, ?, ?, ?, ?, ?)",
            ("wanted-old", None, str(workspace), "Wanted", 1, 1, "build", None),
        )
        for index in range(3):
            connection.execute(
                "insert into session values (?, ?, ?, ?, ?, ?, ?, ?)",
                (f"other-{index}", None, str(tmp_path / "other"), "Other", 1, 100 + index, "build", None),
            )

    sessions = list_native_agent_sessions(workspace, home_dir=home, provider="opencode")

    assert [session.id for session in sessions] == ["wanted-old"]


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


def test_lists_athena_code_sessions_from_native_index(tmp_path: Path) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "project"
    other_workspace = tmp_path / "other"
    workspace.mkdir()
    other_workspace.mkdir()
    db_path = home / ".athena-code" / "context" / "sessions.db"
    db_path.parent.mkdir(parents=True)
    with sqlite3.connect(db_path) as connection:
        connection.execute("pragma user_version = 2")
        connection.execute(
            """
            create table messages (
              id integer primary key autoincrement,
              agent text not null,
              session_id text not null,
              workspace text not null,
              role text not null,
              ts text not null,
              text text not null
            )
            """
        )
        connection.execute(
            "insert into messages (agent, session_id, workspace, role, ts, text) values (?, ?, ?, ?, ?, ?)",
            ("athena", "athena-session-1", str(workspace), "user", "2026-06-10T10:00:00Z", "Add native Athena Code sessions"),
        )
        connection.execute(
            "insert into messages (agent, session_id, workspace, role, ts, text) values (?, ?, ?, ?, ?, ?)",
            ("athena", "athena-session-1", str(workspace), "assistant", "2026-06-10T10:05:00Z", "Implemented the session provider."),
        )
        connection.execute(
            "insert into messages (agent, session_id, workspace, role, ts, text) values (?, ?, ?, ?, ?, ?)",
            ("opencode", "opencode-session", str(workspace), "user", "2026-06-10T11:00:00Z", "Ignore scanned OpenCode rows"),
        )
        connection.execute(
            "insert into messages (agent, session_id, workspace, role, ts, text) values (?, ?, ?, ?, ?, ?)",
            ("athena", "athena-other", str(other_workspace), "user", "2026-06-10T12:00:00Z", "Other workspace"),
        )

    sessions = list_native_agent_sessions(workspace, home_dir=home, provider="athena")
    transcript = read_agent_session_transcript("athena", "athena-session-1", home_dir=home)

    assert [session.id for session in sessions] == ["athena-session-1"]
    assert sessions[0].provider == "athena"
    assert sessions[0].title == "Add native Athena Code sessions"
    assert sessions[0].agent == "Athena Code"
    assert sessions[0].metadata["turns"] == "2"
    assert sessions[0].resume_command == f'athena-code --session "athena-session-1" "{workspace}"'
    assert "# Athena Code Session Transcript" in transcript
    assert "Implemented the session provider." in transcript


def test_athena_filters_workspace_before_provider_limit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "project"
    workspace.mkdir()
    db_path = home / ".athena-code" / "context" / "sessions.db"
    db_path.parent.mkdir(parents=True)
    monkeypatch.setattr(agent_sessions, "MAX_PROVIDER_ROWS", 2)
    with sqlite3.connect(db_path) as connection:
        connection.execute("pragma user_version = 2")
        connection.execute(
            """
            create table messages (
              id integer primary key autoincrement,
              agent text not null,
              session_id text not null,
              workspace text not null,
              role text not null,
              ts text not null,
              text text not null
            )
            """
        )
        connection.execute(
            "insert into messages (agent, session_id, workspace, role, ts, text) values (?, ?, ?, ?, ?, ?)",
            ("athena", "wanted-old", str(workspace), "user", "2026-01-01T00:00:00Z", "Wanted"),
        )
        for index in range(3):
            connection.execute(
                "insert into messages (agent, session_id, workspace, role, ts, text) values (?, ?, ?, ?, ?, ?)",
                ("athena", f"other-{index}", str(tmp_path / "other"), "user", f"2026-06-0{index + 1}T00:00:00Z", "Other"),
            )

    sessions = list_native_agent_sessions(workspace, home_dir=home, provider="athena")

    assert [session.id for session in sessions] == ["wanted-old"]


def _seed_athena_index(db_path: Path, workspace: Path, *, user_version: int) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as connection:
        connection.execute(f"pragma user_version = {user_version}")
        connection.execute(
            """
            create table messages (
              id integer primary key autoincrement,
              agent text not null,
              session_id text not null,
              workspace text not null,
              role text not null,
              ts text not null,
              text text not null
            )
            """
        )
        connection.execute(
            "insert into messages (agent, session_id, workspace, role, ts, text) values (?, ?, ?, ?, ?, ?)",
            ("athena", "athena-session-1", str(workspace), "user", "2026-06-10T10:00:00Z", "Add native Athena Code sessions"),
        )


def test_athena_index_version_gate_rejects_older_and_accepts_newer_schemas(tmp_path: Path) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "project"
    workspace.mkdir()
    db_path = home / ".athena-code" / "context" / "sessions.db"
    _seed_athena_index(db_path, workspace, user_version=1)

    assert list_native_agent_sessions(workspace, home_dir=home, provider="athena") == []
    with pytest.raises(FileNotFoundError):
        read_agent_session_transcript("athena", "athena-session-1", home_dir=home)

    with sqlite3.connect(db_path) as connection:
        connection.execute("pragma user_version = 3")

    sessions = list_native_agent_sessions(workspace, home_dir=home, provider="athena")
    assert [session.id for session in sessions] == ["athena-session-1"]


def test_athena_code_home_override_survives_symlinked_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    real_home = tmp_path / "real-home"
    real_home.mkdir()
    linked_home = tmp_path / "linked-home"
    linked_home.symlink_to(real_home)
    athena_home = tmp_path / "athena-home"
    workspace = tmp_path / "project"
    workspace.mkdir()
    _seed_athena_index(athena_home / "context" / "sessions.db", workspace, user_version=2)

    monkeypatch.setattr(Path, "home", lambda: linked_home)
    monkeypatch.setenv("ATHENA_CODE_HOME", str(athena_home))

    sessions = list_native_agent_sessions(workspace, provider="athena")
    assert [session.id for session in sessions] == ["athena-session-1"]


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


def test_recent_jsonl_selection_avoids_rglob_and_keeps_newest(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "sessions"
    root.mkdir()
    expected: list[Path] = []
    for index in range(5):
        file_path = root / f"session-{index}.jsonl"
        file_path.write_text("{}", encoding="utf-8")
        os.utime(file_path, ns=(index + 1, index + 1))
        if index >= 3:
            expected.append(file_path)

    monkeypatch.setattr(Path, "rglob", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("unbounded rglob")))

    selected = agent_sessions._recent_jsonl_files(root, limit=2)

    assert selected == list(reversed(expected))


def test_claude_metadata_streams_only_first_200_lines(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    workspace = tmp_path / "project"
    workspace.mkdir()
    file_path = tmp_path / "claude-session.jsonl"
    first = json.dumps(
        {
            "sessionId": "claude-session",
            "cwd": str(workspace),
            "timestamp": "2026-05-09T12:00:00Z",
            "message": {"role": "user", "content": "Bound the metadata reader"},
        }
    )
    filler = json.dumps({"timestamp": "2026-05-09T12:00:01Z", "message": {"role": "assistant"}})
    ignored = json.dumps(
        {
            "cwd": str(tmp_path / "wrong-workspace"),
            "timestamp": "2026-05-09T13:00:00Z",
            "message": {"role": "assistant", "model": "must-not-be-read"},
        }
    )
    file_path.write_text("\n".join([first, *([filler] * 199), ignored, *([ignored] * 20)]), encoding="utf-8")

    real_open = Path.open
    lines_read = 0

    class CountingReader:
        def __init__(self, handle):
            self.handle = handle

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return self.handle.__exit__(*args)

        def __iter__(self):
            return self

        def __next__(self):
            nonlocal lines_read
            value = next(self.handle)
            lines_read += 1
            return value

    def tracking_open(path: Path, *args, **kwargs):
        handle = real_open(path, *args, **kwargs)
        return CountingReader(handle) if path == file_path else handle

    monkeypatch.setattr(Path, "open", tracking_open)
    monkeypatch.setattr(Path, "read_text", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("read_text")))

    session = agent_sessions._read_claude_session_file(file_path, workspace, allow_missing_cwd=False)

    assert session is not None
    assert session.title == "Bound the metadata reader"
    assert session.model is None
    assert lines_read == agent_sessions.CLAUDE_METADATA_MAX_LINES


def test_claude_transcript_head_stops_at_requested_budget(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    session_id = "bounded-claude"
    file_path = home / ".claude" / "projects" / "project" / f"{session_id}.jsonl"
    file_path.parent.mkdir(parents=True)
    file_path.write_text(
        "\n".join(
            json.dumps({"message": {"role": "user", "content": f"message-{index}-" + ("x" * 200)}})
            for index in range(100)
        ),
        encoding="utf-8",
    )

    real_open = Path.open
    lines_read = 0

    class CountingReader:
        def __init__(self, handle):
            self.handle = handle

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return self.handle.__exit__(*args)

        def __iter__(self):
            return self

        def __next__(self):
            nonlocal lines_read
            value = next(self.handle)
            lines_read += 1
            return value

    def tracking_open(path: Path, *args, **kwargs):
        handle = real_open(path, *args, **kwargs)
        return CountingReader(handle) if path == file_path else handle

    monkeypatch.setattr(Path, "open", tracking_open)

    transcript = read_agent_session_transcript(
        "claude",
        session_id,
        home_dir=home,
        max_bytes=128,
        tail=False,
    )

    assert len(transcript.encode("utf-8")) <= 128
    assert transcript.startswith("# Claude Code Session Transcript")
    assert lines_read < 100


@pytest.mark.parametrize("tail", [False, True])
def test_bounded_transcript_joiner_preserves_utf8_boundary_semantics(tail: bool) -> None:
    parts = ["header🙂", "middle-é", "tail🙂"]
    output = agent_sessions._BoundedTextJoiner("\n", max_bytes=13, tail=tail)
    for part in parts:
        output.add(part)

    assert output.text() == agent_sessions._bounded_text("\n".join(parts), max_bytes=13, tail=tail)


def test_claude_sessions_do_not_leak_across_workspaces(tmp_path: Path) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "project"
    other_workspace = tmp_path / "other-project"
    workspace.mkdir()
    other_workspace.mkdir()
    projects_dir = home / ".claude" / "projects"
    session_dir = projects_dir / str(workspace).replace(":", "").replace("\\", "-").replace("/", "-")
    other_session_dir = projects_dir / str(other_workspace).replace(":", "").replace("\\", "-").replace("/", "-")
    session_dir.mkdir(parents=True)
    other_session_dir.mkdir(parents=True)

    (session_dir / "claude-current.jsonl").write_text(
        json.dumps(
            {
                "sessionId": "claude-current",
                "timestamp": "2026-05-09T12:00:00Z",
                "message": {"role": "user", "content": [{"type": "text", "text": "Current workspace"}]},
            }
        ),
        encoding="utf-8",
    )
    (other_session_dir / "claude-other.jsonl").write_text(
        json.dumps(
            {
                "sessionId": "claude-other",
                "timestamp": "2026-05-09T13:00:00Z",
                "message": {"role": "user", "content": [{"type": "text", "text": "Other workspace"}]},
            }
        ),
        encoding="utf-8",
    )

    sessions = list_native_agent_sessions(workspace, home_dir=home, provider="claude")

    assert [session.id for session in sessions] == ["claude-current"]


def test_lists_claude_sessions_from_claude_encoded_workspace_dir(tmp_path: Path) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "project_with_underscores" / "Codex sub tracker"
    workspace.mkdir(parents=True)
    encoded = str(workspace).replace(":", "")
    encoded = "".join(character if character.isalnum() or character == "." else "-" for character in encoded)
    session_dir = home / ".claude" / "projects" / encoded
    session_dir.mkdir(parents=True)
    (session_dir / "claude-encoded.jsonl").write_text(
        json.dumps(
            {
                "sessionId": "claude-encoded",
                "cwd": str(workspace),
                "timestamp": "2026-05-09T12:00:00Z",
                "message": {"role": "user", "content": [{"type": "text", "text": "Encoded workspace"}]},
            }
        ),
        encoding="utf-8",
    )

    sessions = list_native_agent_sessions(workspace, home_dir=home, provider="claude")

    assert [session.id for session in sessions] == ["claude-encoded"]


def test_lists_claude_sessions_from_workspace_descendant_dirs(tmp_path: Path) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "project"
    child_workspace = workspace / "client"
    child_workspace.mkdir(parents=True)
    encoded = "".join(character if character.isalnum() or character == "." else "-" for character in str(child_workspace).replace(":", ""))
    session_dir = home / ".claude" / "projects" / encoded
    session_dir.mkdir(parents=True)
    (session_dir / "claude-child.jsonl").write_text(
        json.dumps(
            {
                "sessionId": "claude-child",
                "cwd": str(child_workspace),
                "timestamp": "2026-05-09T12:00:00Z",
                "message": {"role": "user", "content": [{"type": "text", "text": "Child Claude"}]},
            }
        ),
        encoding="utf-8",
    )

    sessions = list_native_agent_sessions(workspace, home_dir=home, provider="claude")

    assert [session.id for session in sessions] == ["claude-child"]


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
                "messages": [{"role": "user", "content": f"Review the Athena sessions in {workspace}"}],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(agent_sessions, "_probe_wsl_hermes_dir", lambda: hermes_home)

    sessions = list_native_agent_sessions(workspace, home_dir=home, provider="hermes")
    transcript = read_agent_session_transcript("hermes", "h1", home_dir=home)

    assert [session.id for session in sessions] == ["h1"]
    assert sessions[0].provider == "hermes"
    assert sessions[0].title.startswith("Review the Athena sessions")
    assert "Review the Athena sessions" in transcript


def test_hermes_workspace_hint_is_bounded_without_serialized_search_text(tmp_path: Path) -> None:
    workspace = tmp_path / "project-with-hyphen"
    workspace.mkdir()
    file_path = tmp_path / "session_h1.json"
    file_path.write_text(
        json.dumps(
            {
                "model": "hermes-model",
                "messages": [
                    {"role": "user", "content": f"Continue work in {workspace} " + ("x" * 50_000)},
                    {"role": "assistant", "content": "y" * 50_000},
                ],
            }
        ),
        encoding="utf-8",
    )

    metadata = agent_sessions._read_hermes_session_file(file_path)

    assert "search_text" not in metadata
    assert metadata["workspace_hint"] is not None
    assert len((metadata["workspace_hint"] or "").encode("utf-8")) <= agent_sessions.HERMES_WORKSPACE_HINT_MAX_BYTES
    assert agent_sessions._hermes_session_matches_workspace(metadata, {}, workspace)


def test_provider_path_identity_preserves_posix_case_and_roots() -> None:
    assert agent_sessions._normalize_path("/") == "/"
    assert agent_sessions._same_or_descendant_path("/Work/Project/child", "/Work/Project")
    assert not agent_sessions._same_or_descendant_path("/work/project", "/Work/Project")
    assert agent_sessions._same_or_descendant_path("/work/project", "/")
    assert agent_sessions._same_or_descendant_path(r"C:\Users\Alan", "C:/")
    assert agent_sessions._same_or_descendant_path("/mnt/c/Users/Alan", "C:\\")


def test_provider_sql_workspace_filter_uses_filesystem_case_semantics() -> None:
    connection = sqlite3.connect(":memory:")
    try:
        connection.execute("create table sessions (cwd text)")
        connection.executemany(
            "insert into sessions (cwd) values (?)",
            [("/Work/Project",), ("/Work/Project/child",), ("/work/project",), ("relative",)],
        )
        sql, params = agent_sessions._workspace_sql_filter("cwd", "/Work/Project")
        assert connection.execute(f"select cwd from sessions where {sql} order by cwd", params).fetchall() == [
            ("/Work/Project",),
            ("/Work/Project/child",),
        ]
        root_sql, root_params = agent_sessions._workspace_sql_filter("cwd", "/")
        assert connection.execute(f"select cwd from sessions where {root_sql} order by cwd", root_params).fetchall() == [
            ("/Work/Project",),
            ("/Work/Project/child",),
            ("/work/project",),
        ]
    finally:
        connection.close()


def test_explicit_hermes_workspace_cannot_fall_through_to_stale_hints() -> None:
    metadata = {
        "workspace": "/Work/Other",
        "workspace_hint": "Earlier work mentioned /Work/Target",
        "title": "Continue /Work/Target",
    }
    assert not agent_sessions._hermes_session_matches_workspace(metadata, {}, Path("/Work/Target"))


def test_hermes_metadata_cache_reuses_unchanged_file_and_keeps_last_good(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    file_path = tmp_path / "session_cached.json"
    file_path.write_text(
        json.dumps(
            {
                "model": "hermes-model",
                "last_updated": "2026-05-12T10:05:00Z",
                "messages": [{"role": "user", "content": "Cache this metadata"}],
            }
        ),
        encoding="utf-8",
    )
    real_read_text = Path.read_text
    reads = 0

    def counting_read_text(path: Path, *args, **kwargs):
        nonlocal reads
        if path == file_path:
            reads += 1
        return real_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", counting_read_text)

    first = agent_sessions._read_hermes_session_file(file_path)
    second = agent_sessions._read_hermes_session_file(file_path)
    file_path.write_text("{truncated", encoding="utf-8")
    corrupt = agent_sessions._read_hermes_session_file(file_path)
    still_corrupt = agent_sessions._read_hermes_session_file(file_path)

    assert first == second == corrupt == still_corrupt
    assert first["title"] == "Cache this metadata"
    assert reads == 2


def test_hermes_metadata_cache_coalesces_concurrent_cold_reads(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    file_path = tmp_path / "session_concurrent.json"
    file_path.write_text(
        json.dumps({"messages": [{"role": "user", "content": "One cold parse"}]}),
        encoding="utf-8",
    )
    real_read_text = Path.read_text
    read_started = threading.Event()
    release_read = threading.Event()
    second_started = threading.Event()
    reads = 0
    reads_lock = threading.Lock()

    def blocking_read_text(path: Path, *args, **kwargs):
        nonlocal reads
        if path == file_path:
            with reads_lock:
                reads += 1
            read_started.set()
            assert release_read.wait(timeout=2)
        return real_read_text(path, *args, **kwargs)

    def second_read():
        second_started.set()
        return agent_sessions._read_hermes_session_file(file_path)

    monkeypatch.setattr(Path, "read_text", blocking_read_text)
    with ThreadPoolExecutor(max_workers=2) as executor:
        first_future = executor.submit(agent_sessions._read_hermes_session_file, file_path)
        assert read_started.wait(timeout=2)
        second_future = executor.submit(second_read)
        assert second_started.wait(timeout=2)
        release_read.set()
        first = first_future.result(timeout=2)
        second = second_future.result(timeout=2)

    assert first == second
    assert reads == 1


def test_hermes_sessions_do_not_leak_across_workspaces(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "project"
    other_workspace = tmp_path / "other-project"
    workspace.mkdir()
    other_workspace.mkdir()
    hermes_home = tmp_path / "wsl-home" / ".hermes"
    sessions_dir = hermes_home / "sessions"
    sessions_dir.mkdir(parents=True)
    (sessions_dir / "session_current.json").write_text(
        json.dumps(
            {
                "model": "hermes-model",
                "platform": "cli",
                "session_start": "2026-05-12T10:00:00Z",
                "last_updated": "2026-05-12T10:05:00Z",
                "messages": [{"role": "user", "content": f"Work on {workspace}"}],
            }
        ),
        encoding="utf-8",
    )
    (sessions_dir / "session_other.json").write_text(
        json.dumps(
            {
                "model": "hermes-model",
                "platform": "cli",
                "session_start": "2026-05-12T11:00:00Z",
                "last_updated": "2026-05-12T11:05:00Z",
                "messages": [{"role": "user", "content": f"Work on {other_workspace}"}],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(agent_sessions, "_probe_wsl_hermes_dir", lambda: hermes_home)

    sessions = list_native_agent_sessions(workspace, home_dir=home, provider="hermes")

    assert [session.id for session in sessions] == ["current"]


def test_hermes_sessions_match_windows_style_workspace_mentions(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "athena-whisper"
    workspace.mkdir()
    windows_style_workspace = str(workspace).replace("/", "\\")
    hermes_home = tmp_path / "wsl-home" / ".hermes"
    sessions_dir = hermes_home / "sessions"
    sessions_dir.mkdir(parents=True)
    (sessions_dir / "session_windows_path.json").write_text(
        json.dumps(
            {
                "model": "hermes-model",
                "platform": "cli",
                "session_start": "2026-05-12T10:00:00Z",
                "last_updated": "2026-05-12T10:05:00Z",
                "messages": [{"role": "user", "content": f"Continue work in {windows_style_workspace}"}],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(agent_sessions, "_probe_wsl_hermes_dir", lambda: hermes_home)

    sessions = list_native_agent_sessions(workspace, home_dir=home, provider="hermes")

    assert [session.id for session in sessions] == ["windows_path"]


def test_hermes_workspace_filter_is_applied_before_result_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "older-workspace"
    workspace.mkdir()
    hermes_home = home / ".hermes"
    (hermes_home / "sessions").mkdir(parents=True)
    (hermes_home / "state.db").touch()

    def fake_rows(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        for index in range(agent_sessions.MAX_PROVIDER_ROWS):
            yield (f"new-{index}", "cli", "model", index + 1, index + 1, 1, f"New {index}")
        yield ("older-target", "cli", "model", 1, 1, 1, "Older target")

    def fake_metadata(file_path: Path) -> dict[str, str | None]:
        return {
            "title": file_path.stem,
            "model": "model",
            "platform": "cli",
            "created_at": None,
            "updated_at": None,
            "workspace": str(workspace) if "older-target" in file_path.name else str(tmp_path / "other"),
            "workspace_hint": None,
        }

    monkeypatch.setattr(agent_sessions, "_iter_sqlite", fake_rows)
    monkeypatch.setattr(agent_sessions, "_read_hermes_session_file", fake_metadata)

    sessions = list_native_agent_sessions(workspace, home_dir=home, provider="hermes")

    assert [session.id for session in sessions] == ["older-target"]


def test_lists_grok_sessions_from_session_dirs(tmp_path: Path) -> None:
    from urllib.parse import quote

    home = tmp_path / "home"
    workspace = tmp_path / "project"
    other_workspace = tmp_path / "other"
    workspace.mkdir()
    other_workspace.mkdir()

    def _write_grok_session(cwd: Path, session_id: str, *, summary: str, first_user: str) -> None:
        session_dir = home / ".grok" / "sessions" / quote(str(cwd), safe="") / session_id
        session_dir.mkdir(parents=True)
        (session_dir / "summary.json").write_text(
            json.dumps(
                {
                    "info": {"id": session_id, "cwd": str(cwd)},
                    "session_summary": summary,
                    "created_at": "2026-06-10T10:00:00Z",
                    "updated_at": "2026-06-10T10:05:00Z",
                    "current_model_id": "grok-build",
                }
            ),
            encoding="utf-8",
        )
        (session_dir / "chat_history.jsonl").write_text(
            "\n".join(
                [
                    json.dumps({"type": "system", "content": "system prompt"}),
                    json.dumps({"type": "user", "content": [{"type": "text", "text": "ignored reminder"}], "synthetic_reason": "skill"}),
                    json.dumps({"type": "user", "content": [{"type": "text", "text": first_user}]}),
                    json.dumps({"type": "assistant", "content": [{"type": "text", "text": "Wired the Grok provider."}]}),
                ]
            ),
            encoding="utf-8",
        )

    _write_grok_session(workspace, "grok-session-1", summary="", first_user="Add Grok as a coding agent")
    _write_grok_session(other_workspace, "grok-other", summary="Other workspace", first_user="Different project")

    sessions = list_native_agent_sessions(workspace, home_dir=home, provider="grok")
    transcript = read_agent_session_transcript("grok", "grok-session-1", home_dir=home)

    assert [session.id for session in sessions] == ["grok-session-1"]
    assert sessions[0].provider == "grok"
    # session_summary is empty, so the title falls back to the first real user turn.
    assert sessions[0].title == "Add Grok as a coding agent"
    assert sessions[0].model == "grok-build"
    assert sessions[0].agent == "Grok"
    assert sessions[0].resume_command == f'grok --cwd "{workspace}" -r "grok-session-1"'
    assert "# Grok Session Transcript" in transcript
    assert "Add Grok as a coding agent" in transcript
    assert "Wired the Grok provider." in transcript
    assert "ignored reminder" not in transcript


def test_grok_session_directory_discovery_is_bounded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from urllib.parse import quote

    workspace = tmp_path / "project"
    workspace.mkdir()
    sessions_root = tmp_path / "sessions"
    cwd_dir = sessions_root / quote(str(workspace), safe="")
    cwd_dir.mkdir(parents=True)
    for index in range(10):
        session_dir = cwd_dir / f"session-{index}"
        session_dir.mkdir()
        os.utime(session_dir, ns=(index + 1, index + 1))

    monkeypatch.setattr(agent_sessions, "MAX_FILE_SCAN_ENTRIES", 3)
    monkeypatch.setattr(Path, "iterdir", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("unbounded iterdir")))

    selected = agent_sessions._recent_grok_session_dirs(sessions_root, workspace, limit=10)

    assert len(selected) == 3
    assert all(decoded == str(workspace) for _path, decoded in selected)


def test_formats_empty_and_populated_summary(tmp_path: Path) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "project"
    workspace.mkdir()

    assert format_agent_sessions_summary([]) == "No native agent sessions were found for this workspace."
    assert list_native_agent_sessions(workspace, home_dir=home) == []


@pytest.mark.parametrize(
    "bad_id",
    [
        "../../../../etc/passwd",
        "/etc/passwd",
        "..",
        "a/../../b",
        "session\\..\\..\\secret",
        "id with spaces",
        "with\x00null",
        "",
        "   ",
    ],
)
def test_transcript_rejects_unsafe_session_ids(tmp_path: Path, bad_id: str) -> None:
    home = tmp_path / "home"
    home.mkdir()
    for provider in ("codex", "opencode", "claude", "hermes"):
        with pytest.raises(ValueError):
            read_agent_session_transcript(provider, bad_id, home_dir=home)


def test_transcript_accepts_typical_session_ids(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    # Valid ids that simply have no backing file should surface as "not found",
    # never as a validation error.
    for valid_id in ("ses_abc123", "9f8e7d6c-1234-5678-9abc-def012345678", "h1.2"):
        with pytest.raises(FileNotFoundError):
            read_agent_session_transcript("claude", valid_id, home_dir=home)
