import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getAgentSessionScanDiagnostics,
  listAgentSessionsCached,
  type AgentSession,
} from "./agent-sessions.js";
import {
  flashWindowForAttention,
  normalizeAttentionNotificationRequest,
  showAttentionNotification,
} from "./attention-notifications.js";
import type { BackendState } from "./backend.js";
import { checkBackendHealth, getBackendState, restartBackend } from "./backend.js";
import {
  checkControlHealth,
  CONTROL_HEALTH_CACHE_MS,
  getControlState,
  restartControlServer,
  type ControlState,
} from "./control-server.js";
import { normalizeExternalUrl } from "./external-links.js";
import {
  getRemoteAccessState,
  getRemoteAccessToken,
  refreshRemoteAccessState,
  regenerateRemoteAccessToken,
  setRemoteAccessEnabled,
  setRemoteAccessPort,
  type RemoteAccessState,
} from "./remote-control.js";
import {
  clearGraphicsQuarantine,
  getGraphicsRuntimeStatus,
  GRAPHICS_PREFERENCE_KEY,
  parseGraphicsPreference,
  type GraphicsRuntimeStatus,
} from "./graphics-state.js";
import { clearTerminalRestorePause, readAthenaLaunchState, type AthenaLaunchState } from "./launch-state.js";
import {
  launchStaggerDelayMs,
  OneShotLaunchOverride,
  publicLaunchAdmission,
  releaseLaunchAdmission,
  reserveLaunchAdmission,
  settleLaunchAdmission,
  type LaunchAdmissionResult,
} from "./launch-admission.js";
import { formatBytes } from "./memory-guard.js";
import {
  agentCliStatus,
  agentCliStatuses,
  isAgentCliKind,
  privateAgentCopies,
  refreshPathFromSystem,
  type AgentCliStatus,
  type PrivateAgentCopies,
} from "./agent-cli.js";
import { getDefaultWorkspace, toWorkspacePath, type WorkspacePath } from "./platform.js";
import { getPreferences, removePreference, setPreference } from "./preferences.js";
import { THEME_PREFERENCE_KEY, themeWindowBackground } from "./theme-window.js";
import {
  acknowledgeEmbeddedTerminalOutput,
  attachEmbeddedTerminalStream,
  clearSavedEmbeddedTerminalRestores,
  getEmbeddedTerminalBuffer,
  getPerformanceDiagnostics,
  initEmbeddedTerminals,
  killEmbeddedTerminal,
  listEmbeddedTerminals,
  renameEmbeddedTerminal,
  resizeEmbeddedTerminal,
  restoreEmbeddedTerminals,
  spawnEmbeddedTerminal,
  subscribeEmbeddedTerminalOutput,
  unsubscribeEmbeddedTerminalOutput,
  writeEmbeddedTerminal,
  type EmbeddedTerminalKind,
  type EmbeddedTerminalSession,
  type EmbeddedTerminalSpawnOptions,
} from "./embedded-terminal.js";

// Heavyweight agents (Claude/Codex/Athena Code/OpenCode/Grok) each pull hundreds
// of MiB plus their own MCP server; launching one onto a memory-starved machine
// freezes the whole desktop via swap thrashing. Warn before the user adds the
// pane that tips the box over. Plain shells are cheap, so they are never guarded.
// A grid reaches IPC as one atomically reserved batch. A low-memory approval is
// therefore a one-shot token for that single request; it must never silently
// authorize later panes or unrelated concurrent requests. Concurrent callers
// share the visible prompt, but only one can consume its approval.
const MAX_UI_TERMINAL_SPAWN_COUNT = 8;
const uiMemoryOverride = new OneShotLaunchOverride();
let uiMemoryPromptInFlight: Promise<boolean> | null = null;

