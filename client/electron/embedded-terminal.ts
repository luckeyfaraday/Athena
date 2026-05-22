import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrowserWindow } from "electron";
import * as pty from "node-pty";
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
import { sanitizedTerminalEnv } from "./terminal-env.js";
import {
  defaultShell,
  isWindows,
  quotePowerShell,
  quoteShell,
  resolveOpenCodeBaselineBinary,
  tempWorkspaceDirectory,
  windowsPathToWslPath,
} from "./platform.js";

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
  process: pty.IPty;
  restore: RestorableTerminal;
};

type RestorableTerminal = {
  id: string;
  workspace: string;
  kind: EmbeddedTerminalKind;
  title: string;
  sessionLabel: string | null;
  providerSessionId: string | null;
  resumeSessionId: string | null;
  createdAt: string;
};

let _appRoot: string | null = null;
let appQuitting = false;
let restoreInFlight = false;

export function initEmbeddedTerminals(appRoot: string): void {
  _appRoot = appRoot;
  startEventLoopMonitor();
}

export function prepareEmbeddedTerminalRestoreForQuit(): void {
  appQuitting = true;
}

const terminals = new Map<string, ManagedTerminal>();
const outputBuffers = new Map<string, string>();
const MAX_BUFFER_CHARS = 200_000;
const PTY_FLUSH_INTERVAL_MS = 16;
const EVENT_LOOP_SAMPLE_INTERVAL_MS = 1000;
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
};

export function listEmbeddedTerminals(): EmbeddedTerminalSession[] {
  return Array.from(terminals.values())
    .filter((entry) => entry.session.status === "running")
    .map((entry) => ({ ...entry.session }));
}

