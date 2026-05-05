import { contextBridge, ipcRenderer } from "electron";
import type { BackendState } from "./backend.js";

export type WorkspaceApi = {
  getBackendState: () => Promise<BackendState>;
  checkBackendHealth: () => Promise<BackendState>;
  restartBackend: () => Promise<BackendState>;
  selectWorkspace: () => Promise<string | null>;
};

const api: WorkspaceApi = {
  getBackendState: () => ipcRenderer.invoke("backend:getState"),
  checkBackendHealth: () => ipcRenderer.invoke("backend:checkHealth"),
  restartBackend: () => ipcRenderer.invoke("backend:restart"),
  selectWorkspace: () => ipcRenderer.invoke("dialog:selectWorkspace"),
};

contextBridge.exposeInMainWorld("contextWorkspace", api);
