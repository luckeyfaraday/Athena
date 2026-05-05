from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

from backend.adapters.base import AdapterCommand
from backend.app import create_app
from backend.context_artifacts import RunArtifacts
from backend.hermes import HermesInstallResult, HermesStatus
from backend.memory import HermesMemoryStore
from backend.runs import Run, RunRegistry, RunStatus


class FakeAdapter:
    agent_type = "codex"

    def __init__(self, fixture: Path) -> None:
        self.fixture = fixture

    def build_command(self, run: Run, artifacts: RunArtifacts) -> AdapterCommand:
        return AdapterCommand(
            argv=[
                sys.executable,
                str(self.fixture),
                "--output-last-message",
                str(artifacts.result),
            ],
            cwd=run.project_dir,
            stdin=f"run={run.run_id}\ncontext={artifacts.context}\n",
        )

    def summarize_result(self, run: Run, artifacts: RunArtifacts) -> str:
        return artifacts.result.read_text(encoding="utf-8").strip()


class FakeHermesManager:
    def __init__(self, home: Path) -> None:
        self.hermes_home = home
        self.installed = False

    def status(self) -> HermesStatus:
        return HermesStatus(
            installed=self.installed,
            command_path="C:/fake/hermes" if self.installed else None,
            version="hermes 0.12.0" if self.installed else None,
            hermes_home=self.hermes_home,
            config_exists=self.installed,
            memory_path=self.hermes_home / "memories" / "MEMORY.md" if self.installed else None,
            native_windows=False,
            install_supported=True,
            setup_required=False,
            message="Hermes Agent is installed." if self.installed else "Hermes Agent is not installed.",
        )

    def install(self, *, timeout_seconds: float = 600) -> HermesInstallResult:
        self.installed = True
        return HermesInstallResult(
            returncode=0,
            stdout="installed",
            stderr="",
            status=self.status(),
        )


def test_health_endpoint(tmp_path: Path) -> None:
    client = _client(tmp_path)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_hermes_status_endpoint(tmp_path: Path) -> None:
    client = _client(tmp_path)

    response = client.get("/hermes/status")

    assert response.status_code == 200
    hermes = response.json()["hermes"]
    assert hermes["installed"] is False
    assert hermes["install_supported"] is True


def test_hermes_install_requires_confirmation(tmp_path: Path) -> None:
    client = _client(tmp_path)

    response = client.post("/hermes/install", json={})

    assert response.status_code == 400


def test_hermes_install_endpoint_runs_manager(tmp_path: Path) -> None:
    client = _client(tmp_path)

    response = client.post("/hermes/install", json={"confirm": True})

    assert response.status_code == 200
    assert response.json()["returncode"] == 0
    assert response.json()["hermes"]["installed"] is True


def test_memory_endpoints_read_and_write_hermes_memory(tmp_path: Path) -> None:
    client = _client(tmp_path)

    stored = client.post("/memory/store", json={"text": "Codex adapter verified."})
    queried = client.get("/memory/hermes", params={"q": "codex"})
    recent = client.get("/memory/recent", params={"limit": 2})

    assert stored.status_code == 200
    assert "Project context from Hermes memory" in queried.text
    assert "Codex adapter verified." in queried.text
    assert recent.json()["entries"][-1] == "[agent] asked Hermes memory about: codex"


def test_spawn_endpoint_executes_fake_agent_and_records_memory(tmp_path: Path) -> None:
    client = _client(tmp_path)

    response = client.post(
        "/agents/spawn",
        json={
            "agent_type": "codex",
            "project_dir": str(tmp_path),
            "task": "Run fake agent.",
        },
    )

    assert response.status_code == 202
    run = response.json()["run"]
    assert run["agent_id"] == "codex-1"

    detail = client.get(f"/agents/runs/{run['run_id']}")
    assert detail.status_code == 200
    detail_body = detail.json()
    assert detail_body["run"]["status"] == RunStatus.SUCCEEDED.value
    assert detail_body["artifacts"]["context"]["exists"] is True
    assert detail_body["artifacts"]["stdout"]["exists"] is True
    assert detail_body["artifacts"]["stderr"]["exists"] is True
    assert detail_body["artifacts"]["result"]["exists"] is True
    assert detail_body["artifacts"]["result"]["size_bytes"] > 0

    stdout = client.get(f"/agents/runs/{run['run_id']}/artifacts/stdout")
    assert stdout.status_code == 200
    assert stdout.text.replace("\r\n", "\n") == "fake stdout\n"

    bounded_stdout = client.get(
        f"/agents/runs/{run['run_id']}/artifacts/stdout",
        params={"max_bytes": 4},
    )
    assert bounded_stdout.status_code == 200
    assert bounded_stdout.text.replace("\r\n", "\n").endswith("t\n")

    context = client.get(
        f"/agents/runs/{run['run_id']}/artifacts/context",
        params={"tail": False, "max_bytes": 32},
    )
    assert context.status_code == 200
    assert context.text.startswith("# Context Workspace")

    unknown = client.get(f"/agents/runs/{run['run_id']}/artifacts/nope")
    assert unknown.status_code == 404

    memory_text = (tmp_path / "MEMORY.md").read_text(encoding="utf-8")
    assert "[codex-1] Task: Run fake agent. | Status: pending" in memory_text
    assert "fake final message" in memory_text


def _client(tmp_path: Path) -> TestClient:
    memory = HermesMemoryStore(memory_path=tmp_path / "MEMORY.md")
    registry = RunRegistry()
    fixture = Path(__file__).parent / "fixtures" / "fake_agent.py"
    app = create_app(
        memory=memory,
        hermes=FakeHermesManager(tmp_path / ".hermes"),
        registry=registry,
        adapters={"codex": FakeAdapter(fixture)},
        execute_inline=True,
    )
    return TestClient(app)
