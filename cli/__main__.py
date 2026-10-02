"""Athena CLI entrypoint.

Prototype scope: Tier-1 (headless) commands only — everything reachable through
the FastAPI backend without the Electron desktop app. Visible-terminal /
workspace remote-control commands are intentionally out of scope here.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from . import __version__


# --------------------------------------------------------------------------- #
# Output helpers
# --------------------------------------------------------------------------- #
def _emit(value: Any, as_json: bool) -> None:
    if as_json:
        print(json.dumps(value, indent=2, default=str))
    elif isinstance(value, str):
        print(value, end="" if value.endswith("\n") else "\n")
    else:
        print(json.dumps(value, indent=2, default=str))


def _kv(label: str, value: Any) -> str:
    return f"  {label:<14} {value}"


# --------------------------------------------------------------------------- #
# Shared bits
# --------------------------------------------------------------------------- #
def _project_dir(args: argparse.Namespace) -> str:
    return str(Path(args.project_dir).resolve())


def _backend(args: argparse.Namespace) -> Any:
    from ._client import Backend

    return Backend(backend_url=args.backend_url)


# --------------------------------------------------------------------------- #
# Command handlers
# --------------------------------------------------------------------------- #
def cmd_health(args: argparse.Namespace) -> int:
    backend = _backend(args)
    payload = backend.get("/health")
    if args.json:
        _emit({"backend_url": backend.base_url, **payload}, True)
    else:
        print(f"backend {backend.base_url}: {payload.get('status', payload)}")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    _emit(_backend(args).get("/hermes/status"), args.json)
    return 0


def _safe(fn, default=None):  # noqa: ANN001, ANN202 - best-effort section fetch
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 - one bad section shouldn't sink the snapshot
        return {"__error__": str(exc), **(default or {})}


def cmd_snapshot(args: argparse.Namespace) -> int:
    backend = _backend(args)
    project = _project_dir(args)

    health = _safe(lambda: backend.get("/health"))
    hermes = _safe(lambda: backend.get("/hermes/status")).get("hermes", {})
    recent = _safe(lambda: backend.get("/memory/recent", limit=5)).get("entries", [])
    sessions = _safe(lambda: backend.get("/agents/sessions", project_dir=project, limit=200))

    from client import get_electron_control_status  # noqa: PLC0415 - reuse MCP discovery

    electron = _safe(get_electron_control_status)

    if args.json:
        _emit(
            {
                "backend_url": backend.base_url,
                "health": health,
                "electron_control": electron,
                "hermes": hermes,
                "recent_memory": recent,
                "sessions": sessions.get("sessions", []),
            },
            True,
        )
        return 0

    session_list = sessions.get("sessions", []) if isinstance(sessions, dict) else []
    print(f"ATHENA SNAPSHOT  ({project})\n")

    ok = isinstance(health, dict) and health.get("status") == "ok"
    print(f"Backend     {'● up' if ok else '○ down'}  {backend.base_url}")
    e_running = isinstance(electron, dict) and electron.get("running")
    print(f"Desktop     {'● running' if e_running else '○ not running'}")
    if hermes:
        print(f"Hermes      {'installed' if hermes.get('installed') else 'not installed'}"
              f"  {hermes.get('version', '')}")

    print(f"\nSessions    {len(session_list)} in project{_count_by(session_list, 'provider')}")
    for s in session_list[:5]:
        title = " ".join(str(s.get("title") or s.get("task") or "").split())[:50]
        print(f"  {str(s.get('provider','')):<9} {title}")

    print(f"\nMemory      {len(recent)} recent shown")
    for entry in recent[:3]:
        print(f"  • {' '.join(str(entry).split())[:80]}")
    return 0


def _count_by(items: list[dict[str, Any]], key: str) -> str:
    counts: dict[str, int] = {}
    for item in items:
        counts[str(item.get(key, "?"))] = counts.get(str(item.get(key, "?")), 0) + 1
    return "  " + ", ".join(f"{k}:{v}" for k, v in sorted(counts.items())) if counts else ""


def cmd_memory_query(args: argparse.Namespace) -> int:
    _emit(_backend(args).get("/memory/hermes", q=args.text, limit=args.limit), args.json)
    return 0


def cmd_memory_recent(args: argparse.Namespace) -> int:
    _emit(_backend(args).get("/memory/recent", limit=args.limit), args.json)
    return 0


def cmd_memory_project(args: argparse.Namespace) -> int:
    _emit(
        _backend(args).get("/memory/hermes/project", project_dir=_project_dir(args), limit=args.limit),
        args.json,
    )
    return 0


def cmd_memory_store(args: argparse.Namespace) -> int:
    _emit(_backend(args).post("/memory/store", {"text": args.text}), args.json)
    return 0


def cmd_memory_delete(args: argparse.Namespace) -> int:
    _emit(_backend(args).post("/memory/delete", {"text": args.text}), args.json)
    return 0


def cmd_ask(args: argparse.Namespace) -> int:
    context = _read_input_source(args.context, args.context_file)
    payload = _backend(args).post(
        "/hermes/ask",
        {
            "project_dir": _project_dir(args),
            "question": args.question,
            "context": context,
            "session_id": args.session_id,
            "timeout_seconds": args.timeout,
        },
        request_timeout_seconds=args.timeout + 5,
    )
    if args.json:
        _emit(payload, True)
    else:
        print(payload.get("answer", payload))
    return 0


def cmd_sessions_list(args: argparse.Namespace) -> int:
    backend = _backend(args)
    if args.all:
        try:
            payload = backend.get("/agents/sessions/all", provider=args.provider, q=args.query, limit=args.limit)
        except Exception as exc:  # noqa: BLE001 - older backend without /all
            if getattr(getattr(exc, "response", None), "status_code", None) != 404:
                raise
            print("note: backend lacks cross-project listing; showing this project only.", file=sys.stderr)
            print("      restart Athena or run `athena serve` for the new build.\n", file=sys.stderr)
            args.all = False
            payload = backend.get(
                "/agents/sessions", project_dir=_project_dir(args), provider=args.provider, q=args.query, limit=args.limit
            )
    else:
        payload = backend.get(
            "/agents/sessions",
            project_dir=_project_dir(args),
            provider=args.provider,
            q=args.query,
            limit=args.limit,
        )
    if args.json:
        _emit(payload, True)
    elif args.all:
        _print_sessions_by_project(payload.get("sessions", []))
    else:
        print(payload.get("summary") or "No sessions.")
    return 0


def _print_sessions_by_project(sessions: list[dict[str, Any]]) -> None:
    groups: dict[str, list[dict[str, Any]]] = {}
    for s in sessions:
        groups.setdefault(_session_group_key(s), []).append(s)
    ordered = sorted(groups.items(), key=lambda kv: max((str(s.get("updated_at", "")) for s in kv[1]), default=""), reverse=True)
    for workspace, items in ordered:
        print(f"\n{workspace}  ({len(items)})")
        for s in items[:8]:
            title = " ".join(str(s.get("title", "")).split())[:60]
            print(f"  {str(s.get('provider','')):<9} {str(s.get('updated_at',''))[:16]}  {title}")
        if len(items) > 8:
            print(f"  … {len(items) - 8} more")


def cmd_sessions_transcript(args: argparse.Namespace) -> int:
    text = _backend(args).get(
        f"/agents/sessions/{args.provider}/{args.session_id}/transcript",
        max_bytes=args.max_bytes,
        tail=str(not args.head).lower(),
    )
    _emit(text, args.json)
    return 0


def _session_group_key(session: dict[str, Any]) -> str:
    return session.get("workspace") or session.get("provider") or "(unknown)"


def cmd_tui(args: argparse.Namespace) -> int:
    try:
        from .tui import run_tui
    except ModuleNotFoundError as exc:
        if exc.name != "_curses":
            raise
        print("error: `athena tui` requires Python curses support, but `_curses` is not installed.", file=sys.stderr)
        if os.name == "nt":
            print("hint: install it with `python -m pip install windows-curses`, then re-run `athena install-cli`.", file=sys.stderr)
        else:
            print("hint: install your platform's Python curses package and try again.", file=sys.stderr)
        return 1

    return run_tui(backend_url=args.backend_url, project_dir=_project_dir(args))


def cmd_install_cli(args: argparse.Namespace) -> int:
    from .install import install_cli

    return install_cli(bin_dir=args.bin_dir, python=args.python)


def cmd_serve(args: argparse.Namespace) -> int:
    from .serve import serve

    return serve(
        host=args.host,
        port=args.port,
        reload=args.reload,
        write_discovery=not args.no_discovery,
    )


def _read_input_source(inline: str | None, file_path: str | None) -> str | None:
    if inline:
        return inline
    if file_path:
        return Path(file_path).read_text(encoding="utf-8")
    return None


# --------------------------------------------------------------------------- #
# Parser
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    # Shared flags live on a parent parser so they are accepted both before the
    # subcommand (`athena --json sessions list`) and after it (`athena sessions list --json`).
    # SUPPRESS defaults so a value given before the subcommand is not clobbered
    # by the leaf subparser's default. Missing values are normalized in main().
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--backend-url", default=argparse.SUPPRESS, help="Override backend URL (else discovery / :8000)."
    )
    common.add_argument(
        "--json", action="store_true", default=argparse.SUPPRESS, help="Emit raw JSON instead of human output."
    )
    common.add_argument(
        "--project-dir",
        default=argparse.SUPPRESS,
        help="Project directory for project-scoped commands (default: cwd).",
    )

    parser = argparse.ArgumentParser(
        prog="athena",
        description="Headless terminal frontend to the Athena backend (prototype).",
        parents=[common],
    )
    parser.add_argument("--version", action="version", version=f"athena {__version__}")

    sub = parser.add_subparsers(dest="command", required=True)

    def leaf(group, name, **kw):  # noqa: ANN001, ANN202 - local parser factory
        return group.add_parser(name, parents=[common], **kw)

    leaf(sub, "health", help="Check backend health.").set_defaults(func=cmd_health)
    leaf(sub, "status", help="Hermes installation + memory status.").set_defaults(func=cmd_status)
    leaf(sub, "snapshot", help="One-shot overview of everything.").set_defaults(func=cmd_snapshot)
    leaf(sub, "tui", help="Interactive command room (SSH-friendly).").set_defaults(func=cmd_tui)
    p = leaf(sub, "install-cli", help="Install an `athena` shim on PATH (run from anywhere).")
    p.add_argument("--bin-dir", default=None, help="Target bin directory (default ~/.local/bin).")
    p.add_argument("--python", default=None, help="Python executable to embed (default: current).")
    p.set_defaults(func=cmd_install_cli)

    # memory
    mem = sub.add_parser("memory", help="Hermes memory.").add_subparsers(dest="sub", required=True)
    p = leaf(mem, "query", help="Query memory.")
    p.add_argument("text")
    p.add_argument("--limit", type=int, default=10)
    p.set_defaults(func=cmd_memory_query)
    p = leaf(mem, "recent", help="Recent memory entries.")
    p.add_argument("--limit", type=int, default=10)
    p.set_defaults(func=cmd_memory_recent)
    p = leaf(mem, "project", help="Project-scoped memory.")
    p.add_argument("--limit", type=int, default=10)
    p.set_defaults(func=cmd_memory_project)
    p = leaf(mem, "store", help="Append an entry to memory.")
    p.add_argument("text")
    p.set_defaults(func=cmd_memory_store)
    p = leaf(mem, "delete", help="Delete an exact memory entry.")
    p.add_argument("text")
    p.set_defaults(func=cmd_memory_delete)

    # ask
    p = leaf(sub, "ask", help="Ask Hermes a one-shot question.")
    p.add_argument("question")
    p.add_argument("--context", default=None, help="Inline extra context.")
    p.add_argument("--context-file", default=None, help="Read extra context from a file.")
    p.add_argument("--session-id", default=None, help="Resume one explicit Hermes session.")
    p.add_argument("--timeout", type=float, default=120)
    p.set_defaults(func=cmd_ask)

    # sessions
    ses = sub.add_parser("sessions", help="Native agent sessions.").add_subparsers(dest="sub", required=True)
    p = leaf(ses, "list", help="List native sessions for the project.")
    p.add_argument("--all", action="store_true", help="All projects, grouped by workspace.")
    p.add_argument("--provider", default=None, help="codex | claude | opencode | athena | hermes | grok")
    p.add_argument("--query", default="")
    p.add_argument("--limit", type=int, default=100)
    p.set_defaults(func=cmd_sessions_list)
    p = leaf(ses, "transcript", help="Read a native session transcript.")
    p.add_argument("provider")
    p.add_argument("session_id")
    p.add_argument("--max-bytes", type=int, default=65536)
    p.add_argument("--head", action="store_true", help="Read from the start instead of the tail.")
    p.set_defaults(func=cmd_sessions_transcript)

    # serve
    p = leaf(sub, "serve", help="Launch the backend headlessly (no Electron).")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--reload", action="store_true")
    p.add_argument("--no-discovery", action="store_true", help="Do not write the discovery file.")
    p.set_defaults(func=cmd_serve)

    # remote: other machines' Athena over Tailscale (direct HTTP, not the backend)
    from .remote import register as register_remote

    register_remote(sub)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    # Apply defaults for the SUPPRESS-ed shared flags (see build_parser).
    args.backend_url = getattr(args, "backend_url", None)
    args.json = getattr(args, "json", False)
    args.project_dir = getattr(args, "project_dir", None) or os.getcwd()
    try:
        return args.func(args)
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # noqa: BLE001 - top-level CLI guard, surface cleanly
        _print_error(exc)
        return 1


def _print_error(exc: Exception) -> None:
    from .remote import RemoteError

    # `athena remote` errors are complete messages about another machine; the
    # local-backend hint below would only mislead.
    if isinstance(exc, RemoteError):
        print(f"error: {exc}", file=sys.stderr)
        return
    # Unwrap httpx errors into something readable without importing httpx eagerly.
    response = getattr(exc, "response", None)
    if response is not None:
        detail: Any = None
        try:
            detail = response.json().get("detail")
        except Exception:  # noqa: BLE001
            detail = response.text
        print(f"error: HTTP {response.status_code}: {detail}", file=sys.stderr)
    else:
        print(f"error: {exc}", file=sys.stderr)
    name = type(exc).__name__
    if isinstance(exc, (ConnectionError, OSError)) or "Connect" in name or "connection" in str(exc).lower():
        print("hint: is the backend running? start it with `athena serve` or open Athena.", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
