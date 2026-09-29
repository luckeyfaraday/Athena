from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from backend.chat_messages import read_chat_messages
import backend.chat_messages as chat


def write_jsonl(path: Path, entries: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(entry) + "\n" for entry in entries), encoding="utf-8")


def test_codex_uses_conversation_events_without_duplicates_or_tools(tmp_path: Path) -> None:
    path = tmp_path / ".codex/sessions/2026/09/29/rollout-chat.jsonl"
    write_jsonl(path, [
        {"type": "event_msg", "payload": {"type": "user_message", "message": "hi"}},
        {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]}},
        {"type": "response_item", "payload": {"type": "function_call", "arguments": "internal tool"}},
        {"type": "event_msg", "payload": {"type": "agent_reasoning", "message": "private reasoning"}},
        {"type": "event_msg", "payload": {"type": "agent_message", "message": "Hi\n42\n    return True"}},
    ])
    first = read_chat_messages("codex", "chat", home_dir=tmp_path)
    assert [(m["role"], m["text"]) for m in first["messages"]] == [("user", "hi"), ("assistant", "Hi\n42\n    return True")]
    with path.open("a") as handle:
        handle.write('{"type":"event_msg","payload":{"type":"agent_message","message":"next"}}\n{"type":')
    second = read_chat_messages("codex", "chat", home_dir=tmp_path)
    assert second["messages"][:2] == first["messages"]
    assert second["messages"][-1]["text"] == "next"
    assert second["revision"] != first["revision"]


def test_codex_response_item_only_sessions_are_readable(tmp_path: Path) -> None:
    write_jsonl(tmp_path / ".codex/sessions/rollout-old.jsonl", [
        {"type": "response_item", "payload": {"type": "message", "role": role, "content": [{"type": "output_text", "text": role}]}}
        for role in ["developer", "user", "assistant"]
    ])
    assert [m["role"] for m in read_chat_messages("codex", "old", home_dir=tmp_path)["messages"]] == ["user", "assistant"]