async function guardAgentLaunchMemory(
  options?: EmbeddedTerminalSpawnOptions,
  count = 1,
): Promise<LaunchAdmissionResult> {
  const kind: EmbeddedTerminalKind = options?.kind ?? "shell";
  let admission = reserveLaunchAdmission({
    source: "ui",
    kind,
    count,
  });
  if (admission.granted) {
    if (admission.decision === "warn") {
      console.warn(admission.message, publicLaunchAdmission(admission));
    }
    return admission;
  }

  if (uiMemoryOverride.consume()) {
    admission = reserveLaunchAdmission({ source: "ui", kind, count, overrideCritical: true });
    console.warn(admission.message, publicLaunchAdmission(admission));
    return admission;
  }
  console.error(admission.message, publicLaunchAdmission(admission));
  const approved = await requestUiMemoryOverride(admission);
  if (!approved) {
    throw new Error("Launch cancelled: not enough free memory. Close some agents and try again.");
  }
  if (!uiMemoryOverride.consume()) {
    throw new Error("Launch cancelled: the low-memory override expired. Try again after closing some agents.");
  }
  admission = reserveLaunchAdmission({ source: "ui", kind, count, overrideCritical: true });
  if (!admission.granted) {
    throw new Error(admission.message);
  }
  console.warn(admission.message, publicLaunchAdmission(admission));
  return admission;
}

