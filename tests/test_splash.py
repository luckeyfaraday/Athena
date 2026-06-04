"""Tests for the TUI splash animation's terminal-free logic.

The curses rendering itself needs a real terminal (smoke-tested manually), but
the wordmark assembly and play()'s timing contract are pure and worth guarding.
"""

from __future__ import annotations

import time

from cli import splash


def test_wordmark_rows_are_rectangular_and_spell_athena() -> None:
    rows = splash._wordmark_rows()
    assert len(rows) == 5
    # Every row is the same width (so the wipe reveal lines up across rows).
    assert len({len(r) for r in rows}) == 1
    # Each of the six letters contributes ink to the block.
    assert all("#" in r for r in rows)
    # Width = 6 letters * 5 cols + 5 single-space gaps.
    assert len(rows[0]) == 6 * 5 + 5


def test_play_respects_min_and_skips_when_ready(monkeypatch) -> None:
    """play() should animate for at least min_seconds even if work is instantly
    done, and never hang — exercised against a fake curses screen."""
    frames: list[int] = []

    class FakeScr:
        def getmaxyx(self):
            return (40, 120)

        def erase(self):
            pass

        def refresh(self):
            pass

        def addnstr(self, *a):
            pass

        def nodelay(self, _flag):
            pass

        def getch(self):
            return -1  # no key pressed

    # Skip the real terminal sleeps so the test stays fast but still loops.
    monkeypatch.setattr(splash.time, "sleep", lambda _s: frames.append(1))
    # Neutralise curses calls that need an initialised terminal.
    for name in ("curs_set", "color_pair"):
        monkeypatch.setattr(splash.curses, name, lambda *a, **k: 0)

    start = time.monotonic()
    splash.play(FakeScr(), lambda: True, min_seconds=0.05, max_seconds=2.0)
    elapsed = time.monotonic() - start
    assert elapsed >= 0.05  # honoured the minimum despite ready() being True
    assert frames  # it actually rendered at least one frame
