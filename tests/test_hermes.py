from pathlib import Path

import pytest

from backend import hermes as hermes_module
from backend.hermes import HermesManager


def test_status_reports_missing_native_windows_as_unsupported(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(hermes_module.platform, "system", lambda: "Windows")
    monkeypatch.setattr(hermes_module.shutil, "which", lambda command: None)

    status = HermesManager(hermes_home=tmp_path / ".hermes").status()

    assert status.installed is False
    assert status.native_windows is True
    assert status.install_supported is False
    assert "WSL2" in status.message


def test_status_detects_installed_hermes_with_memory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hermes_home = tmp_path / ".hermes"
    memory = hermes_home / "memories" / "MEMORY.md"
    memory.parent.mkdir(parents=True)
    memory.write_text("§\nRemember this.\n", encoding="utf-8")
    (hermes_home / "config.yaml").write_text("model: test\n", encoding="utf-8")

    monkeypatch.setattr(hermes_module.platform, "system", lambda: "Linux")
    monkeypatch.setattr(hermes_module.shutil, "which", lambda command: f"/usr/bin/{command}")
    monkeypatch.setattr(hermes_module, "_hermes_version", lambda: "hermes 0.12.0")

    status = HermesManager(hermes_home=hermes_home).status()

    assert status.installed is True
    assert status.setup_required is False
    assert status.memory_path == memory
    assert status.version == "hermes 0.12.0"


def test_status_detects_wsl_hermes_on_native_windows(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hermes_home = tmp_path / ".hermes"
    memory = hermes_home / "memories" / "MEMORY.md"
    memory.parent.mkdir(parents=True)
    memory.write_text("§\nWSL memory.\n", encoding="utf-8")
    (hermes_home / "config.yaml").write_text("model: test\n", encoding="utf-8")

    monkeypatch.setattr(hermes_module.platform, "system", lambda: "Windows")
    monkeypatch.setattr(hermes_module.shutil, "which", lambda command: "C:/Windows/System32/wsl.exe" if command == "wsl.exe" else None)

    def fake_run(*args: object, **kwargs: object) -> object:
        return hermes_module.subprocess.CompletedProcess(
            args=args[0],
            returncode=0,
            stdout="\n".join(
                [
                    "__HERMES_COMMAND__/home/you/.local/bin/hermes",
                    "__HERMES_VERSION__Hermes Agent v0.12.0",
                    f"__HERMES_HOME__{hermes_home}",
                ]
            ),
            stderr="",
        )

    monkeypatch.setattr(hermes_module.subprocess, "run", fake_run)

    status = HermesManager(hermes_home=Path("C:/Users/you/.hermes")).status()

    assert status.installed is True
    assert status.native_windows is True
    assert status.command_path == "wsl:/home/you/.local/bin/hermes"
    assert status.hermes_home == hermes_home
    assert status.memory_path == memory
    assert status.message == "Hermes Agent is installed in WSL2."


def test_install_refuses_native_windows(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(hermes_module.platform, "system", lambda: "Windows")
    monkeypatch.setattr(hermes_module.shutil, "which", lambda command: None)

    with pytest.raises(RuntimeError, match="WSL2"):
        HermesManager(hermes_home=tmp_path / ".hermes").install()


def test_ask_runs_hermes_oneshot_in_project_dir(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    (hermes_home / "config.yaml").write_text("model: test\n", encoding="utf-8")

    monkeypatch.setattr(hermes_module.platform, "system", lambda: "Linux")
    monkeypatch.setattr(hermes_module.shutil, "which", lambda command: f"/usr/bin/{command}" if command == "hermes" else None)
    monkeypatch.setattr(hermes_module, "_hermes_version", lambda: "hermes 0.12.0")

    calls: list[dict[str, object]] = []

    def fake_run(*args: object, **kwargs: object) -> object:
        calls.append({"args": args[0], **kwargs})
        return hermes_module.subprocess.CompletedProcess(
            args=args[0],
            returncode=0,
            stdout="TEST_OK\n",
            stderr="",
        )

    monkeypatch.setattr(hermes_module.subprocess, "run", fake_run)

    result = HermesManager(hermes_home=hermes_home).ask(
        project_dir=tmp_path,
        question="Say test ok.",
        context="Athena direct ask.",
        timeout_seconds=30,
    )

    assert result.answer == "TEST_OK"
    assert result.project_dir == tmp_path
    assert calls[-1]["args"] == [
        "hermes",
        "--oneshot",
        (
            "Answer the user question directly and concisely.\n\n"
            "If Athena context is provided below, use it as optional background context.\n\n"
            "Do not start an interactive chat. Do not try to rediscover Athena session recall when Athena has already provided it.\n\n"
            "User question:\n\n"
            "Say test ok.\n\n"
            "Athena context:\n\n"
            "Athena direct ask."
        ),
    ]
    assert calls[-1]["cwd"] == tmp_path
    assert calls[-1]["timeout"] == 30
