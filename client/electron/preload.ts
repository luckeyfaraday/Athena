import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { BackendState } from "./backend.js";
import type { CodexTerminalState, NativeTerminalResult, NativeTerminalSession } from "./codex-terminal.js";
import type { EmbeddedTerminalKind, EmbeddedTerminalSession } from "./embedded-terminal.js";
import type { WorkspacePath } from "./platform.js";

export type WorkspaceApi = {
  getBackendState: () => Promise<BackendState>;
  checkBackendHealth: () => Promise<BackendState>;
  restartBackend: () => Promise<BackendState>;
  getDefaultWorkspace: () => Promise<WorkspacePath>;
  toWorkspacePath: (workspace: string) => Promise<WorkspacePath>;
  getCodexTerminalState: () => Promise<CodexTerminalState>;
  startCodexTerminal: (workspace: string) => Promise<CodexTerminalState>;
  writeCodexTerminal: (data: string) => Promise<CodexTerminalState>;
  stopCodexTerminal: () => Promise<CodexTerminalState>;
  openNativeCodexTerminal: (workspace: string) => Promise<NativeTerminalResult>;
  openNativeCodexGrid: (workspace: string, panes?: number) => Promise<NativeTerminalResult>;
  getNativeTerminalSessions: () => Promise<NativeTerminalSession[]>;
  listEmbeddedTerminals: () => Promise<EmbeddedTerminalSession[]>;
  spawnEmbeddedTerminal: (
    workspace: string,
    options?: { kind?: EmbeddedTerminalKind; title?: string; cols?: number; rows?: number },
  ) => Promise<EmbeddedTerminalSession>;
  writeEmbeddedTerminal: (id: string, data: string) => Promise<EmbeddedTerminalSession>;
  resizeEmbeddedTerminal: (id: string, cols: number, rows: number) => Promise<EmbeddedTerminalSession>;
  getEmbeddedTerminalBuffer: (id: string) => Promise<string>;
  killEmbeddedTerminal: (id: string) => Promise<EmbeddedTerminalSession>;
  getDroppedFilePaths: (files: File[]) => Promise<string[]>;
  onEmbeddedTerminalData: (callback: (payload: { id: string; data: string }) => void) => () => void;
  onEmbeddedTerminalExit: (callback: (payload: { id: string; exitCode: number | null }) => void) => () => void;
  onEmbeddedTerminalSession: (callback: (session: EmbeddedTerminalSession) => void) => () => void;
  onCodexTerminalData: (callback: (data: string) => void) => () => void;
  onCodexTerminalState: (callback: (state: CodexTerminalState) => void) => () => void;
  selectWorkspace: () => Promise<WorkspacePath | null>;
};

const api: WorkspaceApi = {
  getBackendState: () => ipcRenderer.invoke("backend:getState"),
  checkBackendHealth: () => ipcRenderer.invoke("backend:checkHealth"),
  restartBackend: () => ipcRenderer.invoke("backend:restart"),
  getDefaultWorkspace: () => ipcRenderer.invoke("workspace:getDefault"),
  toWorkspacePath: (workspace: string) => ipcRenderer.invoke("workspace:toPath", workspace),
  getCodexTerminalState: () => ipcRenderer.invoke("codexTerminal:getState"),
  startCodexTerminal: (workspace: string) => ipcRenderer.invoke("codexTerminal:start", workspace),
  writeCodexTerminal: (data: string) => ipcRenderer.invoke("codexTerminal:write", data),
  stopCodexTerminal: () => ipcRenderer.invoke("codexTerminal:stop"),
  openNativeCodexTerminal: (workspace: string) => ipcRenderer.invoke("codexTerminal:openNative", workspace),
  openNativeCodexGrid: (workspace: string, panes?: number) => ipcRenderer.invoke("codexTerminal:openGrid", workspace, panes),
  getNativeTerminalSessions: () => ipcRenderer.invoke("codexTerminal:nativeSessions"),
  listEmbeddedTerminals: () => ipcRenderer.invoke("embeddedTerminal:list"),
  spawnEmbeddedTerminal: (workspace, options) => ipcRenderer.invoke("embeddedTerminal:spawn", workspace, options),
  writeEmbeddedTerminal: (id, data) => ipcRenderer.invoke("embeddedTerminal:write", id, data),
  resizeEmbeddedTerminal: (id, cols, rows) => ipcRenderer.invoke("embeddedTerminal:resize", id, cols, rows),
  getEmbeddedTerminalBuffer: (id) => ipcRenderer.invoke("embeddedTerminal:buffer", id),
  killEmbeddedTerminal: (id) => ipcRenderer.invoke("embeddedTerminal:kill", id),
  getDroppedFilePaths: async (files) => files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
  onEmbeddedTerminalData: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { id: string; data: string }) => callback(payload);
    ipcRenderer.on("embedded-terminal:data", listener);
    return () => ipcRenderer.removeListener("embedded-terminal:data", listener);
  },
  onEmbeddedTerminalExit: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { id: string; exitCode: number | null }) => callback(payload);
    ipcRenderer.on("embedded-terminal:exit", listener);
    return () => ipcRenderer.removeListener("embedded-terminal:exit", listener);
  },
  onEmbeddedTerminalSession: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, session: EmbeddedTerminalSession) => callback(session);
    ipcRenderer.on("embedded-terminal:session", listener);
    return () => ipcRenderer.removeListener("embedded-terminal:session", listener);
  },
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