export function getEmbeddedTerminalBuffer(id: string): string {
  return outputBuffers.get(id) ?? "";
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
  if (restoreInFlight || terminals.size > 0) return listEmbeddedTerminals();
  restoreInFlight = true;
  try {
    const restored: EmbeddedTerminalSession[] = [];
    const allowed = restoreWorkspaceSet(allowedWorkspaces);
    const entries = readRestoreEntries();
    for (const entry of entries) {
      if (allowed && !allowed.has(normalizeRestoreWorkspace(entry.workspace))) continue;
      removeRestoreEntry(entry.id);
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

function restoreWorkspaceSet(workspaces?: string[]): Set<string> | null {
  if (!workspaces || workspaces.length === 0) return null;
  const normalized = workspaces
    .map((workspace) => normalizeRestoreWorkspace(workspace))
    .filter(Boolean);
  return normalized.length > 0 ? new Set(normalized) : null;
}

function normalizeRestoreWorkspace(workspace: string): string {
  try {
    return path.resolve(workspace);
  } catch {
    return workspace;
  }
}

export function getPerformanceDiagnostics(): PerformanceDiagnostics {
  updatePerformanceRates();
  const pendingOutputBytes = Array.from(pendingOutput.values()).reduce((total, value) => total + Buffer.byteLength(value), 0);
  const bufferedTerminalChars = Array.from(outputBuffers.values()).reduce((total, value) => total + value.length, 0);
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
  };
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
    const baseEnv = sanitizedTerminalEnv();
    const term = pty.spawn(launch.command, launch.args, {
      name: "xterm-256color",
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

    session.pid = term.pid;
    terminals.set(id, { session, process: term, restore: restoreEntry });
    upsertRestoreEntry(restoreEntry);
    recordSpawnSucceeded({
      terminalId: session.id,
      title: session.title,
      kind: session.kind,
      workspace: session.workspace,
      source: controlSource,
      pid: session.pid,
    });

    term.onData((data) => {
      recordTerminalOutput(id);
      appendBuffer(id, data);
      queueOutput(id, data);
    });

    term.onExit(({ exitCode }) => {
      flushOutput(id);
      const entry = terminals.get(id);
      if (entry) {
        entry.session = { ...entry.session, status: "exited", exitCode };
        recordTerminalExited(id, exitCode);
        emit("embedded-terminal:exit", { id, exitCode });
        terminals.delete(id);
        if (!appQuitting) removeRestoreEntry(id);
      }
    });

    emit("embedded-terminal:session", session);
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

export function writeEmbeddedTerminal(id: string, data: string): EmbeddedTerminalSession {
  const entry = requireTerminal(id);
  entry.process.write(data);
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
      entry.process.write(write.data);
      if (write.delayAfterMs) await delay(write.delayAfterMs);
    }
  } catch (error) {
    recordInputFailed({ terminalId: entry.session.id, source: "electron-control", preview: text, error: String(error) });
    throw error;
  }
  recordInputWritten({ terminalId: entry.session.id, source: "electron-control", preview: text });
  return { ...entry.session };
}

export function resizeEmbeddedTerminal(id: string, cols: number, rows: number): EmbeddedTerminalSession {
  const entry = terminals.get(id);
  if (!entry) return missingSession(id);
  entry.process.resize(Math.max(20, Math.floor(cols)), Math.max(6, Math.floor(rows)));
  return { ...entry.session };
}

export function killEmbeddedTerminal(id: string): EmbeddedTerminalSession {
  const entry = requireTerminal(id);
  entry.process.kill();
  entry.session = { ...entry.session, status: "exited", exitCode: null };
  terminals.delete(id);
  removeRestoreEntry(id);
  emit("embedded-terminal:exit", { id, exitCode: null });
  return { ...entry.session };
}

function restoreFilePath(): string {
  return path.join(os.homedir(), ".context-workspace", "embedded-terminals.json");
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

function writeRestoreEntries(entries: RestorableTerminal[]): void {
  try {
    const filePath = restoreFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), "utf8");
  } catch {
    // Restore state is best-effort; live PTY control remains authoritative.
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

function terminalLaunch(
  kind: EmbeddedTerminalKind,
  cwd: string,
  promptPath: string | null,
  resumeSessionId?: string,
  mcpConfigPath?: string | null,
): { command: string; args: string[] } {
  if (isWindows) {
    if (kind === "hermes" && resumeSessionId) {
      return {
        command: "powershell.exe",
        args: ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", launchHermesPowerShellCommand(cwd, resumeSessionId)],
      };
    }
    if (kind === "hermes") {
      return {
        command: "powershell.exe",
        args: ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", launchHermesPowerShellCommand(cwd)],
      };
    }
    if (kind !== "shell" && resumeSessionId) {
      return {
        command: "powershell.exe",
        args: ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", launchResumePowerShellCommand(kind, cwd, resumeSessionId, mcpConfigPath)],
      };
    }
    if (kind !== "shell") {
      return {
        command: "powershell.exe",
        args: ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", launchPowerShellCommand(kind, cwd, promptPath, mcpConfigPath)],
      };
    }
    return defaultShell();
  }

  return { command: "bash", args: ["-lc", resumeSessionId ? launchResumeCommand(kind, cwd, resumeSessionId, mcpConfigPath) : launchCommand(kind, cwd, promptPath, mcpConfigPath)] };
}

function launchCommand(kind: EmbeddedTerminalKind, cwd: string, promptPath: string | null, mcpConfigPath?: string | null): string {
  if (kind === "hermes") {
    return [
      `cd ${quoteShell(cwd)}`,
      "printf '\\033[36m[Context Workspace] Hermes ready.\\033[0m\\n'",
      "if ! command -v hermes >/dev/null 2>&1; then printf '\\033[31mhermes is not installed or not on PATH.\\033[0m\\n'; exec bash -l; fi",
      "hermes",
      "exec bash -l",
    ].join("; ");
  }

  if (kind !== "shell") {
    const agent = agentConfig(kind);
    return [
      `cd ${quoteShell(cwd)}`,
      promptPath
        ? `printf '\\033[36m[Context Workspace] %s Athena context: %s\\033[0m\\n' ${quoteShell(agent.label)} ${quoteShell(promptPath)}`
        : `printf '\\033[36m[Context Workspace] Launching %s\\033[0m\\n' ${quoteShell(agent.label)}`,
      `if ! command -v ${quoteShell(agent.executable)} >/dev/null 2>&1; then printf '\\033[31m%s is not installed or not on PATH.\\033[0m\\n' ${quoteShell(agent.executable)}; exec bash -l; fi`,
      `${agent.executable} ${agent.args(cwd, promptPath, "bash", mcpConfigPath)}`.trimEnd(),
      "exec bash -l",
    ].join("; ");
  }

  return [
    `cd ${quoteShell(cwd)}`,
    "printf '\\033[36m[Context Workspace] Embedded shell ready. Launch Codex with Hermes from the Command Room when needed.\\033[0m\\n'",
    "exec bash -l",
  ].join("; ");
}

function launchHermesPowerShellCommand(cwd: string, resumeSessionId?: string): string {
  const wslCwd = windowsPathToWslPath(cwd) ?? cwd.replace(/\\/g, "/");
  const hermesCommand = resumeSessionId ? `hermes --resume ${quoteShell(resumeSessionId)}` : "hermes";
  const wslCommand = `cd ${quoteShell(wslCwd)} && ${hermesCommand}`;
  return [
    `$workspace = ${quotePowerShell(cwd)}`,
    `$wslCommand = ${quotePowerShell(wslCommand)}`,
    "Set-Location -LiteralPath $workspace",
    resumeSessionId
      ? `Write-Host ${quotePowerShell(`[Context Workspace] Resuming Hermes session: ${resumeSessionId}`)} -ForegroundColor Cyan`
      : "Write-Host \"[Context Workspace] Hermes ready.\" -ForegroundColor Cyan",
    "$resolvedWsl = Get-Command wsl.exe -ErrorAction SilentlyContinue",
    "if ($resolvedWsl) { & wsl.exe -e sh -lc $wslCommand; return }",
    "$resolvedHermes = Get-Command hermes -ErrorAction SilentlyContinue",
    resumeSessionId ? `$sessionId = ${quotePowerShell(resumeSessionId)}` : "",
    resumeSessionId ? "if ($resolvedHermes) { & hermes --resume $sessionId; return }" : "if ($resolvedHermes) { & hermes; return }",
    "Write-Host \"wsl.exe is unavailable and native hermes is not on PATH.\" -ForegroundColor Red",
  ].filter(Boolean).join("; ");
}

function launchResumeCommand(kind: EmbeddedTerminalKind, cwd: string, resumeSessionId: string, mcpConfigPath?: string | null): string {
  if (kind === "hermes") {
    return [
      `cd ${quoteShell(cwd)}`,
      `printf '\\033[36m[Context Workspace] Resuming Hermes session: %s\\033[0m\\n' ${quoteShell(resumeSessionId)}`,
      "if ! command -v hermes >/dev/null 2>&1; then printf '\\033[31mhermes is not installed or not on PATH.\\033[0m\\n'; exec bash -l; fi",
      `hermes --resume ${quoteShell(resumeSessionId)}`,
      "exec bash -l",
    ].join("; ");
  }
  const agent = agentConfig(kind);
  return [
    `cd ${quoteShell(cwd)}`,
    `printf '\\033[36m[Context Workspace] Resuming %s session: %s\\033[0m\\n' ${quoteShell(agent.label)} ${quoteShell(resumeSessionId)}`,
    `if ! command -v ${quoteShell(agent.executable)} >/dev/null 2>&1; then printf '\\033[31m%s is not installed or not on PATH.\\033[0m\\n' ${quoteShell(agent.executable)}; exec bash -l; fi`,
    agent.resumeArgs(cwd, resumeSessionId, "bash", mcpConfigPath),
    "exec bash -l",
  ].join("; ");
}

function launchResumePowerShellCommand(kind: EmbeddedTerminalKind, cwd: string, resumeSessionId: string, mcpConfigPath?: string | null): string {
  const agent = agentConfig(kind);
  return [
    `$workspace = ${quotePowerShell(cwd)}`,
    `$sessionId = ${quotePowerShell(resumeSessionId)}`,
    `$agentCommand = ${quotePowerShell(agent.executable)}`,
    `$agentLabel = ${quotePowerShell(agent.label)}`,
    mcpConfigPath ? `$mcpConfigPath = ${quotePowerShell(mcpConfigPath)}` : "",
    "Set-Location -LiteralPath $workspace",
    "Write-Host \"[Context Workspace] Resuming $agentLabel session: $sessionId\" -ForegroundColor Cyan",
    "$resolvedAgent = Get-Command $agentCommand -ErrorAction SilentlyContinue",
    "if (-not $resolvedAgent) { Write-Host \"$agentCommand is not installed or not on PATH.\" -ForegroundColor Red; return }",
    ...(kind === "opencode" ? [selectOpenCodeBaselinePowerShell()] : []),
    agent.resumePowerShellCommand,
  ].join("; ");
}

function launchPowerShellCommand(kind: EmbeddedTerminalKind, cwd: string, promptPath: string | null, mcpConfigPath?: string | null): string {
  const agent = agentConfig(kind);
  return [
    `$workspace = ${quotePowerShell(cwd)}`,
    promptPath ? `$promptPath = ${quotePowerShell(promptPath)}` : "",
    "Set-Location -LiteralPath $workspace",
    `$agentCommand = ${quotePowerShell(agent.executable)}`,
    `$agentLabel = ${quotePowerShell(agent.label)}`,
    mcpConfigPath ? `$mcpConfigPath = ${quotePowerShell(mcpConfigPath)}` : "",
    promptPath
      ? "Write-Host \"[Context Workspace] $agentLabel Athena context: $promptPath\" -ForegroundColor Cyan"
      : "Write-Host \"[Context Workspace] Launching $agentLabel\" -ForegroundColor Cyan",
    "$resolvedAgent = Get-Command $agentCommand -ErrorAction SilentlyContinue",
    "if (-not $resolvedAgent) { Write-Host \"$agentCommand is not installed or not on PATH.\" -ForegroundColor Red; return }",
    ...(kind === "opencode" ? [selectOpenCodeBaselinePowerShell()] : []),
    promptPath ? "$prompt = Get-Content -LiteralPath $promptPath -Raw" : "",
    promptPath ? agent.powerShellCommand : agent.powerShellCommandWithoutPrompt,
  ].join("; ");
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

function isAgentKind(kind: EmbeddedTerminalKind): boolean {
  return kind === "codex" || kind === "opencode" || kind === "claude" || kind === "hermes";
}

function agentConfig(kind: EmbeddedTerminalKind): {
  label: string;
  executable: string;
  powerShellCommand: string;
  powerShellCommandWithoutPrompt: string;
  resumePowerShellCommand: string;
  args: (cwd: string, promptPath: string | null, shell: "bash", mcpConfigPath?: string | null) => string;
  resumeArgs: (cwd: string, sessionId: string, shell: "bash", mcpConfigPath?: string | null) => string;
} {
  if (kind === "opencode") {
    return {
      label: "OpenCode",
      executable: "opencode",
      powerShellCommand: "$agentPrompt = (($prompt -replace '[\\r\\n]+', ' ') -replace '\\s{2,}', ' ').Trim(); $agentArgs = @('--prompt', $agentPrompt, $workspace); & $agentCommand @agentArgs",
      powerShellCommandWithoutPrompt: "$agentArgs = @($workspace); & $agentCommand @agentArgs",
      resumePowerShellCommand: "$agentArgs = @('--session', $sessionId, $workspace); & $agentCommand @agentArgs",
      args: (cwd, promptPath) => promptPath ? `--prompt "$(tr '\\r\\n' '  ' < ${quoteShell(promptPath)})" ${quoteShell(cwd)}` : quoteShell(cwd),
      resumeArgs: (cwd, sessionId) => `opencode --session ${quoteShell(sessionId)} ${quoteShell(cwd)}`,
    };
  }
  if (kind === "claude") {
    return {
      label: "Claude Code",
      executable: "claude",
      powerShellCommand: "$agentArgs = @(); if ($mcpConfigPath) { $agentArgs += @('--mcp-config', $mcpConfigPath) }; $agentArgs += $prompt; & $agentCommand @agentArgs",
      powerShellCommandWithoutPrompt: "$agentArgs = @(); if ($mcpConfigPath) { $agentArgs += @('--mcp-config', $mcpConfigPath) }; & $agentCommand @agentArgs",
      resumePowerShellCommand: "$agentArgs = @(); if ($mcpConfigPath) { $agentArgs += @('--mcp-config', $mcpConfigPath) }; $agentArgs += @('--resume', $sessionId); & $agentCommand @agentArgs",
      args: (_cwd, promptPath, _shell, mcpConfigPath) => [
        mcpConfigPath ? `--mcp-config ${quoteShell(mcpConfigPath)}` : "",
        promptPath ? `"$(cat ${quoteShell(promptPath)})"` : "",
      ].filter(Boolean).join(" "),
      resumeArgs: (_cwd, sessionId, _shell, mcpConfigPath) => [
        "claude",
        mcpConfigPath ? `--mcp-config ${quoteShell(mcpConfigPath)}` : "",
        "--resume",
        quoteShell(sessionId),
      ].filter(Boolean).join(" "),
    };
  }
  return {
    label: "Codex",
    executable: "codex",
    powerShellCommand: "$agentArgs = @('--cd', $workspace, '--', $prompt); & $agentCommand @agentArgs",
    powerShellCommandWithoutPrompt: "$agentArgs = @('--cd', $workspace); & $agentCommand @agentArgs",
    resumePowerShellCommand: "$agentArgs = @('resume', '--cd', $workspace, $sessionId); & $agentCommand @agentArgs",
    args: (cwd, promptPath) => promptPath ? `--cd ${quoteShell(cwd)} -- "$(cat ${quoteShell(promptPath)})"` : `--cd ${quoteShell(cwd)}`,
    resumeArgs: (cwd, sessionId) => `codex resume --cd ${quoteShell(cwd)} ${quoteShell(sessionId)}`,
  };
}

function emit(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function selectOpenCodeBaselinePowerShell(): string {
  return [
    "$baselineCandidates = @()",
    "if ($resolvedAgent.Path) {",
    "  $agentPath = $resolvedAgent.Path",
    "  $agentDir = Split-Path -Parent $agentPath",
    "  $baselineCandidates += Join-Path $agentDir 'node_modules\\opencode-ai\\node_modules\\opencode-windows-x64-baseline\\bin\\opencode.exe'",
    "  if ($agentPath -like '*\\opencode-windows-x64\\bin\\opencode.exe') {",
    "    $baselineCandidates += ($agentPath -replace '\\\\opencode-windows-x64\\\\bin\\\\opencode\\.exe$', '\\opencode-windows-x64-baseline\\bin\\opencode.exe')",
    "  }",
    "  if ($agentPath -like '*\\node_modules\\opencode-ai\\bin\\opencode') {",
    "    $packageRoot = Split-Path -Parent (Split-Path -Parent $agentPath)",
    "    $baselineCandidates += Join-Path $packageRoot 'node_modules\\opencode-windows-x64-baseline\\bin\\opencode.exe'",
    "  }",
    "}",
    "if ($env:APPDATA) {",
    "  $baselineCandidates += Join-Path $env:APPDATA 'npm\\node_modules\\opencode-ai\\node_modules\\opencode-windows-x64-baseline\\bin\\opencode.exe'",
    "}",
    "$baseline = $baselineCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1",
    "if ($baseline) {",
    "  $agentCommand = $baseline",
    "  $env:OPENCODE_BIN_PATH = $baseline",
    "  Write-Host \"[Context Workspace] OpenCode baseline binary selected to avoid Bun AVX2 crash: $baseline\" -ForegroundColor Yellow",
    "}",
  ].join("\n");
}
