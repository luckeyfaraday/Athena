import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listAgentSessionsCached, type AgentSession } from "./agent-sessions.js";
import type { BackendState } from "./backend.js";
import { checkBackendHealth, getBackendState, restartBackend } from "./backend.js";
import { checkControlHealth, getControlState, restartControlServer, type ControlState } from "./control-server.js";
import type { CodexTerminalState } from "./codex-terminal.js";
import { normalizeExternalUrl } from "./external-links.js";
import { clearTerminalRestorePause, readAthenaLaunchState, type AthenaLaunchState } from "./launch-state.js";
import { getDefaultWorkspace, toWorkspacePath, type WorkspacePath } from "./platform.js";
import { getPreferences, removePreference, setPreference } from "./preferences.js";
import {
  getCodexTerminalState,
  getNativeTerminalSessions,
  openNativeCodexGrid,
  openNativeCodexTerminal,
  startCodexTerminal,
  stopCodexTerminal,
  writeCodexTerminal,
  type NativeTerminalResult,
  type NativeTerminalSession,
} from "./codex-terminal.js";
import {
  acknowledgeEmbeddedTerminalOutput,
  attachEmbeddedTerminalBuffer,
  clearSavedEmbeddedTerminalRestores,
  getEmbeddedTerminalBuffer,
  getPerformanceDiagnostics,
  initEmbeddedTerminals,
  killEmbeddedTerminal,
  listEmbeddedAgentMessages,
  listEmbeddedTerminals,
  renameEmbeddedTerminal,
  resizeEmbeddedTerminal,
  sendAgentMessage,
  restoreEmbeddedTerminals,
  spawnEmbeddedTerminal,
  writeEmbeddedTerminal,
  type EmbeddedTerminalKind,
  type EmbeddedTerminalSession,
  type EmbeddedTerminalSpawnOptions,
  type PerformanceDiagnostics,
  type SendAgentMessageRequest,
  type SendAgentMessageResult,
} from "./embedded-terminal.js";
import type { AgentMessage } from "./agent-messages.js";

export function registerIpcHandlers(appRoot: string): void {
  initEmbeddedTerminals(appRoot);
  ipcMain.on("embeddedTerminal:dataAck", (_event, id: string, sequence: number) => {
    if (typeof id === "string" && Number.isSafeInteger(sequence)) {
      acknowledgeEmbeddedTerminalOutput(id, sequence);
    }
  });
  const handle = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      recordIpcBreadcrumb(channel, "start", args);
      try {
        const result = await listener(event, ...args);
        recordIpcBreadcrumb(channel, "ok", args);
        return result;
      } catch (error) {
        recordIpcBreadcrumb(channel, "error", args, String(error));
        throw error;
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
  handle("shell:beep", (): void => {
    // Electron's native shell.beep() has crashed Linux AppImage main during
    // background workspace attention notifications. Visual attention remains
    // authoritative; native audio can be reintroduced via a renderer-owned
    // implementation if needed.
    if (process.platform !== "linux") shell.beep();
  });
  handle("backend:getState", (): BackendState => getBackendState());
  handle("backend:checkHealth", (): Promise<BackendState> => checkBackendHealth());
  handle("backend:restart", (): Promise<BackendState> => restartBackend(appRoot));
  handle("control:getState", (): ControlState => getControlState());
  handle("control:checkHealth", (): Promise<ControlState> => checkControlHealth());
  handle("control:restart", (): Promise<ControlState> => restartControlServer());
  handle("launchState:get", (): AthenaLaunchState | null => readAthenaLaunchState());
  handle("launchState:clearTerminalRestorePause", (): AthenaLaunchState => {
    clearSavedEmbeddedTerminalRestores();
    return clearTerminalRestorePause();
  });
  handle("workspace:getDefault", (): WorkspacePath => getDefaultWorkspace(appRoot));
  handle("workspace:toPath", (_event, workspace: string): WorkspacePath => toWorkspacePath(workspace));
  handle("preferences:get", (): Record<string, string> => getPreferences());
  handle("preferences:set", (_event, key: string, value: string): Record<string, string> => setPreference(key, value));
  handle("preferences:remove", (_event, key: string): Record<string, string> => removePreference(key));
  handle("codexTerminal:getState", (): CodexTerminalState => getCodexTerminalState());
  handle("codexTerminal:start", (event, workspace: string): Promise<CodexTerminalState> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      return Promise.resolve({
        running: false,
        workspace: null,
        pid: null,
        lastError: "Unable to find Electron window for Codex terminal.",
      });
    }
    return startCodexTerminal(workspace, window);
  });
  handle("codexTerminal:write", (_event, data: string): CodexTerminalState => writeCodexTerminal(data));
  handle("codexTerminal:stop", (): Promise<CodexTerminalState> => stopCodexTerminal());
  handle("codexTerminal:openNative", (_event, workspace: string): Promise<NativeTerminalResult> => openNativeCodexTerminal(workspace));
  handle("codexTerminal:openGrid", (_event, workspace: string, panes?: number): Promise<NativeTerminalResult> =>
    openNativeCodexGrid(workspace, panes),
  );
  handle("codexTerminal:nativeSessions", (): NativeTerminalSession[] => getNativeTerminalSessions());
  handle("embeddedTerminal:list", (): EmbeddedTerminalSession[] => listEmbeddedTerminals());
  handle("embeddedTerminal:restore", (_event, allowedWorkspaces?: string[]): Promise<EmbeddedTerminalSession[]> =>
    restoreEmbeddedTerminals(allowedWorkspaces),
  );
  handle("embeddedTerminal:attachBuffer", (_event, id: string): string => attachEmbeddedTerminalBuffer(id));
  handle("embeddedTerminal:buffer", (_event, id: string): string => getEmbeddedTerminalBuffer(id));
  handle("agentMessages:list", (_event, workspace?: string, limit?: number): AgentMessage[] => listEmbeddedAgentMessages(workspace, limit));
  handle("agentMessages:send", (_event, request: SendAgentMessageRequest): Promise<SendAgentMessageResult> => sendAgentMessage({ ...request, source: "ui" }));
  handle("performance:diagnostics", (): Promise<PerformanceDiagnostics> => getPerformanceDiagnostics());
  handle(
    "embeddedTerminal:spawn",
    (_event, workspace: string, options?: EmbeddedTerminalSpawnOptions): Promise<EmbeddedTerminalSession> =>
      spawnEmbeddedTerminal(workspace, options),
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

function recordIpcBreadcrumb(channel: string, phase: "start" | "ok" | "error", args: unknown[], error?: string): void {
  try {
    const directory = path.join(os.homedir(), ".context-workspace");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "ipc-breadcrumb.json"), JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      channel,
      phase,
      args: summarizeIpcArgs(args),
      error: error?.slice(0, 500) ?? null,
    }, null, 2), "utf8");
  } catch {
    // Crash breadcrumbs are best-effort and must never affect IPC handling.
  }
}

function summarizeIpcArgs(args: unknown[]): unknown[] {
  return args.map((arg) => {
    if (typeof arg === "string") return { type: "string", length: arg.length, preview: arg.slice(0, 80) };
    if (typeof arg === "number" || typeof arg === "boolean" || arg == null) return arg;
    if (Array.isArray(arg)) return { type: "array", length: arg.length };
    if (typeof arg === "object") return { type: "object", keys: Object.keys(arg).slice(0, 20) };
    return { type: typeof arg };
  });
}
