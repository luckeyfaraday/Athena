import crypto from "node:crypto";
import fs from "node:fs";
import { broadcastHostEvent, hostStatePath, hostVersion } from "./host-runtime.js";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  attachEmbeddedTerminalControlStream,
  findEmbeddedTerminal,
  getEmbeddedTerminalBuffer,
  killEmbeddedTerminal,
  listEmbeddedAgentMessages,
  listEmbeddedTerminals,
  onEmbeddedTerminalEvent,
  renameEmbeddedTerminal,
  resizeEmbeddedTerminal,
  sendAgentMessage,
  spawnEmbeddedTerminal,
  submitEmbeddedTerminalInput,
  writeEmbeddedTerminal,
  writeEmbeddedTerminalInputRaw,
  type EmbeddedTerminalKind,
  type EmbeddedTerminalSession,
} from "./embedded-terminal.js";
import { recordControlFailure } from "./control-events.js";
import { agentCliStatus, isAgentCliKind } from "./agent-cli.js";
import {
  launchStaggerDelayMs,
  publicLaunchAdmission,
  reserveLaunchAdmission,
  settleLaunchAdmission,
} from "./launch-admission.js";
import {
  evaluateControlAccess,
  sameControlPath,
  validatedWorkspacePath,
  type ControlAccessDecision,
} from "./control-access.js";
import {
  boundedTerminalBufferMaxChars,
  formatTerminalBuffer,
} from "./terminal-buffer.js";
import { parseRawTerminalInputRequest, rawInputPreview } from "./terminal-input.js";
import { toWorkspacePath, type WorkspacePath } from "./platform.js";
import { listDirectories } from "./remote-fs.js";
import { closeHostWorkspace, openHostWorkspace, onReportedWorkspaces, reportedWorkspaces } from "./workspace-registry.js";
import type { AgentContextMode } from "./agent-context.js";
import { sessionIndexClient } from "./session-index-client.js";
import { RemoteSessionHistory, SessionHistoryError } from "./remote-session-history.js";
import { terminalChatSnapshot } from "./host-chat.js";

const remoteSessionHistory = new RemoteSessionHistory((workspace) => sessionIndexClient.listAgentSessions(workspace, false));

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
  model?: string;
  cols?: number;
  rows?: number;
  /** Authenticated, explicit opt-in to launch despite critical memory pressure. */
  memory_override?: boolean;
  memoryOverride?: boolean;
};

type WriteTerminalRequest = {
  terminal_id?: string;
  terminalId?: string;
  session_id?: string;
  sessionId?: string;
  target?: string;
  text?: string;
  input?: string;
  data?: string;
};

