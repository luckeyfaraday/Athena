import json
import sqlite3
import threading
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend import hermes as hermes_module
from backend.hermes import HermesManager


@pytest.fixture(autouse=True)
def _clear_hermes_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        hermes_module.HERMES_BIN_ENV,
        hermes_module.HERMES_ASK_MODEL_ENV,
        hermes_module.HERMES_ASK_PROVIDER_ENV,
        "HERMES_HOME",
    ):
        monkeypatch.delenv(name, raising=False)


def test_status_reports_missing_native_windows_as_uninstalled(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(hermes_module.platform, "system", lambda: "Windows")
    monkeypatch.setattr(hermes_module.shutil, "which", lambda command: None)

    status = HermesManager(hermes_home=tmp_path / ".hermes").status()

    assert status.installed is False
    assert status.native_windows is True
    assert status.install_supported is False
    assert "WSL" not in status.message
    assert "PATH" in status.message


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
    monkeypatch.setattr(hermes_module, "_hermes_version", lambda command: "hermes 0.12.0")

    status = HermesManager(hermes_home=hermes_home).status()

    assert status.installed is True
    assert status.setup_required is False
    assert status.memory_path == memory
    assert status.version == "hermes 0.12.0"


def test_status_detects_native_windows_hermes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hermes_home = tmp_path / ".hermes"
    memory = hermes_home / "memories" / "MEMORY.md"
    memory.parent.mkdir(parents=True)
    memory.write_text("§\nNative memory.\n", encoding="utf-8")
    (hermes_home / "config.yaml").write_text("model: test\n", encoding="utf-8")

    native_hermes = "C:/Program Files/Hermes/hermes.exe"
    monkeypatch.setattr(hermes_module.platform, "system", lambda: "Windows")
    monkeypatch.setattr(hermes_module.shutil, "which", lambda command: native_hermes if command == "hermes" else None)
    monkeypatch.setattr(hermes_module, "_hermes_version", lambda command: "Hermes Agent v0.12.0")

    # The native Windows build is detected directly from PATH with no WSL probe,
    # so no subprocess is spawned during status resolution.
    def fail_run(*args: object, **kwargs: object) -> object:
        raise AssertionError("status() must not shell out on native Windows")

    monkeypatch.setattr(hermes_module.subprocess, "run", fail_run)

    status = HermesManager(hermes_home=hermes_home).status()

    assert status.installed is True
    assert status.native_windows is True
    assert status.command_path == native_hermes
    assert status.hermes_home == hermes_home
    assert status.memory_path == memory
    assert status.message == "Hermes Agent is installed."


def test_install_refuses_native_windows(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(hermes_module.platform, "system", lambda: "Windows")
    monkeypatch.setattr(hermes_module.shutil, "which", lambda command: None)

    with pytest.raises(RuntimeError, match="native Windows Hermes build"):
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
    monkeypatch.setattr(hermes_module, "_hermes_version", lambda command: "hermes 0.12.0")

    calls: list[dict[str, object]] = []

    def fake_run(*args: object, **kwargs: object) -> object:
        calls.append({"args": args[0], **kwargs})
        return hermes_module.subprocess.CompletedProcess(
            args=args[0],
            returncode=0,
            stdout="TEST_OK\n",
            stderr="",
        )

    monkeypatch.setattr(hermes_module, "_run_hermes_command", fake_run)

    result = HermesManager(hermes_home=hermes_home).ask(
        project_dir=tmp_path,
        question="Say test ok.",
        context="Athena direct ask.",
        timeout_seconds=30,
    )

    assert result.answer == "TEST_OK"
    assert result.project_dir == tmp_path
    assert calls[-1]["args"] == [
        "/usr/bin/hermes",
        "--oneshot",
        (
            "Answer the user question directly and concisely.\n\n"
            "If Athena context is provided below, use it as optional background context.\n\n"
            "Do not start an interactive chat.\n\n"
            "User question:\n\n"
            "Say test ok.\n\n"
            "Athena context:\n\n"
            "Athena direct ask."
        ),
    ]
    assert calls[-1]["cwd"] == tmp_path
    assert calls[-1]["timeout_seconds"] == 30


def test_ask_runs_on_native_windows(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    (hermes_home / "config.yaml").write_text("model: test\n", encoding="utf-8")

    monkeypatch.setattr(hermes_module.platform, "system", lambda: "Windows")
    monkeypatch.setattr(hermes_module.shutil, "which", lambda command: "C:/Program Files/Hermes/hermes.exe" if command == "hermes" else None)
    monkeypatch.setattr(hermes_module, "_hermes_version", lambda command: "Hermes Agent v0.12.0")

    calls: list[dict[str, object]] = []

    def fake_run(*args: object, **kwargs: object) -> object:
        calls.append({"args": args[0], **kwargs})
        return hermes_module.subprocess.CompletedProcess(
            args=args[0],
            returncode=0,
            stdout="WIN_OK\n",
            stderr="",
        )

    monkeypatch.setattr(hermes_module, "_run_hermes_command", fake_run)

    # Native Windows Hermes answers directly; the old WSL bridge no longer blocks ask().
    result = HermesManager(hermes_home=hermes_home).ask(
        project_dir=tmp_path,
        question="Say win ok.",
    )

    assert result.answer == "WIN_OK"
    assert calls[-1]["args"][0] == "C:/Program Files/Hermes/hermes.exe"
    assert calls[-1]["args"][1] == "--oneshot"
    assert calls[-1]["cwd"] == tmp_path


def _installed_manager(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> HermesManager:
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir(parents=True, exist_ok=True)
    (hermes_home / "config.yaml").write_text("model: test\n", encoding="utf-8")
    monkeypatch.setattr(hermes_module.platform, "system", lambda: "Linux")
    monkeypatch.setattr(
        hermes_module.shutil,
        "which",
        lambda command: f"/usr/bin/{command}" if command == "hermes" else None,
    )
    monkeypatch.setattr(hermes_module, "_hermes_version", lambda command: "hermes 0.12.0")
    return HermesManager(hermes_home=hermes_home)


def _fake_ask_run(calls: list[dict[str, object]]) -> Callable[..., object]:
    def fake_run(*args: object, **kwargs: object) -> object:
        calls.append({"args": args[0], **kwargs})
        return hermes_module.subprocess.CompletedProcess(args=args[0], returncode=0, stdout="OK\n", stderr="")

    return fake_run


def _make_session_db(hermes_home: Path, rows: list[tuple[object, ...]]) -> None:
    connection = sqlite3.connect(str(hermes_home / "state.db"))
    connection.execute(
        "CREATE TABLE sessions ("
        " id TEXT PRIMARY KEY, cwd TEXT, git_repo_root TEXT,"
        " started_at REAL, last_activity_at REAL, ended_at REAL, archived INTEGER)"
    )
    connection.executemany(
        "INSERT INTO sessions "
        "(id, cwd, git_repo_root, started_at, last_activity_at, ended_at, archived) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        rows,
    )
    connection.commit()
    connection.close()


def test_default_home_honors_hermes_home_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    configured = tmp_path / "custom-hermes"
    monkeypatch.setenv("HERMES_HOME", str(configured))

    assert HermesManager().hermes_home == configured


def test_status_honors_explicit_hermes_bin(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    (hermes_home / "config.yaml").write_text("model: test\n", encoding="utf-8")
    executable = tmp_path / "Hermes Runtime" / "hermes.exe"
    executable.parent.mkdir()
    executable.write_text("binary", encoding="utf-8")
    monkeypatch.setenv(hermes_module.HERMES_BIN_ENV, str(executable))
    monkeypatch.setattr(hermes_module.platform, "system", lambda: "Windows")
    monkeypatch.setattr(hermes_module, "_hermes_version", lambda command: f"version from {command}")

    status = HermesManager(hermes_home=hermes_home).status()

    assert status.installed is True
    assert status.command_path == str(executable)
    assert str(executable) in (status.version or "")


def test_ask_adds_configured_provider_model_and_explicit_session(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _installed_manager(tmp_path, monkeypatch)
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(hermes_module, "_run_hermes_command", _fake_ask_run(calls))
    monkeypatch.setenv(hermes_module.HERMES_ASK_PROVIDER_ENV, "deepseek")
    monkeypatch.setenv(hermes_module.HERMES_ASK_MODEL_ENV, "deepseek-v4-flash")

    manager.ask(project_dir=tmp_path, question="Hi", session_id="session-123")

    args = calls[-1]["args"]
    assert isinstance(args, list)
    assert args[:3] == ["/usr/bin/hermes", "--oneshot", args[2]]
    assert args[args.index("--provider") + 1] == "deepseek"
    assert args[args.index("--model") + 1] == "deepseek-v4-flash"
    assert args[args.index("--resume") + 1] == "session-123"


def test_ask_without_provider_env_uses_hermes_default(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _installed_manager(tmp_path, monkeypatch)
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(hermes_module, "_run_hermes_command", _fake_ask_run(calls))

    manager.ask(project_dir=tmp_path, question="Hi")

    args = calls[-1]["args"]
    assert isinstance(args, list)
    assert "--provider" not in args
    assert "--model" not in args


def test_ask_auto_resumes_only_one_project_session(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _installed_manager(tmp_path, monkeypatch)
    _make_session_db(
        manager.hermes_home,
        [
            ("matching", str(tmp_path / "src"), str(tmp_path), 1.0, 2.0, None, 0),
            ("unrelated", str(tmp_path / "other"), str(tmp_path / "other"), 3.0, 4.0, None, 0),
        ],
    )
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(hermes_module, "_run_hermes_command", _fake_ask_run(calls))

    manager.ask(project_dir=tmp_path, question="Hi")

    args = calls[-1]["args"]
    assert isinstance(args, list)
    assert args[args.index("--resume") + 1] == "matching"


def test_ask_does_not_guess_between_multiple_project_sessions(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _installed_manager(tmp_path, monkeypatch)
    _make_session_db(
        manager.hermes_home,
        [
            ("first", str(tmp_path), str(tmp_path), 1.0, 2.0, None, 0),
            ("second", str(tmp_path / "src"), str(tmp_path), 3.0, 4.0, None, 0),
        ],
    )
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(hermes_module, "_run_hermes_command", _fake_ask_run(calls))

    manager.ask(project_dir=tmp_path, question="Hi")

    args = calls[-1]["args"]
    assert isinstance(args, list)
    assert "--resume" not in args


def test_session_matching_preserves_posix_case(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager = _installed_manager(tmp_path, monkeypatch)
    upper_project = Path("/home/dev/Repo")
    lower_project = Path("/home/dev/repo")
    _make_session_db(
        manager.hermes_home,
        [("wrong-case", str(lower_project), str(lower_project), 1.0, 2.0, None, 0)],
    )

    assert manager._sole_active_session_id_for_project(upper_project) is None


def test_session_matching_normalizes_windows_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager = _installed_manager(tmp_path, monkeypatch)
    _make_session_db(
        manager.hermes_home,
        [("windows", "D:\\My\\Project\\src", "d:/my/project", 1.0, 2.0, None, 0)],
    )

    assert manager._sole_active_session_id_for_project(Path("D:/MY/PROJECT")) == "windows"


def test_malformed_session_db_degrades_to_no_resume(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager = _installed_manager(tmp_path, monkeypatch)
    (manager.hermes_home / "state.db").write_bytes(b"not sqlite")

    assert manager._sole_active_session_id_for_project(tmp_path) is None


def test_run_hermes_command_terminates_process_tree_on_timeout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    terminated: list[object] = []

    class FakeProcess:
        pid = 42
        returncode = -9

        def __init__(self) -> None:
            self.calls = 0

        def communicate(self, timeout: float | None = None) -> tuple[str, str]:
            self.calls += 1
            if self.calls == 1:
                raise hermes_module.subprocess.TimeoutExpired(["hermes"], timeout or 0)
            return "partial", "retrying"

    process = FakeProcess()
    monkeypatch.setattr(hermes_module.subprocess, "Popen", lambda *args, **kwargs: process)
    monkeypatch.setattr(hermes_module, "_terminate_process_tree", lambda value: terminated.append(value))
    monkeypatch.setattr(hermes_module.platform, "system", lambda: "Linux")

    with pytest.raises(hermes_module.subprocess.TimeoutExpired) as caught:
        hermes_module._run_hermes_command(["hermes"], cwd=tmp_path, timeout_seconds=1)

    assert terminated == [process]
    assert caught.value.output == "partial"
    assert caught.value.stderr == "retrying"


def test_windows_cmd_invocation_transports_prompt_outside_shell_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    prompt = 'quote " ampersand & percent % and pipe |'
    monkeypatch.setattr(hermes_module.platform, "system", lambda: "Windows")
    monkeypatch.setattr(
        hermes_module.shutil,
        "which",
        lambda command: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
        if command == "powershell.exe"
        else None,
    )

    invocation, child_env = hermes_module._prepare_hermes_invocation(
        ["C:/Hermes Runtime/hermes.cmd", "--oneshot", prompt]
    )

    assert invocation[0].endswith("powershell.exe")
    assert prompt not in " ".join(invocation)
    assert child_env is not None
    assert child_env["ATHENA_HERMES_COMMAND"] == "C:/Hermes Runtime/hermes.cmd"
    assert json.loads(child_env["ATHENA_HERMES_ARGS_JSON"]) == ["--oneshot", prompt]


class _FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def monotonic(self) -> float:
        return self.now


def _cached_status_manager(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[HermesManager, Path, _FakeClock, list[str], list[str]]:
    """An installed Hermes whose executable is a real file (so it can be fingerprinted)."""
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    (hermes_home / "config.yaml").write_text("model: test\n", encoding="utf-8")
    executable = tmp_path / "bin" / "hermes"
    executable.parent.mkdir()
    executable.write_text("v1", encoding="utf-8")
    monkeypatch.setattr(hermes_module.platform, "system", lambda: "Linux")

    lookups: list[str] = []

    def fake_which(command: str) -> str | None:
        lookups.append(command)
        return str(executable) if command == "hermes" else None

    probes: list[str] = []

    def fake_version(command: str) -> str:
        probes.append(command)
        return f"hermes {len(probes)}"

    clock = _FakeClock()
    monkeypatch.setattr(hermes_module.shutil, "which", fake_which)
    monkeypatch.setattr(hermes_module, "_hermes_version", fake_version)
    monkeypatch.setattr(hermes_module, "time", SimpleNamespace(monotonic=clock.monotonic))
    return HermesManager(hermes_home=hermes_home), executable, clock, lookups, probes


def test_status_reuses_version_until_executable_changes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager, executable, clock, _lookups, probes = _cached_status_manager(tmp_path, monkeypatch)

    first = manager.status()
    # Past the status TTL and the path-resolution TTL: status is recomputed and
    # PATH is walked again, but the unchanged executable is not re-probed.
    clock.now += hermes_module.COMMAND_RESOLUTION_TTL_SECONDS + 1
    second = manager.status()

    assert len(probes) == 1
    assert first.version == second.version == "hermes 1"

    executable.write_text("v2 is a different build", encoding="utf-8")
    clock.now += hermes_module.STATUS_CACHE_TTL_SECONDS + 1
    third = manager.status()

    assert len(probes) == 2
    assert third.version == "hermes 2"


def test_status_caches_path_resolution(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager, _executable, clock, lookups, _probes = _cached_status_manager(tmp_path, monkeypatch)

    manager.status()
    resolved_lookups = len(lookups)
    clock.now += hermes_module.STATUS_CACHE_TTL_SECONDS + 1
    manager.status()

    assert len(lookups) == resolved_lookups

    clock.now += hermes_module.COMMAND_RESOLUTION_TTL_SECONDS
    manager.status()

    assert len(lookups) == 2 * resolved_lookups


def test_status_refresh_bypasses_every_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager, _executable, _clock, lookups, probes = _cached_status_manager(tmp_path, monkeypatch)

    manager.status()
    manager.status()
    resolved_lookups = len(lookups)
    manager.status(refresh=True)

    assert len(probes) == 2
    assert len(lookups) == 2 * resolved_lookups


def test_status_ttl_starts_after_slow_probe_completes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager, _executable, clock, _lookups, probes = _cached_status_manager(tmp_path, monkeypatch)

    def slow_version(command: str) -> str:
        probes.append(command)
        clock.now += 50  # a cold venv can take a long time to answer --version
        return "hermes slow"

    monkeypatch.setattr(hermes_module, "_hermes_version", slow_version)

    manager.status()
    clock.now += 20  # 70s after the miss began, but only 20s after it finished
    manager.status()

    assert len(probes) == 1


def test_failed_version_probe_is_retried_after_backoff(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager, _executable, clock, _lookups, probes = _cached_status_manager(tmp_path, monkeypatch)

    def failing_version(command: str) -> None:
        probes.append(command)
        return None

    monkeypatch.setattr(hermes_module, "_hermes_version", failing_version)

    manager.status()
    clock.now += hermes_module.STATUS_CACHE_TTL_SECONDS + 1
    manager.status()
    assert len(probes) == 1

    clock.now += hermes_module.FAILED_VERSION_RETRY_SECONDS
    manager.status()
    assert len(probes) == 2


def test_concurrent_status_misses_share_one_probe(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    monkeypatch.setattr(hermes_module.platform, "system", lambda: "Linux")
    monkeypatch.setattr(
        hermes_module.shutil,
        "which",
        lambda command: f"/usr/bin/{command}" if command == "hermes" else None,
    )
    probe_started = threading.Event()
    release_probe = threading.Event()
    probes: list[str] = []

    def blocking_version(command: str) -> str:
        probes.append(command)
        probe_started.set()
        assert release_probe.wait(timeout=5)
        return "hermes 0.12.0"

    monkeypatch.setattr(hermes_module, "_hermes_version", blocking_version)
    manager = HermesManager(hermes_home=hermes_home)
    results: list[object] = []

    first = threading.Thread(target=lambda: results.append(manager.status()))
    first.start()
    assert probe_started.wait(timeout=5)
    second = threading.Thread(target=lambda: results.append(manager.status()))
    second.start()
    release_probe.set()
    first.join(timeout=5)
    second.join(timeout=5)

    assert len(probes) == 1
    assert len(results) == 2
    assert results[0] is results[1]


def test_install_invalidates_cached_status(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager, _executable, _clock, _lookups, probes = _cached_status_manager(tmp_path, monkeypatch)
    fake_which = hermes_module.shutil.which

    def which_with_installer_tools(command: str) -> str | None:
        return f"/usr/bin/{command}" if command in {"bash", "curl"} else fake_which(command)

    monkeypatch.setattr(hermes_module.shutil, "which", which_with_installer_tools)
    monkeypatch.setattr(
        hermes_module.subprocess,
        "run",
        lambda *args, **kwargs: hermes_module.subprocess.CompletedProcess(args[0], 0, "installed", ""),
    )

    manager.status()
    result = manager.install()

    assert len(probes) == 2
    assert result.status.version == "hermes 2"
