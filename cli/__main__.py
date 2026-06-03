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
import time
from pathlib import Path
from typing import Any

from . import __version__
from ._client import Backend

TERMINAL_STATUSES = {"succeeded", "failed", "cancelled"}


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


def _print_runs_table(runs: list[dict[str, Any]]) -> None:
    if not runs:
        print("No runs.")
        return
    print(f"{'RUN ID':<26} {'AGENT':<12} {'STATUS':<10} TASK")
    for run in runs:
        run_id = str(run.get("run_id", ""))[:25]
        agent = str(run.get("agent_id") or run.get("agent_type", ""))[:11]
        status = str(run.get("status", ""))[:9]
        task = " ".join(str(run.get("task", "")).split())[:60]
        print(f"{run_id:<26} {agent:<12} {status:<10} {task}")


def _print_run_detail(payload: dict[str, Any]) -> None:
    run = payload.get("run", {})
    print(f"Run {run.get('run_id')}")
    for label, key in (
        ("agent", "agent_id"),
        ("type", "agent_type"),
        ("status", "status"),
        ("task", "task"),
        ("project", "project_dir"),
        ("created", "created_at"),
        ("updated", "updated_at"),
        ("exit_code", "exit_code"),
        ("error", "error"),
    ):
        if run.get(key) is not None:
            print(_kv(label, run[key]))
    artifacts = payload.get("artifacts") or {}
    present = [a for a in artifacts.values() if a.get("exists")]
    if present:
        print("  artifacts:")
        for art in present:
            print(f"    - {art['name']} ({art['size_bytes']} bytes)")


# --------------------------------------------------------------------------- #
# Shared bits
# --------------------------------------------------------------------------- #
def _project_dir(args: argparse.Namespace) -> str:
    return str(Path(args.project_dir).resolve())


def _backend(args: argparse.Namespace) -> Backend:
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
    recall = _safe(lambda: backend.get("/hermes/recall/status", project_dir=project)).get("recall", {})
    sessions = _safe(lambda: backend.get("/agents/sessions", project_dir=project, limit=200))
    runs = _safe(lambda: backend.get("/agents/runs")).get("runs", [])

    from client import get_electron_control_status  # noqa: PLC0415 - reuse MCP discovery

    electron = _safe(get_electron_control_status)

    if args.json:
        _emit(
            {
                "backend_url": backend.base_url,
                "health": health,
                "electron_control": electron,
                "hermes": hermes,
                "recall": recall,
                "recent_memory": recent,
                "sessions": sessions.get("sessions", []),
                "runs": runs,
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

    if recall:
        age = recall.get("age_seconds")
        age_str = f"{age / 3600:.1f}h ago" if isinstance(age, (int, float)) else "never"
        print(f"Recall      {recall.get('status', '?')}  ({recall.get('bytes', 0)} bytes, refreshed {age_str})")

    print(f"\nRuns        {len(runs)} total{_count_by(runs, 'status')}")
    for run in runs[:5]:
        print(f"  {str(run.get('status','')):<10} {str(run.get('run_id',''))[:22]}  "
              f"{' '.join(str(run.get('task','')).split())[:48]}")

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
            "timeout_seconds": args.timeout,
        },
    )
    if args.json:
        _emit(payload, True)
    else:
        print(payload.get("answer", payload))
    return 0


def cmd_recall_show(args: argparse.Namespace) -> int:
    project = _project_dir(args)
    recall_path = Path(project) / ".context-workspace" / "hermes" / "session-recall.md"
    if not recall_path.exists():
        _emit({"exists": False, "path": str(recall_path)} if args.json else f"No recall cache: {recall_path}", args.json)
        return 0
    _emit(recall_path.read_text(encoding="utf-8"), args.json)
    return 0


def cmd_recall_status(args: argparse.Namespace) -> int:
    _emit(_backend(args).get("/hermes/recall/status", project_dir=_project_dir(args)), args.json)
    return 0


