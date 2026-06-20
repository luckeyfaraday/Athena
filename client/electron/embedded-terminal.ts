import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { BrowserWindow } from "electron";
import { buildAgentContextPrompt, resolveAgentContextMode, type AgentContextMode } from "./agent-context.js";
import {
  buildClaudeMcpConfig,
  buildCodexMcpConfigArgs,
  buildOpenCodeMcpConfigContent,
  type AgentMcpLaunch,
} from "./agent-mcp.js";
import {
  agentMessageEnvelope,
  createAgentMessage,
  expireInFlightAgentMessages,
  failQueuedAgentMessages,
  listAgentMessages,
  markTerminalOutputForMessages,
  queuedAgentMessagesForTerminal,
  updateAgentMessageStatus,
  type AgentMessage,
} from "./agent-messages.js";
import { agentHandle, agentHandleMap, resolveAgentTarget } from "./agent-routing.js";
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
import {
  claudeProjectPathCandidates,
  codexSessionIdForWorkspace,
  effectiveCreationMs,
  openCodeDatabaseCandidates,
  openCodeSessionExists,
  openCodeSessionIdForWorkspace,
  savedResumeSessionId,
  selectDiscoveredSessionId,
  selectEmbeddedTerminalRestoreEntries,
  SESSION_DISCOVERY_GRACE_MS,
  type RestorableTerminal,
  type SessionFileCandidate,
} from "./terminal-restore-policy.js";
import { sanitizedTerminalEnv } from "./terminal-env.js";
import { rawInputPreview } from "./terminal-input.js";
import {
  clearTerminalActivity,
  isTerminalActive,
  recordTerminalInputActivity,
  recordTerminalOutputActivity,
} from "./terminal-activity.js";
import {
  DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS,
  appendBoundedTerminalOutput,
} from "./terminal-buffer.js";
import { agentConfig, terminalLaunch } from "./terminal-launch.js";
import {
  resolveOpenCodeBaselineBinary,
  tempWorkspaceDirectory,
} from "./platform.js";

const execFileAsync = promisify(execFile);

export type EmbeddedTerminalKind = "shell" | "hermes" | "codex" | "opencode" | "claude" | "athena" | "grok";

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
  model?: string;
  controlSource?: string;
};

type ImmersiveContextBundle = {
  bundle_id: string;
  context_path: string;
};

export type SendAgentMessageRequest = {
  to: string;
  text: string;
  workspace?: string | null;
  fromTerminalId?: string | null;
  threadId?: string | null;
  replyRequested?: boolean;
  hopCount?: number;
  source?: string;
};

export type SendAgentMessageResult = {
  message: AgentMessage;
  terminal: EmbeddedTerminalSession | null;
  queued: boolean;
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
  expireInFlightAgentMessages("Athena restarted before the message could be delivered.");
  quarantinePendingRestoreAttemptsAfterCrash();
  startEventLoopMonitor();
}

export function prepareEmbeddedTerminalRestoreForQuit(): void {
  appQuitting = true;
  clearRestoreAttempts();
  ptyHost.shutdown();
}

/**
 * True while a restore attempt from this or a previous run has not yet been
 * confirmed stable. Read at launch (before the quarantine pass clears it) to
 * decide whether an unclean previous exit looks like a restore crash-loop.
 */
export function hasPendingEmbeddedTerminalRestoreAttempts(): boolean {
  return readRestoreAttempts() != null;
}

const terminals = new Map<string, ManagedTerminal>();
const outputBuffers = new Map<string, string>();
const MAX_BUFFER_CHARS = 200_000;
const MAX_PENDING_OUTPUT_CHARS = DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS;
const PTY_FLUSH_INTERVAL_MS = 16;
const EVENT_LOOP_SAMPLE_INTERVAL_MS = 1000;
const CLAUDE_SESSION_DISCOVERY_ATTEMPTS = 20;
const CLAUDE_SESSION_DISCOVERY_INTERVAL_MS = 750;
const CODEX_SESSION_DISCOVERY_ATTEMPTS = 20;
const CODEX_SESSION_DISCOVERY_INTERVAL_MS = 750;
const OPENCODE_SESSION_DISCOVERY_ATTEMPTS = 20;
const OPENCODE_SESSION_DISCOVERY_INTERVAL_MS = 750;
// Grok stamps the session dir at creation; allow a little slack so a dir written
// just before our spawn timestamp (clock skew / startup latency) still matches.
const GROK_SESSION_DISCOVERY_SLACK_MS = 5_000;
const pendingOutput = new Map<string, string>();
const inFlightOutput = new Map<string, number>();
let nextOutputSequence = 1;
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

