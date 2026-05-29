import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BrowserWindow } from "electron";
import { buildAgentContextPrompt, resolveAgentContextMode, type AgentContextMode } from "./agent-context.js";
import {
  recentControlEvents,
  recordInputFailed,
  recordInputRequested,
  recordInputWritten,
  recordSpawnFailed,
  recordSpawnRequested,
  recordSpawnSucceeded,
  recordTerminalExited,
  recordTerminalOutput,
  terminalControlStates,
  type ControlEvent,
  type TerminalControlState,
} from "./control-events.js";
import { getBackendState } from "./backend.js";
import { getControlState } from "./control-server.js";
import { terminalInputWritesForKind } from "./input-sequencing.js";
import { isTerminalRestorePaused, readAthenaLaunchState } from "./launch-state.js";
import { ptyHost } from "./pty-host-client.js";
import { claudeProjectPathCandidates, selectEmbeddedTerminalRestoreEntries, type RestorableTerminal } from "./terminal-restore-policy.js";
import { sanitizedTerminalEnv } from "./terminal-env.js";
import { agentConfig, terminalLaunch } from "./terminal-launch.js";
import {
  resolveOpenCodeBaselineBinary,
  tempWorkspaceDirectory,
} from "./platform.js";

const execFileAsync = promisify(execFile);

export type EmbeddedTerminalKind = "shell" | "hermes" | "codex" | "opencode" | "claude";

export type EmbeddedTerminalSession = {
  id: string;
  title: string;
  kind: EmbeddedTerminalKind;
  workspace: string;
  pid: number | null;
  promptPath: string | null;
  initialTask: string | null;
  sessionLabel: string | null;
  providerSessionId: string | null;
  createdAt: string;
  status: "running" | "exited" | "failed";
  exitCode: number | null;
  error: string | null;
};

export type EmbeddedTerminalSpawnOptions = {
  kind?: EmbeddedTerminalKind;
  title?: string;
  task?: string;
  cols?: number;
  rows?: number;
  resumeSessionId?: string;
  sessionLabel?: string;
  providerSessionId?: string;
  contextMode?: AgentContextMode;
  contextText?: string;
  controlSource?: string;
};

type ManagedTerminal = {
  session: EmbeddedTerminalSession;
  restore: RestorableTerminal;
};

type RestoreAttemptState = {
  startedAt: string;
  entries: RestorableTerminal[];
};

let _appRoot: string | null = null;
let appQuitting = false;
let restoreInFlight = false;
let ptyHostListenersInstalled = false;

export function initEmbeddedTerminals(appRoot: string): void {
  _appRoot = appRoot;
  installPtyHostListeners();
  quarantinePendingRestoreAttemptsAfterCrash();
  startEventLoopMonitor();
}

export function prepareEmbeddedTerminalRestoreForQuit(): void {
  appQuitting = true;
  clearRestoreAttempts();
  ptyHost.shutdown();
}

const terminals = new Map<string, ManagedTerminal>();
const outputBuffers = new Map<string, string>();
const MAX_BUFFER_CHARS = 200_000;
const PTY_FLUSH_INTERVAL_MS = 16;
const EVENT_LOOP_SAMPLE_INTERVAL_MS = 1000;
const CLAUDE_SESSION_DISCOVERY_ATTEMPTS = 20;
const CLAUDE_SESSION_DISCOVERY_INTERVAL_MS = 750;
const pendingOutput = new Map<string, string>();
let outputFlushTimer: NodeJS.Timeout | null = null;
let eventLoopMonitorTimer: NodeJS.Timeout | null = null;
let eventLoopLagMs = 0;
let maxEventLoopLagMs = 0;
const perfCounters = {
  ptyChunks: 0,
  ptyBytes: 0,
  ipcBatches: 0,
  ipcBytes: 0,
  lastBatchAt: null as string | null,
  sampleStartedAt: Date.now(),
  rates: {
    ptyChunksPerSecond: 0,
    ptyBytesPerSecond: 0,
    ipcBatchesPerSecond: 0,
    ipcBytesPerSecond: 0,
  },
};

export type PerformanceDiagnostics = {
  activeTerminals: number;
  bufferedTerminalChars: number;
  pendingOutputBytes: number;
  maxBufferChars: number;
  ptyChunksPerSecond: number;
  ptyBytesPerSecond: number;
  ipcBatchesPerSecond: number;
  ipcBytesPerSecond: number;
  eventLoopLagMs: number;
  maxEventLoopLagMs: number;
  lastOutputBatchAt: string | null;
  controlEvents: ControlEvent[];
  terminalControl: TerminalControlState[];
  agentProcesses: AgentProcessDiagnostic[];
};

export type AgentProcessDiagnostic = {
  pid: number;
  ppid: number | null;
  agent: EmbeddedTerminalKind;
  command: string;
  managedTerminalId: string | null;
  managedTerminalTitle: string | null;
  workspace: string | null;
};

