# Athena

Athena is a desktop control surface for running AI coding agents with shared project context. It combines an Electron/React workspace UI, embedded PTY terminals, native agent session discovery, a FastAPI backend, and Hermes memory integration.

The current implementation focuses on local, session-first orchestration: selecting workspaces, launching embedded shells or agent panes, resuming native Codex/OpenCode/Claude/Hermes sessions, checking Hermes/backend status, refreshing recall, and inspecting live session output.

## Features

- Electron desktop app with Athena branding and a compact room-based UI.
- Embedded terminals powered by `node-pty` and `xterm.js`.
- One-click launch options for shell, Hermes, Codex, Codex grid, OpenCode grid, and Claude grid.
- Workspace tabs for switching between active projects.
- Native session discovery for Codex, OpenCode, Claude, and Hermes.
- Session-first Agents and Reviews surfaces for inspecting live buffers and native session metadata.
- FastAPI backend started and monitored by the Electron main process.
- Hermes status and memory endpoints.
- Recall refresh before agent launch, with generated prompt files that include project-local recall context.
- Legacy Codex adapter support for one-shot backend runs and bounded artifact reads.
- Test harness with deterministic fake agents for backend execution flow.

## Repository Layout

```text
backend/                 FastAPI backend, memory, native sessions, legacy run registry, adapters
backend/adapters/        Agent adapter implementations
client/                  Electron + React desktop client
client/electron/         Electron main-process services and IPC handlers
client/src/              React UI and browser-side API wrappers
docs/                    Implementation notes and verification docs
scripts/                 Local verification helpers
tests/                   Backend and adapter tests
SPEC.md                  Historical design notes and project specification
```

## Requirements

- Node.js and npm
- Python 3.11+ recommended
- `pip`
- Optional agent CLIs:
  - `codex`
  - `opencode`
  - `claude`
- Optional Hermes Agent install for real shared memory integration

The desktop app can open without all agent CLIs installed, but missing adapters show as unavailable and related launch commands may fail inside the terminal.

## Setup

Install the client dependencies:

```bash
cd client
npm install
```

Install backend dependencies from the repository root:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
```

For tests, install `pytest` if it is not already available:

```bash
pip install pytest
```

If your preferred Python is not `python3`, set:

```bash
export CONTEXT_WORKSPACE_PYTHON=/absolute/path/to/python
```

The Electron app uses this value when spawning the FastAPI backend.

## Running The Desktop App

From `client/`:

```bash
npm run dev
```

This command:

1. Builds the Electron TypeScript entry points.
2. Starts Vite on `127.0.0.1`.
3. Launches Electron.
4. Electron starts the FastAPI backend on a free localhost port.

For a production build:

```bash
cd client
npm run build
```

To launch a previously built Electron app:

```bash
cd client
npm start
```

## Running The Backend Directly

From the repository root:

```bash
python3 -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

Useful endpoints:

```text
GET  /health
GET  /hermes/status
GET  /memory/hermes?q=<query>
GET  /memory/recent?limit=10
POST /memory/store
GET  /agents/adapters
POST /agents/spawn
GET  /agents/runs
GET  /agents/runs/{run_id}
POST /agents/runs/{run_id}/cancel
GET  /agents/runs/{run_id}/artifacts/{artifact_name}
```

## Testing

Run the backend test suite from the repository root:

```bash
pytest
```

Run the client build checks:

```bash
cd client
npm run build
```

The tests use a fake CLI agent fixture so the execution loop can be verified without calling real hosted models or external agent tools.

## How Agent Sessions Work

Athena's primary workflow is embedded, interactive agent sessions. The Electron main process launches terminal panes for shell, Hermes, Codex, OpenCode, and Claude, then the React UI renders those panes with `xterm.js`.

For agent panes, Athena:

1. Checks whether project recall is missing or stale.
2. Runs the configured recall refresh command when available.
3. Writes a temporary prompt file with workspace details, recall cache path, and recall contents.
4. Starts the selected CLI in an embedded PTY.
5. Tracks the pane as a live session and captures a bounded terminal buffer for review.

The app also discovers native provider sessions already on disk, so previous Codex/OpenCode/Claude/Hermes work can be inspected or resumed from the Sessions tab.

## Legacy Backend Runs

The backend still includes an older one-shot run registry and Codex adapter. This path receives an agent spawn request, creates a run record, writes bounded artifacts under `.context-workspace/runs/<run-id>/`, executes the CLI process, and exposes status/artifact endpoints.

That backend-run flow is maintained for compatibility and tests, but Athena's current product direction is session-first embedded terminals plus native session discovery. Generated context artifacts are cache/output files. Hermes memory and project-local recall remain the durable shared context.

## Embedded Terminals

The Electron main process manages embedded terminals through `node-pty`. The React UI renders them with `xterm.js`.

The `New` menu can launch:

- `Shell`
- `Hermes`
- `Codex`
- `Codex Grid`
- `OpenCode Grid`
- `Claude Grid`

Agent panes receive a generated Hermes prompt path through the terminal environment when applicable.

## Hermes Memory

The backend uses `HermesManager` and `HermesMemoryStore` to find Hermes status and read/write memory.

