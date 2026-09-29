from __future__ import annotations

import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import backend.app as app_module
import backend.runtime as runtime_module
from backend.app import create_app
from backend.hermes import HermesAskResult, HermesInstallResult, HermesStatus
from backend.memory import HermesMemoryStore


class FakeHermesManager:
    def __init__(self, home: Path) -> None:
        self.hermes_home = home
        self.installed = False
        self.status_calls: list[bool] = []

    def status(self, *, refresh: bool = False) -> HermesStatus:
        self.status_calls.append(refresh)
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

    def ask(
        self,
        *,
        project_dir: Path,
        question: str,
        context: str | None = None,
        timeout_seconds: float = 120,
        session_id: str | None = None,
    ) -> HermesAskResult:
        if not self.installed:
            raise RuntimeError("Hermes Agent is not installed.")
        answer = f"answer: {question}"
        if context:
            answer += f" | context: {context}"
        if session_id:
            answer += f" | session: {session_id}"
        return HermesAskResult(answer=answer, project_dir=project_dir, returncode=0, stderr="")


class FailingMemoryStore:
    def format_query_response(self, query: str, *, limit: int = 10) -> str:
        raise PermissionError("memory path denied")

    def format_project_context(self, project_dir: str | Path, *, limit: int = 10) -> str:
        raise PermissionError("memory path denied")

    def recent(self, *, limit: int = 10) -> list[object]:
        raise PermissionError("memory path denied")

    def append(self, text: str) -> object:
        raise PermissionError("memory path denied")

    def remove_exact(self, text: str) -> int:
        raise PermissionError("memory path denied")


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


def test_create_app_does_not_probe_hermes_at_startup(tmp_path: Path) -> None:
    hermes = FakeHermesManager(tmp_path / ".hermes")

    create_app(hermes=hermes)

    # status() may spawn `hermes --version`; startup must only read the home dir.
    assert hermes.status_calls == []


def test_hermes_status_endpoint_forwards_refresh(tmp_path: Path) -> None:
    hermes = FakeHermesManager(tmp_path / ".hermes")
    client = TestClient(create_app(memory=HermesMemoryStore(memory_path=tmp_path / "MEMORY.md"), hermes=hermes))

    client.get("/hermes/status")
    client.get("/hermes/status", params={"refresh": "true"})

    assert hermes.status_calls == [False, True]


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