export function listEmbeddedTerminals(): EmbeddedTerminalSession[] {
  return Array.from(terminals.values())
    .filter((entry) => entry.session.status === "running")
    .map((entry) => ({ ...entry.session }));
}

export function getEmbeddedTerminalBuffer(id: string): string {
  return outputBuffers.get(id) ?? "";
}

type TerminalDataListener = (chunk: string) => void;
type TerminalExitListener = (exitCode: number | null) => void;

const dataListeners = new Map<string, Set<TerminalDataListener>>();
const exitListeners = new Map<string, Set<TerminalExitListener>>();

/**
 * Subscribe to live PTY output for a terminal from inside the main process. This
 * powers the control server's SSE stream endpoint (remote viewers such as the
 * mobile app) alongside the existing renderer IPC fan-out. The listener receives
 * raw terminal chunks exactly as they are appended to the rolling buffer.
 * Returns an unsubscribe function; `onExit` (if provided) fires once when the
 * terminal exits or crashes.
 */
export function subscribeEmbeddedTerminalData(
  id: string,
  onData: TerminalDataListener,
  onExit?: TerminalExitListener,
): () => void {
  let dataSet = dataListeners.get(id);
  if (!dataSet) {
    dataSet = new Set();
    dataListeners.set(id, dataSet);
  }
  dataSet.add(onData);

  if (onExit) {
    let exitSet = exitListeners.get(id);
    if (!exitSet) {
      exitSet = new Set();
      exitListeners.set(id, exitSet);
    }
    exitSet.add(onExit);
  }

  return () => {
    const currentData = dataListeners.get(id);
    if (currentData) {
      currentData.delete(onData);
      if (currentData.size === 0) dataListeners.delete(id);
    }
    if (onExit) {
      const currentExit = exitListeners.get(id);
      if (currentExit) {
        currentExit.delete(onExit);
        if (currentExit.size === 0) exitListeners.delete(id);
      }
    }
  };
}

function notifyTerminalData(id: string, chunk: string): void {
  const listeners = dataListeners.get(id);
  if (!listeners) return;
  for (const listener of listeners) {
    try {
      listener(chunk);
    } catch {
      // A failing stream subscriber must not break PTY fan-out to other clients.
    }
  }
}

function notifyTerminalExit(id: string, exitCode: number | null): void {
  const listeners = exitListeners.get(id);
  if (!listeners) return;
  for (const listener of Array.from(listeners)) {
    try {
      listener(exitCode);
    } catch {
      // Ignore subscriber errors raised during stream teardown.
    }
  }
  exitListeners.delete(id);
}

export function findEmbeddedTerminal(target: string): EmbeddedTerminalSession | null {
  const normalized = target.trim();
  if (!normalized) return null;
  const direct = terminals.get(normalized)?.session;
  if (direct) return { ...direct };
  for (const entry of terminals.values()) {
    if (entry.session.providerSessionId === normalized) return { ...entry.session };
  }
  return null;
}

export async function restoreEmbeddedTerminals(allowedWorkspaces?: string[]): Promise<EmbeddedTerminalSession[]> {
  if (isTerminalRestorePaused()) {
    console.warn("[Athena] Terminal restore is paused because the previous launch did not exit cleanly.");
    return listEmbeddedTerminals();
  }
  if (restoreInFlight) return listEmbeddedTerminals();
  restoreInFlight = true;
  try {
    const restored: EmbeddedTerminalSession[] = [];
    const entries = readRestoreEntries();
    const plan = selectEmbeddedTerminalRestoreEntries(entries, allowedWorkspaces, terminals.keys());
    writeRestoreEntries([...plan.retained, ...plan.live]);
    recordRestoreAttempts(plan.restore);
    for (const entry of plan.live) {
      const liveSession = terminals.get(entry.id)?.session;
      if (liveSession) restored.push({ ...liveSession });
    }
    for (const entry of plan.restore) {
      if (!fs.existsSync(entry.workspace)) continue;
      const session = await spawnEmbeddedTerminal(entry.workspace, {
        kind: entry.kind,
        title: entry.title,
        cols: 96,
        rows: 28,
        resumeSessionId: entry.resumeSessionId ?? undefined,
        sessionLabel: entry.sessionLabel ?? undefined,
        providerSessionId: entry.providerSessionId ?? undefined,
        contextMode: "none",
        controlSource: "restore",
      });
      if (session.status === "running") restored.push(session);
    }
    return restored;
  } finally {
    restoreInFlight = false;
  }
}

export function clearSavedEmbeddedTerminalRestores(): number {
  const entries = readRestoreEntries();
  if (entries.length === 0) return 0;
  archiveRestoreEntries(entries);
  writeRestoreEntries([]);
  return entries.length;
}

