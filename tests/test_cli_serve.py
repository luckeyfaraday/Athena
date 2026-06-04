import json
from pathlib import Path

from cli import serve as serve_module


def test_clear_discovery_marks_matching_record_stopped(tmp_path: Path) -> None:
    discovery = tmp_path / "backend.json"
    discovery.write_text(
        json.dumps({"baseUrl": "http://127.0.0.1:8000", "pid": 123, "running": True}),
        encoding="utf-8",
    )

    serve_module._clear_discovery(discovery, base_url="http://127.0.0.1:8000", pid=123)

    data = json.loads(discovery.read_text(encoding="utf-8"))
    assert data == {"baseUrl": "http://127.0.0.1:8000", "pid": 123, "running": False}


def test_clear_discovery_leaves_replaced_record_running(tmp_path: Path) -> None:
    discovery = tmp_path / "backend.json"
    replacement = {"baseUrl": "http://127.0.0.1:49152", "pid": 456, "running": True}
    discovery.write_text(json.dumps(replacement), encoding="utf-8")

    serve_module._clear_discovery(discovery, base_url="http://127.0.0.1:8000", pid=123)

    assert json.loads(discovery.read_text(encoding="utf-8")) == replacement
