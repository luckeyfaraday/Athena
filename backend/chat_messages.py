"""Bounded, structured conversation reads for the desktop chat view.

Terminal screen repaints are not messages. Read actual user/assistant records,
without tool output or reasoning, and keep stable ids across polling windows.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import agent_sessions as sessions

MAX_READ_BYTES = 4 * 1024 * 1024
MAX_TEXT_CHARS = 256_000
MAX_MESSAGES = 100
# A pane can know its session id before the provider writes the file (fresh
# Claude panes pass --session-id). Until the file exists, the walk over every
# provider directory runs at most this often; direct probes run on every poll.
MISSING_RESCAN_SECONDS = 15.0
HERMES_ROOT_TTL_SECONDS = 60.0
CACHE_ENTRIES = 128
# Bytes before the parse offset that must be unchanged for an append-only read.
ANCHOR_BYTES = 64

# Athena launches agents with a generated context prompt as their first user
# message (terminal-launch passes "$(cat promptPath)" or --prompt, flattened to
# one line for some CLIs). It is launch plumbing, not conversation: only the
# task it carries is shown.
_CONTEXT_PROMPT = re.compile(
    r"\A\s*(?:#\s*Athena (?:Task|Tools|Context)\s+(?:Workspace|Agent):"
    r"|You are running inside an embedded Context Workspace terminal\.)"
)
_CONTEXT_TASK_END = r"(?:Current user instructions have priority|Recall cache path:|Context Workspace refreshed Hermes recall)"
_CONTEXT_TASK = re.compile(rf"^(?:Current task|Task):[ \t]*(.*?)\s*^{_CONTEXT_TASK_END}", re.S | re.M)
_FLAT_CONTEXT_TASK = re.compile(rf"\s(?:Current task|Task): (.*?)\s+{_CONTEXT_TASK_END}", re.S)


@dataclass
class _FileState:
    signature: tuple[int, int]
    # Next unparsed byte, and the bytes just before it (append-only JSONL).
    offset: int
    anchor: bytes
    messages: list[dict[str, Any]]
    fallback: list[dict[str, Any]]
    snapshot: dict[str, Any]


_paths: OrderedDict[tuple[str, str, str], Path] = OrderedDict()
_missing: OrderedDict[tuple[str, str, str], float] = OrderedDict()
_files: OrderedDict[str, _FileState] = OrderedDict()
_hermes_roots: dict[str, tuple[float, Path | None]] = {}
_lock = threading.Lock()


def _remember(cache: OrderedDict, key: Any, value: Any) -> None:
    cache[key] = value
    cache.move_to_end(key)
    while len(cache) > CACHE_ENTRIES:
        cache.popitem(last=False)


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


def _visible_user_text(text: str) -> str | None:
    """The user's own words: an Athena context prompt shrinks to its task, or disappears."""
    if not _CONTEXT_PROMPT.match(text):
        return text
    match = _CONTEXT_TASK.search(text) or _FLAT_CONTEXT_TASK.search(text)
    task = match.group(1).strip() if match else ""
    return task or None


def _message(key: str, role: Any, text: Any, timestamp: Any = None) -> dict[str, Any] | None:
    if role not in ("user", "assistant") or not isinstance(text, str) or not text.strip():
        return None
    if role == "user":
        text = _visible_user_text(text)
        if text is None:
            return None
    return {"id": key, "role": role, "text": text, "timestamp": timestamp if isinstance(timestamp, str) else None}


def _hermes_root(home: Path) -> Path | None:
    # A missing ~/.hermes on Windows is probed through WSL (spawns wsl.exe): never per poll.
    key = str(home)
    now = time.monotonic()
    with _lock:
        cached = _hermes_roots.get(key)
    if cached and now < cached[0]:
        return cached[1]
    root = sessions._resolve_hermes_dir(home)
    with _lock:
        _hermes_roots[key] = (now + HERMES_ROOT_TTL_SECONDS, root)
    return root


def _find(provider: str, session_id: str, home: Path, workspace: Path | None, *, scan: bool) -> Path | None:
    # The Sessions tab's locators, so chat opens exactly the sessions it can.
    if provider == "codex":
        return sessions._find_codex_session_file(session_id, home, scan=scan)
    if provider == "claude":
        return sessions._find_claude_session_file(session_id, home, workspace=workspace, scan=scan)
    if provider == "grok":
        session_dir = sessions._find_grok_session_dir(session_id, home) if scan else None
        return session_dir / "chat_history.jsonl" if session_dir else None
    return sessions._find_hermes_session_file(session_id, _hermes_root(home))


def _path(provider: str, session_id: str, home: Path, workspace: Path | None) -> Path | None:
    key = (str(home), provider, session_id)
    with _lock:
        cached = _paths.get(key)
        last_scan = _missing.get(key)
    if cached and cached.is_file():
        return cached
    now = time.monotonic()
    scan = last_scan is None or now - last_scan >= MISSING_RESCAN_SECONDS
    path = _find(provider, session_id, home, workspace, scan=scan)
    with _lock:
        if path is None:
            if scan:
                _remember(_missing, key, now)
        else:
            _missing.pop(key, None)
            _remember(_paths, key, path)
    return path


def _parse_jsonl(data: bytes, start: int, provider: str, messages: list[dict[str, Any]], fallback: list[dict[str, Any]]) -> int:
    """Append the records of `data` (which begins at byte `start`); return the end of the last finished record."""
    offset = start
    consumed = start
    for line in data.splitlines(keepends=True):
        key = f"{provider}-{offset}"
        offset += len(line)
        try:
            entry = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            if line.endswith(b"\n"):
                consumed = offset
            continue  # An unterminated record is still being written: retry it next poll.
        consumed = offset
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
    return consumed


