from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.adapters.base import AdapterCommand
from backend.app import create_app
from backend.context_artifacts import RunArtifacts
from backend.hermes import HermesInstallResult, HermesStatus
from backend.memory import HermesMemoryStore
from backend.runs import Run, RunRegistry, RunStatus
from backend.runtime import RuntimeLimits


class FakeAdapter:
    agent_type = "codex"

    def __init__(self, fixture: Path, *, sleep: float = 0) -> None:
        self.fixture = fixture
        self.executable = sys.executable
        self.sleep = sleep

    def build_command(self, run: Run, artifacts: RunArtifacts) -> AdapterCommand:
        argv = [
            sys.executable,
            str(self.fixture),
            "--output-last-message",
            str(artifacts.result),
        ]
        if self.sleep:
            argv.extend(["--sleep", str(self.sleep)])
        return AdapterCommand(
            argv=argv,
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


def test_hermes_recall_status_reports_missing_cache(tmp_path: Path) -> None:
    client = _client(tmp_path)

    response = client.get("/hermes/recall/status", params={"project_dir": str(tmp_path)})

    assert response.status_code == 200
    recall = response.json()["recall"]
    assert recall["status"] == "missing"
    assert recall["exists"] is False
    assert recall["stale"] is True
    assert recall["bytes"] == 0
    assert recall["refreshed_at"] is None
    assert recall["refresh_configured"] is False


def test_hermes_recall_status_reports_configured_refresh_command(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CONTEXT_WORKSPACE_HERMES_REFRESH_CMD", "python scripts/hermes-refresh-recall.py")
    client = _client(tmp_path)

    response = client.get("/hermes/recall/status", params={"project_dir": str(tmp_path)})

    assert response.status_code == 200
    assert response.json()["recall"]["refresh_configured"] is True


def test_hermes_recall_status_reports_fresh_cache(tmp_path: Path) -> None:
    recall_dir = tmp_path / ".context-workspace" / "hermes"
    recall_dir.mkdir(parents=True)
    recall_text = "Fresh recall.\n"
    refreshed_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    (recall_dir / "session-recall.md").write_text(recall_text, encoding="utf-8")
    (recall_dir / "last-refresh.json").write_text(
        json.dumps(
            {
                "refreshed_at": refreshed_at,
                "source": "hermes-session-search",
                "bytes": len(recall_text.encode("utf-8")),
            }
        ),
        encoding="utf-8",
    )
    client = _client(tmp_path)

    response = client.get("/hermes/recall/status", params={"project_dir": str(tmp_path)})

    assert response.status_code == 200
    recall = response.json()["recall"]
    assert recall["status"] == "fresh"
    assert recall["exists"] is True
    assert recall["stale"] is False
    assert recall["bytes"] == (recall_dir / "session-recall.md").stat().st_size
    assert recall["source"] == "hermes-session-search"
    assert recall["refresh_configured"] is False


def test_hermes_recall_refresh_requires_configured_command(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CONTEXT_WORKSPACE_HERMES_REFRESH_CMD", raising=False)
    client = _client(tmp_path)

    response = client.post("/hermes/recall/refresh", json={"project_dir": str(tmp_path)})

    assert response.status_code == 409
    assert "CONTEXT_WORKSPACE_HERMES_REFRESH_CMD" in response.json()["detail"]


def test_hermes_recall_refresh_runs_configured_command(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    script = tmp_path / "refresh_recall.py"
    script.write_text(
        "\n".join(
            [
                "import json",
                "import os",
                "from datetime import UTC, datetime",
                "from pathlib import Path",
                "project = Path(os.environ['CONTEXT_WORKSPACE_PROJECT_DIR'])",
                "task = os.environ.get('CONTEXT_WORKSPACE_TASK_HINT', '')",
                "cache = project / '.context-workspace' / 'hermes'",
                "cache.mkdir(parents=True, exist_ok=True)",
                "text = f'## Recall\\n\\n- refreshed for {task}\\n'",
                "(cache / 'session-recall.md').write_text(text, encoding='utf-8')",
                "(cache / 'last-refresh.json').write_text(json.dumps({",
                "    'refreshed_at': datetime.now(UTC).isoformat().replace('+00:00', 'Z'),",
                "    'source': 'test-refresh-command',",
                "    'bytes': len(text.encode('utf-8')),",
                "}), encoding='utf-8')",
                "print('refreshed')",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("CONTEXT_WORKSPACE_HERMES_REFRESH_CMD", f'"{sys.executable}" "{script}"')
    client = _client(tmp_path)

    response = client.post(
        "/hermes/recall/refresh",
        json={"project_dir": str(tmp_path), "task_hint": "manual launch"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["refresh"]["returncode"] == 0
    assert "refreshed" in payload["refresh"]["stdout"]
    assert payload["recall"]["status"] == "fresh"
    assert payload["recall"]["source"] == "test-refresh-command"
    assert payload["recall"]["refresh_configured"] is True
    assert "manual launch" in (tmp_path / ".context-workspace" / "hermes" / "session-recall.md").read_text(encoding="utf-8")


def test_agent_adapters_endpoint_reports_configured_adapters(tmp_path: Path) -> None:
    client = _client(tmp_path)

    response = client.get("/agents/adapters")

    assert response.status_code == 200
    adapters = response.json()["adapters"]
    assert adapters["codex"]["configured"] is True
    assert adapters["codex"]["executable"] == sys.executable
    assert adapters["opencode"]["configured"] is False
    assert adapters["claude"]["configured"] is False


def test_agent_sessions_endpoint_returns_native_session_summary(tmp_path: Path) -> None:
    client = _client(tmp_path)

    response = client.get("/agents/sessions", params={"project_dir": str(tmp_path)})

    assert response.status_code == 200
    body = response.json()
    assert body["project_dir"] == str(tmp_path)
    assert body["sessions"] == []
    assert body["summary"] == "No native agent sessions were found for this workspace."


def test_agent_sessions_endpoint_rejects_unknown_provider(tmp_path: Path) -> None:
    client = _client(tmp_path)

    response = client.get("/agents/sessions", params={"project_dir": str(tmp_path), "provider": "unknown"})

    assert response.status_code == 400
    assert "Unsupported session provider" in response.json()["detail"]


def test_memory_endpoints_read_and_write_hermes_memory(tmp_path: Path) -> None:
    client = _client(tmp_path)

    stored = client.post("/memory/store", json={"text": "Codex adapter verified."})
    queried = client.get("/memory/hermes", params={"q": "codex"})
    empty = client.get("/memory/hermes")
    recent = client.get("/memory/recent", params={"limit": 2})

    assert stored.status_code == 200
    assert "Project context from Hermes memory" in queried.text
    assert "Codex adapter verified." in queried.text
    assert empty.status_code == 200
    assert empty.text == ""
    assert recent.json()["entries"][-1] == "[agent] asked Hermes memory about: codex"


def test_memory_delete_endpoint_removes_exact_entry(tmp_path: Path) -> None:
    client = _client(tmp_path)

    client.post("/memory/store", json={"text": "Keep this memory."})
    client.post("/memory/store", json={"text": "Delete this memory."})
    deleted = client.post("/memory/delete", json={"text": "Delete this memory."})
    recent = client.get("/memory/recent", params={"limit": 10})

    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True, "removed": 1}
    assert recent.json()["entries"] == ["Keep this memory."]


def test_project_memory_endpoint_filters_by_project_dir(tmp_path: Path) -> None:
    client = _client(tmp_path)

    client.post("/memory/store", json={"text": "Persephone project: /home/you/home_ai/projects/free-model-drops newsletter."})
    client.post("/memory/store", json={"text": "Context Workspace project: C:/Users/you/context-workspace Electron shell."})

    matched = client.get("/memory/hermes/project", params={"project_dir": "C:/Users/you/context-workspace"})
    missing = client.get("/memory/hermes/project", params={"project_dir": "C:/Users/you/unknown-project"})

    assert matched.status_code == 200
    assert "Context Workspace project" in matched.text
    assert "Persephone project" not in matched.text
    assert missing.status_code == 200
    assert missing.text == ""


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
    assert detail_body["artifacts"]["stdout"]["name"] == "stdout"
    assert detail_body["artifacts"]["stdout"]["url"] == f"/agents/runs/{run['run_id']}/artifacts/stdout"
    assert "path" not in detail_body["artifacts"]["stdout"]

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


def test_list_runs_endpoint_returns_spawned_runs(tmp_path: Path) -> None:
    client = _client(tmp_path)
    response = client.post(
        "/agents/spawn",
        json={
            "agent_type": "codex",
            "project_dir": str(tmp_path),
            "task": "Run fake agent.",
        },
    )

    runs = client.get("/agents/runs")

    assert response.status_code == 202
    assert runs.status_code == 200
    assert [run["run_id"] for run in runs.json()["runs"]] == [response.json()["run"]["run_id"]]


def test_spawn_rejects_when_global_limit_is_reached(tmp_path: Path) -> None:
    registry = RunRegistry()
    registry.create_run(agent_type="codex", project_dir=tmp_path, task="Already pending")
    client = _client(
        tmp_path,
        registry=registry,
        limits=RuntimeLimits(max_global=1, max_per_project=10, max_per_agent_type={"codex": 10}),
    )

    response = client.post(
        "/agents/spawn",
        json={
            "agent_type": "codex",
            "project_dir": str(tmp_path),
            "task": "Run fake agent.",
        },
    )

    assert response.status_code == 429
    assert "Global concurrency limit" in response.json()["detail"]


def test_spawn_uses_default_timeout_from_runtime_limits(tmp_path: Path) -> None:
    client = _client(
        tmp_path,
        adapter=FakeAdapter(Path(__file__).parent / "fixtures" / "fake_agent.py", sleep=0.2),
        limits=RuntimeLimits(default_timeout_seconds=0.01),
        execute_inline=True,
    )

    response = client.post(
        "/agents/spawn",
        json={
            "agent_type": "codex",
            "project_dir": str(tmp_path),
            "task": "Run fake agent.",
        },
    )

    assert response.status_code == 202
    detail = client.get(f"/agents/runs/{response.json()['run']['run_id']}")
    assert detail.json()["run"]["status"] == RunStatus.FAILED.value


def test_cancel_run_marks_active_run_cancelled(tmp_path: Path) -> None:
    client = _client(tmp_path, adapter=FakeAdapter(Path(__file__).parent / "fixtures" / "fake_agent.py", sleep=1), execute_inline=False)
    response = client.post(
        "/agents/spawn",
        json={
            "agent_type": "codex",
            "project_dir": str(tmp_path),
            "task": "Run slow fake agent.",
        },
    )
    run_id = response.json()["run"]["run_id"]

    cancelled = client.post(f"/agents/runs/{run_id}/cancel")

    assert cancelled.status_code == 200
    assert cancelled.json()["cancelled"] is True
    assert cancelled.json()["run"]["status"] == RunStatus.CANCELLED.value


def _client(
    tmp_path: Path,
    *,
    adapter: FakeAdapter | None = None,
    registry: RunRegistry | None = None,
    limits: RuntimeLimits | None = None,
    execute_inline: bool = True,
) -> TestClient:
    memory = HermesMemoryStore(memory_path=tmp_path / "MEMORY.md")
    registry = registry or RunRegistry()
    fixture = Path(__file__).parent / "fixtures" / "fake_agent.py"
    app = create_app(
        memory=memory,
        hermes=FakeHermesManager(tmp_path / ".hermes"),
        registry=registry,
        adapters={"codex": adapter or FakeAdapter(fixture)},
        limits=limits,
        execute_inline=execute_inline,
    )
    return TestClient(app)
