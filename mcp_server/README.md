# Context Workspace MCP Server

This MCP server exposes Context Workspace as a Hermes tool surface. It talks to
the existing FastAPI backend over localhost and discovers Electron's dynamic
backend port from:

```text
~/.context-workspace/backend.json
```

Set `CONTEXT_WORKSPACE_BACKEND_URL` to override discovery.

Hermes configuration:

```yaml
mcp_servers:
  context_workspace:
    command: "/home/alan/.hermes/hermes-agent/venv/bin/python3"
    args:
      - "/home/alan/home_ai/projects/context-workspace/mcp_server/server.py"
    timeout: 120
    connect_timeout: 30
```

Hermes owns `session_search`. The recall bridge workflow is:

1. Hermes runs `session_search(...)`.
2. Hermes summarizes the result.
3. Hermes calls `context_workspace_write_recall_cache(project_dir, markdown)`.
4. Context Workspace includes that cache in future run `context.md` files.
