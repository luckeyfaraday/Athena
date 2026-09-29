"""Bounded, structured conversation reads for the desktop chat view.

Terminal screen repaints are not messages. Read actual user/assistant records,
without tool output or reasoning, and keep stable ids across polling windows.
"""

from __future__ import annotations

import hashlib
import json
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

from . import agent_sessions as sessions

MAX_READ_BYTES = 4 * 1024 * 1024
MAX_TEXT_CHARS = 256_000
MAX_MESSAGES = 100
_paths: OrderedDict[tuple[str, str, str], Path] = OrderedDict()
_cache: OrderedDict[str, tuple[tuple[int, int], list[dict[str, Any]]]] = OrderedDict()
_lock = threading.Lock()


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        block["text"] for block in content
        if isinstance(block, dict) and block.get("type") in ("text", "input_text", "output_text")
        and isinstance(block.get("text"), str)
    )


def _message(key: str, role: Any, text: Any, timestamp: Any = None) -> dict[str, Any] | None:
    if role not in ("user", "assistant") or not isinstance(text, str) or not text.strip():
        return None
    return {"id": key, "role": role, "text": text, "timestamp": timestamp if isinstance(timestamp, str) else None}


def _path(provider: str, session_id: str, home: Path) -> Path:
    key = (str(home), provider, session_id)
    with _lock:
        cached = _paths.get(key)
    if cached and cached.is_file():
        return cached
    candidate = None
    if provider == "codex":
        root = home / ".codex" / "sessions"
        rows = sessions._query_sqlite(home / ".codex" / "state_5.sqlite", "select rollout_path from threads where id = ? limit 1", (session_id,))
        if rows and isinstance(rows[0][0], str):
            indexed = Path(rows[0][0])
            if indexed.is_file() and indexed.resolve().is_relative_to(root.resolve()):
                candidate = indexed
        if candidate is None:
            candidate = next((p for p in sessions._recent_jsonl_files(root, limit=800)
                              if p.stem == session_id or p.stem.endswith(f"-{session_id}")), None)
    elif provider == "claude":
        candidate = next((d / f"{session_id}.jsonl" for d in sessions._bounded_child_directories(home / ".claude" / "projects")
                          if (d / f"{session_id}.jsonl").is_file()), None)
    elif provider == "grok":
        candidate = next((d / session_id / "chat_history.jsonl" for d in sessions._bounded_child_directories(home / ".grok" / "sessions")
                          if (d / session_id / "chat_history.jsonl").is_file()), None)
    elif provider == "hermes":
        root = sessions._resolve_hermes_dir(home)
        candidate = root / "sessions" / f"session_{session_id}.json" if root else None
    if candidate is None or not candidate.is_file():
        raise FileNotFoundError(f"{provider} conversation is not available yet.")
    with _lock:
        _paths[key] = candidate
        if len(_paths) > 128:
            _paths.popitem(last=False)
    return candidate


def _jsonl_messages(path: Path, provider: str) -> list[dict[str, Any]]:
    messages = []
    fallback = []
    with path.open("rb") as handle:
        size = handle.seek(0, 2)
        start = max(0, size - MAX_READ_BYTES)
        handle.seek(start)
        data = handle.read(MAX_READ_BYTES)
    if start:
        # Never parse a partial first record from the bounded tail.
        newline = data.find(b"\n")
        if newline < 0:
            return []
        start += newline + 1
        data = data[newline + 1:]
    offset = start
    for line in data.splitlines(keepends=True):
        key = f"{provider}-{offset}"
        offset += len(line)
        try:
            entry = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            continue  # Includes the record currently being written by the CLI.
        if not isinstance(entry, dict):
            continue
        message = None
        timestamp = entry.get("timestamp")
        if provider == "codex":
            payload = entry.get("payload")
            if not isinstance(payload, dict):
                continue
            if entry.get("type") == "event_msg":
                role = {"user_message": "user", "agent_message": "assistant"}.get(payload.get("type"))
                message = _message(key, role, payload.get("message"), timestamp)
            elif entry.get("type") == "response_item" and payload.get("type") == "message":
                item = _message(key, payload.get("role"), _text(payload.get("content")), timestamp)
                if item:
                    fallback.append(item)
        elif provider == "claude":
            payload = entry.get("message")
            if not isinstance(payload, dict) or entry.get("isMeta") or entry.get("isSidechain"):
                continue
            message = _message(str(entry.get("uuid") or key), payload.get("role"), _text(payload.get("content")), timestamp)
        elif provider == "grok" and "synthetic_reason" not in entry:
            message = _message(key, entry.get("type"), _text(entry.get("content")), timestamp)
        if message:
            messages.append(message)
    # Codex records messages twice. Prefer its conversation events when present.
    return messages or fallback


