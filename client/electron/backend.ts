import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { defaultPythonExecutable } from "./platform.js";

export type BackendState = {
  baseUrl: string | null;
  healthy: boolean;
  running: boolean;
  port: number | null;
  lastError: string | null;
};

let backendProcess: ChildProcessWithoutNullStreams | null = null;
let startedAt: string | null = null;
let state: BackendState = {
  baseUrl: null,
  healthy: false,
  running: false,
  port: null,
  lastError: null,
};

export function getBackendState(): BackendState {
  return { ...state };
}

export async function startBackend(appRoot: string): Promise<BackendState> {
  if (backendProcess && state.baseUrl) {
    return waitForHealth(state.baseUrl);
  }

  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const python = defaultPythonExecutable();
  const backendParent = resolveBackendParent(appRoot);
  const hermesRefreshCommand = process.env.CONTEXT_WORKSPACE_HERMES_REFRESH_CMD?.trim()
    || defaultHermesRefreshCommand(appRoot, python);

  backendProcess = spawn(
    python,
    ["-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1", "--port", String(port), "--no-access-log"],
    {
      cwd: backendParent,
      env: {
        ...process.env,
        CONTEXT_WORKSPACE_BACKEND_PORT: String(port),
        CONTEXT_WORKSPACE_HERMES_REFRESH_CMD: hermesRefreshCommand,
        PYTHONPATH: mergePythonPath(backendParent, process.env.PYTHONPATH),
      },
      windowsHide: true,
    },
  );
  startedAt = new Date().toISOString();

  state = {
    baseUrl,
    healthy: false,
    running: true,
    port,
    lastError: null,
  };
  writeBackendDiscovery();

  backendProcess.stdout.on("data", () => {
    // Drain stdout so a verbose backend cannot block on pipe backpressure.
  });

  backendProcess.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    for (const line of text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
      if (isBackendErrorLine(line)) {
        state = { ...state, lastError: line };
      }
    }
  });

  backendProcess.on("error", (error) => {
    state = {
      ...state,
      healthy: false,
      running: false,
      lastError: `Backend failed to start with ${python}: ${error.message}`,
    };
    writeBackendDiscovery();
    backendProcess = null;
  });

  backendProcess.on("exit", (code, signal) => {
    state = {
      ...state,
      healthy: false,
      running: false,
      lastError: `Backend exited: ${code ?? signal ?? "unknown"}`,
    };
    writeBackendDiscovery();
    backendProcess = null;
  });

  return waitForHealth(baseUrl);
}

export async function restartBackend(appRoot: string): Promise<BackendState> {
  await stopBackend();
  return startBackend(appRoot);
}

export async function stopBackend(): Promise<void> {
  const processToStop = backendProcess;
  backendProcess = null;
  if (!processToStop) {
    state = { ...state, healthy: false, running: false };
    writeBackendDiscovery();
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      processToStop.kill();
      resolve();
    }, 3000);
    processToStop.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    processToStop.kill();
  });

  state = { ...state, healthy: false, running: false };
  writeBackendDiscovery();
}

export async function checkBackendHealth(): Promise<BackendState> {
  if (!state.baseUrl || !state.running) {
    return getBackendState();
  }
  try {
    const statusCode = await fetchHealthStatus(state.baseUrl);
    const healthy = statusCode >= 200 && statusCode < 300;
    state = {
      ...state,
      healthy,
      lastError: healthy ? null : `Backend health returned HTTP ${statusCode}.`,
    };
  } catch (error) {
    state = { ...state, healthy: false, lastError: String(error) };
  }
  writeBackendDiscovery();
  return getBackendState();
}

async function waitForHealth(baseUrl: string): Promise<BackendState> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    const checked = await checkBackendHealth();
    if (checked.healthy) {
      return checked;
    }
    if (!checked.running && checked.lastError) {
      return checked;
    }
    await delay(250);
  }
  state = { ...state, healthy: false, lastError: "Backend health check timed out." };
  writeBackendDiscovery();
  return getBackendState();
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate backend port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveBackendParent(appRoot: string): string {
  const packagedBackendParent = path.dirname(appRoot);
  const packagedBackend = path.join(packagedBackendParent, "backend");
  if (appRoot.includes(".asar") && path.isAbsolute(packagedBackend)) {
    return packagedBackendParent;
  }
  return path.resolve(appRoot, "..");
}

function mergePythonPath(backendParent: string, existing: string | undefined): string {
  return existing ? `${backendParent}${path.delimiter}${existing}` : backendParent;
}

function defaultHermesRefreshCommand(appRoot: string, python: string): string {
  const scriptPath = resolveRefreshScriptPath(appRoot);
  return `${quoteCommandArg(python)} ${quoteCommandArg(scriptPath)}`;
}

function resolveRefreshScriptPath(appRoot: string): string {
  const candidates = [
    path.resolve(appRoot, "..", "scripts", "hermes-refresh-recall.py"),
    path.resolve(resolveBackendParent(appRoot), "scripts", "hermes-refresh-recall.py"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function quoteCommandArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function fetchHealthStatus(baseUrl: string): Promise<number> {
  const url = new URL("/health", baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.setTimeout(2000, () => {
      request.destroy(new Error("Backend health check timed out."));
    });
    request.on("error", reject);
  });
}

function isBackendErrorLine(line: string): boolean {
  return /^(ERROR|CRITICAL):/.test(line) || line.startsWith("Traceback ");
}

function writeBackendDiscovery(): void {
  try {
    const directory = path.join(os.homedir(), ".context-workspace");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "backend.json"),
      JSON.stringify(
        {
          baseUrl: state.baseUrl,
          port: state.port,
          pid: backendProcess?.pid ?? null,
          healthy: state.healthy,
          running: state.running,
          startedAt,
          lastError: state.lastError,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    // Discovery is best-effort; the in-app backend state remains authoritative.
  }
}