function requestUiMemoryOverride(admission: LaunchAdmissionResult): Promise<boolean> {
  if (uiMemoryPromptInFlight) return uiMemoryPromptInFlight;
  const available = formatBytes(admission.projectedAvailableBytes);
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  const messageBox = {
    type: "warning" as const,
    title: "Low memory",
    message: "Your machine is almost out of memory.",
    detail:
      `After reserving memory for this agent, only ${available} remains. Launching now is likely to freeze Athena `
      + "and your whole desktop while the system swaps.\n\n"
      + "Close some running agents or apps first, or launch anyway at your own risk. One confirmation covers this grid launch.",
    buttons: ["Cancel", "Launch anyway"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  uiMemoryPromptInFlight = (window
    ? dialog.showMessageBox(window, messageBox)
    : dialog.showMessageBox(messageBox))
    .then(({ response }) => {
      const approved = response !== 0;
      if (approved) {
        uiMemoryOverride.grant();
      }
      return approved;
    })
    .finally(() => {
      uiMemoryPromptInFlight = null;
    });
  return uiMemoryPromptInFlight;
}

export function registerIpcHandlers(appRoot: string): void {
  initEmbeddedTerminals(appRoot);
  ipcMain.on("embeddedTerminal:dataAck", (event, id: string, epoch: string, sequence: number) => {
    if (typeof id === "string" && typeof epoch === "string" && Number.isSafeInteger(sequence)) {
      acknowledgeEmbeddedTerminalOutput(id, event.sender.id, epoch, sequence);
    }
  });
  ipcMain.on("embeddedTerminal:subscribe", (event, id: string) => {
    if (typeof id === "string" && id) subscribeEmbeddedTerminalOutput(id, event.sender);
  });
  ipcMain.on("embeddedTerminal:unsubscribe", (event, id: string) => {
    if (typeof id === "string" && id) unsubscribeEmbeddedTerminalOutput(id, event.sender.id);
  });
  installIpcBreadcrumbCrashFlush();
  const handle = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      const breadcrumb = recordIpcBreadcrumb(channel, args);
      try {
        const result = await listener(event, ...args);
        breadcrumb.phase = "ok";
        return result;
      } catch (error) {
        breadcrumb.phase = "error";
        breadcrumb.error = String(error).slice(0, 500);
        throw error;
      } finally {
        // Completion is diagnostic context only; persist it lazily.
        scheduleIpcBreadcrumbFlush();
      }
    });
  };

  handle("window:minimize", (event): void => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  handle("window:toggleMaximize", (event): boolean => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return window.isMaximized();
  });
  handle("window:close", (event): void => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  handle("shell:openExternal", async (_event, value: string): Promise<boolean> => {
    const url = normalizeExternalUrl(value);
    if (!url) return false;
    await shell.openExternal(url);
    return true;
  });
  handle("shell:openPath", async (_event, value: string): Promise<boolean> => {
    if (typeof value !== "string" || !value.trim()) return false;
    let stat: fs.Stats | null = null;
    try {
      stat = fs.existsSync(value) ? fs.statSync(value) : null;
    } catch {
      return false;
    }
    if (!stat?.isDirectory()) return false;
    const error = await shell.openPath(value);
    return !error;
  });
  // Attention sounds are synthesized in the renderer (shell.beep() played the OS default sound and crashed Linux
  // AppImage main); main owns the native notification and the taskbar flash.
  handle("attention:notify", (event, value: unknown): boolean => {
    const request = normalizeAttentionNotificationRequest(value);
    return request ? showAttentionNotification(BrowserWindow.fromWebContents(event.sender), request) : false;
  });
  handle("attention:flash", (event): void => {
    flashWindowForAttention(BrowserWindow.fromWebContents(event.sender));
  });
  handle("backend:getState", (): BackendState => getBackendState());
  handle("backend:checkHealth", (): Promise<BackendState> => checkBackendHealth());
  handle("backend:restart", (): Promise<BackendState> => restartBackend(appRoot));
  handle("control:getState", (): ControlState => getControlState());
  // The control watchdog probes /health continuously; reuse its recent result.
  handle("control:checkHealth", (): Promise<ControlState> => checkControlHealth({ maxAgeMs: CONTROL_HEALTH_CACHE_MS }));
  handle("control:restart", (): Promise<ControlState> => restartControlServer());
  handle("remoteAccess:getState", (): RemoteAccessState => getRemoteAccessState());
  handle("remoteAccess:refresh", (): Promise<RemoteAccessState> => refreshRemoteAccessState());
  handle("remoteAccess:setEnabled", (_event, enabled: unknown): Promise<RemoteAccessState> => setRemoteAccessEnabled(enabled === true));
  handle("remoteAccess:setPort", (_event, port: unknown): Promise<RemoteAccessState> => setRemoteAccessPort(port));
  handle("remoteAccess:regenerateToken", (): RemoteAccessState => regenerateRemoteAccessToken());
  handle("remoteAccess:getToken", (): string => getRemoteAccessToken());
  handle("launchState:get", (): AthenaLaunchState | null => readAthenaLaunchState());
  handle("launchState:clearTerminalRestorePause", (): AthenaLaunchState => {
    clearSavedEmbeddedTerminalRestores();
    return clearTerminalRestorePause();
  });
  handle("workspace:getDefault", (): WorkspacePath => getDefaultWorkspace(appRoot));
  handle("workspace:toPath", (_event, workspace: string): WorkspacePath => toWorkspacePath(workspace));
  handle("preferences:get", (): Record<string, string> => getPreferences());
  handle("preferences:set", (event, key: string, value: string): Record<string, string> => {
    const preferences = setPreference(key, value);
    // Keep the native background in step with the theme for resizes and the next launch.
    if (key === THEME_PREFERENCE_KEY) {
      BrowserWindow.fromWebContents(event.sender)?.setBackgroundColor(themeWindowBackground(value, nativeTheme.shouldUseDarkColors));
    }
    return preferences;
  });
  handle("preferences:remove", (_event, key: string): Record<string, string> => removePreference(key));
  handle("graphics:getStatus", (): GraphicsRuntimeStatus => {
    const preference = parseGraphicsPreference(getPreferences()[GRAPHICS_PREFERENCE_KEY]);
    return getGraphicsRuntimeStatus(preference);
  });
  handle("graphics:setPreference", (_event, value: string): GraphicsRuntimeStatus => {
    const preference = parseGraphicsPreference(value);
    setPreference(GRAPHICS_PREFERENCE_KEY, preference);
    if (preference === "accelerated") clearGraphicsQuarantine();
    return getGraphicsRuntimeStatus(preference);
  });
  handle("embeddedTerminal:list", (): EmbeddedTerminalSession[] => listEmbeddedTerminals());
  handle("embeddedTerminal:restore", (_event, allowedWorkspaces?: string[]): Promise<EmbeddedTerminalSession[]> =>
    restoreEmbeddedTerminals(allowedWorkspaces),
  );
  handle("embeddedTerminal:attachStream", (event, id: string) => attachEmbeddedTerminalStream(id, event.sender));
  handle("embeddedTerminal:buffer", (_event, id: string): string => getEmbeddedTerminalBuffer(id));
  handle("performance:diagnostics", async () => ({
    ...await getPerformanceDiagnostics(),
    sessionIndex: getAgentSessionScanDiagnostics(),
  }));
  handle(
    "embeddedTerminal:spawn",
    async (_event, workspace: string, options?: EmbeddedTerminalSpawnOptions): Promise<EmbeddedTerminalSession> => {
      const admission = await guardAgentLaunchMemory(options);
      let launched = false;
      try {
        const session = await spawnEmbeddedTerminal(workspace, options);
        launched = session.status === "running";
        if (!launched) throw new Error(session.error ?? `Failed to launch ${session.title}.`);
        return session;
      } finally {
        if (launched) settleLaunchAdmission(admission, 1);
        else releaseLaunchAdmission(admission);
      }
    },
  );
  handle(
    "embeddedTerminal:spawnBatch",
    async (
      _event,
      workspace: string,
      optionList: EmbeddedTerminalSpawnOptions[],
    ): Promise<EmbeddedTerminalSession[]> => {
      if (!Array.isArray(optionList) || optionList.length < 1 || optionList.length > MAX_UI_TERMINAL_SPAWN_COUNT) {
        throw new Error(`Terminal batch must contain 1-${MAX_UI_TERMINAL_SPAWN_COUNT} entries.`);
      }
      const kind = optionList[0]?.kind ?? "shell";
      if (optionList.some((options) => (options.kind ?? "shell") !== kind)) {
        throw new Error("A terminal batch must use one agent kind so memory can be reserved atomically.");
      }
      const admission = await guardAgentLaunchMemory(optionList[0], optionList.length);
      const sessions: EmbeddedTerminalSession[] = [];
      let runningCount = 0;
      try {
        for (const [index, options] of optionList.entries()) {
          const staggerMs = launchStaggerDelayMs(kind, index);
          if (staggerMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, staggerMs));
          const session = await spawnEmbeddedTerminal(workspace, options);
          sessions.push(session);
          if (session.status !== "running") {
            throw new Error(session.error ?? `Failed to launch ${session.title}.`);
          }
          runningCount += 1;
        }
        return sessions;
      } finally {
        if (runningCount > 0) settleLaunchAdmission(admission, runningCount);
        else releaseLaunchAdmission(admission);
      }
    },
  );
  handle("embeddedTerminal:write", (_event, id: string, data: string): Promise<EmbeddedTerminalSession> => writeEmbeddedTerminal(id, data));
  handle("embeddedTerminal:rename", (_event, id: string, title: string): EmbeddedTerminalSession => renameEmbeddedTerminal(id, title));
  handle("embeddedTerminal:resize", (_event, id: string, cols: number, rows: number): Promise<EmbeddedTerminalSession> =>
    resizeEmbeddedTerminal(id, cols, rows),
  );
  handle("embeddedTerminal:kill", (_event, id: string): Promise<EmbeddedTerminalSession> => killEmbeddedTerminal(id));
  handle("agentSessions:list", (_event, workspace: string): Promise<AgentSession[]> =>
    listAgentSessionsCached(workspace, listEmbeddedTerminals()),
  );
  // Which agent CLIs the panes would find, resolved the way the panes resolve them, plus copies an older Athena left
  // in its private npm prefix.
  handle("agents:status", async (): Promise<{ agents: AgentCliStatus[]; privateCopies: PrivateAgentCopies | null }> => ({
    agents: await agentCliStatuses(),
    privateCopies: privateAgentCopies(),
  }));
  handle("agents:check", (_event, kind: unknown): Promise<AgentCliStatus> => {
    if (!isAgentCliKind(kind)) throw new Error(`Unknown agent: ${String(kind)}`);
    return agentCliStatus(kind);
  });
  // After an installer ran: pick up PATH entries it added, so the new CLI is found without restarting Athena.
  handle("agents:refreshPath", (): Promise<boolean> => refreshPathFromSystem());
  handle("dialog:selectWorkspace", async (): Promise<WorkspacePath | null> => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    const selected = result.canceled ? null : result.filePaths[0] ?? null;
    return selected ? toWorkspacePath(selected) : null;
  });
  handle("dialog:createWorkspaceFolder", async (): Promise<WorkspacePath | null> => {
    const result = await dialog.showSaveDialog({
      title: "Create workspace folder",
      buttonLabel: "Create",
      properties: ["createDirectory"],
    });
    const target = result.canceled ? null : result.filePath ?? null;
    if (!target) return null;
    fs.mkdirSync(target, { recursive: true });
    return toWorkspacePath(target);
  });
}

