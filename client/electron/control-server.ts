import fs from "node:fs";
import { BrowserWindow } from "electron";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  findEmbeddedTerminal,
  getEmbeddedTerminalBuffer,
  killEmbeddedTerminal,
  listEmbeddedTerminals,
  spawnEmbeddedTerminal,
  submitEmbeddedTerminalInput,
  type EmbeddedTerminalKind,
  type EmbeddedTerminalSession,
} from "./embedded-terminal.js";
import { recordControlFailure } from "./control-events.js";
import { isUncPath, isWindowsPath, normalizeNativePath, toWorkspacePath, type WorkspacePath } from "./platform.js";

type ControlState = {
  baseUrl: string | null;
  port: number | null;
  running: boolean;
  lastError: string | null;
};

type SpawnTerminalRequest = {
  project_dir?: string;
  workspace?: string;
  open_workspace?: boolean;
  openWorkspace?: boolean;
  select_workspace?: boolean;
  selectWorkspace?: boolean;
  kind?: string;
  count?: number;
  title?: string;
  task?: string;
  resume_session_id?: string;
  session_label?: string;
  context_mode?: string;
  context?: string;
  context_text?: string;
  cols?: number;
  rows?: number;
};

type WriteTerminalRequest = {
  terminal_id?: string;
  terminalId?: string;
  session_id?: string;
  sessionId?: string;
  target?: string;
  text?: string;
  input?: string;
};

type OpenWorkspaceRequest = {
  project_dir?: string;
  workspace?: string;
  select?: boolean;
};

type CloseWorkspaceRequest = {
  project_dir?: string;
  workspace?: string;
};

const SUPPORTED_TERMINAL_KINDS = new Set<EmbeddedTerminalKind>(["shell", "hermes", "codex", "opencode", "claude"]);
const MAX_TERMINAL_SPAWN_COUNT = 8;
const CONTROL_WATCHDOG_INTERVAL_MS = 10_000;
const CONTROL_HEALTH_FAILURE_THRESHOLD = 3;
const PROTECTED_POSIX_ROOTS = new Set(["/", "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var"]);
const PROTECTED_WINDOWS_ROOT_NAMES = new Set(["windows", "program files", "program files (x86)", "programdata"]);

let server: http.Server | null = null;
let watchdog: NodeJS.Timeout | null = null;
let watchdogRestartInFlight = false;
let healthFailureCount = 0;
let state: ControlState = {
  baseUrl: null,
  port: null,
  running: false,
  lastError: null,
};

export type { ControlState };

export function getControlState(): ControlState {
  return { ...state };
}

export async function checkControlHealth(): Promise<ControlState> {
  if (!state.baseUrl || !state.running) return getControlState();
  try {
    const statusCode = await fetchControlHealthStatus(state.baseUrl);
    const healthy = statusCode >= 200 && statusCode < 300;
    healthFailureCount = healthy ? 0 : healthFailureCount + 1;
    state = {
      ...state,
      running: healthy || healthFailureCount < CONTROL_HEALTH_FAILURE_THRESHOLD,
      lastError: healthy
        ? null
        : `Electron control health returned HTTP ${statusCode} (${healthFailureCount}/${CONTROL_HEALTH_FAILURE_THRESHOLD}).`,
    };
  } catch (error) {
    healthFailureCount += 1;
    state = {
      ...state,
      running: healthFailureCount < CONTROL_HEALTH_FAILURE_THRESHOLD,
      lastError: `Electron control server is unavailable at ${state.baseUrl} (${healthFailureCount}/${CONTROL_HEALTH_FAILURE_THRESHOLD}): ${String(error)}`,
    };
  }
  writeControlDiscovery();
  return getControlState();
}

