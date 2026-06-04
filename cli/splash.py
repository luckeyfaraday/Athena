"""Athena TUI splash — a branded loading animation for curses.

Replaces the black screen that used to sit on screen while the TUI's first
``refresh()`` talks to the backend. Pure stdlib ``curses`` + ASCII so it runs
anywhere you can SSH (no block-drawing or 256-colour assumptions).

The art mirrors the Athena brand:
  * the *mark* — the six-spoke radiant burst from ``athena-mark.svg`` (a top and
    bottom stroke plus four diagonals around a hollow centre) — blooms outward;
  * the *wordmark* — ``ATHENA`` — wipes in beneath it; and
  * a warm gold shimmer (the brand accent ``#d9c48a``) sweeps the wordmark while
    the backend is still loading.

Colour pairs are configured by ``tui.run_tui`` before we run: 1=cyan, 2=yellow
(our gold accent), 3=white (the cream wordmark). Everything degrades to plain
text if colour or space is unavailable.
"""

from __future__ import annotations

import curses
import time
from typing import Callable

# Six spokes of the mark as (row-step, col-step, glyph). Columns step by two so
# the diagonals read at roughly the right angle given a terminal cell's ~2:1
# height:width ratio. The centre cell is left hollow, like the SVG.
_SPOKES = (
    (-1, 0, "|"),   # top
    (1, 0, "|"),    # bottom
    (-1, -2, "\\"), # upper-left
    (-1, 2, "/"),   # upper-right
    (1, -2, "/"),   # lower-left
    (1, 2, "\\"),   # lower-right
)
_SPOKE_LEN = 3  # cells per spoke (excluding the hollow centre)

# 5-row ASCII wordmark, one column-group per letter.
_GLYPHS = {
    "A": (" ### ", "#   #", "#####", "#   #", "#   #"),
    "T": ("#####", "  #  ", "  #  ", "  #  ", "  #  "),
    "H": ("#   #", "#   #", "#####", "#   #", "#   #"),
    "E": ("#####", "#    ", "#### ", "#    ", "#####"),
    "N": ("#   #", "##  #", "# # #", "#  ##", "#   #"),
}
_WORD = "ATHENA"
_SUBTITLE = "c o m m a n d   r o o m"

# Animation tuning (frames at ~28fps).
_FRAME = 0.035
_BURST_FRAMES = 12       # frames to fully bloom the mark
_WIPE_PER_FRAME = 3      # wordmark columns revealed per frame


def _wordmark_rows() -> list[str]:
    """Assemble the wordmark into five full-width strings (space between letters)."""
    rows = []
    for r in range(5):
        rows.append(" ".join(_GLYPHS[ch][r] for ch in _WORD))
    return rows


def _put(scr, y: int, x: int, text: str, attr: int = 0) -> None:
    """addstr that silently clips to the screen instead of raising."""
    if y < 0 or x < 0:
        return
    h, w = scr.getmaxyx()
    if y >= h or x >= w:
        return
    try:
        scr.addnstr(y, x, text, max(0, w - x - 1), attr)
    except curses.error:
        pass


def _render(scr, frame: int, *, final: bool) -> None:
    """Draw a single animation frame centred on screen."""
    scr.erase()
    h, w = scr.getmaxyx()
    cream = curses.color_pair(3) | curses.A_BOLD
    gold = curses.color_pair(2) | curses.A_BOLD
    dim = curses.color_pair(1) | curses.A_DIM

    word = _wordmark_rows()
    word_w = len(word[0])

    # Vertical layout: burst (7) · gap · wordmark (5) · gap · subtitle (1).
    block_h = (2 * _SPOKE_LEN + 1) + 1 + 5 + 1 + 1
    if h < block_h + 2 or w < word_w + 4:
        # Too small for the full lockup — show a graceful one-liner instead.
        msg = "ATHENA  ·  command room"
        _put(scr, h // 2, max(0, (w - len(msg)) // 2), msg, cream)
        dots = "." * (1 + (frame // 3) % 3) if not final else ""
        _put(scr, h // 2 + 1, max(0, (w - 8) // 2), f"loading{dots}", dim)
        scr.refresh()
        return

    top = (h - block_h) // 2
    cy = top + _SPOKE_LEN          # burst centre row
    cx = w // 2                    # burst centre col

    # --- the mark: spokes bloom from the hollow centre outward --------------
    grown = _SPOKE_LEN if final else min(_SPOKE_LEN, 1 + frame // 4)
    for dy, dx, glyph in _SPOKES:
        for i in range(1, grown + 1):
            _put(scr, cy + dy * i, cx + dx * i, glyph, cream)

    # --- the wordmark: a left-to-right wipe reveal --------------------------
    burst_done = final or frame >= _BURST_FRAMES
    if burst_done:
        wf = 10_000 if final else (frame - _BURST_FRAMES)
        reveal = min(word_w, wf * _WIPE_PER_FRAME)
        wx = cx - word_w // 2
        wy = cy + _SPOKE_LEN + 2
        # Gold shimmer sweeps the revealed wordmark once it's fully wiped in.
        shimmer = -1
        if not final and reveal >= word_w:
            shimmer = ((frame - _BURST_FRAMES) * 1) % (word_w + 10)
        for r in range(5):
            visible = word[r][:reveal]
            _put(scr, wy + r, wx, visible, cream)
            if 0 <= shimmer < len(visible) and visible[shimmer] != " ":
                _put(scr, wy + r, wx + shimmer, visible[shimmer], gold)

    # --- subtitle + loading ticker -----------------------------------------
    fully_in = final or (burst_done and (frame - _BURST_FRAMES) * _WIPE_PER_FRAME >= word_w)
    if fully_in:
        sy = cy + _SPOKE_LEN + 2 + 5 + 1
        _put(scr, sy, cx - len(_SUBTITLE) // 2, _SUBTITLE, dim)
        if not final:
            dots = "." * (1 + (frame // 4) % 3)
            tick = f"summoning the command room{dots}"
            _put(scr, sy + 1, cx - len(tick) // 2, tick, dim)

    scr.refresh()


def play(
    scr,
    is_ready: Callable[[], bool],
    *,
    min_seconds: float = 1.0,
    max_seconds: float = 8.0,
) -> None:
    """Animate the Athena splash until ``is_ready()`` (and ``min_seconds``).

    ``is_ready`` is polled each frame — pass it the ``is_set`` of a threading
    Event that your background load sets when done. The splash always shows for
    at least ``min_seconds`` so it never just flickers, and never blocks past
    ``max_seconds`` if the backend is pathologically slow. Any keypress skips it.
    """
    try:
        curses.curs_set(0)
    except curses.error:
        pass
    scr.nodelay(True)
    start = time.monotonic()
    frame = 0
    try:
        while True:
            elapsed = time.monotonic() - start
            try:
                if scr.getch() != -1:  # user pressed a key — skip ahead
                    break
            except curses.error:
                pass
            if elapsed >= max_seconds:
                break
            if elapsed >= min_seconds and is_ready():
                break
            _render(scr, frame, final=False)
            frame += 1
            time.sleep(_FRAME)
        # Settle on a fully-revealed frame so the hand-off doesn't flicker.
        _render(scr, frame, final=True)
        time.sleep(0.12)
    finally:
        scr.nodelay(False)
        scr.erase()