def test_claude_keeps_text_and_ignores_tool_results_and_sidechains(tmp_path: Path) -> None:
    write_jsonl(tmp_path / ".claude/projects/project/chat.jsonl", [
        {"uuid": "u", "message": {"role": "user", "content": "hello"}},
        {"message": {"role": "user", "content": [{"type": "tool_result", "content": "noise"}]}},
        {"isSidechain": True, "message": {"role": "assistant", "content": "other conversation"}},
        {"uuid": "a", "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "hidden"}, {"type": "text", "text": "answer"}]}},
    ])
    assert [(m["id"], m["text"]) for m in read_chat_messages("claude", "chat", home_dir=tmp_path)["messages"]] == [("u", "hello"), ("a", "answer")]


def test_bounded_tail_keeps_complete_records_and_stable_ids(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / ".claude/projects/project/chat.jsonl"
    write_jsonl(path, [{"message": {"role": "assistant", "content": "x" * 80 + str(i)}} for i in range(20)])
    monkeypatch.setattr(chat, "MAX_READ_BYTES", 1000)
    first = read_chat_messages("claude", "chat", home_dir=tmp_path)["messages"]
    with path.open("a") as handle:
        handle.write(json.dumps({"message": {"role": "user", "content": "again"}}) + "\n")
    second = read_chat_messages("claude", "chat", home_dir=tmp_path)["messages"]
    assert first[-1] == second[-2]
    assert second[-1]["text"] == "again"


@pytest.mark.parametrize("provider", ["codex", "claude", "grok", "hermes", "opencode", "athena"])
def test_rejects_paths_as_session_ids(tmp_path: Path, provider: str) -> None:
    with pytest.raises(ValueError):
        read_chat_messages(provider, "../secrets", home_dir=tmp_path)


def test_grok_excludes_synthetic_turns(tmp_path: Path) -> None:
    write_jsonl(tmp_path / ".grok/sessions/project/chat/chat_history.jsonl", [
        {"type": "user", "content": "question"},
        {"type": "user", "content": "reminder", "synthetic_reason": "reminder"},
        {"type": "assistant", "content": [{"type": "text", "text": "answer"}]},
    ])
    assert [m["text"] for m in read_chat_messages("grok", "chat", home_dir=tmp_path)["messages"]] == ["question", "answer"]


def test_hermes_reads_messages(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / ".hermes"
    monkeypatch.setattr(chat.sessions, "_resolve_hermes_dir", lambda home: root)
    path = root / "sessions/session_chat.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"messages": [{"role": "system", "content": "hidden"}, {"role": "assistant", "content": "answer"}]}))
    assert [m["text"] for m in read_chat_messages("hermes", "chat", home_dir=tmp_path)["messages"]] == ["answer"]


def test_opencode_groups_text_parts_and_excludes_reasoning(tmp_path: Path) -> None:
    path = tmp_path / ".local/share/opencode/opencode.db"
    path.parent.mkdir(parents=True)
    with sqlite3.connect(path) as db:
        db.executescript("create table message (id text, session_id text, data text, time_created int); create table part (id text, message_id text, data text, time_created int);")
        db.execute("insert into message values (?, ?, ?, ?)", ("m1", "chat", '{"role":"assistant"}', 1))
        for i, (kind, text) in enumerate([("text", "first"), ("reasoning", "hidden"), ("text", "second")]):
            db.execute("insert into part values (?, ?, ?, ?)", (str(i), "m1", json.dumps({"type": kind, "text": text}), i))
    assert [m["text"] for m in read_chat_messages("opencode", "chat", home_dir=tmp_path)["messages"]] == ["first\nsecond"]


def test_athena_reads_the_latest_turns_in_order(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "index.db"
    monkeypatch.setattr(chat.sessions, "_athena_index_path", lambda home: path)
    with sqlite3.connect(path) as db:
        db.execute("create table messages (id int, agent text, session_id text, role text, text text, ts text)")
        db.executemany("insert into messages values (?, 'athena', 'chat', 'assistant', ?, null)", [(i, str(i)) for i in range(120)])
    messages = read_chat_messages("athena", "chat", home_dir=tmp_path)["messages"]
    assert len(messages) == 100
    assert messages[0]["text"] == "20"
    assert messages[-1]["text"] == "119"


def test_codex_index_finds_older_sessions_without_directory_scans(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / ".codex/sessions/older/variant-name.jsonl"
    write_jsonl(path, [{"type": "event_msg", "payload": {"type": "agent_message", "message": "older reply"}}])
    with sqlite3.connect(tmp_path / ".codex/state_5.sqlite") as db:
        db.execute("create table threads (id text, rollout_path text)")
        db.execute("insert into threads values (?, ?)", ("old", str(path)))
    monkeypatch.setattr(chat.sessions, "_recent_jsonl_files", lambda *args, **kwargs: pytest.fail("index should resolve the file"))
    assert read_chat_messages("codex", "old", home_dir=tmp_path)["messages"][0]["text"] == "older reply"


def test_chat_http_endpoint_reports_errors_and_returns_structured_messages(monkeypatch: pytest.MonkeyPatch) -> None:
    import backend.app as app_module
    from fastapi.testclient import TestClient

    def read(provider, session_id):
        if session_id == "missing":
            raise FileNotFoundError("Not saved yet")
        if session_id == "invalid":
            raise ValueError("Invalid session")
        return {"messages": [{"id": "a", "role": "assistant", "text": "42", "timestamp": None}], "revision": "rev"}

    monkeypatch.setattr(app_module, "read_chat_messages", read)
    client = TestClient(app_module.create_app())
    assert client.get("/agents/sessions/codex/missing/chat").status_code == 404
    assert client.get("/agents/sessions/codex/invalid/chat").status_code == 400
    assert client.get("/agents/sessions/codex/ok/chat").json()["messages"][0]["text"] == "42"
