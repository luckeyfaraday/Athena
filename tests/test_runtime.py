from types import SimpleNamespace

import pytest

from backend import runtime as runtime_module
from backend.runtime import DEFAULT_AGENT_EXECUTABLES, AdapterStatusCache, adapter_statuses

# one PATH lookup per agent CLI Athena knows about
AGENTS = len(DEFAULT_AGENT_EXECUTABLES)


def test_adapter_statuses_reports_installed_and_missing_clis(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        runtime_module.shutil,
        "which",
        lambda executable: "C:/fake/codex.exe" if executable == "fake-codex" else None,
    )

    statuses = adapter_statuses({"codex": "fake-codex"})

    assert set(statuses) == {"codex", "opencode", "claude", "grok", "athena"}
    assert statuses["athena"]["executable"] == "athena-code"
    assert statuses["codex"]["executable"] == "fake-codex"
    assert statuses["codex"]["installed"] is True
    assert statuses["codex"]["command_path"] == "C:/fake/codex.exe"
    assert statuses["opencode"]["executable"] == "opencode"
    assert statuses["opencode"]["installed"] is False
    assert statuses["opencode"]["command_path"] is None


def _counting_which(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    lookups: list[str] = []

    def fake_which(executable: str) -> str | None:
        lookups.append(executable)
        return None

    monkeypatch.setattr(runtime_module.shutil, "which", fake_which)
    return lookups


def test_adapter_status_cache_reuses_lookups_within_ttl(monkeypatch: pytest.MonkeyPatch) -> None:
    lookups = _counting_which(monkeypatch)
    cache = AdapterStatusCache()

    first = cache.get()
    second = cache.get()

    assert first == second
    assert len(lookups) == AGENTS


def test_adapter_status_cache_refresh_bypasses_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    lookups = _counting_which(monkeypatch)
    cache = AdapterStatusCache()

    cache.get()
    cache.get(refresh=True)

    assert len(lookups) == 2 * AGENTS


def test_adapter_status_cache_expires_after_ttl(monkeypatch: pytest.MonkeyPatch) -> None:
    lookups = _counting_which(monkeypatch)
    now = [1000.0]
    monkeypatch.setattr(runtime_module, "time", SimpleNamespace(monotonic=lambda: now[0]))
    cache = AdapterStatusCache(ttl_seconds=300)

    cache.get()
    now[0] += 299
    cache.get()
    assert len(lookups) == AGENTS

    now[0] += 2
    cache.get()
    assert len(lookups) == 2 * AGENTS


def test_adapter_status_cache_is_keyed_on_path(monkeypatch: pytest.MonkeyPatch) -> None:
    lookups = _counting_which(monkeypatch)
    monkeypatch.setenv("PATH", "/first")
    cache = AdapterStatusCache()

    cache.get()
    monkeypatch.setenv("PATH", "/second")
    cache.get()

    assert len(lookups) == 2 * AGENTS


def test_adapter_status_cache_returns_copies(monkeypatch: pytest.MonkeyPatch) -> None:
    _counting_which(monkeypatch)
    cache = AdapterStatusCache()

    cache.get()["codex"]["installed"] = True

    assert cache.get()["codex"]["installed"] is False
