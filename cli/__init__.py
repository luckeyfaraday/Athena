"""Athena CLI — a headless terminal frontend to the Athena backend.

This is a *prototype* (Tier-1 / headless only). It is a sibling of the MCP
server: both speak to the same FastAPI backend over HTTP through the shared
``mcp_server/client.py`` client, so there is a single source of truth for
discovery, WSL translation, and request shapes.

Run it with ``python -m cli`` or the ``athena`` wrapper script.
"""

__all__ = ["__version__"]

__version__ = "0.1.0-prototype"