def cmd_recall_write(args: argparse.Namespace) -> int:
    markdown = _read_input_source(args.markdown, args.file, allow_stdin=True)
    if not markdown:
        print("error: provide recall markdown via argument, --file, or stdin", file=sys.stderr)
        return 2
    payload = _backend(args).post(
        "/hermes/recall/write",
        {"project_dir": _project_dir(args), "markdown": markdown, "source": args.source},
    )
    _emit(payload, args.json)
    return 0


def cmd_sessions_list(args: argparse.Namespace) -> int:
    payload = _backend(args).get(
        "/agents/sessions",
        project_dir=_project_dir(args),
        provider=args.provider,
        q=args.query,
        limit=args.limit,
    )
    if args.json:
        _emit(payload, True)
    else:
        print(payload.get("summary") or "No sessions.")
    return 0


def cmd_sessions_transcript(args: argparse.Namespace) -> int:
    text = _backend(args).get(
        f"/agents/sessions/{args.provider}/{args.session_id}/transcript",
        max_bytes=args.max_bytes,
        tail=str(not args.head).lower(),
    )
    _emit(text, args.json)
    return 0


def cmd_run_start(args: argparse.Namespace) -> int:
    backend = _backend(args)
    payload = backend.post(
        "/agents/spawn",
        {
            "agent_type": args.agent,
            "project_dir": _project_dir(args),
            "task": args.task,
            "timeout_seconds": args.timeout,
        },
    )
    run_id = payload.get("run", {}).get("run_id")
    if args.json and not (args.wait or args.follow):
        _emit(payload, True)
        return 0
    print(f"started run {run_id} ({args.agent})", file=sys.stderr)
    if args.follow:
        return _follow_run(backend, run_id, args.artifact, args.json)
    if args.wait:
        final = _wait_for_run(backend, run_id, args.timeout or 600)
        _emit(final, args.json) if args.json else _print_run_detail(final)
        return 0 if final.get("run", {}).get("status") == "succeeded" else 1
    return 0


def cmd_run_list(args: argparse.Namespace) -> int:
    payload = _backend(args).get("/agents/runs")
    if args.json:
        _emit(payload, True)
    else:
        _print_runs_table(payload.get("runs", []))
    return 0


def cmd_run_get(args: argparse.Namespace) -> int:
    payload = _backend(args).get(f"/agents/runs/{args.run_id}")
    if args.json:
        _emit(payload, True)
    else:
        _print_run_detail(payload)
    return 0


def cmd_run_cancel(args: argparse.Namespace) -> int:
    _emit(_backend(args).post(f"/agents/runs/{args.run_id}/cancel"), args.json)
    return 0


def cmd_run_logs(args: argparse.Namespace) -> int:
    backend = _backend(args)
    if args.follow:
        return _follow_run(backend, args.run_id, args.artifact, args.json)
    text = backend.get(
        f"/agents/runs/{args.run_id}/artifacts/{args.artifact}",
        max_bytes=args.max_bytes,
        tail=str(not args.head).lower(),
    )
    _emit(text, args.json)
    return 0


def cmd_tui(args: argparse.Namespace) -> int:
    from .tui import run_tui

    return run_tui(backend_url=args.backend_url, project_dir=_project_dir(args))


def cmd_serve(args: argparse.Namespace) -> int:
    from .serve import serve

    return serve(
        host=args.host,
        port=args.port,
        reload=args.reload,
        write_discovery=not args.no_discovery,
    )


