# Athena CLI (prototype)

A headless, terminal-native frontend to the Athena backend. It is a **sibling of
the MCP server**: both talk to the same FastAPI backend over HTTP through the
shared client in `mcp_server/client.py`. There is no duplicated HTTP logic,
discovery, or WSL handling — the CLI reuses all of it.

> **Status:** prototype. Scope is mostly **Tier-1 (headless)**: everything the
> backend can do without the Electron desktop app. The one exception is
> [`athena remote`](#remote-machines), which drives the terminals of Athena
> desktops on your *other* machines over Tailscale.

## Why this exists

The Electron app currently *is* the product — the backend can't really be used
without it. This CLI decouples the engine from the desktop shell so Athena's
core (memory, sessions, ask-hermes) is usable over SSH,
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
| `sessions list` | Native Codex/Claude/OpenCode/Hermes sessions |
| `sessions transcript <provider> <id>` | Read a native transcript |
| `snapshot` | One-shot overview of everything (`--json`) |
| `tui` | Interactive command room (SSH-friendly) |
| `install-cli` | Install an `athena` shim on PATH (run from anywhere) |
| `serve` | Launch the backend headlessly |
| `remote …` | Drive Athena terminals on your other machines ([below](#remote-machines)) |

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
| `Enter` / `→` | Projects: **open** · Sessions: **resume** here |
| `←` / `Esc` | Back out of a project (Esc quits at top level) |
| `n` | **Launch** a new agent interactively in this terminal |
| `r` | Refresh · `/` filter · `q` quit |

**The Sessions tab is grouped by project.** It lists every workspace that has
native sessions (across `codex`/`claude`/`opencode`/`hermes`), most-recent first,
with your current directory marked `►`. Press `Enter` to open a project and see
its sessions, then `Enter` to resume one. This is what makes things findable when
you have sessions scattered across dozens of repos.

Resume uses each session's backend-provided `resume_command` (`codex resume …`,
`claude --resume …`, etc.), now anchored to the session's *own* workspace.
`n` launches an agent into the project you're currently viewing.

> Cross-project listing uses the backend `GET /agents/sessions/all` endpoint
> added with this change. The running Athena desktop app must be on this build
> (restart it, or use `athena serve`) for the aggregated view to populate.

The same data is available non-interactively:

```bash
./cli/athena sessions list --all          # grouped by project
./cli/athena sessions list --all --json   # structured
```

## Remote machines

`athena remote` drives the Athena terminals on your other computers from a
shell, for example over SSH from a phone. Each machine's Athena exposes its
control API on its Tailscale addresses (port 47821) once **Settings > System >
Remote access** is turned on there. These commands talk to that API directly
over HTTP using only the Python standard library: no backend, no httpx.

```bash
athena remote machines                      # your other computers + whether Athena answers
athena remote ls                            # running terminals on every ready machine
athena remote ls omarchy --all              # one machine, including exited terminals
athena remote spawn omarchy claude --workspace '~/src/app' --task "fix the failing test"
athena remote open omarchy '~/src/notes'    # open a workspace tab there
athena remote tail omarchy:claude --follow  # backlog, then live output until it exits
athena remote say omarchy:claude "yes, commit it"
athena remote keys omarchy:claude --key down --key enter
athena remote kill omarchy:3f9c2a1b
```

| Command | What it does |
|---|---|
| `remote machines` | Desktop peers on your tailnet: `ready`, `needs token`, `refused`, `not answering`, `offline` |
| `remote ls [MACHINE]` | Terminals on one machine, or every ready one (`--all` adds exited ones) |
| `remote spawn MACHINE KIND --workspace PATH` | Start `shell`/`claude`/`codex`/`opencode`/`athena`/`grok`/`hermes` (`--task`, `--count 1-8`, `--title`, `--memory-override`); prints one TARGET per terminal |
| `remote open MACHINE PATH` | Open a workspace tab on that machine (`--select` to switch to it) |
| `remote tail TARGET` | Print the terminal's backlog (`--lines N`, `--chars N`); `--follow` streams until it exits |
| `remote say TARGET TEXT…` | Type the text and submit it (Enter), the way Athena sends prompts |
| `remote keys TARGET [DATA]` | Raw keystrokes, nothing appended. DATA understands `\r \n \t \e \xHH \\`; `--key` (repeatable) adds `enter esc tab up down left right ctrl-c ctrl-d backspace` after it |
| `remote kill TARGET` | Kill a terminal |

**Addressing.** MACHINE is a tailnet name (short name, OS hostname, or full
MagicDNS name), a Tailscale IP, `host:port`, or `http://host:port`; anything
`tailscale status` doesn't know is used as a hostname as-is only without a token.
With `--token` or `ATHENA_REMOTE_TOKEN`, an undiscovered destination requires an
explicit full `http://` or `https://` URL so a typo cannot send credentials to an
unintended DNS host. TARGET is
`MACHINE:TERMINAL` (`MACHINE:PORT:TERMINAL` with an explicit port, or
`http://host:port/TERMINAL`). TERMINAL is the id shown by `remote ls` (any
unique prefix of 4+ characters) or a handle the remote Athena resolves itself:
`claude` when there is one Claude pane, `claude#2`, `codex#1`.

**Access.** Every device needs the host's access token by default: pass `--token` or set
`ATHENA_REMOTE_TOKEN` (on that machine: Settings > System > Remote access > Copy
token). Alternatively, explicitly enable **Trust my own devices** on the host to
let other devices signed in to the same Tailscale account connect without a token.
A token belongs to one machine, so it is only sent by commands that
name a machine (`ls MACHINE`, `spawn`, `tail`, `say`, ...); `remote machines`
and a bare `remote ls` contact every peer and never send it. `--port` /
`ATHENA_REMOTE_PORT` change the port.

**Paths are the remote machine's.** `--workspace ~/src/app` is expanded by
*your* shell to *your* home before Athena sees it. Quote it (`'~/src/app'`) and
`athena remote` expands `~` to the remote home instead (the `homedir` that
`athena remote machines --json` shows). A path under your local home that isn't
under the remote one gets a warning.

## Design notes

- `cli/_client.py` puts `mcp_server/` on `sys.path` and reuses
  `ContextWorkspaceClient`, wrapping its async methods synchronously. Keep it
  that way — re-implementing the HTTP layer is how the CLI and MCP server drift.
- `cli/serve.py` is the only genuinely new capability: a backend launch path
  independent of Electron, plus discovery-file publishing.
- Tier-2 (visible terminals, open/close workspace, inject input) would layer on
  `ContextWorkspaceElectronClient` and only work while Athena is open.
- `cli/remote.py` deliberately does *not* go through `_client.py`: it talks to
  other machines' Electron control API (`client/electron/control-server.ts`)
  with `http.client`, and to Tailscale through `tailscale status --json`, so it
  runs on a bare Python install.