export async function getPerformanceDiagnostics(): Promise<PerformanceDiagnostics> {
  updatePerformanceRates();
  const pendingOutputBytes = Array.from(pendingOutput.values()).reduce((total, value) => total + Buffer.byteLength(value), 0);
  const bufferedTerminalChars = Array.from(outputBuffers.values()).reduce((total, value) => total + value.length, 0);
  const agentProcesses = await detectAgentProcesses();
  return {
    activeTerminals: terminals.size,
    bufferedTerminalChars,
    pendingOutputBytes,
    maxBufferChars: MAX_BUFFER_CHARS,
    ptyChunksPerSecond: perfCounters.rates.ptyChunksPerSecond,
    ptyBytesPerSecond: perfCounters.rates.ptyBytesPerSecond,
    ipcBatchesPerSecond: perfCounters.rates.ipcBatchesPerSecond,
    ipcBytesPerSecond: perfCounters.rates.ipcBytesPerSecond,
    eventLoopLagMs,
    maxEventLoopLagMs,
    lastOutputBatchAt: perfCounters.lastBatchAt,
    controlEvents: recentControlEvents(),
    terminalControl: terminalControlStates(),
    agentProcesses,
  };
}

async function detectAgentProcesses(): Promise<AgentProcessDiagnostic[]> {
  const managed = Array.from(terminals.values()).map((entry) => ({
    pid: entry.session.pid,
    id: entry.session.id,
    title: entry.session.title,
    workspace: entry.session.workspace,
  })).filter((entry): entry is { pid: number; id: string; title: string; workspace: string } => entry.pid != null);
  const processList = await listSystemProcesses();
  const managedByPid = new Map(managed.map((entry) => [entry.pid, entry]));

  return processList
    .map((processInfo) => {
      const agent = classifyAgentProcess(processInfo.command);
      if (!agent) return null;
      const owner = findManagedOwner(processInfo.pid, processList, managedByPid);
      return {
        pid: processInfo.pid,
        ppid: processInfo.ppid,
        agent,
        command: processInfo.command,
        managedTerminalId: owner?.id ?? null,
        managedTerminalTitle: owner?.title ?? null,
        workspace: owner?.workspace ?? extractWorkspaceFromCommand(processInfo.command),
      };
    })
    .filter((item): item is AgentProcessDiagnostic => Boolean(item))
    .sort((left, right) => Number(Boolean(left.managedTerminalId)) - Number(Boolean(right.managedTerminalId)) || left.pid - right.pid)
    .slice(0, 80);
}

type ProcessInfo = {
  pid: number;
  ppid: number | null;
  command: string;
};

async function listSystemProcesses(): Promise<ProcessInfo[]> {
  if (process.platform === "linux") return listLinuxProcesses();
  return listPsProcesses();
}

async function listLinuxProcesses(): Promise<ProcessInfo[]> {
  try {
    const entries = await fs.promises.readdir("/proc", { withFileTypes: true });
    const pids = entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name));
    const results = await Promise.all(pids.map((pid) => readLinuxProcess(pid)));
    return results.filter((entry): entry is ProcessInfo => Boolean(entry));
  } catch {
    return listPsProcesses();
  }
}

async function readLinuxProcess(pid: number): Promise<ProcessInfo | null> {
  try {
    const [status, cmdline] = await Promise.all([
      fs.promises.readFile(`/proc/${pid}/status`, "utf8"),
      fs.promises.readFile(`/proc/${pid}/cmdline`, "utf8"),
    ]);
    const ppidMatch = status.match(/^PPid:\s+(\d+)/m);
    const command = cmdline.replace(/\0/g, " ").trim();
    if (!command) return null;
    return {
      pid,
      ppid: ppidMatch ? Number(ppidMatch[1]) : null,
      command,
    };
  } catch {
    return null;
  }
}

async function listPsProcesses(): Promise<ProcessInfo[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8", maxBuffer: 2_000_000 });
    return stdout.split("\n").map((line): ProcessInfo | null => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3],
      };
    }).filter((entry): entry is ProcessInfo => Boolean(entry));
  } catch {
    return [];
  }
}

function classifyAgentProcess(command: string): EmbeddedTerminalKind | null {
  const lower = command.toLowerCase();
  if (/\bclaude(\s|$)/.test(lower) || lower.includes("/claude ")) return "claude";
  if (/\bcodex(\s|$)/.test(lower) || lower.includes("/codex ")) return "codex";
  if (/\bopencode(\s|$)/.test(lower) || lower.includes("/opencode ")) return "opencode";
  if (/\bhermes(\s|$)/.test(lower) || lower.includes("/hermes") || lower.includes("hermes_cli")) return "hermes";
  return null;
}

function findManagedOwner(
  pid: number,
  processes: ProcessInfo[],
  managedByPid: Map<number, { pid: number; id: string; title: string; workspace: string }>,
) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const seen = new Set<number>();
  let current: number | null = pid;
  while (current && !seen.has(current)) {
    seen.add(current);
    const managed = managedByPid.get(current);
    if (managed) return managed;
    current = byPid.get(current)?.ppid ?? null;
  }
  return null;
}