Memory query endpoint:

```text
GET /memory/hermes?q=<query>
```

The response is plain text so CLI agents can consume it easily with tools like `curl`.

## Hermes MCP Bridge

Athena includes an MCP server under `mcp_server/` so Hermes can call into the running desktop workspace. This bridge is intended for Hermes running in WSL while Athena runs on Windows.

Install the MCP server dependencies into the Python environment Hermes will use:

```bash
pip install -r /mnt/c/Users/alanq/context-workspace/mcp_server/requirements.txt
```

Add the bridge to the WSL Hermes config at `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  context_workspace:
    command: "python"
    args:
      - "/mnt/c/Users/alanq/context-workspace/mcp_server/server.py"
    timeout: 120
    connect_timeout: 30
    env:
      CONTEXT_WORKSPACE_BACKEND_STATE: "/mnt/c/Users/alanq/.context-workspace/backend.json"
```

If Hermes uses its own virtual environment, set `command` to that interpreter, for example:

```yaml
command: "/home/alan/.hermes/hermes-agent/venv/bin/python3"
```

The Electron app writes backend discovery state to:

```text
C:\Users\alanq\.context-workspace\backend.json
```

From WSL, that file is available at:

```text
/mnt/c/Users/alanq/.context-workspace/backend.json
```

Start the Athena desktop app before starting Hermes so the backend state file exists. If you run the backend directly on a fixed port, you can use `CONTEXT_WORKSPACE_BACKEND_URL` instead:

```yaml
env:
  CONTEXT_WORKSPACE_BACKEND_URL: "http://127.0.0.1:8000"
```

The bridge exposes tools for health checks, Hermes memory reads/writes through the backend, native agent session discovery, visible embedded terminal spawning, legacy agent run management, artifact reads, and project-local recall cache management.

Visible terminal tools require the Electron app itself, not only the FastAPI backend. Electron writes control discovery state to:

```text
C:\Users\alanq\.context-workspace\electron-control.json
```

From WSL, that file is available at:

```text
/mnt/c/Users/alanq/.context-workspace/electron-control.json
```

Set `CONTEXT_WORKSPACE_ELECTRON_CONTROL_URL` only when you need to override this discovery file.

When Electron starts the backend, it configures a default recall refresh command:

```text
python scripts/hermes-refresh-recall.py
```

You can override it with `CONTEXT_WORKSPACE_HERMES_REFRESH_CMD`. The default script writes a short project-local recall cache and uses native Codex/OpenCode/Claude session discovery as fallback context, which keeps recall refresh working even when Hermes in WSL cannot reach the Windows backend loopback URL.

Recommended recall workflow:

1. Hermes runs its own `session_search`.
2. Hermes calls `context_workspace_summarize_agent_sessions` when it needs native Codex/OpenCode/Claude session history for the selected workspace.
3. Hermes summarizes the relevant prior-session context.
4. Hermes calls `context_workspace_write_recall_cache(project_dir, markdown)`.
5. Future Athena agent launches include that cache in the generated prompt context.

Useful MCP tools for this workflow:

```text
context_workspace_list_agent_sessions(project_dir, provider?, query?, limit?)
context_workspace_summarize_agent_sessions(project_dir, provider?, query?, limit?)
context_workspace_spawn_terminal(project_dir, kind?, count?, title?, resume_session_id?, session_label?)
context_workspace_write_recall_cache(project_dir, markdown)
context_workspace_read_recall_cache(project_dir)
context_workspace_clear_recall_cache(project_dir)
```

Use `context_workspace_spawn_terminal` for visible Command Room sessions. Use `context_workspace_spawn_agent` only for the legacy backend run/artifact path.

Athena owns these app-side tools. Hermes still owns its own config, `session_search`, long-term memory writes, and the decision about when to refresh or clear recall.

## Troubleshooting

### Backend does not start

Check that backend dependencies are installed and that Electron is using the expected Python:

```bash
export CONTEXT_WORKSPACE_PYTHON=/path/to/python
```

Then restart the desktop app.

### Agent command is unavailable

Install the relevant CLI and make sure it is on `PATH` for the Electron process:

```bash
which codex
which opencode
which claude
```

### Embedded shell prints an `nvm` warning

If the app is launched through `npm run dev`, the embedded shell may inherit npm environment variables. With `nvm`, this can produce:

```text
nvm is not compatible with the "npm_config_prefix" environment variable
```

This comes from shell startup, not the terminal renderer. A narrow fix is to sanitize `npm_config_prefix` from the PTY environment before spawning embedded terminals.

### Port conflicts

Electron asks the OS for a free backend port. Vite uses `127.0.0.1:5173` during development.

## Notes For Contributors

- Keep generated run artifacts inside `.context-workspace/runs/<run-id>/`.
- Do not overwrite user-owned `AGENTS.md`, `CLAUDE.md`, or tool configuration files without explicit opt-in.
- Keep Hermes memory as the durable source of shared context.
- Prefer adapter-specific behavior over assuming every agent CLI handles instructions the same way.
- Run `pytest` and `npm run build` before opening a PR.