// IPC crash breadcrumbs. Every ipcMain.handle call used to rewrite a file
// synchronously -- including embeddedTerminal:write on every keystroke. The
// most recent calls now live in a fixed in-memory ring. Rare, risky channels
// (spawn, restore, window/shell/dialog, graphics and preference changes,
// backend/control restarts) still persist the ring synchronously *before*
// their handler runs, so a native crash of the main process inside one of them
// leaves its `start` record on disk. Hot channels (keystrokes, resize, lists,
// health/status polls) only schedule a debounced async write. The ring is also
// flushed synchronously when a renderer or child process dies and at quit.
type IpcBreadcrumb = {
  at: number;
  channel: string;
  phase: "start" | "ok" | "error";
  args: unknown[];
  error: string | null;
};

const IPC_BREADCRUMB_CAPACITY = 64;
const IPC_BREADCRUMB_FLUSH_DELAY_MS = 5_000;
// Terminal input is user keystrokes (possibly secrets); record only its size.
const IPC_REDACTED_STRING_CHANNELS = new Set(["embeddedTerminal:write"]);
// Per-keystroke, per-resize, list and polling channels. Everything else is
// written through synchronously before its handler runs.
const IPC_HOT_CHANNELS = new Set([
  "embeddedTerminal:write",
  "embeddedTerminal:resize",
  "embeddedTerminal:list",
  "embeddedTerminal:buffer",
  "agentSessions:list",
  "backend:getState",
  "backend:checkHealth",
  "control:getState",
  "control:checkHealth",
  "remoteAccess:getState",
  "launchState:get",
  "preferences:get",
  "graphics:getStatus",
  "performance:diagnostics",
  "workspace:getDefault",
  "workspace:toPath",
]);
const ipcBreadcrumbs: IpcBreadcrumb[] = [];
let ipcBreadcrumbNext = 0;
let ipcBreadcrumbTimer: NodeJS.Timeout | null = null;
let ipcBreadcrumbCrashFlushInstalled = false;
// Bumped by every synchronous flush; a background write that started earlier
// holds an older snapshot and must not replace the newer file.
let ipcBreadcrumbSyncFlushes = 0;

