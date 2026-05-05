from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

from backend.adapters.base import AdapterCommand
from backend.app import create_app
from backend.context_artifacts import RunArtifacts
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


def test_health_endpoint(tmp_path: Path) -> None:
    client = _client(tmp_path)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


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
    assert detail.json()["run"]["status"] == RunStatus.SUCCEEDED.value

    memory_text = (tmp_path / "MEMORY.md").read_text(encoding="utf-8")
    assert "[codex-1] Task: Run fake agent. | Status: pending" in memory_text
    assert "fake final message" in memory_text


def _client(tmp_path: Path) -> TestClient:
    memory = HermesMemoryStore(memory_path=tmp_path / "MEMORY.md")
    registry = RunRegistry()
    fixture = Path(__file__).parent / "fixtures" / "fake_agent.py"
    app = create_app(
        memory=memory,
        registry=registry,
        adapters={"codex": FakeAdapter(fixture)},
        execute_inline=True,
    )
    return TestClient(app)
