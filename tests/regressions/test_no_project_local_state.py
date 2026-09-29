"""Athena must never create state inside a user's project directory.

Recall caches, session handoffs, immersive context bundles, and legacy run
artifacts used to write `<project>/.context-workspace/`. Those features were
removed; these checks keep any backend route from reintroducing project-local
state. (App-level state under `~/.context-workspace/` is unrelated and fine.)
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import backend.app as app_module
from backend.app import create_app
from backend.hermes import HermesAskResult, HermesStatus
from backend.memory import HermesMemoryStore


class _InstalledHermes:
    def __init__(self, home: Path) -> None:
        self.hermes_home = home

    def status(self, *, refresh: bool = False) -> HermesStatus:
        return HermesStatus(
            installed=True,
            command_path="/usr/bin/hermes",
            version="hermes test",
            hermes_home=self.hermes_home,
            config_exists=True,
            memory_path=None,
            native_windows=False,
            install_supported=False,
            setup_required=False,
            message="Hermes Agent is installed.",
        )

    def ask(self, *, project_dir: Path, question: str, **_: object) -> HermesAskResult:
        return HermesAskResult(answer=f"answer: {question}", project_dir=project_dir, returncode=0, stderr="")


def _client(tmp_path: Path) -> TestClient:
    return TestClient(
        create_app(
            memory=HermesMemoryStore(memory_path=tmp_path / "hermes" / "MEMORY.md"),
            hermes=_InstalledHermes(tmp_path / "hermes"),
        )
    )


def test_project_scoped_routes_leave_the_project_directory_untouched(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setattr(app_module, "list_native_agent_sessions", lambda *args, **kwargs: [])
    client = _client(tmp_path)

    responses = [
        client.post("/hermes/ask", json={"project_dir": str(project), "question": "Use session recall context."}),
        client.post("/memory/store", json={"project_dir": str(project), "text": "Remember the build command."}),
        client.get("/memory/hermes/project", params={"project_dir": str(project)}),
        client.get("/agents/sessions", params={"project_dir": str(project)}),
        client.get("/hermes/status"),
        client.get("/agents/adapters"),
    ]

    assert [response.status_code for response in responses] == [200] * len(responses)
    assert list(project.iterdir()) == []


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/workspace/snapshot"),
        ("post", "/context/bundles"),
        ("get", "/context/bundles/bundle-1"),
        ("post", "/context/turns"),
        ("get", "/hermes/recall/status"),
        ("post", "/hermes/recall/refresh"),
        ("post", "/hermes/recall/write"),
        ("post", "/hermes/recall/mark-used"),
        ("post", "/agents/spawn"),
        ("get", "/agents/runs"),
        ("get", "/agents/runs/run_12345678"),
        ("post", "/agents/runs/run_12345678/cancel"),
        ("get", "/agents/runs/run_12345678/artifacts/stdout"),
    ],
)
def test_removed_project_state_routes_stay_removed(tmp_path: Path, method: str, path: str) -> None:
    response = getattr(_client(tmp_path), method)(path)

    assert response.status_code == 404
