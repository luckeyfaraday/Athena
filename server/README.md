# Athena server

Run Athena's agent and terminal engine as a Node.js service on Linux. Connect
from the machine switcher in Athena on Windows, macOS, or Linux over Tailscale.
The server does not install, import, or launch Electron or require a display.

The desktop and service share terminal launching, streaming, input, approval
handling, agent messaging, attention events, directory browsing, and session
history/resume. The service owns and saves open workspaces without a renderer.
Closing a viewing desktop disconnects its streams; agents keep running.

## Install on Linux

Use a checkout containing this feature on the server and the viewing desktop.
Requirements: Node.js 22.15+ with npm, Python 3.11+, Git, and Tailscale installed
and signed in. Install and sign in to each agent CLI as the Linux user who will
run the service. Projects and agent credentials belong to that Linux user.

From the repository root:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt -r mcp_server/requirements.txt
npm ci --prefix server
npm run build --prefix server
.venv/bin/python -m cli install-cli
athena server run --workspace "$HOME/projects/my-app"
```

If Python's venv module or the compiler for `node-pty` is missing, install your
distribution's Python venv and C++ build packages first (on Ubuntu/Debian:
`python3-venv`, `build-essential`). No desktop dependencies are needed.
If `~/.local/bin` is not on PATH, use `.venv/bin/python -m cli server` in place
of `athena server`, or `node server/dist/server-main.js` directly.

The server listens on loopback for local agent/MCP control and on addresses
confirmed by the local Tailscale client for remote control (port **47821**).
It waits and retries if Tailscale is not ready. No public or LAN listener is
created. Python's backend stays on loopback.

In another terminal on the server:

```bash
athena server status
athena server token
```

Copy that token into **Settings → System → Your machines → Access token** on
the viewing computer. Select the server in the machine switcher. Keep the remote
port the same on both machines. Existing terminal-capable remote clients work;
remote chat requires the desktop changes in this feature too.

## Start automatically with systemd

Generate a user unit with absolute paths to this installation, Node, Python,
the state directory, and the PATH containing your agent tools:

```bash
mkdir -p ~/.config/systemd/user
athena server service-file > ~/.config/systemd/user/athena-server.service
systemctl --user daemon-reload
systemctl --user enable --now athena-server
journalctl --user -u athena-server -f
```

Enable lingering for this user (`loginctl enable-linger "$USER"`, administrator
authorization may be required) to start at boot and keep running after logout.
Run as your regular development user. Token values are never written to the
service journal; `athena server token` prints one only when requested.

Stop a foreground server before starting the systemd unit. The instance lock
rejects a second process using the same data directory. Use
`systemctl --user stop athena-server` to stop the service and its processes.

## Lifecycle and state

- Defaults to `~/.context-workspace/server`, separate from desktop state.
- `--data-dir PATH` selects another directory; pass it to `token`, `status`, and
  `service-file` too. Files containing credentials are private to the owner.
- Open workspaces and the remote pairing token survive service restarts.
- Client disconnects, UI reloads, and switching machines leave processes running.
- Stopping/restarting the **service** stops its processes. `--restore` opts into
  the existing saved-session resume mechanism on startup; it does not preserve
  an in-memory process across a reboot. Without it, resume agents from Sessions.
- `--workspace PATH` can be repeated; saved tabs reopen automatically.
- `--local-only` disables Tailscale listeners for local development/testing.
- `--no-backend` runs terminal-only; Hermes and native conversation history need
  the Python backend, which starts by default. `CONTEXT_WORKSPACE_PYTHON` chooses
  another interpreter; otherwise the repository's `.venv` is used when present.

Remote panes support terminal and chat view, including reading conversation
history from the host. Image uploads from a viewing computer are not implemented;
reference files already on the server. Local settings, themes, and desktop
notifications remain on the viewing device. Windows-only programs still require
a Windows host. This is a service for an authorized user's own machines, not a
multi-user sandbox.

## Update and verify

After updating the checkout, run `npm ci --prefix server` and
`npm run build --prefix server`, update Python requirements if changed, then
restart the service when its running jobs can be interrupted. Regenerate the
unit if you moved the checkout or changed Node/Python/PATH.

```bash
npm test --prefix server
# Also exercise the real Python backend and a fixture agent on Linux:
ATHENA_TEST_BACKEND=1 npm test --prefix server
```

The integration test starts a real service and PTY, connects the same remote
client used by the desktop, disconnects it, and reconnects another client to
the original process. It also checks authentication, output replay, workspace
events/persistence, pairing persistence, and duplicate instance rejection.
