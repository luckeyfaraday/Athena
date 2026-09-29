"""Athena TUI — a curses command room for SSH.

Built on stdlib ``curses`` (no third-party deps) so it runs anywhere you can
SSH. The core trick for "launch" and "resume": you are already in a terminal, so
there is no need for Athena's Electron PTY layer. The TUI browses the backend's
data and, when you act, it *suspends itself*, execs the real agent binary
(``codex``, ``claude``, ...) directly in your terminal, and resumes when the
agent exits.

The single view lists resumable native sessions grouped by project (Enter
opens a project, then Enter resumes a session in this terminal).

Keys: ↑/↓ or j/k move · Enter act · n new launch · r refresh · / filter · q quit

"n" (launch) opens in-TUI pickers: choose a workspace (type to filter the list,
or pick "type a different path…" to spawn into a workspace with no sessions
yet), then the agent. Esc backs out at any step.
"""

from __future__ import annotations

import curses
import os
import subprocess
import sys
import threading
from typing import Any

from . import splash
from ._client import Backend, backend_status

# Interactive launch commands per agent. cwd is set to the project dir.
LAUNCH_COMMANDS = {
    "codex": "codex",
    "claude": "claude",
    "opencode": "opencode .",
    "athena": "athena-code .",
    "hermes": "hermes",
}


