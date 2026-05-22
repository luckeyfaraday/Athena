import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AgentSession } from "./agent-sessions.js";
import type { BackendState } from "./backend.js";
import type { ControlState } from "./control-server.js";
import type { CodexTerminalState, NativeTerminalResult, NativeTerminalSession } from "./codex-terminal.js";
import type { EmbeddedTerminalKind, EmbeddedTerminalSession, EmbeddedTerminalSpawnOptions } from "./embedded-terminal.js";
import type { WorkspacePath } from "./platform.js";

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
  controlEvents: Array<{
    id: string;
    at: string;
    kind: string;
    source: string;
    terminalId: string | null;
    terminalTitle: string | null;
    terminalKind: string | null;
    detail: string | null;
    preview: string | null;
  }>;
  terminalControl: Array<{
    terminalId: string;
    title: string;
    kind: string;
    workspace: string;
    pid: number | null;
    status: string;
    lastSpawnAt: string | null;
    spawnSource: string | null;
    lastSpawnResult: string | null;
    lastInjectedAt: string | null;
    lastInjectedBy: string | null;
    lastInjectTextPreview: string | null;
    lastInjectResult: string | null;
    lastPtyWriteAt: string | null;
    lastOutputAt: string | null;
    attentionReason: string | null;
  }>;
};

export type WorkspaceApi = {
  getBackendState: () => Promise<BackendState>;
  checkBackendHealth: () => Promise<BackendState>;
  restartBackend: () => Promise<BackendState>;
  getControlState: () => Promise<ControlState>;
  checkControlHealth: () => Promise<ControlState>;
  restartControl: () => Promise<ControlState>;
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
  restoreEmbeddedTerminals: (allowedWorkspaces?: string[]) => Promise<EmbeddedTerminalSession[]>;
  spawnEmbeddedTerminal: (workspace: string, options?: EmbeddedTerminalSpawnOptions) => Promise<EmbeddedTerminalSession>;
  writeEmbeddedTerminal: (id: string, data: string) => Promise<EmbeddedTerminalSession>;
  renameEmbeddedTerminal: (id: string, title: string) => Promise<EmbeddedTerminalSession>;
  resizeEmbeddedTerminal: (id: string, cols: number, rows: number) => Promise<EmbeddedTerminalSession>;
  getEmbeddedTerminalBuffer: (id: string) => Promise<string>;
  getPerformanceDiagnostics: () => Promise<PerformanceDiagnostics>;
  killEmbeddedTerminal: (id: string) => Promise<EmbeddedTerminalSession>;
  listAgentSessions: (workspace: string) => Promise<AgentSession[]>;
  getDroppedFilePaths: (files: File[]) => Promise<string[]>;
  openExternalUrl: (url: string) => Promise<boolean>;
  onEmbeddedTerminalData: (callback: (payload: { id: string; data: string }) => void) => () => void;
  onEmbeddedTerminalExit: (callback: (payload: { id: string; exitCode: number | null }) => void) => () => void;
  onEmbeddedTerminalSession: (callback: (session: EmbeddedTerminalSession) => void) => () => void;
  onCodexTerminalData: (callback: (data: string) => void) => () => void;
  onCodexTerminalState: (callback: (state: CodexTerminalState) => void) => () => void;
  selectWorkspace: () => Promise<WorkspacePath | null>;
  minimizeWindow: () => Promise<void>;
  toggleMaximizeWindow: () => Promise<boolean>;
  closeWindow: () => Promise<void>;
};

function createIpcSubscription<T>(channel: string) {
  const callbacks = new Set<(payload: T) => void>();
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => {
    for (const callback of callbacks) callback(payload);
  };
  return (callback: (payload: T) => void) => {
    const wasEmpty = callbacks.size === 0;
    callbacks.add(callback);
    if (wasEmpty) ipcRenderer.on(channel, listener);
    return () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) ipcRenderer.removeListener(channel, listener);
    };
  };
}

const onEmbeddedTerminalData = createIpcSubscription<{ id: string; data: string }>("embedded-terminal:data");
const onEmbeddedTerminalExit = createIpcSubscription<{ id: string; exitCode: number | null }>("embedded-terminal:exit");
const onEmbeddedTerminalSession = createIpcSubscription<EmbeddedTerminalSession>("embedded-terminal:session");
const onCodexTerminalData = createIpcSubscription<string>("codex-terminal:data");
const onCodexTerminalState = createIpcSubscription<CodexTerminalState>("codex-terminal:state");

const api: WorkspaceApi = {
  getBackendState: () => ipcRenderer.invoke("backend:getState"),
  checkBackendHealth: () => ipcRenderer.invoke("backend:checkHealth"),
  restartBackend: () => ipcRenderer.invoke("backend:restart"),
  getControlState: () => ipcRenderer.invoke("control:getState"),
  checkControlHealth: () => ipcRenderer.invoke("control:checkHealth"),
  restartControl: () => ipcRenderer.invoke("control:restart"),
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
  restoreEmbeddedTerminals: (allowedWorkspaces) => ipcRenderer.invoke("embeddedTerminal:restore", allowedWorkspaces),
  spawnEmbeddedTerminal: (workspace, options) => ipcRenderer.invoke("embeddedTerminal:spawn", workspace, options),
  writeEmbeddedTerminal: (id, data) => ipcRenderer.invoke("embeddedTerminal:write", id, data),
  renameEmbeddedTerminal: (id, title) => ipcRenderer.invoke("embeddedTerminal:rename", id, title),
  resizeEmbeddedTerminal: (id, cols, rows) => ipcRenderer.invoke("embeddedTerminal:resize", id, cols, rows),
  getEmbeddedTerminalBuffer: (id) => ipcRenderer.invoke("embeddedTerminal:buffer", id),
  getPerformanceDiagnostics: () => ipcRenderer.invoke("performance:diagnostics"),
  killEmbeddedTerminal: (id) => ipcRenderer.invoke("embeddedTerminal:kill", id),
  listAgentSessions: (workspace) => ipcRenderer.invoke("agentSessions:list", workspace),
  getDroppedFilePaths: async (files) => files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
  openExternalUrl: (url) => ipcRenderer.invoke("shell:openExternal", url),
  onEmbeddedTerminalData,
  onEmbeddedTerminalExit,
  onEmbeddedTerminalSession,
  onCodexTerminalData,
  onCodexTerminalState,
  selectWorkspace: () => ipcRenderer.invoke("dialog:selectWorkspace"),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:toggleMaximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
};

contextBridge.exposeInMainWorld("contextWorkspace", api);
