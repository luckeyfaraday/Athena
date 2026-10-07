import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configureHostRuntime, hostStatePath } from "./host-runtime.js";
import { acquireServerLock, parseServerOptions, serverServiceFile } from "./server-options.js";
import { readRemoteAccessConfig, writeRemoteAccessConfig, generateRemoteToken } from "./remote-access.js";

const entry = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(entry), "../..");
const appRoot = path.join(repoRoot, "client");

async function main(): Promise<void> {
  const options = parseServerOptions(process.argv.slice(2));
  if (options.command === "help") {
    console.log(`Athena server (Node.js, no desktop required)
Usage: athena server [run|token|status|service-file] [options]
  --data-dir PATH   Service state (default ~/.context-workspace/server)
  --port PORT       Tailscale port (default 47821; match your desktop)
  --workspace PATH  Open a project on startup (repeatable)
  --restore         Resume saved agent sessions after service restart
  --local-only      Listen on loopback only, for local use/testing
  --no-backend      Terminals only; disable Hermes and conversation history

token prints the pairing token to your terminal, never to the service journal.
service-file prints a systemd user unit. See server/README.md for installation.`);
    return;
  }
  const venvPython = path.join(repoRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const python = process.env.CONTEXT_WORKSPACE_PYTHON ?? (fs.existsSync(venvPython) ? venvPython : process.platform === "win32" ? "python" : "python3");
  if (options.command === "service-file") {
    console.log(serverServiceFile(options, entry, python));
    return;
  }
  const configFile = path.join(options.dataDir, "remote-access.json");
  if (options.command === "token") {
    const token = readRemoteAccessConfig(configFile).token;
    if (!token) throw new Error("No pairing token exists yet. Start the server first.");
    console.log(token);
    return;
  }
  if (options.command === "status") {
    const file = path.join(options.dataDir, "electron-control.json");
    const discovery = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!discovery.running) throw new Error("Athena server is stopped.");
    const response = await fetch(`${discovery.baseUrl}/machine`, {
      headers: { authorization: `Bearer ${discovery.token}` }, signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`Athena server status returned HTTP ${response.status}.`);
    console.log(JSON.stringify(await response.json(), null, 2));
    return;
  }

  const releaseLock = acquireServerLock(options.dataDir);
  process.once("exit", releaseLock);
  process.umask(0o077);
  const version = JSON.parse(fs.readFileSync(path.join(repoRoot, "server/package.json"), "utf8")).version as string;
  configureHostRuntime({
    userData: () => options.dataDir, stateDirectory: () => options.dataDir,
    version: () => version,
  });
  process.env.CONTEXT_WORKSPACE_PYTHON = python;
  process.env.CONTEXT_WORKSPACE_BACKEND_STATE = hostStatePath("backend.json");
  process.env.CONTEXT_WORKSPACE_ELECTRON_CONTROL_STATE = hostStatePath("electron-control.json");
  // Starting from an Athena pane must not give this host's agents the parent
  // desktop's URLs/token. They discover this service's private control file.
  delete process.env.CONTEXT_WORKSPACE_BACKEND_URL;
  delete process.env.CONTEXT_WORKSPACE_ELECTRON_CONTROL_URL;
  delete process.env.CONTEXT_WORKSPACE_ELECTRON_CONTROL_TOKEN;
  delete process.env.CONTEXT_WORKSPACE_TERMINAL_ID;
  // Import after selecting the service's state directory; desktop state stays separate.
  const engine = await import("./embedded-terminal.js");
  const backend = await import("./backend.js");
  const control = await import("./control-server.js");
  const remote = await import("./remote-control.js");
  const launch = await import("./launch-state.js");
  const workspaces = await import("./workspace-registry.js");
  const { flushAgentMessages } = await import("./agent-messages.js");
  const { sessionIndexClient } = await import("./session-index-client.js");
  const { resolveNpmGlobalPrefix } = await import("./terminal-env.js");
  let stopping = false;
  let startup: Promise<void>;
  async function shutdown(code: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 30_000);
    try {
      // Finish startup before tearing down, so it cannot reopen a listener.
      await startup?.catch(() => undefined);
      sessionIndexClient.dispose();
      const results = await Promise.allSettled([
        remote.stopRemoteAccess(), control.stopControlServer(),
        engine.prepareEmbeddedTerminalRestoreForQuit(), backend.stopBackend(),
      ]);
      if (results[2].status === "fulfilled") engine.confirmEmbeddedTerminalRestoreShutdown();
      flushAgentMessages();
      if (results.every((result) => result.status === "fulfilled" && result.value !== false)) launch.markAthenaCleanExit();
      else code = 1;
    } catch (error) {
      console.error(`Athena server shutdown: ${String(error)}`);
      code = 1;
    } finally {
      clearTimeout(deadline);
      releaseLock();
      process.exit(code);
    }
  }
  process.once("SIGTERM", () => void shutdown(0));
  process.once("SIGINT", () => void shutdown(0));
  process.once("uncaughtException", (error) => { console.error(error); void shutdown(1); });
  process.once("unhandledRejection", (error) => { console.error(error); void shutdown(1); });
  startup = (async () => {
    launch.beginAthenaLaunch({ restoreAttemptPending: engine.hasPendingEmbeddedTerminalRestoreAttempts(), cleanupStaleProcesses: false });
    workspaces.initializeWorkspaceRegistry(hostStatePath("workspaces.json"));
    for (const workspace of options.workspaces) {
      const { validatedWorkspacePath } = await import("./control-access.js");
      workspaces.openHostWorkspace(validatedWorkspacePath(workspace), false);
    }
    engine.initEmbeddedTerminals(appRoot);
    await resolveNpmGlobalPrefix();
    if (stopping) return;
    if (options.backend) {
      const state = await backend.startBackend(appRoot);
      if (!state.healthy) throw new Error(state.lastError ?? "Python backend did not become healthy. Install backend/requirements.txt in .venv.");
    }
    if (stopping) return;
    await control.startControlServer();
    if (stopping) return;
    const previous = readRemoteAccessConfig(configFile);
    writeRemoteAccessConfig(configFile, {
      ...previous, enabled: !options.localOnly, port: options.port ?? previous.port,
      token: previous.token ?? generateRemoteToken(),
    });
    const state = await remote.startRemoteAccess();
    if (stopping) return;
    if (options.restore) await engine.restoreEmbeddedTerminals();
    console.log(`Athena server ready. State: ${options.dataDir}`);
    for (const url of state.urls) console.log(`Tailscale: ${url}`);
    for (const error of state.errors) console.warn(error);
    console.log("Use 'athena server token' with the same --data-dir to pair a desktop.");
  })();
  try { await startup; } catch (error) { console.error(String(error)); await shutdown(1); }
}

void main().catch((error) => { console.error(String(error)); process.exitCode = 1; });
