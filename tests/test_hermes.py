import sqlite3
from collections.abc import Callable
from pathlib import Path

import pytest

from backend import hermes as hermes_module
from backend.hermes import HermesManager


@pytest.fixture(autouse=True)
def _clear_ask_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ask provider/model flags default to the user's Hermes config."""
    monkeypatch.delenv(hermes_module.HERMES_ASK_MODEL_ENV, raising=False)
    monkeypatch.delenv(hermes_module.HERMES_ASK_PROVIDER_ENV, raising=False)


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
    monkeypatch.setattr(hermes_module, "_hermes_version", lambda: "hermes 0.12.0")

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
    monkeypatch.setattr(hermes_module, "_hermes_version", lambda: "Hermes Agent v0.12.0")

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


def test_ask_runs_on_native_windows(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    (hermes_home / "config.yaml").write_text("model: test\n", encoding="utf-8")

    monkeypatch.setattr(hermes_module.platform, "system", lambda: "Windows")
    monkeypatch.setattr(hermes_module.shutil, "which", lambda command: "C:/Program Files/Hermes/hermes.exe" if command == "hermes" else None)
    monkeypatch.setattr(hermes_module, "_hermes_version", lambda: "Hermes Agent v0.12.0")

    calls: list[dict[str, object]] = []

    def fake_run(*args: object, **kwargs: object) -> object:
        calls.append({"args": args[0], **kwargs})
        return hermes_module.subprocess.CompletedProcess(
            args=args[0],
            returncode=0,
            stdout="WIN_OK\n",
            stderr="",
        )

    monkeypatch.setattr(hermes_module.subprocess, "run", fake_run)

    # Native Windows Hermes answers directly; the old WSL bridge no longer blocks ask().
    result = HermesManager(hermes_home=hermes_home).ask(
        project_dir=tmp_path,
        question="Say win ok.",
    )

    assert result.answer == "WIN_OK"
    assert calls[-1]["args"][0] == "hermes"
    assert calls[-1]["args"][1] == "--oneshot"
    assert calls[-1]["cwd"] == tmp_path


def _installed_hermes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> HermesManager:
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir(parents=True, exist_ok=True)
    (hermes_home / "config.yaml").write_text("model: test\n", encoding="utf-8")
    monkeypatch.setattr(hermes_module.platform, "system", lambda: "Linux")
    monkeypatch.setattr(
        hermes_module.shutil,
        "which",
        lambda command: f"/usr/bin/{command}" if command == "hermes" else None,
    )
    monkeypatch.setattr(hermes_module, "_hermes_version", lambda: "hermes 0.12.0")
    return HermesManager(hermes_home=hermes_home)


def _fake_run(calls: list[dict[str, object]]) -> Callable[..., object]:
    def fake_run(*args: object, **kwargs: object) -> object:
        calls.append({"args": args[0], **kwargs})
        return hermes_module.subprocess.CompletedProcess(
            args=args[0],
            returncode=0,
            stdout="OK\n",
            stderr="",
        )

    return fake_run


def _make_session_db(hermes_home: Path, rows: list[tuple[object, ...]]) -> None:
    """Create a minimal Hermes state.db.

    Rows are (id, cwd, git_repo_root, started_at, last_activity_at,
    ended_at, archived).
    """
    db = hermes_home / "state.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(db))
    con.execute(
        "CREATE TABLE sessions ("
        " id TEXT PRIMARY KEY, cwd TEXT, git_repo_root TEXT,"
        " started_at REAL, last_activity_at REAL, ended_at REAL, archived INTEGER)"
    )
    con.executemany(
        "INSERT INTO sessions "
        "(id, cwd, git_repo_root, started_at, last_activity_at, ended_at, archived) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        rows,
    )
    con.commit()
    con.close()


def test_ask_adds_provider_model_flags_from_env(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _installed_hermes(tmp_path, monkeypatch)
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(hermes_module.subprocess, "run", _fake_run(calls))
    monkeypatch.setenv(hermes_module.HERMES_ASK_PROVIDER_ENV, "deepseek")
    monkeypatch.setenv(hermes_module.HERMES_ASK_MODEL_ENV, "deepseek-v4-flash")

    manager.ask(project_dir=tmp_path, question="Hi")

    args = calls[-1]["args"]
    assert isinstance(args, list)
    assert args[1] == "--oneshot"
    provider_index = args.index("--provider")
    model_index = args.index("--model")
    assert args[provider_index + 1] == "deepseek"
    assert args[model_index + 1] == "deepseek-v4-flash"
    # The prompt must immediately follow --oneshot; flags come after it.
    assert provider_index > 2 and model_index > 2
    assert "--resume" not in args


def test_ask_without_env_uses_hermes_default_config(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _installed_hermes(tmp_path, monkeypatch)
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(hermes_module.subprocess, "run", _fake_run(calls))

    manager.ask(project_dir=tmp_path, question="Hi")

    args = calls[-1]["args"]
    assert isinstance(args, list)
    assert args == ["hermes", "--oneshot", args[2]]
    assert "--provider" not in args and "--model" not in args


def test_ask_resumes_explicit_session_id(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _installed_hermes(tmp_path, monkeypatch)
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(hermes_module.subprocess, "run", _fake_run(calls))

    manager.ask(project_dir=tmp_path, question="Hi", session_id="abc123")

    args = calls[-1]["args"]
    assert isinstance(args, list)
    assert args[args.index("--resume") + 1] == "abc123"


def test_ask_resumes_newest_session_for_project_only(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hermes_home = tmp_path / ".hermes"
    _make_session_db(
        hermes_home,
        [
            # More recent, but belongs to an unrelated project.
            ("other-project", "D:/Other/Project", None, 1000.0, 2000.0, None, 0),
            ("same-project-old", "D:/My/Project", None, 500.0, 600.0, None, 0),
            ("same-project-new", "D:/My/Project", None, 700.0, 800.0, None, 0),
        ],
    )
    manager = _installed_hermes(tmp_path, monkeypatch)
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(hermes_module.subprocess, "run", _fake_run(calls))

    manager.ask(project_dir=Path("D:/My/Project"), question="Hi")

    args = calls[-1]["args"]
    assert isinstance(args, list)
    assert args[args.index("--resume") + 1] == "same-project-new"


def test_ask_matches_windows_path_and_subdirectory_cwd(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hermes_home = tmp_path / ".hermes"
    _make_session_db(
        hermes_home,
        [
            # Windows-style backslashes, launched from a subdirectory of the project.
            ("win-session", "D:\\My\\Project\\subdir", None, 1000.0, 1001.0, None, 0),
        ],
    )
    manager = _installed_hermes(tmp_path, monkeypatch)
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(hermes_module.subprocess, "run", _fake_run(calls))

    manager.ask(project_dir=Path("D:/My/Project"), question="Hi")

    args = calls[-1]["args"]
    assert isinstance(args, list)
    assert args[args.index("--resume") + 1] == "win-session"


def test_ask_resumes_session_matching_git_root(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hermes_home = tmp_path / ".hermes"
    _make_session_db(
        hermes_home,
        [("git-session", None, "D:/My/Project", 1000.0, 1001.0, None, 0)],
    )
    manager = _installed_hermes(tmp_path, monkeypatch)
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(hermes_module.subprocess, "run", _fake_run(calls))

    manager.ask(project_dir=Path("D:/My/Project"), question="Hi")

    args = calls[-1]["args"]
    assert isinstance(args, list)
    assert args[args.index("--resume") + 1] == "git-session"


def test_ask_skips_resume_when_no_session_for_project(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hermes_home = tmp_path / ".hermes"
    _make_session_db(
        hermes_home,
        [("other-project", "D:/Other/Project", None, 1000.0, 2000.0, None, 0)],
    )
    manager = _installed_hermes(tmp_path, monkeypatch)
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(hermes_module.subprocess, "run", _fake_run(calls))

    manager.ask(project_dir=Path("D:/My/Project"), question="Hi")

    args = calls[-1]["args"]
    assert isinstance(args, list)
    assert "--resume" not in args


def test_ask_ignores_malformed_session_db(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir(parents=True, exist_ok=True)
    (hermes_home / "state.db").write_bytes(b"not a sqlite file")
    manager = _installed_hermes(tmp_path, monkeypatch)
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(hermes_module.subprocess, "run", _fake_run(calls))

    manager.ask(project_dir=Path("D:/My/Project"), question="Hi")

    args = calls[-1]["args"]
    assert isinstance(args, list)
    assert "--resume" not in args