function extractWorkspaceFromCommand(command: string): string | null {
  const cdMatch = command.match(/\bcd\s+'([^']+)'/);
  if (cdMatch) return cdMatch[1];
  const codexCdMatch = command.match(/--cd\s+('([^']+)'|"([^"]+)"|([^\s]+))/);
  if (codexCdMatch) return codexCdMatch[2] ?? codexCdMatch[3] ?? codexCdMatch[4] ?? null;
  return null;
}

export async function spawnEmbeddedTerminal(
  workspace: string,
  options: EmbeddedTerminalSpawnOptions = {},
): Promise<EmbeddedTerminalSession> {
  const cwd = path.resolve(workspace);
  const stat = fs.existsSync(cwd) ? fs.statSync(cwd) : null;
  if (!stat?.isDirectory()) {
    throw new Error(`Workspace does not exist: ${cwd}`);
  }

  const kind = options.kind ?? "shell";
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const contextMode = resolveAgentContextMode(options.contextMode, options.task, options.contextText);
  const promptPath = kind === "shell" || kind === "hermes" || options.resumeSessionId || contextMode === "none"
    ? null
    : writeAgentContextPrompt(cwd, kind, contextMode, options.title, options.task, options.contextText);
  const backendUrl = getBackendState().baseUrl;
  const controlUrl = getControlState().baseUrl;
  const mcpConfigPath = isAgentKind(kind) && backendUrl && controlUrl
    ? writeMcpConfig(kind, backendUrl, controlUrl)
    : null;
  const launch = terminalLaunch(kind, cwd, promptPath, options.resumeSessionId, mcpConfigPath);
  const sessionLabel = options.sessionLabel ?? defaultSessionLabel(kind, options.resumeSessionId);
  const providerSessionId = isAgentKind(kind) ? options.providerSessionId ?? options.resumeSessionId ?? null : null;
  const restoreEntry: RestorableTerminal = {
    id,
    title: options.title ?? defaultTitle(kind),
    kind,
    workspace: cwd,
    sessionLabel: options.sessionLabel ?? defaultSessionLabel(kind, options.resumeSessionId),
    providerSessionId,
    resumeSessionId: isAgentKind(kind) ? options.resumeSessionId ?? providerSessionId : null,
    createdAt: new Date().toISOString(),
  };

  const session: EmbeddedTerminalSession = {
    id,
    title: restoreEntry.title,
    kind,
    workspace: cwd,
    pid: null,
    promptPath,
    initialTask: options.task?.trim() || null,
    sessionLabel: restoreEntry.sessionLabel,
    providerSessionId,
    createdAt: restoreEntry.createdAt,
    status: "running",
    exitCode: null,
    error: null,
  };
  const controlSource = options.controlSource ?? "ui";
  recordSpawnRequested({
    terminalId: session.id,
    title: session.title,
    kind: session.kind,
    workspace: session.workspace,
    source: controlSource,
    preview: session.initialTask,
  });

  try {
    const openCodeBaseline = kind === "opencode" ? resolveOpenCodeBaselineBinary() : null;
    const baseEnv = stringEnv(sanitizedTerminalEnv());
    const pid = await ptyHost.spawn({
      id,
      command: launch.command,
      args: launch.args,
      cwd,
      cols: options.cols ?? 96,
      rows: options.rows ?? 28,
      env: {
        ...baseEnv,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        CONTEXT_WORKSPACE_TERMINAL_ID: id,
        ...(promptPath ? { CONTEXT_WORKSPACE_HERMES_PROMPT: promptPath } : {}),
        ...(openCodeBaseline ? { OPENCODE_BIN_PATH: openCodeBaseline } : {}),
        ...(backendUrl ? { CONTEXT_WORKSPACE_BACKEND_URL: backendUrl } : {}),
        ...(controlUrl ? { CONTEXT_WORKSPACE_ELECTRON_CONTROL_URL: controlUrl } : {}),
      },
    });

    session.pid = pid;
    terminals.set(id, { session, restore: restoreEntry });
    upsertRestoreEntry(restoreEntry);
    recordSpawnSucceeded({
      terminalId: session.id,
      title: session.title,
      kind: session.kind,
      workspace: session.workspace,
      source: controlSource,
      pid,
    });

    emit("embedded-terminal:session", session);
    maybeDiscoverClaudeSessionId(session.id, cwd, restoreEntry.createdAt);
    return { ...session };
  } catch (error) {
    const failed = { ...session, status: "failed" as const, error: String(error) };
    recordSpawnFailed({
      terminalId: failed.id,
      title: failed.title,
      kind: failed.kind,
      workspace: failed.workspace,
      source: controlSource,
      error: failed.error ?? "Terminal spawn failed.",
    });
    emit("embedded-terminal:session", failed);
    return failed;
  }
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export async function writeEmbeddedTerminal(id: string, data: string): Promise<EmbeddedTerminalSession> {
  const entry = requireTerminal(id);
  await ptyHost.write(id, data);
  return { ...entry.session };
}

export function renameEmbeddedTerminal(id: string, title: string): EmbeddedTerminalSession {
  const entry = requireTerminal(id);
  const nextTitle = title.trim();
  if (!nextTitle) throw new Error("Session title cannot be empty.");
  entry.session = { ...entry.session, title: nextTitle };
  entry.restore = { ...entry.restore, title: nextTitle };
  upsertRestoreEntry(entry.restore);
  emit("embedded-terminal:session", entry.session);
  return { ...entry.session };
}

export async function submitEmbeddedTerminalInput(target: string, text: string): Promise<EmbeddedTerminalSession> {
  const entry = requireTerminalTarget(target);
  if (!text.trim()) throw new Error("Input text cannot be empty.");
  recordInputRequested({ terminalId: entry.session.id, source: "electron-control", preview: text });
  const writes = terminalInputWritesForKind(entry.session.kind, text);
  try {
    for (const write of writes) {
      await ptyHost.write(entry.session.id, write.data);
      if (write.delayAfterMs) await delay(write.delayAfterMs);
    }
  } catch (error) {
    recordInputFailed({ terminalId: entry.session.id, source: "electron-control", preview: text, error: String(error) });
    throw error;
  }
  recordInputWritten({ terminalId: entry.session.id, source: "electron-control", preview: text });
  return { ...entry.session };
}

/**
 * Write raw bytes straight to the PTY with no line-submit sequencing. Unlike
 * {@link submitEmbeddedTerminalInput}, nothing is appended — the caller controls
 * every byte. This backs interactive remote input (e.g. mobile xterm onData),
 * where keystrokes, arrows, and control codes must reach the agent TUI verbatim.
 */
export async function writeEmbeddedTerminalInputRaw(target: string, data: string): Promise<EmbeddedTerminalSession> {
  const entry = requireTerminalTarget(target);
  if (!data) throw new Error("Input data cannot be empty.");
  recordInputRequested({ terminalId: entry.session.id, source: "electron-control", preview: data });
  try {
    await ptyHost.write(entry.session.id, data);
  } catch (error) {
    recordInputFailed({ terminalId: entry.session.id, source: "electron-control", preview: data, error: String(error) });
    throw error;
  }
  recordInputWritten({ terminalId: entry.session.id, source: "electron-control", preview: data });
  return { ...entry.session };
}

export async function resizeEmbeddedTerminal(id: string, cols: number, rows: number): Promise<EmbeddedTerminalSession> {
  const entry = terminals.get(id);
  if (!entry) return missingSession(id);
  await ptyHost.resize(id, Math.max(20, Math.floor(cols)), Math.max(6, Math.floor(rows)));
  return { ...entry.session };
}

export async function killEmbeddedTerminal(id: string): Promise<EmbeddedTerminalSession> {
  const entry = requireTerminal(id);
  await ptyHost.kill(id);
  entry.session = { ...entry.session, status: "exited", exitCode: null };
  terminals.delete(id);
  removeRestoreEntry(id);
  emit("embedded-terminal:exit", { id, exitCode: null });
  return { ...entry.session };
}

function installPtyHostListeners(): void {
  if (ptyHostListenersInstalled) return;
  ptyHostListenersInstalled = true;
  ptyHost.on("data", ({ id, data }) => {
    recordTerminalOutput(id);
    appendBuffer(id, data);
    notifyTerminalData(id, data);
    queueOutput(id, data);
  });
  ptyHost.on("exit", ({ id, exitCode }) => {
    flushOutput(id);
    notifyTerminalExit(id, exitCode);
    const entry = terminals.get(id);
    if (!entry) return;
    entry.session = { ...entry.session, status: "exited", exitCode };
    recordTerminalExited(id, exitCode);
    emit("embedded-terminal:exit", { id, exitCode });
    terminals.delete(id);
    if (!appQuitting) removeRestoreEntry(id);
  });
  ptyHost.on("error", ({ id, error }) => {
    if (!id) {
      console.error("[Athena] PTY host error:", error);
      return;
    }
    const entry = terminals.get(id);
    if (!entry) return;
    entry.session = { ...entry.session, status: "failed", error };
    recordSpawnFailed({
      terminalId: entry.session.id,
      title: entry.session.title,
      kind: entry.session.kind,
      workspace: entry.session.workspace,
      source: "pty-host",
      error,
    });
    emit("embedded-terminal:session", entry.session);
  });
  ptyHost.on("crash", ({ ids, error }) => {
    console.error("[Athena] PTY host crashed:", error);
    for (const id of ids) {
      flushOutput(id);
      notifyTerminalExit(id, null);
      const entry = terminals.get(id);
      if (!entry) continue;
      entry.session = { ...entry.session, status: "failed", error };
      recordSpawnFailed({
        terminalId: entry.session.id,
        title: entry.session.title,
        kind: entry.session.kind,
        workspace: entry.session.workspace,
        source: "pty-host",
        error,
      });
      emit("embedded-terminal:session", entry.session);
      emit("embedded-terminal:exit", { id, exitCode: null });
      terminals.delete(id);
      if (!appQuitting) removeRestoreEntry(id);
    }
  });
}

function restoreFilePath(): string {
  return path.join(os.homedir(), ".context-workspace", "embedded-terminals.json");
}

function restoreAttemptsFilePath(): string {
  return path.join(os.homedir(), ".context-workspace", "embedded-terminal-restore-attempts.json");
}

function readRestoreEntries(): RestorableTerminal[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(restoreFilePath(), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRestorableTerminal);
  } catch {
    return [];
  }
}