export function listEmbeddedAgentMessages(workspace?: string | null, limit?: number): AgentMessage[] {
  return listAgentMessages(workspace, limit);
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
  try {
    return { ...resolveAgentTarget(target, listEmbeddedTerminals()) };
  } catch {
    return null;
  }
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
    if (plan.restore.length > 0) scheduleRestoreAttemptClear();
    for (const entry of plan.restore) {
      if (!fs.existsSync(entry.workspace)) continue;
      const resumeSessionId = await resolveRestoreResumeSessionId(entry);
      const session = await spawnEmbeddedTerminal(entry.workspace, {
        kind: entry.kind,
        title: entry.title,
        cols: 96,
        rows: 28,
        resumeSessionId: resumeSessionId ?? undefined,
        sessionLabel: entry.sessionLabel ?? undefined,
        // Without a resumable session the spawn starts a fresh provider
        // session, so a saved provider id would be a stale, wrong binding.
        providerSessionId: resumeSessionId ? entry.providerSessionId ?? resumeSessionId : undefined,
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

async function resolveRestoreResumeSessionId(entry: RestorableTerminal): Promise<string | null> {
  const savedSessionId = savedResumeSessionId(entry);
  if (savedSessionId && entry.kind === "claude") {
    // A pre-assigned --session-id only becomes resumable once Claude has
    // written its session file; without one, `claude --resume` would fail and
    // strand the pane, so restore launches fresh instead.
    return (await claudeSessionFileExists(entry.workspace, savedSessionId)) ? savedSessionId : null;
  }
  if (savedSessionId && isOpenCodeKind(entry.kind)) {
    // A session deleted inside the TUI would make `--session` fail and strand
    // the pane, so restore confirms the id is still in the session store.
    return (await openCodeSessionExists(openCodeDatabaseCandidates(), savedSessionId)) ? savedSessionId : null;
  }
  if (savedSessionId) return savedSessionId;

  const startedAtMs = Date.parse(entry.createdAt);
  const spawnedAtMs = Number.isFinite(startedAtMs) ? startedAtMs : 0;
  // Entries saved before session-id discovery existed for their kind carry no
  // id; recover it from the provider's session store by creation time.
  if (isOpenCodeKind(entry.kind)) {
    return openCodeSessionIdForWorkspace(openCodeDatabaseCandidates(), entry.workspace, spawnedAtMs, attachedProviderSessionIds(entry.id));
  }
  if (entry.kind !== "codex") return null;
  return codexSessionIdForWorkspace(path.join(os.homedir(), ".codex", "sessions"), entry.workspace, spawnedAtMs, attachedProviderSessionIds(entry.id));
}

async function claudeSessionFileExists(workspace: string, sessionId: string): Promise<boolean> {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  for (const dir of claudeProjectPathCandidates(projectsDir, workspace)) {
    try {
      await fs.promises.access(path.join(dir, `${sessionId}.jsonl`));
      return true;
    } catch {
      // Try the next encoding candidate.
    }
  }
  return false;
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
  if (/\bathena-code(\s|$)/.test(lower) || lower.includes("/athena-code ")) return "athena";
  if (/\bclaude(\s|$)/.test(lower) || lower.includes("/claude ")) return "claude";
  if (/\bcodex(\s|$)/.test(lower) || lower.includes("/codex ")) return "codex";
  if (/\bgrok(\s|$)/.test(lower) || lower.includes("/grok ")) return "grok";
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
  const backendUrl = getBackendState().baseUrl;
  const controlUrl = getControlState().baseUrl;
  const immersiveBundle = isImmersiveContextMode(contextMode) && isAgentKind(kind) && !options.resumeSessionId
    ? await createImmersiveContextBundle(
        backendUrl,
        cwd,
        kind,
        contextMode,
        options.task,
        options.contextText,
      )
    : null;
  const promptPath = kind === "shell" || kind === "hermes" || options.resumeSessionId || contextMode === "none"
    ? null
    : writeAgentContextPrompt(
        cwd,
        kind,
        contextMode,
        options.title,
        options.task,
        options.contextText,
        immersiveBundle,
      );
  const mcpWiring = resolveAgentMcpWiring(kind, backendUrl, controlUrl);
  // Fresh Claude panes get their session id assigned up front (claude
  // --session-id <uuid>) instead of inferred from session-file mtimes after
  // launch. Inference mis-attached a neighbor pane's session when two panes
  // shared a workspace, which routed injected input to the wrong agent (#137).
  const assignedSessionId = kind === "claude" && !options.resumeSessionId && !options.providerSessionId
    ? randomUUID()
    : null;
  const launch = terminalLaunch(kind, cwd, promptPath, options.resumeSessionId, mcpWiring.launch, assignedSessionId, options.model);
  const sessionLabel = options.sessionLabel ?? defaultSessionLabel(kind, options.resumeSessionId ?? assignedSessionId ?? undefined);
  const providerSessionId = isAgentKind(kind) ? options.providerSessionId ?? options.resumeSessionId ?? assignedSessionId : null;
  const restoreEntry: RestorableTerminal = {
    id,
    title: options.title ?? defaultTitle(kind),
    kind,
    workspace: cwd,
    sessionLabel,
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
        ...mcpWiring.env,
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
    maybeDiscoverProviderSessionId(session.id, cwd, restoreEntry.createdAt);
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
  recordTerminalInputActivity(id);
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
  const message = createAgentMessage({
    workspace: entry.session.workspace,
    from: "external",
    to: agentHandle(entry.session, listEmbeddedTerminals()),
    toTerminalId: entry.session.id,
    toKind: entry.session.kind,
    text,
    source: "terminal-injection",
    status: "injecting",
  });
  recordInputRequested({ terminalId: entry.session.id, source: "electron-control", preview: text });
  const writes = terminalInputWritesForKind(entry.session.kind, text);
  try {
    recordTerminalInputActivity(entry.session.id);
    for (const write of writes) {
      await ptyHost.write(entry.session.id, write.data);
      if (write.delayAfterMs) await delay(write.delayAfterMs);
    }
  } catch (error) {
    recordInputFailed({ terminalId: entry.session.id, source: "electron-control", preview: text, error: String(error) });
    updateAgentMessageStatus(message.id, "failed", String(error));
    throw error;
  }
  recordInputWritten({ terminalId: entry.session.id, source: "electron-control", preview: text });
  updateAgentMessageStatus(message.id, "written");
  return { ...entry.session };
}

export async function sendAgentMessage(request: SendAgentMessageRequest): Promise<SendAgentMessageResult> {
  const sessions = listEmbeddedTerminals();
  const fromSession = request.fromTerminalId ? findEmbeddedTerminal(request.fromTerminalId) : null;
  const workspace = request.workspace ?? fromSession?.workspace ?? null;
  const target = requireTerminalTarget(request.to, workspace);
  const handles = agentHandleMap(sessions);
  const message = createAgentMessage({
    workspace: target.session.workspace,
    from: fromSession ? handles.get(fromSession.id) ?? fromSession.title : request.source ?? "human",
    fromTerminalId: fromSession?.id ?? request.fromTerminalId ?? null,
    to: handles.get(target.session.id) ?? target.session.title,
    toTerminalId: target.session.id,
    toKind: target.session.kind,
    text: request.text,
    threadId: request.threadId,
    replyRequested: request.replyRequested,
    hopCount: request.hopCount,
    source: request.source ?? "athena",
    status: isTerminalActive(target.session.id) ? "queued" : "injecting",
  });
  if (message.status === "queued") {
    terminalsWithQueuedMessages.add(target.session.id);
    scheduleQueueDrain(target.session.id);
    return { message, terminal: { ...target.session }, queued: true };
  }

  const delivered = await deliverAgentMessage(target, message, "agent-message");
  return { message: delivered, terminal: { ...target.session }, queued: false };
}

/** Inject a single message envelope into a terminal and record the outcome. */
async function deliverAgentMessage(entry: ManagedTerminal, message: AgentMessage, source: string): Promise<AgentMessage> {
  const envelope = agentMessageEnvelope(message);
  const injecting = updateAgentMessageStatus(message.id, "injecting") ?? message;
  recordInputRequested({ terminalId: entry.session.id, source, preview: envelope });
  try {
    recordTerminalInputActivity(entry.session.id);
    for (const write of terminalInputWritesForKind(entry.session.kind, envelope)) {
      await ptyHost.write(entry.session.id, write.data);
      if (write.delayAfterMs) await delay(write.delayAfterMs);
    }
  } catch (error) {
    recordInputFailed({ terminalId: entry.session.id, source, preview: envelope, error: String(error) });
    return updateAgentMessageStatus(message.id, "failed", String(error)) ?? injecting;
  }
  recordInputWritten({ terminalId: entry.session.id, source, preview: envelope });
  return updateAgentMessageStatus(message.id, "written") ?? injecting;
}

// Queued messages wait for the target terminal to return to an idle prompt
// before they are injected, so a message sent to a busy agent is never typed
// into the middle of its current turn. Delivery is retried on a short debounce
// after each burst of terminal output (the agent finishing a turn), and exactly
// one queued message is injected per idle window so they arrive in order without
// piling up. Messages that never find an idle window are expired so they fail
// visibly instead of sitting "queued" forever.
const QUEUE_DRAIN_DEBOUNCE_MS = 1200;
const QUEUE_MESSAGE_MAX_AGE_MS = 120_000;
const queueDrainTimers = new Map<string, NodeJS.Timeout>();
const terminalsWithQueuedMessages = new Set<string>();
const drainInFlight = new Set<string>();

function scheduleQueueDrain(terminalId: string): void {
  const existing = queueDrainTimers.get(terminalId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    queueDrainTimers.delete(terminalId);
    void drainQueuedAgentMessages(terminalId);
  }, QUEUE_DRAIN_DEBOUNCE_MS);
  timer.unref?.();
  queueDrainTimers.set(terminalId, timer);
}

function clearQueueDrain(terminalId: string): void {
  const timer = queueDrainTimers.get(terminalId);
  if (timer) clearTimeout(timer);
  queueDrainTimers.delete(terminalId);
  terminalsWithQueuedMessages.delete(terminalId);
}

async function drainQueuedAgentMessages(terminalId: string): Promise<void> {
  if (drainInFlight.has(terminalId)) return;
  drainInFlight.add(terminalId);
  try {
    const entry = terminals.get(terminalId);
    if (!entry || entry.session.status !== "running") {
      failQueuedAgentMessages(terminalId, "Target terminal is no longer running.");
      terminalsWithQueuedMessages.delete(terminalId);
      return;
    }
    const now = Date.now();
    for (const message of queuedAgentMessagesForTerminal(terminalId)) {
      if (now - Date.parse(message.at) > QUEUE_MESSAGE_MAX_AGE_MS) {
        updateAgentMessageStatus(message.id, "failed", "Timed out waiting for the target terminal to become idle.");
      }
    }
    const pending = queuedAgentMessagesForTerminal(terminalId);
    if (pending.length === 0) {
      terminalsWithQueuedMessages.delete(terminalId);
      return;
    }
    if (isTerminalActive(terminalId)) {
      scheduleQueueDrain(terminalId);
      return;
    }
    // Injecting the oldest message makes the terminal busy again, so any
    // remaining messages wait for the next idle window and stay ordered.
    await deliverAgentMessage(entry, pending[0], "agent-message-queue");
    if (queuedAgentMessagesForTerminal(terminalId).length > 0) scheduleQueueDrain(terminalId);
    else terminalsWithQueuedMessages.delete(terminalId);
  } finally {
    drainInFlight.delete(terminalId);
  }
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
  const preview = rawInputPreview(data);
  recordInputRequested({ terminalId: entry.session.id, source: "electron-control", preview });
  try {
    recordTerminalInputActivity(entry.session.id);
    await ptyHost.write(entry.session.id, data);
  } catch (error) {
    recordInputFailed({ terminalId: entry.session.id, source: "electron-control", preview, error: String(error) });
    throw error;
  }
  recordInputWritten({ terminalId: entry.session.id, source: "electron-control", preview });
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
  failQueuedAgentMessages(id, "Target terminal was stopped before delivery.");
  clearQueueDrain(id);
  terminals.delete(id);
  clearTerminalActivity(id);
  notifyTerminalExit(id, null);
  removeRestoreEntry(id);
  emit("embedded-terminal:exit", { id, exitCode: null });
  clearTerminalOutputState(id);
  return { ...entry.session };
}

function installPtyHostListeners(): void {
  if (ptyHostListenersInstalled) return;
  ptyHostListenersInstalled = true;
  ptyHost.on("data", ({ id, data }) => {
    recordTerminalOutput(id);
    recordTerminalOutputActivity(id);
    markTerminalOutputForMessages(id);
    appendBuffer(id, data);
    notifyTerminalData(id, data);
    queueOutput(id, data);
    // Output usually means the agent finished a turn; retry queued delivery
    // once it settles back to an idle prompt.
    if (terminalsWithQueuedMessages.has(id)) scheduleQueueDrain(id);
  });
  ptyHost.on("exit", ({ id, exitCode }) => {
    flushOutput(id);
    notifyTerminalExit(id, exitCode);
    const entry = terminals.get(id);
    if (!entry) return;
    entry.session = { ...entry.session, status: "exited", exitCode };
    recordTerminalExited(id, exitCode);
    failQueuedAgentMessages(id, "Target terminal exited before delivery.");
    clearQueueDrain(id);
    emit("embedded-terminal:exit", { id, exitCode });
    terminals.delete(id);
    clearTerminalActivity(id);
    if (!appQuitting) removeRestoreEntry(id);
    clearTerminalOutputState(id);
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
    failQueuedAgentMessages(id, "Target terminal failed before delivery.");
    clearQueueDrain(id);
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
      failQueuedAgentMessages(id, "Target terminal crashed before delivery.");
      clearQueueDrain(id);
      emit("embedded-terminal:session", entry.session);
      emit("embedded-terminal:exit", { id, exitCode: null });
      terminals.delete(id);
      clearTerminalActivity(id);
      if (!appQuitting) removeRestoreEntry(id);
      clearTerminalOutputState(id);
    }
  });
}

function clearTerminalOutputState(id: string): void {
  outputBuffers.delete(id);
  pendingOutput.delete(id);
  inFlightOutput.delete(id);
  dataListeners.delete(id);
  exitListeners.delete(id);
  if (pendingOutput.size === 0 && outputFlushTimer) {
    clearTimeout(outputFlushTimer);
    outputFlushTimer = null;
  }
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

// Attempt state exists to catch restores that crash the app right back down
// (the SIGBUS loop). Once restored terminals have survived this long, the
// restore itself is proven safe, so the attempt record is cleared; a later
// crash then neither quarantines those terminals nor pauses future restores.
const RESTORE_ATTEMPT_STABILITY_MS = 120_000;
let restoreAttemptClearTimer: NodeJS.Timeout | null = null;

function scheduleRestoreAttemptClear(): void {
  if (restoreAttemptClearTimer) clearTimeout(restoreAttemptClearTimer);
  restoreAttemptClearTimer = setTimeout(() => {
    restoreAttemptClearTimer = null;
    if (!appQuitting) clearRestoreAttempts();
  }, RESTORE_ATTEMPT_STABILITY_MS);
  restoreAttemptClearTimer.unref?.();
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
    && ["shell", "hermes", "codex", "opencode", "claude", "athena", "grok"].includes(item.kind)
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
  pendingOutput.set(id, appendBoundedTerminalOutput(pendingOutput.get(id) ?? "", data, MAX_PENDING_OUTPUT_CHARS));
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
    if (!data || inFlightOutput.has(terminalId)) continue;
    pendingOutput.delete(terminalId);
    const sequence = nextOutputSequence++;
    inFlightOutput.set(terminalId, sequence);
    perfCounters.ipcBatches += 1;
    perfCounters.ipcBytes += Buffer.byteLength(data);
    perfCounters.lastBatchAt = new Date().toISOString();
    emit("embedded-terminal:data", { id: terminalId, data, sequence });
  }

  if (!id) return;
  if (pendingOutput.size > 0 && !outputFlushTimer) {
    outputFlushTimer = setTimeout(() => flushOutput(), PTY_FLUSH_INTERVAL_MS);
  }
}

export function acknowledgeEmbeddedTerminalOutput(id: string, sequence: number): void {
  if (inFlightOutput.get(id) !== sequence) return;
  inFlightOutput.delete(id);
  if (pendingOutput.has(id)) flushOutput(id);
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

function requireTerminalTarget(target: string, workspace?: string | null): ManagedTerminal {
  const session = resolveAgentTarget(target, listEmbeddedTerminals(), workspace);
  return requireTerminal(session.id);
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

// MCP wiring split: `launch` is threaded into the command builders (Claude's
// --mcp-config file, Codex's -c overrides), while `env` is merged into the spawn
// environment (opencode/athena read OPENCODE_CONFIG_CONTENT). Each agent uses
// exactly one of the two; the other stays empty.
type AgentMcpWiring = { launch: AgentMcpLaunch | null; env: Record<string, string> };

function resolveAgentMcpWiring(kind: EmbeddedTerminalKind, backendUrl: string | null, controlUrl: string | null): AgentMcpWiring {
  const empty: AgentMcpWiring = { launch: null, env: {} };
  if (!isAgentKind(kind) || !backendUrl || !controlUrl) return empty;
  const serverPath = resolveMcpServerPath();
  if (!serverPath) return empty;
  try {
    if (kind === "claude") {
      return { launch: { configPath: writeClaudeMcpConfigFile(serverPath, backendUrl, controlUrl) }, env: {} };
    }
    if (kind === "codex") {
      return { launch: { codexConfigArgs: buildCodexMcpConfigArgs(serverPath, backendUrl, controlUrl) }, env: {} };
    }
    if (kind === "opencode" || kind === "athena") {
      return { launch: null, env: { OPENCODE_CONFIG_CONTENT: buildOpenCodeMcpConfigContent(serverPath, backendUrl, controlUrl) } };
    }
    // Hermes is intentionally unwired: the context_workspace server proxies into
    // the backend (i.e. Hermes itself), so its memory/ask tools would be circular.
    // Hermes also registers MCP servers persistently via `hermes mcp add` rather
    // than through an ephemeral per-launch flag, and bypasses the agentConfig path.
    //
    // Grok has no per-launch MCP flag or config env var; it reads persistent
    // `.grok/settings.json` (`mcpServers`) from the project, so it stays unwired
    // here and picks up context_workspace from that file when present.
  } catch {
    // Non-fatal: agent launches without MCP wiring if config generation fails.
  }
  return empty;
}

function writeClaudeMcpConfigFile(serverPath: string, backendUrl: string, controlUrl: string): string {
  const configPath = path.join(tempWorkspaceDirectory(), `athena-claude-mcp-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const config = buildClaudeMcpConfig(serverPath, backendUrl, controlUrl);
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
  immersiveBundle?: ImmersiveContextBundle | null,
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
    bundleId: immersiveBundle?.bundle_id,
    contextPath: immersiveBundle?.context_path,
  });
  if (!prompt) throw new Error("Agent context prompt cannot be empty.");
  fs.writeFileSync(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
  return promptPath;
}

function isImmersiveContextMode(mode: AgentContextMode): mode is "immersive" | "immersive_curated" {
  return mode === "immersive" || mode === "immersive_curated";
}

async function createImmersiveContextBundle(
  backendUrl: string | null,
  workspace: string,
  kind: EmbeddedTerminalKind,
  mode: "immersive" | "immersive_curated",
  task?: string,
  contextText?: string,
): Promise<ImmersiveContextBundle> {
  if (!backendUrl) {
    throw new Error("Athena immersive mode requires the backend to be available.");
  }
  const response = await fetch(`${backendUrl}/context/bundles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_dir: workspace,
      mode,
      agent: agentConfig(kind).label,
      task: task?.trim() ?? "",
      context: contextText?.trim() ?? "",
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Athena immersive context creation failed with HTTP ${response.status}.${detail ? ` ${detail}` : ""}`);
  }
  const payload = await response.json() as { bundle?: Partial<ImmersiveContextBundle> };
  const bundleId = payload.bundle?.bundle_id;
  const contextPath = payload.bundle?.context_path;
  if (!bundleId || !contextPath) {
    throw new Error("Athena immersive context creation returned an invalid bundle.");
  }
  return { bundle_id: bundleId, context_path: contextPath };
}

function defaultTitle(kind: EmbeddedTerminalKind): string {
  if (kind === "hermes") return "Hermes";
  if (kind === "codex") return "Codex";
  if (kind === "opencode") return "OpenCode";
  if (kind === "claude") return "Claude";
  if (kind === "athena") return "Athena Code";
  if (kind === "grok") return "Grok";
  return "Shell";
}

function defaultSessionLabel(kind: EmbeddedTerminalKind, resumeSessionId?: string): string | null {
  if (kind === "shell") return null;
  if (kind === "hermes") return resumeSessionId ? resumeSessionId : null;
  return resumeSessionId ? resumeSessionId : "New";
}

function maybeDiscoverProviderSessionId(terminalId: string, workspace: string, createdAt: string): void {
  const entry = terminals.get(terminalId);
  if (!entry || entry.session.providerSessionId) return;
  if (entry.session.kind === "claude") void discoverClaudeSessionId(terminalId, workspace, createdAt);
  else if (entry.session.kind === "codex") void discoverCodexSessionId(terminalId, workspace, createdAt);
  else if (entry.session.kind === "grok") void discoverGrokSessionId(terminalId, workspace, createdAt);
  else if (isOpenCodeKind(entry.session.kind)) void discoverOpenCodeSessionId(terminalId, workspace, createdAt);
}

// Grok writes one directory per session under ~/.grok/sessions/<urlencoded-cwd>/<id>,
// so the freshest session dir created after the pane spawned is this pane's session.
// Ids already bound to other live panes are excluded so co-located Grok panes don't
// claim each other's session.
async function discoverGrokSessionId(terminalId: string, workspace: string, createdAt: string): Promise<void> {
  const startedAtMs = Date.parse(createdAt);
  const spawnedAtMs = Number.isFinite(startedAtMs) ? startedAtMs : Date.now();
  const sessionsDir = path.join(os.homedir(), ".grok", "sessions", encodeURIComponent(path.resolve(workspace)));

  for (let attempt = 0; attempt < CODEX_SESSION_DISCOVERY_ATTEMPTS; attempt += 1) {
    const entry = terminals.get(terminalId);
    if (!entry || entry.session.kind !== "grok" || entry.session.providerSessionId || entry.session.status !== "running") return;
    const sessionId = grokSessionIdForWorkspace(sessionsDir, spawnedAtMs, attachedProviderSessionIds(terminalId));
    if (sessionId) {
      attachProviderSessionId(terminalId, sessionId);
      return;
    }
    await delay(CODEX_SESSION_DISCOVERY_INTERVAL_MS);
  }
}

function grokSessionIdForWorkspace(sessionsDir: string, spawnedAtMs: number, exclude: Set<string>): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { id: string; mtimeMs: number } | null = null;
  for (const dirent of entries) {
    if (!dirent.isDirectory() || exclude.has(dirent.name)) continue;
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(path.join(sessionsDir, dirent.name)).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs + GROK_SESSION_DISCOVERY_SLACK_MS < spawnedAtMs) continue;
    if (!best || mtimeMs > best.mtimeMs) best = { id: dirent.name, mtimeMs };
  }
  return best?.id ?? null;
}

// Athena Code is an OpenCode fork that keeps OpenCode's session storage, so
// both kinds discover their session id from the same database set. Ids bound
// to other live panes are excluded, which also keeps OpenCode and Athena panes
// sharing a workspace from claiming each other's session.
async function discoverOpenCodeSessionId(terminalId: string, workspace: string, createdAt: string): Promise<void> {
  const startedAtMs = Date.parse(createdAt);
  const spawnedAtMs = Number.isFinite(startedAtMs) ? startedAtMs : Date.now();

  for (let attempt = 0; attempt < OPENCODE_SESSION_DISCOVERY_ATTEMPTS; attempt += 1) {
    const entry = terminals.get(terminalId);
    if (!entry || !isOpenCodeKind(entry.session.kind) || entry.session.providerSessionId || entry.session.status !== "running") return;
    const sessionId = await openCodeSessionIdForWorkspace(openCodeDatabaseCandidates(), workspace, spawnedAtMs, attachedProviderSessionIds(terminalId));
    if (sessionId) {
      attachProviderSessionId(terminalId, sessionId);
      return;
    }
    await delay(OPENCODE_SESSION_DISCOVERY_INTERVAL_MS);
  }
}

async function discoverCodexSessionId(terminalId: string, workspace: string, createdAt: string): Promise<void> {
  const startedAtMs = Date.parse(createdAt);
  const spawnedAtMs = Number.isFinite(startedAtMs) ? startedAtMs : Date.now();
  const sessionsDir = path.join(os.homedir(), ".codex", "sessions");

  for (let attempt = 0; attempt < CODEX_SESSION_DISCOVERY_ATTEMPTS; attempt += 1) {
    const entry = terminals.get(terminalId);
    if (!entry || entry.session.kind !== "codex" || entry.session.providerSessionId || entry.session.status !== "running") return;
    const sessionId = await codexSessionIdForWorkspace(sessionsDir, workspace, spawnedAtMs, attachedProviderSessionIds(terminalId));
    if (sessionId) {
      attachProviderSessionId(terminalId, sessionId);
      return;
    }
    await delay(CODEX_SESSION_DISCOVERY_INTERVAL_MS);
  }
}

// Fallback only: fresh Claude panes are assigned an explicit --session-id at
// spawn, so this discovery now runs just for terminals that predate that
// change (restored entries without a saved provider session id).
async function discoverClaudeSessionId(terminalId: string, workspace: string, createdAt: string): Promise<void> {
  const startedAtMs = Date.parse(createdAt);
  const spawnedAtMs = Number.isFinite(startedAtMs) ? startedAtMs : Date.now();

  for (let attempt = 0; attempt < CLAUDE_SESSION_DISCOVERY_ATTEMPTS; attempt += 1) {
    const entry = terminals.get(terminalId);
    if (!entry || entry.session.kind !== "claude" || entry.session.providerSessionId || entry.session.status !== "running") return;
    const sessionId = await claudeSessionIdForWorkspace(workspace, spawnedAtMs, attachedProviderSessionIds(terminalId));
    if (sessionId) {
      attachProviderSessionId(terminalId, sessionId);
      return;
    }
    await delay(CLAUDE_SESSION_DISCOVERY_INTERVAL_MS);
  }
}

// Session ids already bound to other live terminals must never be discovered
// again: a neighbor pane's session claiming a second terminal is exactly the
// crossed-registry failure from issue #137.
function attachedProviderSessionIds(excludeTerminalId: string): Set<string> {
  const ids = new Set<string>();
  for (const [terminalId, entry] of terminals) {
    if (terminalId === excludeTerminalId) continue;
    if (entry.session.providerSessionId) ids.add(entry.session.providerSessionId);
  }
  return ids;
}

async function claudeSessionIdForWorkspace(
  workspace: string,
  spawnedAtMs: number,
  excludeSessionIds?: ReadonlySet<string>,
): Promise<string | null> {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  const candidates: SessionFileCandidate[] = [];
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
        const createdMs = effectiveCreationMs(stat);
        if (createdMs < spawnedAtMs - SESSION_DISCOVERY_GRACE_MS) continue;
        const id = await claudeSessionIdFromFile(filePath, path.basename(name, ".jsonl"));
        if (id) candidates.push({ id, createdMs });
      } catch {
        // Claude session discovery is best-effort; restore still falls back to a fresh Claude launch.
      }
    }
  }
  return selectDiscoveredSessionId(candidates, spawnedAtMs, excludeSessionIds);
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
  if (!entry || !isSessionDiscoveryKind(entry.session.kind)) return;
  // Two concurrent discoveries can race to the same candidate; only the first
  // may bind it. The loser keeps polling and picks up its own session file.
  if (attachedProviderSessionIds(terminalId).has(providerSessionId)) return;
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
  return kind === "codex" || kind === "opencode" || kind === "claude" || kind === "hermes" || kind === "athena" || kind === "grok";
}

function isOpenCodeKind(kind: EmbeddedTerminalKind): boolean {
  return kind === "opencode" || kind === "athena";
}

function isSessionDiscoveryKind(kind: EmbeddedTerminalKind): boolean {
  return kind === "claude" || kind === "codex" || kind === "grok" || isOpenCodeKind(kind);
}

function emit(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}
