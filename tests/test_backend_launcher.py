from __future__ import annotations

from pathlib import Path

from backend import launcher


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


def test_launcher_can_run_the_bundled_recall_refresh_script(tmp_path: Path) -> None:
    marker = tmp_path / "ran.txt"
    script = tmp_path / "refresh.py"
    script.write_text(
        "from pathlib import Path\n"
        f"Path({str(marker)!r}).write_text('refreshed', encoding='utf-8')\n",
        encoding="utf-8",
    )

    result = launcher.main(["--refresh-recall-script", str(script)])

    assert result == 0
    assert marker.read_text(encoding="utf-8") == "refreshed"