function readRestoreAttempts(): RestoreAttemptState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(restoreAttemptsFilePath(), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const state = parsed as Partial<RestoreAttemptState>;
    if (typeof state.startedAt !== "string" || !Array.isArray(state.entries)) return null;
    const entries = state.entries.filter(isRestorableTerminal);
    return entries.length > 0 ? { startedAt: state.startedAt, entries } : null;
  } catch {
    return null;
  }
}

function writeRestoreAttempts(state: RestoreAttemptState): void {
  try {
    const filePath = restoreAttemptsFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Restore attempt state is a crash-loop guard; app startup must continue.
  }
}

function recordRestoreAttempts(entries: RestorableTerminal[]): void {
  if (entries.length === 0) return;
  const previous = readRestoreAttempts();
  const byId = new Map<string, RestorableTerminal>();
  for (const entry of previous?.entries ?? []) byId.set(entry.id, entry);
  for (const entry of entries) byId.set(entry.id, entry);
  writeRestoreAttempts({
    startedAt: previous?.startedAt ?? new Date().toISOString(),
    entries: Array.from(byId.values()),
  });
}

function clearRestoreAttempts(): void {
  try {
    fs.unlinkSync(restoreAttemptsFilePath());
  } catch {
    // Missing or unreadable attempt state should not block clean shutdown.
  }
}

