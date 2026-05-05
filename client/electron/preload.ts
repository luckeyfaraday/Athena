import { contextBridge, ipcRenderer } from "electron";
import type { BackendState } from "./backend.js";
import type { CodexTerminalState, NativeTerminalResult, NativeTerminalSession } from "./codex-terminal.js";

export type WorkspaceApi = {
  getBackendState: () => Promise<BackendState>;
  checkBackendHealth: () => Promise<BackendState>;
  restartBackend: () => Promise<BackendState>;
  getCodexTerminalState: () => Promise<CodexTerminalState>;
  startCodexTerminal: (workspace: string) => Promise<CodexTerminalState>;
  writeCodexTerminal: (data: string) => Promise<CodexTerminalState>;
  stopCodexTerminal: () => Promise<CodexTerminalState>;
  openNativeCodexTerminal: (workspace: string) => Promise<NativeTerminalResult>;
  openNativeCodexGrid: (workspace: string, panes?: number) => Promise<NativeTerminalResult>;
  getNativeTerminalSessions: () => Promise<NativeTerminalSession[]>;
  onCodexTerminalData: (callback: (data: string) => void) => () => void;
  onCodexTerminalState: (callback: (state: CodexTerminalState) => void) => () => void;
  selectWorkspace: () => Promise<string | null>;
};

const api: WorkspaceApi = {
  getBackendState: () => ipcRenderer.invoke("backend:getState"),
  checkBackendHealth: () => ipcRenderer.invoke("backend:checkHealth"),
  restartBackend: () => ipcRenderer.invoke("backend:restart"),
  getCodexTerminalState: () => ipcRenderer.invoke("codexTerminal:getState"),
  startCodexTerminal: (workspace: string) => ipcRenderer.invoke("codexTerminal:start", workspace),
  writeCodexTerminal: (data: string) => ipcRenderer.invoke("codexTerminal:write", data),
  stopCodexTerminal: () => ipcRenderer.invoke("codexTerminal:stop"),
  openNativeCodexTerminal: (workspace: string) => ipcRenderer.invoke("codexTerminal:openNative", workspace),
  openNativeCodexGrid: (workspace: string, panes?: number) => ipcRenderer.invoke("codexTerminal:openGrid", workspace, panes),
  getNativeTerminalSessions: () => ipcRenderer.invoke("codexTerminal:nativeSessions"),
  onCodexTerminalData: (callback: (data: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: string) => callback(data);
    ipcRenderer.on("codex-terminal:data", listener);
    return () => ipcRenderer.removeListener("codex-terminal:data", listener);
  },
  onCodexTerminalState: (callback: (state: CodexTerminalState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: CodexTerminalState) => callback(state);
    ipcRenderer.on("codex-terminal:state", listener);
    return () => ipcRenderer.removeListener("codex-terminal:state", listener);
  },
  selectWorkspace: () => ipcRenderer.invoke("dialog:selectWorkspace"),
};

contextBridge.exposeInMainWorld("contextWorkspace", api);