class AthenaTUI:
    def __init__(self, stdscr: "curses._CursesWindow", backend: Backend, project_dir: str) -> None:
        self.scr = stdscr
        self.backend = backend
        self.project = project_dir
        self.sel = 0               # selected row
        self.top = 0               # scroll offset
        self.filter = ""
        self.status = "Welcome to Athena. Sessions are grouped by project — Enter to open one, ? for help."
        self.summary: dict[str, Any] = {}
        self.sessions: list[dict[str, Any]] = []     # sessions across all projects
        self.projects: list[dict[str, Any]] = []     # grouped by workspace
        self.drill: str | None = None                # workspace we've drilled into

    # -- data ------------------------------------------------------------- #
    def refresh(self) -> None:
        self.summary = self._safe(lambda: {
            "health": self.backend.get("/health").get("status"),
            "hermes": self.backend.get("/hermes/status").get("hermes", {}),
        }, {})
        self.sessions = self._load_sessions()
        self._build_projects()

    def _load_sessions(self) -> list[dict[str, Any]]:
        """Cross-project listing, falling back to the cwd project on older
        backends that lack the /agents/sessions/all endpoint."""
        try:
            return self.backend.get("/agents/sessions/all", limit=500).get("sessions", [])
        except Exception:  # noqa: BLE001 - older backend (no /all endpoint)
            self.status = "Backend lacks cross-project listing — showing this project only. Restart Athena or use `athena serve`."
            return self._safe(
                lambda: self.backend.get("/agents/sessions", project_dir=self.project, limit=200).get("sessions", []),
                [],
            )

    def _build_projects(self) -> None:
        groups: dict[str, list[dict[str, Any]]] = {}
        for s in self.sessions:
            groups.setdefault(_group_key(s), []).append(s)
        projects = [
            {
                "workspace": ws,
                "sessions": items,
                "count": len(items),
                "updated_at": max((str(i.get("updated_at", "")) for i in items), default=""),
                "providers": sorted({str(i.get("provider", "")) for i in items if i.get("provider")}),
            }
            for ws, items in groups.items()
        ]
        projects.sort(key=lambda p: p["updated_at"], reverse=True)
        self.projects = projects
        if self.drill and self.drill not in groups:
            self.drill = None

    @staticmethod
    def _safe(fn, default):  # noqa: ANN001, ANN205
        try:
            return fn()
        except Exception:  # noqa: BLE001 - a down section shouldn't crash the TUI
            return default

    def rows(self) -> list[dict[str, Any]]:
        if self.drill is None:
            items, key = self.projects, "workspace"
        else:
            drilled = next((p for p in self.projects if p["workspace"] == self.drill), None)
            items, key = (drilled["sessions"] if drilled else []), "title"
        if not self.filter:
            return items
        f = self.filter.lower()
        return [it for it in items if f in str(it.get(key, "")).lower()]

    # -- drawing ---------------------------------------------------------- #
    def draw(self) -> None:
        self.scr.erase()
        h, w = self.scr.getmaxyx()
        self._draw_header(w)
        self._draw_tabs(w)
        self._draw_body(h, w)
        self._draw_footer(h, w)
        self.scr.refresh()

    def _line(self, y: int, x: int, text: str, w: int, attr: int = 0) -> None:
        self.scr.addnstr(y, x, text.ljust(w - x - 1), w - x - 1, attr)

    def _draw_header(self, w: int) -> None:
        s = self.summary
        hermes = s.get("hermes", {}) if isinstance(s, dict) else {}
        up = s.get("health") == "ok"
        bits = [
            f"backend {'UP' if up else 'DOWN'}",
            f"hermes {'ok' if hermes.get('installed') else 'no'}",
            self.backend.base_url,
        ]
        self._line(0, 0, "  ATHENA — command room", w, curses.A_BOLD | curses.color_pair(1))
        self._line(1, 0, "  " + "  ·  ".join(bits), w, curses.color_pair(3))
        self._line(2, 0, "  " + self.project, w, curses.color_pair(3))

    def _draw_tabs(self, w: int) -> None:
        x = 2
        label = f" Sessions ({len(self.projects)}) "
        self.scr.addnstr(4, x, label, w - x - 1, curses.A_REVERSE | curses.A_BOLD)
        x += len(label) + 1
        if self.drill:
            crumb = f"  ▸ {self.drill}"
            self.scr.addnstr(4, x + 1, crumb, w - x - 2, curses.color_pair(1) | curses.A_BOLD)
            x += len(crumb) + 1
        if self.filter:
            self.scr.addnstr(4, x + 2, f"/{self.filter}", w - x - 3, curses.color_pair(2))

    def _draw_body(self, h: int, w: int) -> None:
        top_y, bottom_y = 6, h - 3
        height = bottom_y - top_y
        rows = self.rows()
        self._clamp(rows, height)
        if not rows:
            self._line(top_y, 2, "(nothing here — press r to refresh, n to launch)", w, curses.color_pair(3))
            return
        render = self._project_row if self.drill is None else self._session_row
        for idx in range(self.top, min(len(rows), self.top + height)):
            y = top_y + (idx - self.top)
            attr = curses.A_REVERSE if idx == self.sel else 0
            self._line(y, 0, "  " + render(rows[idx]), w, attr)

    def _project_row(self, p: dict[str, Any]) -> str:
        ws = str(p.get("workspace", ""))
        name = ws.rstrip("/").rsplit("/", 1)[-1] or ws
        here = "►" if ws == self.project else " "
        provs = ",".join(pr[:2] for pr in p.get("providers", []))[:14]
        when = str(p.get("updated_at", ""))[:16]
        return f"{here} {p.get('count', 0):>4}  {when:<17} {provs:<15} {name:<22} {ws}"

    def _session_row(self, s: dict[str, Any]) -> str:
        prov = str(s.get("provider", ""))[:8]
        when = str(s.get("updated_at", ""))[:16]
        branch = str(s.get("branch") or "")[:14]
        title = " ".join(str(s.get("title", "")).split())
        return f"{prov:<8} {when:<17} {branch:<15} {title}"

    def _draw_footer(self, h: int, w: int) -> None:
        action = "Enter open project" if self.drill is None else "Enter resume · ←/Esc back"
        keys = f"↑↓ move · {action} · n launch · r refresh · / filter · q quit"
        self._line(h - 2, 0, "  " + self.status, w, curses.color_pair(2))
        self._line(h - 1, 0, "  " + keys, w, curses.A_DIM)

    def _clamp(self, rows: list[Any], height: int) -> None:
        self.sel = max(0, min(self.sel, len(rows) - 1)) if rows else 0
        if self.sel < self.top:
            self.top = self.sel
        elif self.sel >= self.top + height:
            self.top = self.sel - height + 1

    # -- terminal suspend ------------------------------------------------- #
    def _suspend(self, run):  # noqa: ANN001, ANN202
        """Drop out of curses, run `run()` against the real terminal, return."""
        curses.def_prog_mode()
        curses.endwin()
        try:
            run()
        finally:
            try:
                input("\n[Enter] return to Athena ")
            except (EOFError, KeyboardInterrupt):
                pass
            curses.reset_prog_mode()
            self.scr.clear()
            curses.curs_set(0)

    def _active_project(self) -> str:
        """The project actions target: the drilled-in one, else the cwd project.

        A provider-fallback group (e.g. "hermes") is not a real directory, so
        launches fall back to the cwd project there.
        """
        if self.drill and os.path.isabs(self.drill):
            return self.drill
        return self.project

    def _exec(self, command: str, cwd: str | None = None) -> None:
        self._suspend(lambda: subprocess.call(command, shell=True, cwd=cwd or self._active_project()))

    # -- actions ---------------------------------------------------------- #
    def act(self) -> None:
        rows = self.rows()
        if not rows:
            return
        item = rows[self.sel]
        if self.drill is None:
            self.drill = item["workspace"]            # drill into the project
            self.filter = ""
            self.sel = self.top = 0
        else:
            cmd = item.get("resume_command")
            if not cmd:
                self.status = "This session has no resume command."
                return
            self.status = f"Resuming {item.get('provider')} session…"
            self._exec(cmd)

    def back(self) -> bool:
        """Pop out of a drilled-in project. Returns False if nothing to pop."""
        if self.drill is not None:
            self.drill = None
            self.filter = ""
            self.sel = self.top = 0
            return True
        return False

    def _launch_targets(self) -> list[dict[str, str]]:
        """Workspaces offered as quick-picks when launching: the active project
        first, then every real (absolute-path) workspace we already know about.
        You can always type a path that isn't in this list."""
        seen: set[str] = set()
        targets: list[dict[str, str]] = []

        def add(path: str, label: str) -> None:
            if path and os.path.isabs(path) and path not in seen:
                seen.add(path)
                targets.append({"path": path, "label": label})

        add(self._active_project(), "current")
        for p in self.projects:
            add(str(p.get("workspace", "")), f"{p.get('count', 0)} sessions")
        return targets

    # -- launch flow (in-curses overlays) --------------------------------- #
    def _overlay_pick(self, title: str, options: list[tuple[str, Any]]) -> Any:
        """Blocking full-screen picker drawn inside curses. ``options`` is a
        list of (label, value). Returns the chosen value, or None on Esc.

        Type any printable character to filter the list incrementally — the
        only sane way to navigate dozens of workspaces."""
        sel = top = 0
        filt = ""
        footer = "↑↓ move · PgUp/PgDn page · type to filter · Enter select · Esc cancel"
        while True:
            view = [o for o in options if filt.lower() in o[0].lower()] if filt else options
            h, w = self.scr.getmaxyx()
            top_y, height = 2, max(1, h - 4)
            sel = max(0, min(sel, len(view) - 1)) if view else 0
            if sel < top:
                top = sel
            elif sel >= top + height:
                top = sel - height + 1
            self.scr.erase()
            head = f"  {title}" + (f"      filter: {filt}_" if filt else "")
            self._line(0, 0, head, w, curses.A_BOLD | curses.color_pair(1))
            self._line(1, 0, f"  {len(view)}/{len(options)}", w, curses.color_pair(3))
            if not view:
                self._line(top_y, 2, "(no matches — Esc to cancel)", w, curses.color_pair(3))
            for idx in range(top, min(len(view), top + height)):
                y = top_y + (idx - top)
                attr = curses.A_REVERSE if idx == sel else 0
                self._line(y, 0, "  " + view[idx][0], w, attr)
            self._line(h - 1, 0, "  " + footer, w, curses.A_DIM)
            self.scr.refresh()
            ch = self.scr.getch()
            if ch == 27:  # Esc
                return None
            elif ch == curses.KEY_DOWN:
                sel += 1
            elif ch == curses.KEY_UP:
                sel = max(0, sel - 1)
            elif ch == curses.KEY_NPAGE:
                sel += height
            elif ch == curses.KEY_PPAGE:
                sel = max(0, sel - height)
            elif ch in (curses.KEY_ENTER, 10, 13):
                if view:
                    return view[sel][1]
            elif ch in (curses.KEY_BACKSPACE, 127, 8):
                filt, sel, top = filt[:-1], 0, 0
            elif 32 <= ch < 127:
                filt, sel, top = filt + chr(ch), 0, 0

    _CUSTOM_PATH = object()  # sentinel for the "type a path" picker entry

    def _pick_workspace(self) -> str | None:
        options: list[tuple[str, Any]] = [
            (f"{t['path']}  ({t['label']})", t["path"]) for t in self._launch_targets()
        ]
        options.append(("＋ type a different path…", self._CUSTOM_PATH))
        choice = self._overlay_pick("Spawn into which workspace?", options)
        if choice is None:
            return None
        if choice is self._CUSTOM_PATH:
            raw = self._read_line("path: ")
            if not raw:
                return None
            chosen = os.path.abspath(os.path.expanduser(raw))
            if not os.path.isdir(chosen):
                self.status = f"No such directory: {chosen}"
                return None
            return chosen
        return choice

    def launch(self) -> None:
        target = self._pick_workspace()
        if not target:
            self.status = "Launch cancelled."
            return
        agent = self._overlay_pick("Which agent?", [(a, a) for a in LAUNCH_COMMANDS])
        if not agent:
            self.status = "Launch cancelled."
            return
        self.status = f"Launching {agent} in {_short_path(target)}…"
        self._exec(LAUNCH_COMMANDS[agent], cwd=target)
        self.refresh()

    def _first_refresh_with_splash(self) -> None:
        """Load the initial data behind the branded splash instead of a black
        screen. ``refresh()`` runs on a worker thread (it only touches the
        backend, never curses) while the splash animates on the main thread."""
        done = threading.Event()

        def _work() -> None:
            try:
                self.refresh()
            finally:
                done.set()

        worker = threading.Thread(target=_work, daemon=True)
        worker.start()
        splash.play(self.scr, done.is_set)
        done.wait(timeout=10)  # backend pathologically slow: fall through anyway

    # -- main loop -------------------------------------------------------- #
    def loop(self) -> None:
        curses.curs_set(0)
        self._first_refresh_with_splash()
        while True:
            self.draw()
            try:
                ch = self.scr.getch()
            except KeyboardInterrupt:
                return
            if ch == ord("q"):
                return
            elif ch == 27:  # Esc: leave a drilled project, else quit
                if not self.back():
                    return
            elif ch in (curses.KEY_LEFT, ord("h"), curses.KEY_BACKSPACE, 127, 8):
                self.back()
            elif ch in (curses.KEY_DOWN, ord("j")):
                self.sel += 1
            elif ch in (curses.KEY_UP, ord("k")):
                self.sel = max(0, self.sel - 1)
            elif ch in (curses.KEY_RIGHT, ord("l")):
                self.act()
            elif ch in (curses.KEY_ENTER, 10, 13):
                self.act()
            elif ch == ord("n"):
                self.launch()
            elif ch == ord("r"):
                self.status = "Refreshing…"
                self.draw()
                self.refresh()
                self.status = "Refreshed."
            elif ch == ord("/"):
                self.filter = self._read_filter()
                self.sel = 0
                self.top = 0
            elif ch == ord("?"):
                self.status = "Projects→Enter opens · Enter resumes · ←/Esc back · n launch · r refresh · / filter · q quit"

    def _read_filter(self) -> str:
        return self._read_line("filter: ")

    def _read_line(self, label: str) -> str:
        """Echoed single-line input on the footer row. Returns "" if blank."""
        curses.echo()
        curses.curs_set(1)
        h, w = self.scr.getmaxyx()
        self._line(h - 2, 0, "  " + label, w, curses.color_pair(2))
        x = 2 + len(label)
        self.scr.move(h - 2, x)
        try:
            text = self.scr.getstr(h - 2, x, max(1, w - x - 2)).decode("utf-8", "replace").strip()
        except Exception:  # noqa: BLE001
            text = ""
        curses.noecho()
        curses.curs_set(0)
        return text