function quarantinePendingRestoreAttemptsAfterCrash(): void {
  const launchState = readAthenaLaunchState();
  if (!launchState?.terminalRestorePaused && launchState?.cleanExit !== false) return;
  const attempts = readRestoreAttempts();
  if (!attempts) return;

  const attemptedIds = new Set(attempts.entries.map((entry) => entry.id));
  const currentEntries = readRestoreEntries();
  const quarantined = currentEntries.filter((entry) => attemptedIds.has(entry.id));
  if (quarantined.length > 0) {
    archiveRestoreEntries(quarantined, "quarantine", {
      reason: "Previous launch ended before restored terminals exited cleanly.",
      attemptedAt: attempts.startedAt,
      quarantinedAt: new Date().toISOString(),
    });
    writeRestoreEntries(currentEntries.filter((entry) => !attemptedIds.has(entry.id)));
    console.warn(`[Athena] Quarantined ${quarantined.length} embedded terminal restore entries after an unclean launch.`);
  }
  clearRestoreAttempts();
}

function writeRestoreEntries(entries: RestorableTerminal[]): void {
  try {
    const filePath = restoreFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), "utf8");
  } catch {
    // Restore state is best-effort; live PTY control remains authoritative.
  }
}

function archiveRestoreEntries(entries: RestorableTerminal[], suffix = "bak", metadata?: Record<string, unknown>): void {
  try {
    const filePath = restoreFilePath();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = `${filePath}.${stamp}.${suffix}`;
    const payload = metadata ? { ...metadata, entries } : entries;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(archivePath, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // Archiving is best-effort. Clearing stale restore state should still proceed.
  }
}

function upsertRestoreEntry(entry: RestorableTerminal): void {
  const entries = readRestoreEntries().filter((item) => item.id !== entry.id);
  writeRestoreEntries([entry, ...entries].slice(0, 40));
}

function removeRestoreEntry(id: string): void {
  writeRestoreEntries(readRestoreEntries().filter((entry) => entry.id !== id));
}

function isRestorableTerminal(value: unknown): value is RestorableTerminal {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<RestorableTerminal>;
  return typeof item.id === "string"
    && typeof item.workspace === "string"
    && typeof item.title === "string"
    && typeof item.createdAt === "string"
    && typeof item.kind === "string"
    && ["shell", "hermes", "codex", "opencode", "claude"].includes(item.kind)
    && (item.sessionLabel == null || typeof item.sessionLabel === "string")
    && (item.providerSessionId == null || typeof item.providerSessionId === "string")
    && (item.resumeSessionId == null || typeof item.resumeSessionId === "string");
}

function appendBuffer(id: string, data: string): void {
  const next = `${outputBuffers.get(id) ?? ""}${data}`;
  outputBuffers.set(id, next.length > MAX_BUFFER_CHARS ? next.slice(-MAX_BUFFER_CHARS) : next);
}

function queueOutput(id: string, data: string): void {
  updatePerformanceRates();
  perfCounters.ptyChunks += 1;
  perfCounters.ptyBytes += Buffer.byteLength(data);
  pendingOutput.set(id, `${pendingOutput.get(id) ?? ""}${data}`);
  if (outputFlushTimer) return;
  outputFlushTimer = setTimeout(() => flushOutput(), PTY_FLUSH_INTERVAL_MS);
}

function flushOutput(id?: string): void {
  updatePerformanceRates();
  if (outputFlushTimer) {
    clearTimeout(outputFlushTimer);
    outputFlushTimer = null;
  }

  const entries = id ? [[id, pendingOutput.get(id) ?? ""] as const] : Array.from(pendingOutput.entries());
  for (const [terminalId, data] of entries) {
    if (!data) continue;
    pendingOutput.delete(terminalId);
    perfCounters.ipcBatches += 1;
    perfCounters.ipcBytes += Buffer.byteLength(data);
    perfCounters.lastBatchAt = new Date().toISOString();
    emit("embedded-terminal:data", { id: terminalId, data });
  }

  if (!id) return;
  if (pendingOutput.size > 0 && !outputFlushTimer) {
    outputFlushTimer = setTimeout(() => flushOutput(), PTY_FLUSH_INTERVAL_MS);
  }
}

function roundRate(value: number): number {
  return Math.round(value * 10) / 10;
}

function updatePerformanceRates(): void {
  const now = Date.now();
  const elapsedMs = now - perfCounters.sampleStartedAt;
  if (elapsedMs < 1000) return;
  const elapsedSeconds = elapsedMs / 1000;
  perfCounters.rates = {
    ptyChunksPerSecond: roundRate(perfCounters.ptyChunks / elapsedSeconds),
    ptyBytesPerSecond: roundRate(perfCounters.ptyBytes / elapsedSeconds),
    ipcBatchesPerSecond: roundRate(perfCounters.ipcBatches / elapsedSeconds),
    ipcBytesPerSecond: roundRate(perfCounters.ipcBytes / elapsedSeconds),
  };
  perfCounters.ptyChunks = 0;
  perfCounters.ptyBytes = 0;
  perfCounters.ipcBatches = 0;
  perfCounters.ipcBytes = 0;
  perfCounters.sampleStartedAt = now;
}

function startEventLoopMonitor(): void {
  if (eventLoopMonitorTimer) return;
  let expectedAt = Date.now() + EVENT_LOOP_SAMPLE_INTERVAL_MS;
  const sample = () => {
    const now = Date.now();
    eventLoopLagMs = Math.max(0, now - expectedAt);
    maxEventLoopLagMs = Math.max(maxEventLoopLagMs, eventLoopLagMs);
    expectedAt = now + EVENT_LOOP_SAMPLE_INTERVAL_MS;
    eventLoopMonitorTimer = setTimeout(sample, EVENT_LOOP_SAMPLE_INTERVAL_MS);
    eventLoopMonitorTimer.unref?.();
  };
  eventLoopMonitorTimer = setTimeout(sample, EVENT_LOOP_SAMPLE_INTERVAL_MS);
  eventLoopMonitorTimer.unref?.();
}

function requireTerminal(id: string): ManagedTerminal {
  const entry = terminals.get(id);
  if (!entry) throw new Error(`Embedded terminal not found: ${id}`);
  return entry;
}

function requireTerminalTarget(target: string): ManagedTerminal {
  const normalized = target.trim();
  const direct = terminals.get(normalized);
  if (direct) return direct;
  for (const entry of terminals.values()) {
    if (entry.session.providerSessionId === normalized) return entry;
  }
  throw new Error(`Embedded terminal target not found: ${target}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function missingSession(id: string): EmbeddedTerminalSession {
  return {
    id,
    title: "Unknown terminal",
    kind: "shell",
    workspace: "",
    pid: null,
    promptPath: null,
    initialTask: null,
    sessionLabel: null,
    providerSessionId: null,
    createdAt: new Date().toISOString(),
    status: "exited",
    exitCode: null,
    error: "Embedded terminal not found.",
  };
}

function resolveMcpServerPath(): string | null {
  if (!_appRoot) return null;
  // Same logic as resolveBackendParent in backend.ts: one level up from appRoot covers both dev and packaged
  const parent = _appRoot.includes(".asar") ? path.dirname(_appRoot) : path.resolve(_appRoot, "..");
  const candidate = path.join(parent, "mcp_server", "server.py");
  return fs.existsSync(candidate) ? candidate : null;
}

function writeMcpConfig(kind: EmbeddedTerminalKind, backendUrl: string, controlUrl: string): string | null {
  const serverPath = resolveMcpServerPath();
  if (!serverPath) return null;
  try {
    if (kind === "claude") return writeClaudeMcpConfig(backendUrl, controlUrl, serverPath);
  } catch {
    // Non-fatal: agent launches without MCP wiring if config write fails.
  }
  return null;
}

function writeClaudeMcpConfig(backendUrl: string, controlUrl: string, serverPath: string): string {
  const configPath = path.join(tempWorkspaceDirectory(), `athena-claude-mcp-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const config = {
    mcpServers: {
      context_workspace: {
        command: "python3",
        args: [serverPath],
        env: { CONTEXT_WORKSPACE_BACKEND_URL: backendUrl, CONTEXT_WORKSPACE_ELECTRON_CONTROL_URL: controlUrl },
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
  return configPath;
}

function writeAgentContextPrompt(
  cwd: string,
  kind: EmbeddedTerminalKind,
  mode: AgentContextMode,
  title?: string,
  task?: string,
  contextText?: string,
): string {
  const directory = tempWorkspaceDirectory();
  const promptPath = path.join(directory, `athena-agent-context-${Date.now()}-${Math.random().toString(16).slice(2)}.md`);
  const prompt = buildAgentContextPrompt({
    mode,
    workspace: cwd,
    agentLabel: agentConfig(kind).label,
    title,
    task,
    contextText,
  });
  if (!prompt) throw new Error("Agent context prompt cannot be empty.");
  fs.writeFileSync(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
  return promptPath;
}

function defaultTitle(kind: EmbeddedTerminalKind): string {
  if (kind === "hermes") return "Hermes";
  if (kind === "codex") return "Codex";
  if (kind === "opencode") return "OpenCode";
  if (kind === "claude") return "Claude";
  return "Shell";
}

function defaultSessionLabel(kind: EmbeddedTerminalKind, resumeSessionId?: string): string | null {
  if (kind === "shell") return null;
  if (kind === "hermes") return resumeSessionId ? resumeSessionId : null;
  return resumeSessionId ? resumeSessionId : "New";
}

function maybeDiscoverClaudeSessionId(terminalId: string, workspace: string, createdAt: string): void {
  const entry = terminals.get(terminalId);
  if (!entry || entry.session.kind !== "claude" || entry.session.providerSessionId) return;
  void discoverClaudeSessionId(terminalId, workspace, createdAt);
}

async function discoverClaudeSessionId(terminalId: string, workspace: string, createdAt: string): Promise<void> {
  const startedAtMs = Date.parse(createdAt);
  const minMtimeMs = Number.isFinite(startedAtMs) ? startedAtMs - 10_000 : Date.now() - 10_000;

  for (let attempt = 0; attempt < CLAUDE_SESSION_DISCOVERY_ATTEMPTS; attempt += 1) {
    const entry = terminals.get(terminalId);
    if (!entry || entry.session.kind !== "claude" || entry.session.providerSessionId || entry.session.status !== "running") return;
    const sessionId = await newestClaudeSessionIdForWorkspace(workspace, minMtimeMs);
    if (sessionId) {
      attachProviderSessionId(terminalId, sessionId);
      return;
    }
    await delay(CLAUDE_SESSION_DISCOVERY_INTERVAL_MS);
  }
}

async function newestClaudeSessionIdForWorkspace(workspace: string, minMtimeMs: number): Promise<string | null> {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  const candidates: { id: string; mtimeMs: number }[] = [];
  for (const dir of claudeProjectPathCandidates(projectsDir, workspace)) {
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const filePath = path.join(dir, name);
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.mtimeMs < minMtimeMs) continue;
        const id = await claudeSessionIdFromFile(filePath, path.basename(name, ".jsonl"));
        if (id) candidates.push({ id, mtimeMs: stat.mtimeMs });
      } catch {
        // Claude session discovery is best-effort; restore still falls back to a fresh Claude launch.
      }
    }
  }
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.id ?? null;
}

async function claudeSessionIdFromFile(filePath: string, fallback: string): Promise<string | null> {
  try {
    const lines = (await fs.promises.readFile(filePath, "utf8")).split("\n").filter(Boolean).slice(0, 20);
    for (const line of lines) {
      const entry = parseJsonObject(line);
      const sessionId = stringProperty(entry, "sessionId");
      if (sessionId) return sessionId;
    }
  } catch {
    return null;
  }
  return fallback || null;
}

function attachProviderSessionId(terminalId: string, providerSessionId: string): void {
  const entry = terminals.get(terminalId);
  if (!entry || entry.session.kind !== "claude") return;
  entry.session = {
    ...entry.session,
    providerSessionId,
    sessionLabel: entry.session.sessionLabel === "New" || !entry.session.sessionLabel ? providerSessionId : entry.session.sessionLabel,
  };
  entry.restore = {
    ...entry.restore,
    providerSessionId,
    resumeSessionId: providerSessionId,
    sessionLabel: entry.restore.sessionLabel === "New" || !entry.restore.sessionLabel ? providerSessionId : entry.restore.sessionLabel,
  };
  upsertRestoreEntry(entry.restore);
  emit("embedded-terminal:session", entry.session);
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringProperty(value: Record<string, unknown> | null, key: string): string | null {
  const item = value?.[key];
  return typeof item === "string" && item.trim() ? item : null;
}

function isAgentKind(kind: EmbeddedTerminalKind): boolean {
  return kind === "codex" || kind === "opencode" || kind === "claude" || kind === "hermes";
}

function emit(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}
