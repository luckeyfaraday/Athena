"""Entry point for Athena's self-contained desktop backend runtime."""

from __future__ import annotations

import argparse
import os
import runpy
from collections.abc import Sequence

import uvicorn

from backend.app import app


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the Athena desktop backend.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("CONTEXT_WORKSPACE_BACKEND_PORT", "8000")),
    )
    parser.add_argument("--no-access-log", action="store_true")
    parser.add_argument(
        "--mcp-server",
        action="store_true",
        help="Run Athena's bundled stdio MCP server instead of the HTTP server.",
    )
    parser.add_argument(
        "--refresh-recall-script",
        metavar="PATH",
        help="Run Athena's bundled recall refresh script instead of the HTTP server.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.mcp_server:
        from mcp_server.server import main as run_mcp_server

        run_mcp_server()
        return 0
    if args.refresh_recall_script:
        runpy.run_path(args.refresh_recall_script, run_name="__main__")
        return 0

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        access_log=not args.no_access_log,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
