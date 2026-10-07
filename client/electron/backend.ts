import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { defaultPythonExecutable } from "./platform.js";
import { hostStatePath } from "./host-runtime.js";
import { currentNpmGlobalPrefix, mergePathEntries, npmGlobalBinPath, pathKeyOf } from "./terminal-env.js";

export type BackendState = {
  baseUrl: string | null;
  healthy: boolean;
  running: boolean;
  port: number | null;
  lastError: string | null;
};

export type BackendLaunch = {
  command: string;
  args: string[];
  bundled: boolean;
};

const BACKEND_STDERR_LIMIT = 16_384;

let backendProcess: ChildProcessWithoutNullStreams | null = null;
let startedAt: string | null = null;
/** Serialized discovery content last written, excluding the timestamp. */
let lastDiscoveryContent: string | null = null;
let lastDiscoveryMtimeMs: number | null = null;
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
  const launch = resolveBackendLaunch(appRoot, port);
  const backendParent = resolveBackendParent(appRoot);

  backendProcess = spawn(
    launch.command,
    launch.args,
    {
      cwd: backendParent,
      // POSIX group ownership lets shutdown signal uvicorn and every child it
      // may have spawned. Windows uses taskkill /T for the forced fallback.
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        // the backend reports installed agent CLIs; it looks them up on the same PATH the terminals get
        ...backendPathEnv(),
        CONTEXT_WORKSPACE_BACKEND_PORT: String(port),
        // Frozen runtimes already contain the backend package and dependencies.
        // Keep host modules from shadowing that tested bundle at runtime.
        PYTHONPATH: launch.bundled ? "" : mergePythonPath(backendParent, process.env.PYTHONPATH),
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

  let stderrTail = "";
  backendProcess.stderr.on("data", (chunk: Buffer) => {
    const rawText = chunk.toString("utf8");
    stderrTail = `${stderrTail}${rawText}`.slice(-BACKEND_STDERR_LIMIT);
    const text = rawText.trim();
    for (const line of text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
      if (isBackendErrorLine(line)) {
        state = { ...state, lastError: line };
      }
    }
  });

  const launchedProcess = backendProcess;
  backendProcess.on("error", (error) => {
    state = {
      ...state,
      healthy: false,
      running: false,
      lastError: `Backend failed to start with ${launch.command}: ${error.message}`,
    };
    writeBackendDiscovery();
    if (backendProcess === launchedProcess) backendProcess = null;
  });

  backendProcess.on("exit", (code, signal) => {
    const exitSummary = `Backend exited: ${code ?? signal ?? "unknown"}`;
    state = {
      ...state,
      healthy: false,
      running: false,
      lastError: formatBackendExitError(exitSummary, stderrTail),
    };
    writeBackendDiscovery();
    if (backendProcess === launchedProcess) backendProcess = null;
  });

  return waitForHealth(baseUrl);
}

export async function restartBackend(appRoot: string): Promise<BackendState> {
  await stopBackend();
  return startBackend(appRoot);
}

export async function stopBackend(): Promise<boolean> {
  const processToStop = backendProcess;
  backendProcess = null;
  if (!processToStop) {
    state = { ...state, healthy: false, running: false };
    writeBackendDiscovery();
    return true;
  }

  signalBackendTree(processToStop, "SIGTERM");
  let exited = await waitForChildExit(processToStop, 3_000);
  if (!exited) {
    if (process.platform === "win32" && processToStop.pid) {
      await forceKillWindowsTree(processToStop.pid);
    } else {
      signalBackendTree(processToStop, "SIGKILL");
    }
    exited = await waitForChildExit(processToStop, 1_000);
  }

  state = { ...state, healthy: false, running: false };
  writeBackendDiscovery();
  return exited;
}

function signalBackendTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
  });
}

function forceKillWindowsTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => resolve());
    killer.once("exit", () => resolve());
  });
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
    // While the process is alive but not yet serving, ECONNREFUSED just means
    // uvicorn hasn't finished booting. That is expected on every launch, so do
    // not surface it as a user-facing error. A genuine failure shows up via the
    // exit/error handlers or the waitForHealth timeout message instead.
    const stillBooting = state.running && isStartupConnectionError(error);
    state = { ...state, healthy: false, lastError: stillBooting ? null : String(error) };
  }
  writeBackendDiscovery();
  return getBackendState();
}

function isStartupConnectionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ECONNREFUSED" || code === "ECONNRESET") return true;
  return /ECONNREFUSED|ECONNRESET|socket hang up/i.test(String(error));
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

export function resolveBackendLaunch(appRoot: string, port: number): BackendLaunch {
  const configuredPython = process.env.CONTEXT_WORKSPACE_PYTHON?.trim();
  if (configuredPython) {
    return pythonBackendLaunch(configuredPython, port);
  }
  if (appRoot.includes(".asar")) {
    const executable = process.platform === "win32" ? "athena-backend.exe" : "athena-backend";
    return {
      command: path.join(path.dirname(appRoot), "backend-runtime", "athena-backend", executable),
      args: ["--host", "127.0.0.1", "--port", String(port), "--no-access-log"],
      bundled: true,
    };
  }
  return pythonBackendLaunch(defaultPythonExecutable(), port);
}

function pythonBackendLaunch(python: string, port: number): BackendLaunch {
  return {
    command: python,
    args: ["-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1", "--port", String(port), "--no-access-log"],
    bundled: false,
  };
}

// PATH with npm's machine-wide global bin appended when it is missing, as the terminals get it (terminal-env.ts).
function backendPathEnv(): Record<string, string> {
  const key = pathKeyOf(process.env);
  const prefix = currentNpmGlobalPrefix();
  const current = process.env[key] ?? "";
  if (!prefix) return { [key]: current };
  const bin = npmGlobalBinPath(prefix);
  return { [key]: fs.existsSync(bin) ? mergePathEntries(current, bin) : current };
}

function mergePythonPath(backendParent: string, existing: string | undefined): string {
  return existing ? `${backendParent}${path.delimiter}${existing}` : backendParent;
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

export function formatBackendExitError(exitSummary: string, stderr: string): string {
  const detail = stderr.trim();
  return detail ? `${exitSummary}\n${detail}` : exitSummary;
}

// The renderer polls health every few seconds; rewrite backend.json only when
// its content (ignoring the timestamp) changes, or when another writer (such as
// `athena serve`) replaced or removed it -- detected with a cheap stat.
function writeBackendDiscovery(): void {
  const discovery = {
    baseUrl: state.baseUrl,
    port: state.port,
    pid: backendProcess?.pid ?? null,
    healthy: state.healthy,
    running: state.running,
    startedAt,
    lastError: state.lastError,
  };
  const content = JSON.stringify(discovery);
  const filePath = hostStatePath("backend.json");
  if (content === lastDiscoveryContent && fileMtimeMs(filePath) === lastDiscoveryMtimeMs) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({ ...discovery, updatedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
    lastDiscoveryContent = content;
    lastDiscoveryMtimeMs = fileMtimeMs(filePath);
  } catch {
    // Discovery is best-effort; the in-app backend state remains authoritative.
  }
}

function fileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}
