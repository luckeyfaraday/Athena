import { BrowserWindow, dialog, ipcMain } from "electron";
import type { BackendState } from "./backend.js";
import { checkBackendHealth, getBackendState, restartBackend } from "./backend.js";
import type { CodexTerminalState } from "./codex-terminal.js";
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

export function registerIpcHandlers(appRoot: string): void {
  ipcMain.handle("backend:getState", (): BackendState => getBackendState());
  ipcMain.handle("backend:checkHealth", (): Promise<BackendState> => checkBackendHealth());
  ipcMain.handle("backend:restart", (): Promise<BackendState> => restartBackend(appRoot));
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
  ipcMain.handle("dialog:selectWorkspace", async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
}
