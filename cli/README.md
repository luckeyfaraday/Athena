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

## Install it on PATH (run from any directory)

```bash
./cli/athena install-cli
```

This drops a small `athena` launcher into `~/.local/bin` (override with
`--bin-dir`). The launcher hard-codes this install's root and Python and
**preserves your current directory**, so project-scoped commands default to
wherever you run them — you don't have to be in this folder. If `~/.local/bin`
isn't on your `PATH`, the command prints how to add it.

**With the desktop app this is automatic:** when Athena starts it installs the
same shim (see `client/electron/athena-cli.ts`), so `athena` is available in your
terminal after you install Athena. It never overwrites an `athena` you created
yourself.

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
| `install-cli` | Install an `athena` shim on PATH (run from anywhere) |
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
| `Enter` / `→` | Projects: **open** · Sessions: **resume** here · Runs: **follow** logs |
| `←` / `Esc` | Back out of a project (Esc quits at top level) |
| `n` | **Launch** a new agent (interactive in-terminal, or headless run) |
| `r` | Refresh · `/` filter · `q` quit |

**The Sessions tab is grouped by project.** It lists every workspace that has
native sessions (across `codex`/`claude`/`opencode`/`hermes`), most-recent first,
with your current directory marked `►`. Press `Enter` to open a project and see
its sessions, then `Enter` to resume one. This is what makes things findable when
you have sessions scattered across dozens of repos.

Resume uses each session's backend-provided `resume_command` (`codex resume …`,
`claude --resume …`, etc.), now anchored to the session's *own* workspace.
`n` launches/spawns into the project you're currently viewing. Headless launches
go through `/agents/spawn` (codex adapter) and appear in the Runs tab.

> Cross-project listing uses the backend `GET /agents/sessions/all` endpoint
> added with this change. The running Athena desktop app must be on this build
> (restart it, or use `athena serve`) for the aggregated view to populate.

The same data is available non-interactively:

```bash
./cli/athena sessions list --all          # grouped by project
./cli/athena sessions list --all --json   # structured
```

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