function recordIpcBreadcrumb(channel: string, args: unknown[]): IpcBreadcrumb {
  const breadcrumb: IpcBreadcrumb = {
    at: Date.now(),
    channel,
    phase: "start",
    args: summarizeIpcArgs(args, IPC_REDACTED_STRING_CHANNELS.has(channel)),
    error: null,
  };
  if (ipcBreadcrumbs.length < IPC_BREADCRUMB_CAPACITY) {
    ipcBreadcrumbs.push(breadcrumb);
  } else {
    ipcBreadcrumbs[ipcBreadcrumbNext] = breadcrumb;
  }
  ipcBreadcrumbNext = (ipcBreadcrumbNext + 1) % IPC_BREADCRUMB_CAPACITY;
  if (IPC_HOT_CHANNELS.has(channel)) scheduleIpcBreadcrumbFlush();
  else flushIpcBreadcrumbs(`before:${channel}`);
  return breadcrumb;
}

function scheduleIpcBreadcrumbFlush(): void {
  if (ipcBreadcrumbTimer) return;
  ipcBreadcrumbTimer = setTimeout(() => {
    ipcBreadcrumbTimer = null;
    const filePath = ipcBreadcrumbPath();
    const temporary = `${filePath}.${process.pid}.tmp`;
    const content = serializeIpcBreadcrumbs("periodic");
    const syncFlushesAtStart = ipcBreadcrumbSyncFlushes;
    void fs.promises.mkdir(path.dirname(filePath), { recursive: true })
      .then(() => fs.promises.writeFile(temporary, content, "utf8"))
      .then(() => {
        // Renamed on the main thread, ordered against synchronous flushes.
        if (ipcBreadcrumbSyncFlushes === syncFlushesAtStart) fs.renameSync(temporary, filePath);
        else fs.rmSync(temporary, { force: true });
      })
      .catch(() => {
        // Crash breadcrumbs are best-effort and must never affect IPC handling.
        try {
          fs.rmSync(temporary, { force: true });
        } catch {
          // Ignore.
        }
      });
  }, IPC_BREADCRUMB_FLUSH_DELAY_MS);
  ipcBreadcrumbTimer.unref?.();
}