# --------------------------------------------------------------------------- #
# Run polling / live follow — the "see every single thing" experience
# --------------------------------------------------------------------------- #
def _wait_for_run(backend: Backend, run_id: str, timeout: float, poll: float = 2.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while True:
        payload = backend.get(f"/agents/runs/{run_id}")
        if payload.get("run", {}).get("status") in TERMINAL_STATUSES:
            return payload
        if time.monotonic() >= deadline:
            return {"timed_out": True, **payload}
        time.sleep(poll)


def _follow_run(backend: Backend, run_id: str, artifact: str, as_json: bool, poll: float = 1.5) -> int:
    """Stream a run's artifact live until the run reaches a terminal state."""
    printed = 0
    while True:
        try:
            text = backend.get(
                f"/agents/runs/{run_id}/artifacts/{artifact}",
                max_bytes=1048576,
                tail="false",
            )
        except Exception:  # noqa: BLE001 - artifact may not exist yet
            text = ""
        if isinstance(text, str) and len(text) > printed:
            sys.stdout.write(text[printed:])
            sys.stdout.flush()
            printed = len(text)
        status = backend.get(f"/agents/runs/{run_id}").get("run", {}).get("status")
        if status in TERMINAL_STATUSES:
            print(f"\n--- run {run_id} {status} ---", file=sys.stderr)
            return 0 if status == "succeeded" else 1
        time.sleep(poll)


def _read_input_source(inline: str | None, file_path: str | None, allow_stdin: bool = False) -> str | None:
    if inline:
        return inline
    if file_path:
        return Path(file_path).read_text(encoding="utf-8")
    if allow_stdin and not sys.stdin.isatty():
        data = sys.stdin.read()
        return data or None
    return None


# --------------------------------------------------------------------------- #
# Parser
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    # Shared flags live on a parent parser so they are accepted both before the
    # subcommand (`athena --json run list`) and after it (`athena run list --json`).
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
    p.add_argument("--timeout", type=float, default=120)
    p.set_defaults(func=cmd_ask)

    # recall
    rec = sub.add_parser("recall", help="Project-local Hermes recall.").add_subparsers(dest="sub", required=True)
    leaf(rec, "show", help="Print the recall cache.").set_defaults(func=cmd_recall_show)
    leaf(rec, "status", help="Recall freshness/metadata.").set_defaults(func=cmd_recall_status)
    p = leaf(rec, "write", help="Write recall markdown (arg, --file, or stdin).")
    p.add_argument("markdown", nargs="?", default=None)
    p.add_argument("--file", default=None)
    p.add_argument("--source", default="athena-cli")
    p.set_defaults(func=cmd_recall_write)

    # sessions
    ses = sub.add_parser("sessions", help="Native agent sessions.").add_subparsers(dest="sub", required=True)
    p = leaf(ses, "list", help="List native sessions for the project.")
    p.add_argument("--provider", default=None, help="codex | claude | opencode | hermes")
    p.add_argument("--query", default="")
    p.add_argument("--limit", type=int, default=100)
    p.set_defaults(func=cmd_sessions_list)
    p = leaf(ses, "transcript", help="Read a native session transcript.")
    p.add_argument("provider")
    p.add_argument("session_id")
    p.add_argument("--max-bytes", type=int, default=65536)
    p.add_argument("--head", action="store_true", help="Read from the start instead of the tail.")
    p.set_defaults(func=cmd_sessions_transcript)

    # run
    run = sub.add_parser("run", help="Headless agent runs.").add_subparsers(dest="sub", required=True)
    p = leaf(run, "start", help="Start a headless agent run.")
    p.add_argument("task")
    p.add_argument("--agent", default="codex")
    p.add_argument("--timeout", type=float, default=None)
    p.add_argument("--wait", action="store_true", help="Block until the run finishes.")
    p.add_argument("--follow", action="store_true", help="Stream artifact output live.")
    p.add_argument("--artifact", default="stdout", help="Artifact to follow (stdout/stderr/result).")
    p.set_defaults(func=cmd_run_start)
    leaf(run, "list", help="List runs.").set_defaults(func=cmd_run_list)
    p = leaf(run, "get", help="Show a run's detail.")
    p.add_argument("run_id")
    p.set_defaults(func=cmd_run_get)
    p = leaf(run, "cancel", help="Cancel a run.")
    p.add_argument("run_id")
    p.set_defaults(func=cmd_run_cancel)
    p = leaf(run, "logs", help="Read or follow run artifacts.")
    p.add_argument("run_id")
    p.add_argument("--artifact", default="stdout")
    p.add_argument("--follow", action="store_true")
    p.add_argument("--max-bytes", type=int, default=65536)
    p.add_argument("--head", action="store_true")
    p.set_defaults(func=cmd_run_logs)

    # serve
    p = leaf(sub, "serve", help="Launch the backend headlessly (no Electron).")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--reload", action="store_true")
    p.add_argument("--no-discovery", action="store_true", help="Do not write the discovery file.")
    p.set_defaults(func=cmd_serve)

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
