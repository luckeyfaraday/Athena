from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MCP_ROOT = ROOT / "mcp_server"
if str(MCP_ROOT) not in sys.path:
    sys.path.insert(0, str(MCP_ROOT))

import client
from config import Settings


def test_explicit_backend_url_wins(tmp_path: Path, monkeypatch) -> None:
    state_path = tmp_path / "backend.json"
    state_path.write_text(json.dumps({"baseUrl": "http://127.0.0.1:50379"}), encoding="utf-8")
    monkeypatch.setattr(client, "_running_under_wsl", lambda: True)

    settings = Settings(
        backend_url="http://manual-host:9000",
        backend_state_path=state_path,
        windows_host="172.20.1.1",
    )

    assert client.get_backend_url(settings) == "http://manual-host:9000"


def test_backend_json_localhost_is_unchanged_outside_wsl(tmp_path: Path, monkeypatch) -> None:
    state_path = tmp_path / "backend.json"
    state_path.write_text(json.dumps({"baseUrl": "http://127.0.0.1:50379"}), encoding="utf-8")
    monkeypatch.setattr(client, "_running_under_wsl", lambda: False)

    settings = Settings(backend_url=None, backend_state_path=state_path)

    assert client.get_backend_url(settings) == "http://127.0.0.1:50379"


def test_backend_json_localhost_translates_under_wsl(tmp_path: Path, monkeypatch) -> None:
    state_path = tmp_path / "backend.json"
    state_path.write_text(json.dumps({"baseUrl": "http://127.0.0.1:50379"}), encoding="utf-8")
    monkeypatch.setattr(client, "_running_under_wsl", lambda: True)

    settings = Settings(
        backend_url=None,
        backend_state_path=state_path,
        windows_host="172.20.1.1",
    )

    assert client.get_backend_url(settings) == "http://172.20.1.1:50379"


def test_backend_json_non_loopback_is_unchanged_under_wsl(tmp_path: Path, monkeypatch) -> None:
    state_path = tmp_path / "backend.json"
    state_path.write_text(json.dumps({"baseUrl": "http://192.168.1.10:50379"}), encoding="utf-8")
    monkeypatch.setattr(client, "_running_under_wsl", lambda: True)

    settings = Settings(
        backend_url=None,
        backend_state_path=state_path,
        windows_host="172.20.1.1",
    )

    assert client.get_backend_url(settings) == "http://192.168.1.10:50379"


def test_resolv_conf_nameserver_can_supply_windows_host(tmp_path: Path) -> None:
    resolv = tmp_path / "resolv.conf"
    resolv.write_text("search localdomain\nnameserver 172.25.144.1\n", encoding="utf-8")

    assert client._windows_host_from_resolv_conf(resolv) == "172.25.144.1"


def test_control_token_env_override_wins(tmp_path: Path) -> None:
    state_path = tmp_path / "electron-control.json"
    state_path.write_text(json.dumps({"baseUrl": "http://127.0.0.1:5", "token": "from-file"}), encoding="utf-8")
    settings = Settings(electron_control_token="from-env", electron_control_state_path=state_path)

    assert client.get_electron_control_token(settings) == "from-env"


def test_control_token_read_from_discovery_file(tmp_path: Path) -> None:
    state_path = tmp_path / "electron-control.json"
    state_path.write_text(json.dumps({"baseUrl": "http://127.0.0.1:5", "token": "secret-123"}), encoding="utf-8")
    settings = Settings(electron_control_token=None, electron_control_state_path=state_path)

    assert client.get_electron_control_token(settings) == "secret-123"


def test_control_token_absent_returns_none(tmp_path: Path) -> None:
    state_path = tmp_path / "electron-control.json"
    state_path.write_text(json.dumps({"baseUrl": "http://127.0.0.1:5"}), encoding="utf-8")
    settings = Settings(electron_control_token=None, electron_control_state_path=state_path)

    assert client.get_electron_control_token(settings) is None
    # Missing file is also tolerated.
    assert client.get_electron_control_token(Settings(electron_control_token=None, electron_control_state_path=tmp_path / "missing.json")) is None


def test_control_auth_headers_shape() -> None:
    assert client._control_auth_headers("abc") == {"Authorization": "Bearer abc"}
    assert client._control_auth_headers(None) == {}
