# Athena CLI (prototype)

A headless, terminal-native frontend to the Athena backend. It is a **sibling of
the MCP server**: both talk to the same FastAPI backend over HTTP through the
shared client in `mcp_server/client.py`. There is no duplicated HTTP logic,
discovery, or WSL handling — the CLI reuses all of it.

> **Status:** prototype. Scope is **Tier-1 (headless)** only — everything the
> backend can do without the Electron desktop app. Visible-terminal and
> workspace remote-control commands (which require the running desktop app) are
> intentionally not included yet.

## Why this exists

The Electron app currently *is* the product — the backend can't really be used
without it. This CLI decouples the engine from the desktop shell so Athena's
core (memory, recall, sessions, headless runs, ask-hermes) is usable over SSH,
in CI, from cron, from scripts, and from other Athena-related projects.

## Running

```bash
# from the repo root
python -m cli --help
# or the wrapper
./cli/athena --help
```

If no backend is running, start one headlessly (this is the one piece of new
plumbing — normally Electron owns the backend lifecycle):

```bash
./cli/athena serve            # uvicorn backend.app:app on 127.0.0.1:8000
                              # writes ~/.context-workspace/backend.json so
                              # every other command + the MCP server find it
```

Otherwise the CLI auto-discovers a backend already started by Athena via
`~/.context-workspace/backend.json`, or falls back to `http://127.0.0.1:8000`.

## Commands

| Command | What it does |
|---|---|
| `health` | Backend health + resolved URL |
| `status` | Hermes install + memory status |
| `memory query <text>` | Query Hermes memory |
| `memory recent` | Recent memory entries |
| `memory project` | Project-scoped memory (`--project-dir`) |
| `memory store <text>` | Append a memory entry |
| `memory delete <text>` | Delete an exact entry |
| `ask <question>` | One-shot Hermes Q&A (`--context`, `--context-file`) |
| `recall show` | Print the project recall cache |
| `recall status` | Recall freshness / metadata |
| `recall write [md]` | Write recall (arg, `--file`, or stdin) |
| `sessions list` | Native Codex/Claude/OpenCode/Hermes sessions |
| `sessions transcript <provider> <id>` | Read a native transcript |
| `run start <task>` | Start a headless agent run (`--wait`, `--follow`) |
| `run list` / `run get <id>` / `run cancel <id>` | Manage runs |
| `run logs <id> [--follow]` | Read/stream run artifacts live |
| `snapshot` | One-shot overview of everything (`--json`) |
| `tui` | Interactive command room (SSH-friendly) |
| `serve` | Launch the backend headlessly |

Global flags: `--json` (machine output), `--backend-url`, `--project-dir`.

## TUI — the SSH command room

```bash
./cli/athena tui
```

A stdlib-`curses` full-screen UI (no third-party deps, runs over any SSH
session). The key idea: you are already in a terminal, so it needs none of
Athena's Electron PTY layer. It browses the backend and, when you act, it
*suspends itself*, execs the real agent binary in your terminal, then resumes.

| Key | Action |
|---|---|
| `↑`/`↓` or `j`/`k` | Move selection |
| `Tab` / `1` / `2` | Switch Sessions / Runs |
| `Enter` | Sessions: **resume** the session here · Runs: **follow** logs live |
| `n` | **Launch** a new agent (interactive in-terminal, or headless run) |
| `r` | Refresh · `/` filter · `q` quit |

Resume uses each session's backend-provided `resume_command`
(`codex resume …`, `claude --resume …`, etc.). Headless launches go through
`/agents/spawn` (codex adapter) and appear in the Runs tab.

### The "see every single thing" workflow

```bash
./cli/athena run start "add a test for the parser" --agent codex --follow
```

`--follow` streams the run's `stdout` artifact live until the run reaches a
terminal state, then exits non-zero on failure. `run logs <id> --follow` does the
same for an already-started run.

## Design notes

- `cli/_client.py` puts `mcp_server/` on `sys.path` and reuses
  `ContextWorkspaceClient`, wrapping its async methods synchronously. Keep it
  that way — re-implementing the HTTP layer is how the CLI and MCP server drift.
- `cli/serve.py` is the only genuinely new capability: a backend launch path
  independent of Electron, plus discovery-file publishing.
- Tier-2 (visible terminals, open/close workspace, inject input) would layer on
  `ContextWorkspaceElectronClient` and only work while Athena is open.
