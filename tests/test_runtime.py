from pathlib import Path

from backend import runtime as runtime_module
from backend.runtime import RuntimeLimits, adapter_statuses, check_runtime_limits
from backend.runs import RunRegistry


class Adapter:
    agent_type = "codex"
    executable = "fake-codex"


def test_check_runtime_limits_allows_when_under_limits(tmp_path: Path) -> None:
    registry = RunRegistry()

    decision = check_runtime_limits(
        registry,
        RuntimeLimits(max_global=1, max_per_project=1, max_per_agent_type={"codex": 1}),
        project_dir=tmp_path,
        agent_type="codex",
    )

    assert decision.allowed is True


def test_check_runtime_limits_rejects_per_project_limit(tmp_path: Path) -> None:
    registry = RunRegistry()
    registry.create_run(agent_type="codex", project_dir=tmp_path, task="Pending")

    decision = check_runtime_limits(
        registry,
        RuntimeLimits(max_global=10, max_per_project=1, max_per_agent_type={"codex": 10}),
        project_dir=tmp_path,
        agent_type="codex",
    )

    assert decision.allowed is False
    assert "Project concurrency limit" in decision.reason


def test_adapter_statuses_reports_configured_and_missing_adapters(monkeypatch) -> None:
    monkeypatch.setattr(
        runtime_module.shutil,
        "which",
        lambda executable: "C:/fake/codex.exe" if executable == "fake-codex" else None,
    )

    statuses = adapter_statuses({"codex": Adapter()})

    assert statuses["codex"]["configured"] is True
    assert statuses["codex"]["installed"] is True
    assert statuses["codex"]["command_path"] == "C:/fake/codex.exe"
    assert statuses["opencode"]["configured"] is False
    assert statuses["opencode"]["installed"] is False
