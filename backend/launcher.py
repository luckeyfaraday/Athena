"""Entry point for Athena's self-contained desktop backend runtime."""

from __future__ import annotations

import argparse
import os
import ssl
import sys
from collections.abc import MutableMapping, Sequence

import uvicorn

from backend.app import app

# Where distributions keep their trusted certificates. The bundled OpenSSL only
# looks where the machine that built it does (Ubuntu's /usr/lib/ssl), so on
# other systems it trusts nothing and every HTTPS request fails verification.
SYSTEM_CA_BUNDLES = (
    "/etc/ssl/certs/ca-certificates.crt",  # Debian, Ubuntu, Arch, Gentoo
    "/etc/pki/tls/certs/ca-bundle.crt",  # Fedora, RHEL
    "/etc/ssl/ca-bundle.pem",  # openSUSE
    "/etc/ssl/cert.pem",  # Alpine, macOS
)


def ensure_ca_bundle(environ: MutableMapping[str, str] = os.environ) -> None:
    """Point OpenSSL at the system's certificates when its own defaults are missing.

    Setting the variable rather than passing a context also covers every
    subprocess the backend starts, and leaves a user's own override alone.
    OpenSSL reads it once, at the first TLS handshake, so this must run before
    anything in the process connects over HTTPS.
    """
    if sys.platform == "win32":
        return  # Python reads the Windows certificate store instead.
    if environ.get("SSL_CERT_FILE") or environ.get("SSL_CERT_DIR"):
        return
    defaults = ssl.get_default_verify_paths()
    if defaults.cafile or defaults.capath:
        return
    for candidate in SYSTEM_CA_BUNDLES:
        if os.path.isfile(candidate):
            environ["SSL_CERT_FILE"] = candidate
            return
    try:
        import certifi
    except ImportError:
        return
    environ["SSL_CERT_FILE"] = certifi.where()


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
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    ensure_ca_bundle()
    if args.mcp_server:
        from mcp_server.server import main as run_mcp_server

        run_mcp_server()
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