export async function startControlServer(): Promise<ControlState> {
  if (server && state.baseUrl && state.running) {
    startControlWatchdog();
    return { ...state };
  }

  const port = await findFreePort();
  const nextServer = http.createServer((request, response) => {
    void handleRequest(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    nextServer.once("error", reject);
    nextServer.listen(port, "127.0.0.1", resolve);
  }).catch((error) => {
    state = {
      baseUrl: null,
      port: null,
      running: false,
      lastError: `Electron control server failed to start: ${String(error)}`,
    };
    writeControlDiscovery();
    throw error;
  });

  server = nextServer;
  state = {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    running: true,
    lastError: null,
  };
  healthFailureCount = 0;
  writeControlDiscovery();
  startControlWatchdog();
  return { ...state };
}

export async function restartControlServer(reason = "manual restart"): Promise<ControlState> {
  stopControlWatchdog();
  const serverToStop = server;
  server = null;
  if (serverToStop) {
    await new Promise<void>((resolve) => serverToStop.close(() => resolve()));
  }
  state = {
    baseUrl: null,
    port: null,
    running: false,
    lastError: `Electron control restarting: ${reason}`,
  };
  healthFailureCount = 0;
  writeControlDiscovery();
  return startControlServer();
}

export async function stopControlServer(): Promise<void> {
  stopControlWatchdog();
  const serverToStop = server;
  server = null;
  if (!serverToStop) {
    state = { ...state, running: false };
    writeControlDiscovery();
    return;
  }
  await new Promise<void>((resolve) => serverToStop.close(() => resolve()));
  state = { ...state, running: false };
  writeControlDiscovery();
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { status: "ok", service: "electron-control" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/terminals") {
      sendJson(response, 200, { terminals: listEmbeddedTerminals() });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/terminals/") && url.pathname.endsWith("/buffer")) {
      const target = decodeURIComponent(url.pathname.slice("/terminals/".length, -"/buffer".length));
      const terminal = requireResolvedTerminal(target);
      const maxChars = boundedMaxChars(url.searchParams.get("max_chars"));
      const buffer = tailText(getEmbeddedTerminalBuffer(terminal.id), maxChars);
      sendJson(response, 200, {
        terminal,
        buffer,
        chars: buffer.length,
        max_chars: maxChars,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspaces/open") {
      const payload = parseOpenWorkspaceRequest(await readJsonBody(request));
      const workspace = openWorkspaceInRenderer(payload.workspace, payload.select);
      sendJson(response, 200, { workspace, selected: payload.select });
      return;
    }
    if (request.method === "POST" && url.pathname === "/workspaces/close") {
      const payload = parseCloseWorkspaceRequest(await readJsonBody(request));
      const result = await closeWorkspaceInRenderer(payload.workspace);
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/terminals/") && url.pathname.endsWith("/resolve")) {
      const target = decodeURIComponent(url.pathname.slice("/terminals/".length, -"/resolve".length));
      sendJson(response, 200, { terminal: findEmbeddedTerminal(target) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/terminals/write") {
      const payload = parseWriteTerminalRequest(await readJsonBody(request));
      const session = await submitEmbeddedTerminalInput(payload.target, payload.text).catch((error) => {
        recordControlFailure({
          kind: "input.failed",
          detail: String(error),
          preview: payload.text,
        });
        throw error;
      });
      sendJson(response, 200, { written: true, terminal: session });
      return;
    }
    if (request.method === "POST" && url.pathname === "/terminals/kill") {
      const payload = parseKillTerminalRequest(await readJsonBody(request));
      const terminal = requireResolvedTerminal(payload.target);
      const killed = await killEmbeddedTerminal(terminal.id);
      sendJson(response, 200, { killed: true, terminal: killed });
      return;
    }
    if (request.method === "POST" && url.pathname === "/terminals/spawn") {
      const payload = parseSpawnTerminalRequest(await readJsonBody(request));
      if (payload.openWorkspace) {
        payload.workspace = openWorkspaceInRenderer(payload.workspace, payload.selectWorkspace).nativePath;
      }
      const sessions: EmbeddedTerminalSession[] = [];
      for (let index = 0; index < payload.count; index += 1) {
        const session = await spawnEmbeddedTerminal(payload.workspace, {
          kind: payload.kind,
          title: payload.count > 1 ? terminalGridTitle(payload.kind, index) : payload.title,
          task: payload.task,
          cols: payload.cols,
          rows: payload.rows,
          resumeSessionId: payload.resumeSessionId,
          sessionLabel: payload.sessionLabel,
          contextMode: payload.contextMode,
          contextText: payload.contextText,
          controlSource: "electron-control",
        }).catch((error) => {
          recordControlFailure({
            kind: "spawn.failed",
            detail: String(error),
            preview: payload.task,
          });
          throw error;
        });
        sessions.push(session);
        if (payload.kind === "opencode" && index < payload.count - 1) await delay(650);
      }
      sendJson(response, 200, { sessions });
      return;
    }
    sendJson(response, 404, { error: `Unknown control endpoint: ${request.method} ${url.pathname}` });
  } catch (error) {
    state = { ...state, lastError: String(error) };
    writeControlDiscovery();
    sendJson(response, 400, { error: String(error) });
  }
}

function parseWriteTerminalRequest(body: unknown): { target: string; text: string } {
  if (!body || typeof body !== "object") throw new Error("Request body must be an object.");
  const request = body as WriteTerminalRequest;
  const target = stringValue(request.target)
    ?? stringValue(request.terminal_id)
    ?? stringValue(request.terminalId)
    ?? stringValue(request.session_id)
    ?? stringValue(request.sessionId);
  if (!target) throw new Error("terminal_id, session_id, or target is required.");
  const text = stringValue(request.text) ?? stringValue(request.input);
  if (!text) throw new Error("text is required.");
  return { target, text };
}

function parseKillTerminalRequest(body: unknown): { target: string } {
  if (!body || typeof body !== "object") throw new Error("Request body must be an object.");
  const request = body as WriteTerminalRequest;
  const target = stringValue(request.target)
    ?? stringValue(request.terminal_id)
    ?? stringValue(request.terminalId)
    ?? stringValue(request.session_id)
    ?? stringValue(request.sessionId);
  if (!target) throw new Error("terminal_id, session_id, or target is required.");
  return { target };
}

function parseSpawnTerminalRequest(body: unknown): {
  workspace: string;
  openWorkspace: boolean;
  selectWorkspace: boolean;
  kind: EmbeddedTerminalKind;
  count: number;
  title?: string;
  task?: string;
  resumeSessionId?: string;
  sessionLabel?: string;
  contextMode?: "none" | "task" | "curated";
  contextText?: string;
  cols?: number;
  rows?: number;
} {
  if (!body || typeof body !== "object") throw new Error("Request body must be an object.");
  const request = body as SpawnTerminalRequest;
  const workspace = String(request.project_dir ?? request.workspace ?? "").trim();
  if (!workspace) throw new Error("project_dir is required.");
  const kind = String(request.kind ?? "shell").trim().toLowerCase();
  if (!SUPPORTED_TERMINAL_KINDS.has(kind as EmbeddedTerminalKind)) {
    throw new Error(`Unsupported terminal kind: ${request.kind}`);
  }
  const rawCount = Number(request.count ?? 1);
  const count = Math.max(1, Math.min(Number.isFinite(rawCount) ? Math.floor(rawCount) : 1, MAX_TERMINAL_SPAWN_COUNT));
  return {
    workspace,
    openWorkspace: booleanValue(request.open_workspace ?? request.openWorkspace),
    selectWorkspace: booleanValue(request.select_workspace ?? request.selectWorkspace ?? request.open_workspace ?? request.openWorkspace, true),
    kind: kind as EmbeddedTerminalKind,
    count,
    title: stringValue(request.title),
    task: stringValue(request.task),
    resumeSessionId: stringValue(request.resume_session_id),
    sessionLabel: stringValue(request.session_label),
    contextMode: contextModeValue(request.context_mode),
    contextText: stringValue(request.context_text) ?? stringValue(request.context),
    cols: numberValue(request.cols),
    rows: numberValue(request.rows),
  };
}

function parseOpenWorkspaceRequest(body: unknown): { workspace: string; select: boolean } {
  if (!body || typeof body !== "object") throw new Error("Request body must be an object.");
  const request = body as OpenWorkspaceRequest;
  return {
    workspace: validatedWorkspacePath(request.project_dir ?? request.workspace),
    select: booleanValue(request.select, true),
  };
}

function parseCloseWorkspaceRequest(body: unknown): { workspace: string } {
  if (!body || typeof body !== "object") throw new Error("Request body must be an object.");
  const request = body as CloseWorkspaceRequest;
  return { workspace: validatedWorkspacePath(request.project_dir ?? request.workspace) };
}

function validatedWorkspacePath(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("project_dir is required.");
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) throw new Error("Project directory must be a local filesystem path, not a URL.");
  if (isUncPath(raw)) throw new Error("UNC workspace paths are not supported by Electron control yet.");
  if (!path.isAbsolute(raw) && !isWindowsPath(raw)) throw new Error("Project directory must be an absolute path.");

  const normalized = normalizeNativePath(raw);
  const resolved = fs.realpathSync.native(normalized);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`Project directory is not a directory: ${resolved}`);

  const home = fs.realpathSync.native(os.homedir());
  if (sameControlPath(resolved, home)) throw new Error("Refusing to use the home directory as a project root.");

  if (process.platform === "win32" || isWindowsPath(resolved)) {
    rejectProtectedWindowsWorkspace(resolved);
    return resolved;
  }

  if (PROTECTED_POSIX_ROOTS.has(path.posix.normalize(resolved))) {
    throw new Error(`Refusing to use protected directory as a project root: ${resolved}`);
  }
  return resolved;
}

function rejectProtectedWindowsWorkspace(workspace: string): void {
  const parsed = path.win32.parse(workspace);
  const normalized = path.win32.normalize(workspace);
  if (sameControlPath(normalized, parsed.root)) {
    throw new Error(`Refusing to use drive root as a project root: ${workspace}`);
  }
  const relativeParts = normalized.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  const firstPart = relativeParts[0]?.toLowerCase();
  if (firstPart && PROTECTED_WINDOWS_ROOT_NAMES.has(firstPart)) {
    throw new Error(`Refusing to use protected Windows directory as a project root: ${workspace}`);
  }
}

function sameControlPath(left: string, right: string): boolean {
  const normalize = process.platform === "win32" || isWindowsPath(left) || isWindowsPath(right)
    ? (value: string) => path.win32.normalize(value).toLowerCase()
    : (value: string) => path.posix.normalize(value);
  return normalize(left) === normalize(right);
}

function openWorkspaceInRenderer(workspace: string, select: boolean): WorkspacePath {
  const workspacePath = toWorkspacePath(workspace);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("workspace:open", { workspace: workspacePath, select });
  }
  return workspacePath;
}

async function closeWorkspaceInRenderer(workspace: string): Promise<{ closed: true; workspace: WorkspacePath; killed: EmbeddedTerminalSession[] }> {
  const workspacePath = toWorkspacePath(workspace);
  const killed = await Promise.all(listEmbeddedTerminals()
    .filter((terminal) => sameControlPath(terminal.workspace, workspacePath.nativePath))
    .map((terminal) => killEmbeddedTerminal(terminal.id)));
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("workspace:close", { workspace: workspacePath });
  }
  return { closed: true, workspace: workspacePath, killed };
}