def test_hermes_ask_endpoint_returns_direct_answer(tmp_path: Path) -> None:
    client = _client(tmp_path)
    client.post("/hermes/install", json={"confirm": True})

    response = client.post(
        "/hermes/ask",
        json={
            "project_dir": str(tmp_path),
            "question": "What changed?",
            "context": "Use the current workspace.",
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "answer": "answer: What changed? | context: Use the current workspace.",
        "project_dir": str(tmp_path),
        "source": "hermes-oneshot",
        "returncode": 0,
        "stderr": "",
    }


def test_hermes_ask_endpoint_does_not_create_project_state(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    client = _client(tmp_path)
    client.post("/hermes/install", json={"confirm": True})

    response = client.post(
        "/hermes/ask",
        json={"project_dir": str(project), "question": "Use session recall to get project context."},
    )

    assert response.status_code == 200
    # Every question goes to Hermes; there is no project-local shortcut cache.
    assert response.json()["source"] == "hermes-oneshot"
    assert response.json()["answer"] == "answer: Use session recall to get project context."
    assert list(project.iterdir()) == []


def test_hermes_ask_endpoint_forwards_explicit_session_id(tmp_path: Path) -> None:
    client = _client(tmp_path)
    client.post("/hermes/install", json={"confirm": True})

    response = client.post(
        "/hermes/ask",
        json={
            "project_dir": str(tmp_path),
            "question": "Continue the active discussion.",
            "session_id": "hermes-session-123",
        },
    )

    assert response.status_code == 200
    assert response.json()["answer"].endswith("| session: hermes-session-123")


def test_hermes_ask_endpoint_reports_unavailable_hermes(tmp_path: Path) -> None:
    client = _client(tmp_path)

    response = client.post(
        "/hermes/ask",
        json={"project_dir": str(tmp_path), "question": "What changed?"},
    )

    assert response.status_code == 502
    assert "not installed" in response.json()["detail"]


def test_agent_adapters_endpoint_reports_installed_clis(tmp_path: Path) -> None:
    client = _client(tmp_path)

    response = client.get("/agents/adapters")

    assert response.status_code == 200
    adapters = response.json()["adapters"]
    assert set(adapters) == {"codex", "opencode", "claude", "grok"}
    assert adapters["codex"]["executable"] == sys.executable
    assert adapters["codex"]["installed"] is True
    assert adapters["opencode"]["executable"] == "opencode"


def test_agent_adapters_endpoint_caches_path_lookups(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    lookups: list[str] = []

    def fake_which(executable: str) -> str | None:
        lookups.append(executable)
        return f"/usr/bin/{executable}" if executable == "codex" else None

    monkeypatch.setattr(runtime_module.shutil, "which", fake_which)
    client = TestClient(
        create_app(
            memory=HermesMemoryStore(memory_path=tmp_path / "MEMORY.md"),
            hermes=FakeHermesManager(tmp_path / ".hermes"),
        )
    )

    first = client.get("/agents/adapters")
    second = client.get("/agents/adapters")

    assert first.json() == second.json()
    assert first.json()["adapters"]["codex"]["installed"] is True
    assert sorted(lookups) == ["claude", "codex", "grok", "opencode"]

    refreshed = client.get("/agents/adapters", params={"refresh": "true"})

    assert refreshed.status_code == 200
    assert len(lookups) == 8


def test_agent_sessions_endpoint_returns_native_session_summary(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app_module, "list_native_agent_sessions", lambda *args, **kwargs: [])
    client = _client(tmp_path)

    response = client.get("/agents/sessions", params={"project_dir": str(tmp_path)})

    assert response.status_code == 200
    body = response.json()
    assert body["project_dir"] == str(tmp_path)
    assert body["sessions"] == []
    assert body["summary"] == "No native agent sessions were found for this workspace."


def test_project_agent_sessions_endpoint_coalesces_repeated_scans(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    def fake_list(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        nonlocal calls
        calls += 1
        return []

    monkeypatch.setattr(app_module, "list_native_agent_sessions", fake_list)
    client = _client(tmp_path)

    first = client.get("/agents/sessions", params={"project_dir": str(tmp_path)})
    second = client.get("/agents/sessions", params={"project_dir": str(tmp_path)})
    refreshed = client.get("/agents/sessions", params={"project_dir": str(tmp_path), "refresh": "true"})

    assert first.status_code == second.status_code == refreshed.status_code == 200
    assert calls == 2


def test_agent_sessions_endpoint_rejects_unknown_provider(tmp_path: Path) -> None:
    client = _client(tmp_path)

    response = client.get("/agents/sessions", params={"project_dir": str(tmp_path), "provider": "unknown"})

    assert response.status_code == 400
    assert "Unsupported session provider" in response.json()["detail"]


def test_all_agent_sessions_endpoint_uses_short_lived_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    class FakeSession:
        def __init__(self, session_id: str) -> None:
            self.session_id = session_id

        def payload(self) -> dict[str, str]:
            return {"id": self.session_id}

    def fake_list(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        nonlocal calls
        calls += 1
        return [FakeSession(f"session-{calls}")]

    monkeypatch.setattr(app_module, "list_native_agent_sessions", fake_list)
    monkeypatch.setattr(app_module, "format_agent_sessions_summary", lambda sessions: f"{len(sessions)} sessions")
    client = _client(tmp_path)

    first = client.get("/agents/sessions/all")
    second = client.get("/agents/sessions/all")

    assert first.status_code == 200
    assert second.status_code == 200
    assert calls == 1
    assert first.json()["sessions"] == [{"id": "session-1"}]
    assert first.json()["cache"]["hit"] is False
    assert second.json()["sessions"] == [{"id": "session-1"}]
    assert second.json()["cache"]["hit"] is True


def test_all_agent_sessions_concurrent_cold_misses_are_coalesced(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0
    scan_started = threading.Event()
    release_scan = threading.Event()

    def fake_list(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        nonlocal calls
        calls += 1
        scan_started.set()
        assert release_scan.wait(timeout=2)
        return []

    monkeypatch.setattr(app_module, "list_native_agent_sessions", fake_list)
    monkeypatch.setattr(app_module, "format_agent_sessions_summary", lambda sessions: "0 sessions")
    client = _client(tmp_path)

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(client.get, "/agents/sessions/all")
        assert scan_started.wait(timeout=2)
        second = pool.submit(client.get, "/agents/sessions/all")
        release_scan.set()
        responses = [first.result(timeout=2), second.result(timeout=2)]

    assert calls == 1
    assert all(response.status_code == 200 for response in responses)
    assert sorted(response.json()["cache"]["hit"] for response in responses) == [False, True]


def test_all_agent_sessions_endpoint_refresh_bypasses_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    class FakeSession:
        def __init__(self, session_id: str) -> None:
            self.session_id = session_id

        def payload(self) -> dict[str, str]:
            return {"id": self.session_id}

    def fake_list(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        nonlocal calls
        calls += 1
        return [FakeSession(f"session-{calls}")]

    monkeypatch.setattr(app_module, "list_native_agent_sessions", fake_list)
    monkeypatch.setattr(app_module, "format_agent_sessions_summary", lambda sessions: f"{len(sessions)} sessions")
    client = _client(tmp_path)

    client.get("/agents/sessions/all")
    refreshed = client.get("/agents/sessions/all", params={"refresh": "true"})

    assert calls == 2
    assert refreshed.json()["sessions"] == [{"id": "session-2"}]
    assert refreshed.json()["cache"]["hit"] is False


def test_all_agent_sessions_cache_is_bounded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app_module, "list_native_agent_sessions", lambda *args, **kwargs: [])
    monkeypatch.setattr(app_module, "format_agent_sessions_summary", lambda sessions: "0 sessions")
    client = _client(tmp_path)

    for index in range(app_module.ALL_SESSIONS_CACHE_MAX_ENTRIES + 8):
        response = client.get("/agents/sessions/all", params={"q": f"query-{index}"})
        assert response.status_code == 200

    assert len(client.app.state.all_sessions_cache) <= app_module.ALL_SESSIONS_CACHE_MAX_ENTRIES


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
    # Reads must not write: querying memory may not append query-log entries.
    assert recent.json()["entries"] == ["Codex adapter verified."]


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

    client.post("/memory/store", json={"text": "Persephone project: /home/you/projects/free-model-drops newsletter."})
    client.post("/memory/store", json={"text": "Context Workspace project: C:/Users/you/context-workspace Electron shell."})

    matched = client.get("/memory/hermes/project", params={"project_dir": "C:/Users/you/context-workspace"})
    missing = client.get("/memory/hermes/project", params={"project_dir": "C:/Users/you/unknown-project"})

    assert matched.status_code == 200
    assert "Context Workspace project" in matched.text
    assert "Persephone project" not in matched.text
    assert missing.status_code == 200
    assert missing.text == ""


def test_memory_store_with_project_dir_scopes_entry_for_project(tmp_path: Path) -> None:
    client = _client(tmp_path)

    stored = client.post(
        "/memory/store",
        json={"project_dir": str(tmp_path), "text": "Test 202 is ready"},
    )
    matched = client.get("/memory/hermes/project", params={"project_dir": str(tmp_path)})

    assert stored.status_code == 200
    assert stored.json()["entry"] == f"Project {tmp_path}: Test 202 is ready"
    assert matched.status_code == 200
    assert "Test 202 is ready" in matched.text


def test_memory_endpoints_report_unavailable_memory_clearly(tmp_path: Path) -> None:
    client = _client(tmp_path, memory=FailingMemoryStore())

    queried = client.get("/memory/hermes", params={"q": "codex"})
    project = client.get("/memory/hermes/project", params={"project_dir": str(tmp_path)})
    recent = client.get("/memory/recent")
    stored = client.post("/memory/store", json={"text": "Cannot write."})
    deleted = client.post("/memory/delete", json={"text": "Cannot delete."})

    for response in (queried, project, recent, stored, deleted):
        assert response.status_code == 503
        assert "Hermes memory is unavailable" in response.json()["detail"]


def _client(
    tmp_path: Path,
    *,
    memory: object | None = None,
) -> TestClient:
    memory = memory or HermesMemoryStore(memory_path=tmp_path / "MEMORY.md")
    app = create_app(
        memory=memory,
        hermes=FakeHermesManager(tmp_path / ".hermes"),
        agent_executables={"codex": sys.executable},
    )
    return TestClient(app)
