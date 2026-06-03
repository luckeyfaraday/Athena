"""Headless backend launcher.

Today the backend's lifecycle is owned by Electron (``client/electron/backend.ts``
spawns ``uvicorn backend.app:app``). This gives the backend a launch path that
does not need the desktop app, and publishes the same discovery file the rest of
the stack reads (``~/.context-workspace/backend.json``) so other CLI commands and
the MCP server find it automatically.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
from pathlib import Path

from ._client import ROOT

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
DISCOVERY_PATH = Path(
    os.environ.get(
        "CONTEXT_WORKSPACE_BACKEND_STATE",
        Path.home() / ".context-workspace" / "backend.json",
    )
)


def serve(host: str, port: int, reload: bool, write_discovery: bool) -> int:
    base_url = f"http://{host}:{port}"
    cmd = [
        sys.executable,
        "-m",
        "uvicorn",
        "backend.app:app",
        "--host",
        host,
        "--port",
        str(port),
        "--no-access-log",
    ]
    if reload:
        cmd.append("--reload")

    print(f"athena serve: starting backend at {base_url}", file=sys.stderr)
    proc = subprocess.Popen(cmd, cwd=str(ROOT))

    written = _write_discovery(base_url, proc.pid) if write_discovery else None
    if written:
        print(f"athena serve: wrote discovery file {written}", file=sys.stderr)

    def _forward(signum, _frame):  # noqa: ANN001 - signal handler signature
        proc.send_signal(signum)

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, _forward)

    try:
        return proc.wait()
    finally:
        if written:
            _clear_discovery(written)


def _write_discovery(base_url: str, pid: int) -> Path | None:
    try:
        DISCOVERY_PATH.parent.mkdir(parents=True, exist_ok=True)
        DISCOVERY_PATH.write_text(
            json.dumps({"baseUrl": base_url, "pid": pid, "running": True}, indent=2) + "\n",
            encoding="utf-8",
        )
        return DISCOVERY_PATH
    except OSError as exc:
        print(f"athena serve: could not write discovery file: {exc}", file=sys.stderr)
        return None


def _clear_discovery(path: Path) -> None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    # Only clear the file we wrote, never one a running Electron app owns.
    if data.get("pid") == os.getpid() or data.get("running") is True:
        data["running"] = False
        try:
            path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        except OSError:
            pass