function requireResolvedTerminal(target: string): EmbeddedTerminalSession {
  const terminal = findEmbeddedTerminal(target);
  if (!terminal) throw new Error(`Embedded terminal target not found: ${target}`);
  return terminal;
}

function terminalGridTitle(kind: EmbeddedTerminalKind, index: number): string {
  const titles = kind === "codex"
    ? ["Codex Builder", "Codex Reviewer", "Codex Scout", "Codex Fixer"]
    : kind === "opencode"
      ? ["OpenCode Builder", "OpenCode Reviewer", "OpenCode Scout", "OpenCode Fixer"]
      : kind === "claude"
        ? ["Claude Builder", "Claude Reviewer", "Claude Scout", "Claude Fixer"]
        : [];
  return titles[index] ?? `${kind}-${index + 1}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (value == null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : undefined;
}

function booleanValue(value: unknown, defaultValue = false): boolean {
  if (value == null) return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return defaultValue;
}

function contextModeValue(value: unknown): "none" | "task" | "curated" | undefined {
  if (value == null) return undefined;
  const mode = String(value).trim().toLowerCase();
  if (mode === "none" || mode === "task" || mode === "curated") return mode;
  throw new Error(`Unsupported context_mode: ${value}`);
}

function boundedMaxChars(value: string | null): number {
  const parsed = Number(value ?? 40_000);
  if (!Number.isFinite(parsed)) return 40_000;
  return Math.max(1_000, Math.min(Math.floor(parsed), 200_000));
}

function tailText(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(-maxChars) : value;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 64_000) {
        request.destroy(new Error("Request body is too large."));
      }
    });
    request.on("error", reject);
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("Unable to allocate Electron control port.")));
        return;
      }
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startControlWatchdog(): void {
  if (watchdog) return;
  watchdog = setInterval(() => {
    void runControlWatchdog();
  }, CONTROL_WATCHDOG_INTERVAL_MS);
  watchdog.unref?.();
}

function stopControlWatchdog(): void {
  if (!watchdog) return;
  clearInterval(watchdog);
  watchdog = null;
}

async function runControlWatchdog(): Promise<void> {
  if (watchdogRestartInFlight || !state.baseUrl) return;
  const checked = await checkControlHealth();
  if (checked.running) return;
  watchdogRestartInFlight = true;
  try {
    await restartControlServer(checked.lastError ?? "watchdog health check failed");
  } finally {
    watchdogRestartInFlight = false;
  }
}

function fetchControlHealthStatus(baseUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.get(new URL("/health", baseUrl), (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.setTimeout(1_500, () => {
      request.destroy(new Error("Electron control health check timed out."));
    });
    request.on("error", reject);
  });
}

function writeControlDiscovery(): void {
  try {
    const directory = path.join(os.homedir(), ".context-workspace");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "electron-control.json"),
      JSON.stringify(
        {
          baseUrl: state.baseUrl,
          port: state.port,
          pid: process.pid,
          running: state.running,
          lastError: state.lastError,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    // Discovery is best-effort; the in-app control server remains authoritative.
  }
}