type SendAgentMessageRequest = {
  to?: string;
  target?: string;
  text?: string;
  input?: string;
  workspace?: string;
  project_dir?: string;
  from_terminal_id?: string;
  fromTerminalId?: string;
  thread_id?: string;
  threadId?: string;
  reply_requested?: boolean;
  replyRequested?: boolean;
  hop_count?: number;
  hopCount?: number;
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

const SUPPORTED_TERMINAL_KINDS = new Set<EmbeddedTerminalKind>(["shell", "hermes", "codex", "opencode", "claude", "athena", "grok"]);
const MAX_TERMINAL_SPAWN_COUNT = 8;
const CONTROL_WATCHDOG_INTERVAL_MS = 10_000;
const CONTROL_HEALTH_FAILURE_THRESHOLD = 3;
/**
 * The watchdog already probes /health every CONTROL_WATCHDOG_INTERVAL_MS, so a
 * renderer status poll reuses a probe at least this fresh instead of issuing
 * another loopback request.
 */
export const CONTROL_HEALTH_CACHE_MS = CONTROL_WATCHDOG_INTERVAL_MS;

// The control server can spawn processes, inject input into live PTYs, and read
// terminal buffers, so every non-/health endpoint requires a per-launch secret.
// The token is shared only via the 0600 discovery file, which is readable by the
// same OS user that already controls the desktop session. This both stops other
// processes that lack filesystem access and defeats browser CSRF / DNS-rebinding
// (a web page cannot read the token, and Host/Origin are loopback-checked too).
let controlToken: string | null = null;

let server: http.Server | null = null;
const controlSockets = new Set<net.Socket>();
let watchdog: NodeJS.Timeout | null = null;
let watchdogRestartInFlight = false;
let healthFailureCount = 0;
let lastHealthCheckAt = 0;
let healthCheckInFlight: Promise<ControlState> | null = null;
/** Serialized discovery content last written, excluding the timestamp. */
let lastDiscoveryContent: string | null = null;
let lastDiscoveryMtimeMs: number | null = null;
let state: ControlState = {
  baseUrl: null,
  port: null,
  running: false,
  lastError: null,
};

export type { ControlState };

/**
 * One way into the control API. The local listener authorizes with the
 * per-launch token; the remote (Tailscale) listener in remote-control.ts brings
 * its own authorizer and source tag and shares every route below.
 */
export type ControlListener = {
  source: "local" | "remote";
  authorize: (request: IncomingMessage) => ControlAccessDecision | Promise<ControlAccessDecision>;
  onError?: (error: unknown) => void;
};

const localListener: ControlListener = {
  source: "local",
  authorize: (request) => evaluateControlAccess(
    {
      host: headerValue(request.headers.host),
      origin: headerValue(request.headers.origin),
      authorization: headerValue(request.headers.authorization),
      token: headerValue(request.headers["x-athena-control-token"]),
    },
    controlToken,
  ),
  onError: (error) => {
    state = { ...state, lastError: String(error) };
    writeControlDiscovery();
  },
};

export function createControlRequestListener(listener: ControlListener): http.RequestListener {
  return (request, response) => {
    void handleRequest(request, response, listener);
  };
}

export function getControlState(): ControlState {
  return { ...state };
}

/**
 * Probe the control server's /health endpoint. `maxAgeMs` lets pollers reuse a
 * probe that completed recently (e.g. by the watchdog); concurrent callers
 * share one in-flight probe.
 */
export function checkControlHealth(options: { maxAgeMs?: number } = {}): Promise<ControlState> {
  if (!state.baseUrl || !state.running) return Promise.resolve(getControlState());
  const maxAgeMs = options.maxAgeMs ?? 0;
  if (maxAgeMs > 0 && lastHealthCheckAt > 0 && Date.now() - lastHealthCheckAt < maxAgeMs) {
    return Promise.resolve(getControlState());
  }
  healthCheckInFlight ??= probeControlHealth(state.baseUrl).finally(() => {
    healthCheckInFlight = null;
  });
  return healthCheckInFlight;
}

async function probeControlHealth(baseUrl: string): Promise<ControlState> {
  try {
    const statusCode = await fetchControlHealthStatus(baseUrl);
    // A restart while the probe was in flight makes this result stale.
    if (state.baseUrl !== baseUrl) return getControlState();
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
    if (state.baseUrl !== baseUrl) return getControlState();
    healthFailureCount += 1;
    state = {
      ...state,
      running: healthFailureCount < CONTROL_HEALTH_FAILURE_THRESHOLD,
      lastError: `Electron control server is unavailable at ${baseUrl} (${healthFailureCount}/${CONTROL_HEALTH_FAILURE_THRESHOLD}): ${String(error)}`,
    };
  }
  lastHealthCheckAt = Date.now();
  writeControlDiscovery();
  return getControlState();
}

export async function startControlServer(): Promise<ControlState> {
  if (server && state.baseUrl && state.running) {
    startControlWatchdog();
    return { ...state };
  }

  const port = await findFreePort();
  controlToken = crypto.randomBytes(32).toString("hex");
  const nextServer = http.createServer(createControlRequestListener(localListener));
  nextServer.on("connection", (socket) => {
    controlSockets.add(socket);
    socket.once("close", () => controlSockets.delete(socket));
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
  lastHealthCheckAt = 0;
  writeControlDiscovery();
  startControlWatchdog();
  return { ...state };
}

export async function restartControlServer(reason = "manual restart"): Promise<ControlState> {
  stopControlWatchdog();
  const serverToStop = server;
  server = null;
  if (serverToStop) {
    await closeControlServer(serverToStop);
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

export async function stopControlServer(): Promise<boolean> {
  stopControlWatchdog();
  const serverToStop = server;
  server = null;
  if (!serverToStop) {
    state = { ...state, running: false };
    writeControlDiscovery();
    return true;
  }
  const closed = await closeControlServer(serverToStop);
  state = { ...state, running: false };
  writeControlDiscovery();
  return closed;
}

function closeControlServer(serverToStop: http.Server, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(closed);
    };
    serverToStop.close((error) => finish(!error));
    // SSE and keep-alive connections otherwise keep `close()` pending forever.
    serverToStop.closeIdleConnections?.();
    serverToStop.closeAllConnections?.();
    for (const socket of controlSockets) socket.destroy();
    timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, listener: ControlListener): Promise<void> {
  const controlSource = listener.source === "remote" ? "remote-control" : "electron-control";
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { status: "ok", service: "electron-control" });
      return;
    }
    const access = await listener.authorize(request);
    if (!access.ok) {
      sendJson(response, access.status, { error: access.reason });
      return;
    }
    if (request.method === "GET" && url.pathname === "/machine") {
      // Lets a remote Athena label this machine and check it can drive it.
      sendJson(response, 200, { ...machineInfo(), via: listener.source });
      return;
    }
    if (request.method === "GET" && url.pathname === "/events") {
      streamControlEvents(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/workspaces") {
      sendJson(response, 200, reportedWorkspaces());
      return;
    }
    if (request.method === "GET" && url.pathname === "/fs/dirs") {
      // Folder names only, for a remote Athena's "open folder" picker.
      sendJson(response, 200, await listDirectories(url.searchParams.get("path") ?? undefined, {
        includeHidden: booleanValue(url.searchParams.get("hidden")),
      }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/terminals") {
      sendJson(response, 200, { terminals: listEmbeddedTerminals() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/agent-sessions") {
      const workspace = validatedWorkspacePath(url.searchParams.get("workspace"));
      const key = process.platform === "win32" ? workspace.toLowerCase() : workspace;
      try {
        sendJson(response, 200, await remoteSessionHistory.list(key, url.searchParams.get("cursor")));
      } catch (error) {
        if (!(error instanceof SessionHistoryError)) throw error;
        sendJson(response, error.status, { error: error.message });
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/agent-messages") {
      sendJson(response, 200, {
        messages: listEmbeddedAgentMessages(url.searchParams.get("workspace") ?? url.searchParams.get("project_dir"), Number(url.searchParams.get("limit") ?? 100)),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/agent-messages/send") {
      const payload = parseSendAgentMessageRequest(await readJsonBody(request));
      const result = await sendAgentMessage(payload);
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/terminals/") && url.pathname.endsWith("/chat")) {
      const target = decodeURIComponent(url.pathname.slice("/terminals/".length, -"/chat".length));
      const terminal = requireResolvedTerminal(target);
      try { sendJson(response, 200, await terminalChatSnapshot(terminal)); }
      catch (error) { sendJson(response, 503, { error: String(error) }); }
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/terminals/") && url.pathname.endsWith("/buffer")) {
      const target = decodeURIComponent(url.pathname.slice("/terminals/".length, -"/buffer".length));
      const terminal = requireResolvedTerminal(target);
      const maxChars = boundedTerminalBufferMaxChars(url.searchParams.get("max_chars"));
      const buffer = formatTerminalBuffer(getEmbeddedTerminalBuffer(terminal.id), maxChars);
      sendJson(response, 200, {
        terminal,
        ...buffer,
      });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/terminals/") && url.pathname.endsWith("/stream")) {
      const target = decodeURIComponent(url.pathname.slice("/terminals/".length, -"/stream".length));
      const terminal = requireResolvedTerminal(target);
      const maxChars = boundedTerminalBufferMaxChars(url.searchParams.get("max_chars"));
      streamEmbeddedTerminal(request, response, terminal.id, maxChars, url.searchParams.get("format") === "json" ? "json" : "base64");
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
    if (request.method === "POST" && url.pathname === "/terminals/input") {
      const payload = parseRawTerminalInputRequest(await readJsonBody(request));
      const preview = rawInputPreview(payload.data);
      const session = await writeEmbeddedTerminalInputRaw(payload.target, payload.data).catch((error) => {
        recordControlFailure({
          kind: "input.failed",
          detail: String(error),
          preview,
        });
        throw error;
      });
      sendJson(response, 200, { written: true, terminal: session });
      return;
    }
    if (request.method === "POST" && url.pathname === "/terminals/keys") {
      // Interactive keystrokes from a remote pane: the same path as typing into
      // a local pane, without the per-write control-event record /terminals/input keeps.
      const payload = parseRawTerminalInputRequest(await readJsonBody(request));
      const terminal = requireResolvedTerminal(payload.target);
      sendJson(response, 200, { written: true, terminal: await writeEmbeddedTerminal(terminal.id, payload.data) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/terminals/resize") {
      const payload = parseResizeTerminalRequest(await readJsonBody(request));
      const terminal = requireResolvedTerminal(payload.target);
      sendJson(response, 200, { resized: true, terminal: await resizeEmbeddedTerminal(terminal.id, payload.cols, payload.rows) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/terminals/rename") {
      const payload = parseRenameTerminalRequest(await readJsonBody(request));
      const terminal = requireResolvedTerminal(payload.target);
      sendJson(response, 200, { renamed: true, terminal: renameEmbeddedTerminal(terminal.id, payload.title) });
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
      // An agent that is not installed would open a pane that only prints an error. Callers of this API have no
      // install dialog, so tell them what to install instead.
      if (isAgentCliKind(payload.kind)) {
        const cli = await agentCliStatus(payload.kind);
        if (!cli.installed) {
          recordControlFailure({ kind: "spawn.failed", detail: `${cli.label} is not installed`, preview: payload.task });
          sendJson(response, 409, {
            error: "agent_not_installed",
            agent: payload.kind,
            message: `${cli.label} (${cli.executable}) is not installed or not on PATH.`,
            install_command: cli.installCommand,
            docs: cli.docsUrl,
          });
          return;
        }
      }
      const admission = reserveLaunchAdmission({
        source: "control",
        kind: payload.kind,
        count: payload.count,
        // Reaching this route already requires the per-launch control token, so
        // this flag is both explicit and authorized by the existing auth layer.
        overrideCritical: payload.memoryOverride,
      });
      if (!admission.granted) {
        recordControlFailure({
          kind: "spawn.failed",
          detail: admission.message,
          preview: payload.task,
        });
        sendJson(response, 429, {
          error: admission.message,
          admission: publicLaunchAdmission(admission),
          retryable: true,
          override: "Resubmit the authenticated request with memory_override: true to launch anyway.",
        });
        return;
      }
      const sessions: EmbeddedTerminalSession[] = [];
      let failedSession: EmbeddedTerminalSession | null = null;
      try {
        if (payload.openWorkspace) {
          payload.workspace = openWorkspaceInRenderer(payload.workspace, payload.selectWorkspace).nativePath;
        }
        for (let index = 0; index < payload.count; index += 1) {
          const staggerMs = launchStaggerDelayMs(payload.kind, index);
          if (staggerMs > 0) await delay(staggerMs);
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
            model: payload.model,
            controlSource,
          }).catch((error) => {
            recordControlFailure({
              kind: "spawn.failed",
              detail: String(error),
              preview: payload.task,
            });
            throw error;
          });
          if (session.status !== "running") {
            failedSession = session;
            recordControlFailure({
              kind: "spawn.failed",
              detail: session.error ?? `Failed to launch ${session.title}.`,
              preview: payload.task,
            });
            break;
          }
          sessions.push(session);
        }
      } finally {
        // Drop failed/unstarted capacity immediately. Successful capacity stays
        // leased briefly because agent/MCP descendants allocate after node-pty's
        // spawn promise resolves and are not yet visible in /proc at this point.
        settleLaunchAdmission(admission, sessions.length);
      }
      if (failedSession) {
        sendJson(response, 500, {
          error: failedSession.error ?? `Failed to launch ${failedSession.title}.`,
          failed: failedSession,
          sessions,
          admission: publicLaunchAdmission(admission),
        });
        return;
      }
      sendJson(response, 200, { sessions, admission: publicLaunchAdmission(admission) });
      return;
    }
    sendJson(response, 404, { error: `Unknown control endpoint: ${request.method} ${url.pathname}` });
  } catch (error) {
    listener.onError?.(error);
    sendJson(response, 400, { error: String(error) });
  }
}

function targetFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") throw new Error("Request body must be an object.");
  const request = body as WriteTerminalRequest;
  return stringValue(request.target)
    ?? stringValue(request.terminal_id)
    ?? stringValue(request.terminalId)
    ?? stringValue(request.session_id)
    ?? stringValue(request.sessionId);
}

function parseWriteTerminalRequest(body: unknown): { target: string; text: string } {
  const target = targetFromBody(body);
  if (!target) throw new Error("terminal_id, session_id, or target is required.");
  const request = body as WriteTerminalRequest;
  const text = stringValue(request.text) ?? stringValue(request.input);
  if (!text) throw new Error("text is required.");
  return { target, text };
}

function parseSendAgentMessageRequest(body: unknown): Parameters<typeof sendAgentMessage>[0] {
  if (!body || typeof body !== "object") throw new Error("Request body must be an object.");
  const request = body as SendAgentMessageRequest;
  const to = stringValue(request.to) ?? stringValue(request.target);
  if (!to) throw new Error("to or target is required.");
  const text = stringValue(request.text) ?? stringValue(request.input);
  if (!text) throw new Error("text is required.");
  return {
    to,
    text,
    workspace: stringValue(request.workspace) ?? stringValue(request.project_dir),
    fromTerminalId: stringValue(request.from_terminal_id) ?? stringValue(request.fromTerminalId),
    threadId: stringValue(request.thread_id) ?? stringValue(request.threadId),
    replyRequested: booleanValue(request.reply_requested ?? request.replyRequested),
    hopCount: numberValue(request.hop_count ?? request.hopCount),
    source: "electron-control",
  };
}

const MAX_TERMINAL_COLS = 1_000;
const MAX_TERMINAL_ROWS = 500;
const MAX_TERMINAL_TITLE_LENGTH = 200;

function parseResizeTerminalRequest(body: unknown): { target: string; cols: number; rows: number } {
  const target = targetFromBody(body);
  if (!target) throw new Error("terminal_id, session_id, or target is required.");
  const request = body as { cols?: unknown; rows?: unknown };
  const cols = numberValue(request.cols);
  const rows = numberValue(request.rows);
  if (cols === undefined || rows === undefined || cols < 1 || rows < 1) throw new Error("cols and rows must be positive numbers.");
  return { target, cols: Math.min(cols, MAX_TERMINAL_COLS), rows: Math.min(rows, MAX_TERMINAL_ROWS) };
}

function parseRenameTerminalRequest(body: unknown): { target: string; title: string } {
  const target = targetFromBody(body);
  if (!target) throw new Error("terminal_id, session_id, or target is required.");
  const title = stringValue((body as { title?: unknown }).title);
  if (!title) throw new Error("title is required.");
  if (title.length > MAX_TERMINAL_TITLE_LENGTH) throw new Error(`title must be at most ${MAX_TERMINAL_TITLE_LENGTH} characters.`);
  return { target, title };
}

function parseKillTerminalRequest(body: unknown): { target: string } {
  const target = targetFromBody(body);
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
  contextMode?: AgentContextMode;
  contextText?: string;
  model?: string;
  cols?: number;
  rows?: number;
  memoryOverride: boolean;
} {
  if (!body || typeof body !== "object") throw new Error("Request body must be an object.");
  const request = body as SpawnTerminalRequest;
  const workspace = String(request.project_dir ?? request.workspace ?? "").trim();
  if (!workspace) throw new Error("project_dir is required.");
  const kind = embeddedTerminalKindValue(request.kind ?? "shell");
  const rawCount = Number(request.count ?? 1);
  const count = Math.max(1, Math.min(Number.isFinite(rawCount) ? Math.floor(rawCount) : 1, MAX_TERMINAL_SPAWN_COUNT));
  return {
    workspace,
    openWorkspace: booleanValue(request.open_workspace ?? request.openWorkspace),
    selectWorkspace: booleanValue(request.select_workspace ?? request.selectWorkspace ?? request.open_workspace ?? request.openWorkspace, true),
    kind,
    count,
    title: stringValue(request.title),
    task: stringValue(request.task),
    resumeSessionId: stringValue(request.resume_session_id),
    sessionLabel: stringValue(request.session_label),
    contextMode: contextModeValue(request.context_mode),
    contextText: stringValue(request.context_text) ?? stringValue(request.context),
    model: modelValue(request.model),
    cols: numberValue(request.cols),
    rows: numberValue(request.rows),
    memoryOverride: booleanValue(request.memory_override ?? request.memoryOverride),
  };
}

// Model is forwarded verbatim as a CLI flag argument (quoted downstream in
// terminal-launch). Reject whitespace/control characters so a malformed request
// fails fast rather than launching an agent with a broken flag.
function modelValue(value: unknown): string | undefined {
  const model = stringValue(value);
  if (model === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f]/.test(model)) {
    throw new Error("model must be a single token without whitespace or control characters.");
  }
  return model;
}

function embeddedTerminalKindValue(value: unknown): EmbeddedTerminalKind {
  const normalized = String(value).trim().toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-");
  const aliases: Record<string, EmbeddedTerminalKind> = {
    shell: "shell",
    hermes: "hermes",
    codex: "codex",
    opencode: "opencode",
    "open-code": "opencode",
    claude: "claude",
    "claude-code": "claude",
    athena: "athena",
    "athena-code": "athena",
    athenacode: "athena",
    grok: "grok",
    "grok-build": "grok",
    grokbuild: "grok",
  };
  const kind = aliases[normalized];
  if (!kind || !SUPPORTED_TERMINAL_KINDS.has(kind)) {
    throw new Error(`Unsupported terminal kind: ${value}`);
  }
  return kind;
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

function openWorkspaceInRenderer(workspace: string, select: boolean): WorkspacePath {
  const workspacePath = toWorkspacePath(workspace);
  openHostWorkspace(workspacePath.nativePath, select);
  broadcastHostEvent("workspace:open", { workspace: workspacePath, select });
  return workspacePath;
}

async function closeWorkspaceInRenderer(workspace: string): Promise<{ closed: true; workspace: WorkspacePath; killed: EmbeddedTerminalSession[] }> {
  const workspacePath = toWorkspacePath(workspace);
  const killed = await Promise.all(listEmbeddedTerminals()
    .filter((terminal) => sameControlPath(terminal.workspace, workspacePath.nativePath))
    .map((terminal) => killEmbeddedTerminal(terminal.id)));
  closeHostWorkspace(workspacePath.nativePath);
  broadcastHostEvent("workspace:close", { workspace: workspacePath });
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
        : kind === "athena"
          ? ["Athena Builder", "Athena Reviewer", "Athena Scout", "Athena Fixer"]
          : kind === "grok"
            ? ["Grok Builder", "Grok Reviewer", "Grok Scout", "Grok Fixer"]
            : [];
  return titles[index] ?? `${kind}-${index + 1}`;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
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

// Unknown or retired modes (such as the removed "immersive" recall bundles)
// are ignored, so the launch falls back to the default task/none resolution.
function contextModeValue(value: unknown): AgentContextMode | undefined {
  if (value == null) return undefined;
  const mode = String(value).trim().toLowerCase();
  if (mode === "none" || mode === "task" || mode === "curated") return mode;
  return undefined;
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

const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
const SSE_MAX_BACKLOG_BYTES = 1_000_000;

/**
 * Stream a terminal's sequenced output as Server-Sent Events. Atomic attach
 * pauses a distinct hub consumer while its `snapshot` is queued, so output
 * produced in that window is retained and follows at the next sequence. A slow
 * consumer that exceeds its bounded hub queue receives another self-declaring
 * `snapshot` reset instead of a silent gap. SSE ids carry epoch:sequence while
 * payloads stay base64-compatible with existing clients. Keystrokes continue
 * to flow back over POST /terminals/write; this channel is output-only.
 */
function streamEmbeddedTerminal(
  request: IncomingMessage,
  response: ServerResponse,
  terminalId: string,
  maxChars: number,
  format: "base64" | "json",
): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    // Disable proxy buffering so chunks are delivered immediately.
    "X-Accel-Buffering": "no",
  });
  // An initial comment flushes headers so EventSource fires `open` right away.
  response.write(": athena-control stream\n\n");

  const send = (event: string, payload: string, eventId?: string): boolean => {
    if (closed) return false;
    if (response.writableLength > SSE_MAX_BACKLOG_BYTES) {
      cleanup();
      response.destroy(new Error("Terminal stream backpressure exceeded."));
      return false;
    }
    try {
      response.write(`${eventId ? `id: ${eventId}\n` : ""}event: ${event}\ndata: ${payload}\n\n`);
      return true;
    } catch {
      cleanup();
      return false;
    }
  };

  let closed = false;
  let stream: ReturnType<typeof attachEmbeddedTerminalControlStream> | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    stream?.close();
  };

  const consumerId = `control-sse:${crypto.randomUUID()}`;
  stream = attachEmbeddedTerminalControlStream(
    terminalId,
    consumerId,
    maxChars,
    (delivery) => {
      if (!delivery.data && !delivery.reset) return true;
      if (format === "json") {
        return send(
          delivery.reset ? "snapshot" : "data",
          JSON.stringify(delivery.reset
            ? { epoch: delivery.epoch, throughSequence: delivery.sequence, data: delivery.data }
            : { epoch: delivery.epoch, fromSequence: delivery.fromSequence, sequence: delivery.sequence, data: delivery.data }),
          `${delivery.epoch}:${delivery.sequence}`,
        );
      }
      return send(
        delivery.reset ? "snapshot" : "data",
        Buffer.from(delivery.data, "utf8").toString("base64"),
        `${delivery.epoch}:${delivery.sequence}`,
      );
    },
    ({ exitCode, epoch, throughSequence }) => {
      send(
        "exit",
        format === "json"
          ? JSON.stringify({ exitCode, epoch, throughSequence })
          : Buffer.from(JSON.stringify({ exitCode }), "utf8").toString("base64"),
        `${epoch}:${throughSequence}`,
      );
      cleanup();
      response.end();
    },
  );
  const { snapshot } = stream;
  if (!send(
    "snapshot",
    format === "json"
      ? JSON.stringify({ epoch: snapshot.epoch, throughSequence: snapshot.throughSequence, data: snapshot.buffer })
      : Buffer.from(snapshot.buffer, "utf8").toString("base64"),
    `${snapshot.epoch}:${snapshot.throughSequence}`,
  )) return;
  stream.start();

  heartbeat = setInterval(() => response.write(": keep-alive\n\n"), SSE_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  request.on("close", cleanup);
  response.on("close", cleanup);
  response.on("error", cleanup);
}

function machineInfo(): { hostname: string; platform: NodeJS.Platform; arch: string; version: string; homedir: string } {
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    version: hostVersion(),
    homedir: os.homedir(),
  };
}

const EVENT_CHANNELS: Record<string, string> = {
  "embedded-terminal:session": "session",
  "embedded-terminal:attention": "attention",
  "embedded-terminal:exit": "exit",
};

/**
 * Server-Sent Events for a remote Athena watching this machine: a `hello`
 * with every terminal and the open workspace tabs, then `session`, `attention`,
 * `exit`, and `workspaces` as they happen. Payloads are JSON.
 */
function streamControlEvents(request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let closed = false;
  const send = (event: string, payload: unknown): void => {
    if (closed) return;
    if (response.writableLength > SSE_MAX_BACKLOG_BYTES) {
      cleanup();
      response.destroy(new Error("Event stream backpressure exceeded."));
      return;
    }
    try {
      response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      cleanup();
    }
  };
  const removeTerminalEvents = onEmbeddedTerminalEvent((channel, payload) => {
    const event = EVENT_CHANNELS[channel];
    if (event) send(event, payload);
  });
  const removeWorkspaceEvents = onReportedWorkspaces((workspaces) => send("workspaces", workspaces));
  const heartbeat = setInterval(() => {
    if (!closed) response.write(": keep-alive\n\n");
  }, SSE_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  function cleanup(): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    removeTerminalEvents();
    removeWorkspaceEvents();
  }
  send("hello", { machine: machineInfo(), terminals: listEmbeddedTerminals(), ...reportedWorkspaces() });
  request.on("close", cleanup);
  response.on("close", cleanup);
  response.on("error", cleanup);
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

// Health checks run every few seconds; rewrite electron-control.json only when
// its content (ignoring the timestamp) changes, or when another writer replaced
// or removed it -- detected with a cheap stat.
function writeControlDiscovery(): void {
  const discovery = {
    baseUrl: state.baseUrl,
    port: state.port,
    pid: process.pid,
    running: state.running,
    lastError: state.lastError,
    token: controlToken,
  };
  const content = JSON.stringify(discovery);
  const filePath = hostStatePath("electron-control.json");
  if (content === lastDiscoveryContent && fileMtimeMs(filePath) === lastDiscoveryMtimeMs) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({ ...discovery, updatedAt: new Date().toISOString() }, null, 2),
      // 0600: the token authorizes process spawning, so keep it readable only
      // by the owning user even on shared machines.
      { encoding: "utf8", mode: 0o600 },
    );
    // `mode` only applies when writeFileSync creates the file, so also tighten
    // a file an older build left with looser permissions.
    fs.chmodSync(filePath, 0o600);
    lastDiscoveryContent = content;
    lastDiscoveryMtimeMs = fileMtimeMs(filePath);
  } catch {
    // Discovery is best-effort; the in-app control server remains authoritative.
  }
}

function fileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}