def _group_key(session: dict[str, Any]) -> str:
    """Group sessions by workspace; sessions without one fall under their
    provider (e.g. Hermes sessions that carry no workspace -> "hermes")."""
    return session.get("workspace") or session.get("provider") or "(unknown)"


def _short_path(path: str) -> str:
    """Last path segment, for compact status messages."""
    return path.rstrip("/").rsplit("/", 1)[-1] or path


def run_tui(backend_url: str | None, project_dir: str) -> int:
    # Probe discovery before entering curses so a missing or stale backend
    # surfaces as a readable message rather than a black screen or crash. The
    # two cases need different fixes, so we tell them apart.
    status = backend_status(backend_url)
    if not status["running"]:
        if status["stale"]:
            print(f"error: Athena backend discovery is stale — {status['baseUrl']} is not responding.", file=sys.stderr)
            print(f"detail: {status['detail']}", file=sys.stderr)
            print("hint: restart Athena (or `athena serve`) to refresh discovery, then retry.", file=sys.stderr)
        else:
            print("error: no Athena backend is running.", file=sys.stderr)
            print(f"detail: {status['detail']}", file=sys.stderr)
            print("hint: open Athena or run `athena serve`, then retry.", file=sys.stderr)
        return 1

    backend = Backend(backend_url=backend_url)

    def _main(stdscr: "curses._CursesWindow") -> None:
        curses.use_default_colors()
        for idx, fg in ((1, curses.COLOR_CYAN), (2, curses.COLOR_YELLOW), (3, curses.COLOR_WHITE)):
            try:
                curses.init_pair(idx, fg, -1)
            except curses.error:
                pass
        AthenaTUI(stdscr, backend, project_dir).loop()

    curses.wrapper(_main)
    return 0
