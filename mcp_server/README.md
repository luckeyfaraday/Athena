# Context Workspace MCP Server

This MCP server exposes Context Workspace as a Hermes tool surface. It talks to
the existing FastAPI backend over localhost and discovers Electron's dynamic
backend port from:

```text
~/.context-workspace/backend.json
```

Set `CONTEXT_WORKSPACE_BACKEND_URL` to override discovery.

When the MCP server runs inside WSL and discovers an Electron backend URL such
as `http://127.0.0.1:<port>` from the Windows `backend.json`, it automatically
rewrites the host to the Windows gateway IP from `/etc/resolv.conf`. This keeps
the Electron app bound to Windows localhost while making Hermes-in-WSL able to
reach the backend.

If WSL gateway discovery is wrong for your environment, set:

```bash
export CONTEXT_WORKSPACE_WINDOWS_HOST=<windows-host-ip>
```

`CONTEXT_WORKSPACE_BACKEND_URL` still has highest priority and is used exactly
as provided.

Visible embedded terminal launches use the Electron control server, discovered
from:

```text
~/.context-workspace/electron-control.json
```

Set `CONTEXT_WORKSPACE_ELECTRON_CONTROL_URL` to override discovery. The desktop
app must be running for visible terminal tools to work.

Hermes configuration:

```yaml
mcp_servers:
  context_workspace:
    command: "/home/you/.hermes/hermes-agent/venv/bin/python3"
    args:
      - "/home/you/projects/context-workspace/mcp_server/server.py"
    timeout: 120
    connect_timeout: 30
```

Hermes owns `session_search`, its own config, and durable memory writes. Context
Workspace owns app-side tools such as backend health checks, native session
discovery, recall cache files, legacy run spawning, and visible terminal
spawning.

The recall bridge workflow is:

1. Hermes runs `session_search(...)`.
2. Hermes calls `context_workspace_summarize_agent_sessions(...)` when native
   Codex/OpenCode/Claude session history would help.
3. Hermes summarizes the useful result.
4. Hermes calls `context_workspace_write_recall_cache(project_dir, markdown)`.
5. Context Workspace includes that cache in future run `context.md` files.

Session discovery tools:

```text
context_workspace_list_agent_sessions(project_dir, provider?, query?, limit?)
context_workspace_summarize_agent_sessions(project_dir, provider?, query?, limit?)
```

Visible terminal launch tool:

```text
context_workspace_spawn_agent(project_dir, task, agent_type?, visible_terminal?)
context_workspace_spawn_terminal(project_dir, kind?, count?, title?, resume_session_id?, session_label?)
context_workspace_read_agent_session(provider, session_id, max_bytes?, tail?)
```

Use `context_workspace_spawn_agent` when Hermes should start Codex, OpenCode,
or Claude for a user task. By default it opens a visible Command Room PTY
through Electron control and injects the task, recall cache, and Hermes memory.

Use `context_workspace_spawn_terminal` only when Hermes needs lower-level
terminal control, such as opening a shell, Hermes pane, grid, or explicit resume.

Do not call Athena's FastAPI `POST /agents/spawn` directly for OpenCode or
Claude visible terminals. That route is the legacy backend run/artifact path.
If `context_workspace_spawn_agent` reports that the Electron control server is
unavailable, start or restart the Athena desktop app and check
`~/.context-workspace/electron-control.json`.
