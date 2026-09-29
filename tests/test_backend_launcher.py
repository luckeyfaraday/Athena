from __future__ import annotations

from backend import launcher
from mcp_server import server as mcp_server


def test_launcher_starts_uvicorn_with_requested_options(monkeypatch) -> None:
    calls: list[tuple[object, dict[str, object]]] = []
    monkeypatch.setattr(launcher.uvicorn, "run", lambda app, **kwargs: calls.append((app, kwargs)))

    result = launcher.main(["--host", "127.0.0.2", "--port", "9123", "--no-access-log"])

    assert result == 0
    assert calls == [
        (
            launcher.app,
            {"host": "127.0.0.2", "port": 9123, "access_log": False},
        )
    ]


def test_launcher_can_run_the_bundled_mcp_server(monkeypatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(mcp_server, "main", lambda: calls.append("mcp"))

    result = launcher.main(["--mcp-server"])

    assert result == 0
    assert calls == ["mcp"]