/** Synchronously persist the IPC breadcrumb ring (crash, renderer loss, quit). */
export function flushIpcBreadcrumbs(reason: string): void {
  if (ipcBreadcrumbTimer) {
    clearTimeout(ipcBreadcrumbTimer);
    ipcBreadcrumbTimer = null;
  }
  if (ipcBreadcrumbs.length === 0) return;
  ipcBreadcrumbSyncFlushes += 1;
  try {
    const filePath = ipcBreadcrumbPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, serializeIpcBreadcrumbs(reason), "utf8");
  } catch {
    // Crash breadcrumbs are best-effort and must never affect IPC handling.
  }
}

function installIpcBreadcrumbCrashFlush(): void {
  if (ipcBreadcrumbCrashFlushInstalled) return;
  ipcBreadcrumbCrashFlushInstalled = true;
  app.on("render-process-gone", (_event, _webContents, details) => {
    flushIpcBreadcrumbs(`render-process-gone:${details.reason}`);
  });
  app.on("child-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    flushIpcBreadcrumbs(`child-process-gone:${details.type}:${details.reason}`);
  });
}

function ipcBreadcrumbPath(): string {
  return path.join(os.homedir(), ".context-workspace", "ipc-breadcrumb.json");
}

function serializeIpcBreadcrumbs(reason: string): string {
  const ordered = ipcBreadcrumbs.length < IPC_BREADCRUMB_CAPACITY
    ? ipcBreadcrumbs
    : [...ipcBreadcrumbs.slice(ipcBreadcrumbNext), ...ipcBreadcrumbs.slice(0, ipcBreadcrumbNext)];
  return JSON.stringify({
    pid: process.pid,
    flushedAt: new Date().toISOString(),
    reason,
    // Oldest first; the last entry is the most recent IPC call.
    calls: ordered.map((entry) => ({ ...entry, at: new Date(entry.at).toISOString() })),
  });
}

function summarizeIpcArgs(args: unknown[], redactStrings = false): unknown[] {
  return args.map((arg) => {
    if (typeof arg === "string") {
      return redactStrings
        ? { type: "string", length: arg.length }
        : { type: "string", length: arg.length, preview: arg.slice(0, 80) };
    }
    if (typeof arg === "number" || typeof arg === "boolean" || arg == null) return arg;
    if (Array.isArray(arg)) return { type: "array", length: arg.length };
    if (typeof arg === "object") return { type: "object", keys: Object.keys(arg).slice(0, 20) };
    return { type: typeof arg };
  });
}
