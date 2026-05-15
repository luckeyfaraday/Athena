import { BrowserWindow, dialog, ipcMain } from "electron";
import { listAgentSessionsCached, type AgentSession } from "./agent-sessions.js";
import type { BackendState } from "./backend.js";
import { checkBackendHealth, getBackendState, restartBackend } from "./backend.js";
import type { CodexTerminalState } from "./codex-terminal.js";
import { getDefaultWorkspace, toWorkspacePath, type WorkspacePath } from "./platform.js";
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
  getEmbeddedTerminalBuffer,
  killEmbeddedTerminal,
  listEmbeddedTerminals,
  resizeEmbeddedTerminal,
  spawnEmbeddedTerminal,
  writeEmbeddedTerminal,
  type EmbeddedTerminalKind,
  type EmbeddedTerminalSession,
  type EmbeddedTerminalSpawnOptions,
} from "./embedded-terminal.js";

export function registerIpcHandlers(appRoot: string): void {
  ipcMain.handle("window:minimize", (event): void => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle("window:toggleMaximize", (event): boolean => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return window.isMaximized();
  });
  ipcMain.handle("window:close", (event): void => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle("backend:getState", (): BackendState => getBackendState());
  ipcMain.handle("backend:checkHealth", (): Promise<BackendState> => checkBackendHealth());
  ipcMain.handle("backend:restart", (): Promise<BackendState> => restartBackend(appRoot));
  ipcMain.handle("workspace:getDefault", (): WorkspacePath => getDefaultWorkspace(appRoot));
  ipcMain.handle("workspace:toPath", (_event, workspace: string): WorkspacePath => toWorkspacePath(workspace));
  ipcMain.handle("codexTerminal:getState", (): CodexTerminalState => getCodexTerminalState());
  ipcMain.handle("codexTerminal:start", (event, workspace: string): Promise<CodexTerminalState> => {
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
  ipcMain.handle("codexTerminal:write", (_event, data: string): CodexTerminalState => writeCodexTerminal(data));
  ipcMain.handle("codexTerminal:stop", (): Promise<CodexTerminalState> => stopCodexTerminal());
  ipcMain.handle("codexTerminal:openNative", (_event, workspace: string): Promise<NativeTerminalResult> => openNativeCodexTerminal(workspace));
  ipcMain.handle("codexTerminal:openGrid", (_event, workspace: string, panes?: number): Promise<NativeTerminalResult> =>
    openNativeCodexGrid(workspace, panes),
  );
  ipcMain.handle("codexTerminal:nativeSessions", (): NativeTerminalSession[] => getNativeTerminalSessions());
  ipcMain.handle("embeddedTerminal:list", (): EmbeddedTerminalSession[] => listEmbeddedTerminals());
  ipcMain.handle("embeddedTerminal:buffer", (_event, id: string): string => getEmbeddedTerminalBuffer(id));
  ipcMain.handle(
    "embeddedTerminal:spawn",
    (_event, workspace: string, options?: EmbeddedTerminalSpawnOptions): Promise<EmbeddedTerminalSession> =>
      spawnEmbeddedTerminal(workspace, options),
  );
  ipcMain.handle("embeddedTerminal:write", (_event, id: string, data: string): EmbeddedTerminalSession => writeEmbeddedTerminal(id, data));
  ipcMain.handle("embeddedTerminal:resize", (_event, id: string, cols: number, rows: number): EmbeddedTerminalSession =>
    resizeEmbeddedTerminal(id, cols, rows),
  );
  ipcMain.handle("embeddedTerminal:kill", (_event, id: string): EmbeddedTerminalSession => killEmbeddedTerminal(id));
  ipcMain.handle("agentSessions:list", (_event, workspace: string): Promise<AgentSession[]> =>
    listAgentSessionsCached(workspace, listEmbeddedTerminals()),
  );
  ipcMain.handle("dialog:selectWorkspace", async (): Promise<WorkspacePath | null> => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    const selected = result.canceled ? null : result.filePaths[0] ?? null;
    return selected ? toWorkspacePath(selected) : null;
  });
}
