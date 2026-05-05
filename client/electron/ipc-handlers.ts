import { dialog, ipcMain } from "electron";
import type { BackendState } from "./backend.js";
import { checkBackendHealth, getBackendState, restartBackend } from "./backend.js";

export function registerIpcHandlers(appRoot: string): void {
  ipcMain.handle("backend:getState", (): BackendState => getBackendState());
  ipcMain.handle("backend:checkHealth", (): Promise<BackendState> => checkBackendHealth());
  ipcMain.handle("backend:restart", (): Promise<BackendState> => restartBackend(appRoot));
  ipcMain.handle("dialog:selectWorkspace", async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
}
