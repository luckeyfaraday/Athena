from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MCP_ROOT = ROOT / "mcp_server"
if str(MCP_ROOT) not in sys.path:
    sys.path.insert(0, str(MCP_ROOT))

import server
import tools
from backend.safety import SafetyError


def test_tool_schema_resolves_future_annotations() -> None:
    schema = server._tool_schema(tools.context_workspace_spawn_agent)["inputSchema"]

    assert schema["properties"]["project_dir"] == {"type": "string"}
    assert schema["properties"]["task"] == {"type": "string"}
    assert schema["properties"]["agent_type"] == {"type": "string"}
    assert schema["properties"]["timeout_seconds"] == {
        "anyOf": [{"type": "number"}, {"type": "null"}]
    }
    assert schema["properties"]["visible_terminal"] == {"type": "boolean"}
    assert schema["required"] == ["project_dir", "task"]


def test_agent_session_tool_schema_includes_filters() -> None:
    schema = server._tool_schema(tools.context_workspace_list_agent_sessions)["inputSchema"]

    assert schema["properties"]["project_dir"] == {"type": "string"}
    assert schema["properties"]["provider"] == {
        "anyOf": [{"type": "string"}, {"type": "null"}]
    }
    assert schema["properties"]["query"] == {"type": "string"}
    assert schema["properties"]["limit"] == {"type": "integer"}
    assert schema["required"] == ["project_dir"]


def test_spawn_terminal_tool_schema_defaults_to_visible_terminal() -> None:
    schema = server._tool_schema(tools.context_workspace_spawn_terminal)["inputSchema"]

    assert schema["properties"]["project_dir"] == {"type": "string"}
    assert schema["properties"]["kind"] == {"type": "string"}
    assert schema["properties"]["count"] == {"type": "integer"}
    assert schema["properties"]["title"] == {
        "anyOf": [{"type": "string"}, {"type": "null"}]
    }
    assert schema["properties"]["task"] == {
        "anyOf": [{"type": "string"}, {"type": "null"}]
    }
    assert schema["properties"]["resume_session_id"] == {
        "anyOf": [{"type": "string"}, {"type": "null"}]
    }
    assert schema["required"] == ["project_dir"]


def test_read_agent_session_tool_schema() -> None:
    schema = server._tool_schema(tools.context_workspace_read_agent_session)["inputSchema"]

    assert schema["properties"]["provider"] == {"type": "string"}
    assert schema["properties"]["session_id"] == {"type": "string"}
    assert schema["properties"]["max_bytes"] == {"type": "integer"}
    assert schema["required"] == ["provider", "session_id"]


def test_spawn_agent_defaults_to_visible_terminal(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[dict[str, object]] = []

    async def fake_spawn_terminal(**kwargs: object) -> dict[str, object]:
        calls.append(kwargs)
        return {"sessions": [{"id": "terminal-1"}]}

    monkeypatch.setattr(tools, "context_workspace_spawn_terminal", fake_spawn_terminal)

    result = asyncio.run(tools.context_workspace_spawn_agent(str(tmp_path), "Optimize About page", agent_type="opencode"))

    assert result["mode"] == "visible_terminal"
    assert calls == [
        {
            "project_dir": str(tmp_path),
            "kind": "opencode",
            "count": 1,
            "title": "OpenCode: Optimize About page",
            "session_label": "New",
            "task": "Optimize About page",
        }
    ]


def test_delete_memory_tool_schema_requires_text() -> None:
    schema = server._tool_schema(tools.context_workspace_delete_memory)["inputSchema"]

    assert schema["properties"]["text"] == {"type": "string"}
    assert schema["required"] == ["text"]


def test_recall_cache_round_trip_uses_valid_project_dir(tmp_path: Path) -> None:
    result = asyncio.run(
        tools.context_workspace_write_recall_cache(
            str(tmp_path),
            "Recovered Hermes session context.",
        )
    )

    recall_path = tmp_path / ".context-workspace" / "hermes" / "session-recall.md"
    metadata_path = tmp_path / ".context-workspace" / "hermes" / "last-refresh.json"
    assert result["written"] is True
    assert result["path"] == str(recall_path)
    assert recall_path.read_text(encoding="utf-8") == "Recovered Hermes session context.\n"
    assert metadata_path.exists()

    payload = asyncio.run(tools.context_workspace_read_recall_cache(str(tmp_path)))
    assert payload["exists"] is True
    assert payload["markdown"] == "Recovered Hermes session context.\n"


def test_recall_cache_rejects_unsafe_project_dir() -> None:
    with pytest.raises(SafetyError):
        asyncio.run(tools.context_workspace_write_recall_cache(str(Path.home()), "unsafe"))


def test_clear_recall_cache_removes_only_owned_files(tmp_path: Path) -> None:
    cache_dir = tmp_path / ".context-workspace" / "hermes"
    cache_dir.mkdir(parents=True)
    for name in ("session-recall.md", "last-refresh.json", "control-state.json", "keep.txt"):
        (cache_dir / name).write_text(name, encoding="utf-8")

    result = asyncio.run(tools.context_workspace_clear_recall_cache(str(tmp_path)))

    assert sorted(Path(path).name for path in result["removed"]) == [
        "control-state.json",
        "last-refresh.json",
        "session-recall.md",
    ]
    assert (cache_dir / "keep.txt").exists()