def _file_messages(provider: str, session_id: str, home: Path) -> list[dict[str, Any]]:
    path = _path(provider, session_id, home)
    stat = path.stat()
    signature = (stat.st_mtime_ns, stat.st_size)
    with _lock:
        cached = _cache.get(str(path))
    if cached and cached[0] == signature:
        return cached[1]
    if provider == "hermes":
        if stat.st_size > MAX_READ_BYTES:
            raise ValueError("This Hermes conversation is too large for chat. Open the terminal to continue.")
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            return cached[1] if cached else []
        messages = []
        for index, entry in enumerate(data.get("messages", []) if isinstance(data, dict) else []):
            if isinstance(entry, dict):
                item = _message(f"hermes-{index}", entry.get("role", entry.get("type")), _text(entry.get("content")), entry.get("timestamp"))
                if item:
                    messages.append(item)
    else:
        messages = _jsonl_messages(path, provider)
    messages = _bounded(messages)
    with _lock:
        _cache[str(path)] = (signature, messages)
        if len(_cache) > 128:
            _cache.popitem(last=False)
    return messages


def _bounded(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    kept = []
    chars = 0
    for message in reversed(messages[-MAX_MESSAGES:]):
        remaining = MAX_TEXT_CHARS - chars
        if remaining <= 0:
            break
        text = message["text"]
        kept.append({**message, "text": text[-remaining:]})
        chars += len(text)
    return list(reversed(kept))


def read_chat_messages(provider: str, session_id: str, *, home_dir: str | Path | None = None) -> dict[str, Any]:
    session_id = sessions._validate_session_id(session_id)
    home = Path(home_dir).expanduser().resolve() if home_dir is not None else Path.home()
    if provider in ("codex", "claude", "grok", "hermes"):
        messages = _file_messages(provider, session_id, home)
    elif provider == "athena":
        db = sessions._athena_index_path(home)
        rows = sessions._query_sqlite(db, "select id, role, substr(text, -?), ts from messages where agent = 'athena' and session_id = ? order by id desc limit ?", (MAX_TEXT_CHARS, session_id, MAX_MESSAGES))
        messages = [item for row in reversed(rows) if (item := _message(f"athena-{row[0]}", row[1], row[2], row[3]))]
    elif provider == "opencode":
        db = home / ".local" / "share" / "opencode" / "opencode.db"
        rows = sessions._query_sqlite(db, """
            select m.id, m.data, p.data from
            (select * from message where session_id = ? order by time_created desc, id desc limit ?) m
            left join part p on p.message_id = m.id
            where json_valid(p.data) and json_extract(p.data, '$.type') = 'text'
            order by m.time_created, m.id, p.time_created, p.id
            limit 1000
        """, (session_id, MAX_MESSAGES))
        grouped: dict[str, dict[str, Any]] = {}
        for msg_id, raw_message, raw_part in rows:
            metadata = sessions._json_object(raw_message) or {}
            part = sessions._json_object(raw_part) or {}
            if part.get("type") != "text" or part.get("synthetic") or part.get("ignored"):
                continue
            item = _message(f"opencode-{msg_id}", metadata.get("role"), part.get("text"))
            if item:
                if msg_id in grouped:
                    grouped[msg_id]["text"] += "\n" + item["text"]
                else:
                    grouped[msg_id] = item
        messages = list(grouped.values())
    else:
        raise ValueError(f"Unsupported session provider: {provider}")
    messages = _bounded(messages)
    revision = hashlib.sha256(json.dumps(messages, ensure_ascii=False).encode()).hexdigest()
    return {"messages": messages, "revision": revision}
