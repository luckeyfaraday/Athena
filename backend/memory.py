"""Hermes MEMORY.md / USER.md access layer."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .locks import exclusive_file_lock


ENTRY_SEPARATOR = "§"
DEFAULT_PROFILE = "default"

_SECRET_PATTERNS = [
    re.compile(r"(?i)\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s`]+"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
]
_INJECTION_PATTERNS = [
    re.compile(r"(?i)\bignore (all )?(previous|prior) instructions\b"),
    re.compile(r"(?i)\bsystem prompt\b"),
    re.compile(r"(?i)\bdeveloper message\b"),
]


@dataclass(frozen=True)
class MemoryEntry:
    text: str


class HermesMemoryStore:
    def __init__(
        self,
        *,
        profile: str = DEFAULT_PROFILE,
        root: Path | None = None,
        memory_path: Path | None = None,
        user_path: Path | None = None,
    ) -> None:
        base = root or Path.home() / ".hermes" / "profiles" / profile / "memories"
        self.memory_path = memory_path or base / "MEMORY.md"
        self.user_path = user_path or base / "USER.md"
        self.lock_path = self.memory_path.with_suffix(self.memory_path.suffix + ".lock")

    def entries(self) -> list[MemoryEntry]:
        return [MemoryEntry(text=entry) for entry in parse_memory_entries(_read_text(self.memory_path))]

    def recent(self, *, limit: int = 10) -> list[MemoryEntry]:
        bounded = max(1, min(limit, 100))
        return self.entries()[-bounded:]

    def search(self, query: str, *, limit: int = 10) -> list[MemoryEntry]:
        terms = [term.lower() for term in re.findall(r"\w+", query) if term.strip()]
        entries = self.entries()
        if not terms:
            return entries[-max(1, min(limit, 100)) :]

        scored: list[tuple[int, int, MemoryEntry]] = []
        for index, entry in enumerate(entries):
            haystack = entry.text.lower()
            score = sum(haystack.count(term) for term in terms)
            if score:
                scored.append((score, index, entry))

        scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
        return [entry for _, _, entry in scored[: max(1, min(limit, 100))]]

    def append(self, text: str) -> MemoryEntry:
        sanitized = sanitize_memory_text(text)
        if not sanitized:
            raise ValueError("Memory entry cannot be empty")

        with exclusive_file_lock(self.lock_path):
            existing = _read_text(self.memory_path)
            self.memory_path.parent.mkdir(parents=True, exist_ok=True)
            prefix = "" if not existing.strip() else "\n"
            with self.memory_path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(f"{prefix}{ENTRY_SEPARATOR}\n{sanitized}\n")
        return MemoryEntry(text=sanitized)

    def format_query_response(self, query: str, *, limit: int = 10) -> str:
        matches = self.search(query, limit=limit)
        if not matches:
            return f"No Hermes memory entries matched query: {query.strip() or '(empty)'}"

        body = "\n\n".join(f"- {entry.text}" for entry in matches)
        return f"Project context from Hermes memory:\n\n{body}"

    def log_query(self, agent_id: str | None, query: str) -> None:
        actor = agent_id.strip() if agent_id else "agent"
        self.append(f"[{actor}] asked Hermes memory about: {query.strip()}")


def parse_memory_entries(text: str) -> list[str]:
    entries = []
    for raw in text.split(ENTRY_SEPARATOR):
        entry = raw.strip()
        if entry:
            entries.append(entry)
    return entries


def sanitize_memory_text(text: str) -> str:
    sanitized = text.strip()
    for pattern in _SECRET_PATTERNS:
        sanitized = pattern.sub(lambda match: f"{match.group(1)}=[REDACTED]" if match.groups() else "[REDACTED]", sanitized)
    for pattern in _INJECTION_PATTERNS:
        sanitized = pattern.sub("[POTENTIAL_INJECTION_REDACTED]", sanitized)
    return sanitized


def _read_text(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8")
