import argparse
import builtins

from cli import __main__ as cli_main


def test_tui_reports_missing_curses_with_install_hint(monkeypatch, capsys) -> None:
    real_import = builtins.__import__

    def fake_import(name, globals=None, locals=None, fromlist=(), level=0):  # noqa: A002, ANN001
        if (name == "cli.tui" or (name == "tui" and level == 1)) and "run_tui" in fromlist:
            raise ModuleNotFoundError("No module named '_curses'", name="_curses")
        return real_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    monkeypatch.setattr(cli_main.os, "name", "nt", raising=False)

    result = cli_main.cmd_tui(argparse.Namespace(backend_url=None, project_dir="."))

    captured = capsys.readouterr()
    assert result == 1
    assert "_curses" in captured.err
    assert "python -m pip install windows-curses" in captured.err


def test_sessions_grouping_does_not_import_tui(monkeypatch, capsys) -> None:
    real_import = builtins.__import__

    def fake_import(name, globals=None, locals=None, fromlist=(), level=0):  # noqa: A002, ANN001
        if name == "cli.tui":
            raise AssertionError("sessions output should not import cli.tui")
        return real_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", fake_import)

    cli_main._print_sessions_by_project(
        [
            {"workspace": "C:\\repo", "provider": "codex", "updated_at": "2026-06-06T12:00:00", "title": "Fix TUI"},
            {"provider": "hermes", "updated_at": "2026-06-06T11:00:00", "title": "No workspace"},
        ]
    )

    captured = capsys.readouterr()
    assert "C:\\repo" in captured.out
    assert "hermes" in captured.out