def _read_jsonl(path: Path, provider: str, size: int, previous: _FileState | None) -> _FileState:
    """Parse only what was appended since `previous`; re-read the bounded tail otherwise."""
    with path.open("rb") as handle:
        if previous and ANCHOR_BYTES <= previous.offset <= size and size - previous.offset <= MAX_READ_BYTES:
            handle.seek(previous.offset - ANCHOR_BYTES)
            data = handle.read(size - previous.offset + ANCHOR_BYTES)
            # The bytes before the offset are unchanged: the CLI only appended.
            if data[:ANCHOR_BYTES] == previous.anchor:
                messages, fallback = list(previous.messages), list(previous.fallback)
                offset = _parse_jsonl(data[ANCHOR_BYTES:], previous.offset, provider, messages, fallback)
                anchor = data[:offset - previous.offset + ANCHOR_BYTES][-ANCHOR_BYTES:]
                return _FileState(previous.signature, offset, anchor, messages[-MAX_MESSAGES:], fallback[-MAX_MESSAGES:], previous.snapshot)
        start = max(0, size - MAX_READ_BYTES)
        handle.seek(start)
        data = handle.read(size - start)
    messages: list[dict[str, Any]] = []
    fallback: list[dict[str, Any]] = []
    if start:
        # Never parse a partial first record from the bounded tail.
        newline = data.find(b"\n")
        if newline < 0:
            return _FileState((0, 0), start, b"", messages, fallback, {})
        start += newline + 1
        data = data[newline + 1:]
    offset = _parse_jsonl(data, start, provider, messages, fallback)
    return _FileState((0, 0), offset, data[:offset - start][-ANCHOR_BYTES:], messages[-MAX_MESSAGES:], fallback[-MAX_MESSAGES:], {})


def _hermes_messages(path: Path, size: int) -> list[dict[str, Any]] | None:
    if size > MAX_READ_BYTES:
        raise ValueError("This Hermes conversation is too large for chat. Open the terminal to continue.")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return None  # Caught mid-rewrite; keep what was read last.
    messages = []
    for index, entry in enumerate(data.get("messages", []) if isinstance(data, dict) else []):
        if isinstance(entry, dict):
            item = _message(f"hermes-{index}", entry.get("role", entry.get("type")), _text(entry.get("content")), entry.get("timestamp"))
            if item:
                messages.append(item)
    return messages


def _not_created() -> dict[str, Any]:
    return {"messages": [], "revision": "", "missing": True}


def _file_snapshot(provider: str, session_id: str, home: Path, workspace: Path | None) -> dict[str, Any]:
    path = _path(provider, session_id, home, workspace)
    if path is None:
        return _not_created()
    try:
        stat = path.stat()
        signature = (stat.st_mtime_ns, stat.st_size)
        with _lock:
            previous = _files.get(str(path))
        # Unchanged file: no read, no parse, no re-hash.
        if previous and previous.signature == signature:
            return previous.snapshot
        if provider == "hermes":
            messages = _hermes_messages(path, stat.st_size)
            if messages is None:
                return previous.snapshot if previous else {"messages": [], "revision": ""}
            state = _FileState(signature, 0, b"", messages, [], _snapshot(messages))
        else:
            state = _read_jsonl(path, provider, stat.st_size, previous)
            # Codex records messages twice. Prefer its conversation events when present.
            visible = state.messages or state.fallback
            unchanged = previous is not None and visible == (previous.messages or previous.fallback)
            state.signature = signature
            state.snapshot = previous.snapshot if unchanged else _snapshot(visible)
    except FileNotFoundError:
        return _not_created()  # Deleted between lookup and read.
    with _lock:
        _remember(_files, str(path), state)
    return state.snapshot


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


def _snapshot(messages: list[dict[str, Any]]) -> dict[str, Any]:
    messages = _bounded(messages)
    revision = hashlib.sha256(json.dumps(messages, ensure_ascii=False).encode()).hexdigest()
    return {"messages": messages, "revision": revision}


def read_chat_messages(
    provider: str,
    session_id: str,
    *,
    home_dir: str | Path | None = None,
    workspace: str | Path | None = None,
) -> dict[str, Any]:
    """Latest conversation turns. A session whose file does not exist yet is `missing`, not an error.

    `workspace` (absolute) only helps locate the session file cheaply.
    """
    session_id = sessions._validate_session_id(session_id)
    home = Path(home_dir).expanduser().resolve() if home_dir is not None else Path.home()
    hint = Path(workspace) if workspace and Path(workspace).is_absolute() else None
    if provider in ("codex", "claude", "grok", "hermes"):
        return _file_snapshot(provider, session_id, home, hint)
    if provider == "athena":
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
        grouped: dict[str, tuple[Any, list[str]]] = {}
        for msg_id, raw_message, raw_part in rows:
            metadata = sessions._json_object(raw_message) or {}
            part = sessions._json_object(raw_part) or {}
            text = part.get("text")
            if part.get("type") != "text" or part.get("synthetic") or part.get("ignored") or not isinstance(text, str) or not text.strip():
                continue
            grouped.setdefault(msg_id, (metadata.get("role"), []))[1].append(text)
        # Whole messages, so a context prompt is recognized however it was split into parts.
        messages = [item for msg_id, (role, parts) in grouped.items() if (item := _message(f"opencode-{msg_id}", role, "\n".join(parts)))]
    else:
        raise ValueError(f"Unsupported session provider: {provider}")
    return _snapshot(messages)
