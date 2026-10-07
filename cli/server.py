"""Launch the shared Node host; ``serve`` remains the Python backend command."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys


def run_server(args: list[str]) -> int:
    root = Path(__file__).resolve().parents[1]
    entry = root / "server" / "dist" / "server-main.js"
    if not entry.is_file():
        print("Build the server first: cd server && npm ci && npm run build", file=sys.stderr)
        return 1
    node = shutil.which("node")
    if not node:
        print("Athena server requires Node.js 22.15 or later on PATH.", file=sys.stderr)
        return 1
    command = [node, str(entry), *args]
    if os.name != "nt":
        os.execv(node, command)
    return subprocess.call(command)
