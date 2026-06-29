import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AgentSession } from "./agent-sessions.js";
import type { BackendState } from "./backend.js";
import type { ControlState } from "./control-server.js";
import type { CodexTerminalState, NativeTerminalResult, NativeTerminalSession } from "./codex-terminal.js";
import type { EmbeddedTerminalKind, EmbeddedTerminalSession, EmbeddedTerminalSpawnOptions } from "./embedded-terminal.js";
import type { AthenaLaunchState } from "./launch-state.js";
import type { WorkspacePath } from "./platform.js";

export type AgentMessage = {
  id: string;
  threadId: string;
  at: string;
  updatedAt: string;
  workspace: string;
  from: string;
  fromTerminalId: string | null;
  to: string;
  toTerminalId: string | null;
  toKind: string | null;
  text: string;
  preview: string;
  status: string;
  replyRequested: boolean;
  hopCount: number;
  source: string;
  error: string | null;
};

export type SendAgentMessageRequest = {
  to: string;
  text: string;
  workspace?: string | null;
  fromTerminalId?: string | null;
  threadId?: string | null;
  replyRequested?: boolean;
  hopCount?: number;
};

export type SendAgentMessageResult = {
  message: AgentMessage;
  terminal: EmbeddedTerminalSession | null;
  queued: boolean;
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
  agentProcesses: Array<{
    pid: number;
    ppid: number | null;
    agent: string;
    command: string;
    managedTerminalId: string | null;
    managedTerminalTitle: string | null;
    workspace: string | null;
  }>;
};

export type WorkspaceApi = {
  getBackendState: () => Promise<BackendState>;
  checkBackendHealth: () => Promise<BackendState>;
  restartBackend: () => Promise<BackendState>;
  getControlState: () => Promise<ControlState>;
  checkControlHealth: () => Promise<ControlState>;
  restartControl: () => Promise<ControlState>;
  getLaunchState: () => Promise<AthenaLaunchState | null>;
  clearTerminalRestorePause: () => Promise<AthenaLaunchState>;
  getPreferences: () => Promise<Record<string, string>>;
  setPreference: (key: string, value: string) => Promise<Record<string, string>>;
  removePreference: (key: string) => Promise<Record<string, string>>;
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
  attachEmbeddedTerminalBuffer: (id: string, maxChars?: number) => Promise<string>;
  getEmbeddedTerminalBuffer: (id: string) => Promise<string>;
  listAgentMessages: (workspace?: string, limit?: number) => Promise<AgentMessage[]>;
  sendAgentMessage: (request: SendAgentMessageRequest) => Promise<SendAgentMessageResult>;
  getPerformanceDiagnostics: () => Promise<PerformanceDiagnostics>;
  killEmbeddedTerminal: (id: string) => Promise<EmbeddedTerminalSession>;
  listAgentSessions: (workspace: string) => Promise<AgentSession[]>;
  getDroppedFilePaths: (files: File[]) => Promise<string[]>;
  openExternalUrl: (url: string) => Promise<boolean>;
  openPath: (path: string) => Promise<boolean>;
  playAttentionSound: () => Promise<void>;
  onEmbeddedTerminalData: (callback: (payload: { id: string; data: string }) => void) => () => void;
  onEmbeddedTerminalDataFor: (id: string, callback: (payload: { id: string; data: string }) => void) => () => void;
  onEmbeddedTerminalExit: (callback: (payload: { id: string; exitCode: number | null }) => void) => () => void;
  onEmbeddedTerminalSession: (callback: (session: EmbeddedTerminalSession) => void) => () => void;
  onCodexTerminalData: (callback: (data: string) => void) => () => void;
  onCodexTerminalState: (callback: (state: CodexTerminalState) => void) => () => void;
  selectWorkspace: () => Promise<WorkspacePath | null>;
  createWorkspaceFolder: () => Promise<WorkspacePath | null>;
  onWorkspaceOpen: (callback: (payload: { workspace: WorkspacePath; select: boolean }) => void) => () => void;
  onWorkspaceClose: (callback: (payload: { workspace: WorkspacePath }) => void) => () => void;
  minimizeWindow: () => Promise<void>;
  toggleMaximizeWindow: () => Promise<boolean>;
  closeWindow: () => Promise<void>;
};

function createIpcSubscription<T>(channel: string, afterDispatch?: (payload: T) => void) {
  const callbacks = new Set<(payload: T) => void>();
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => {
    for (const callback of callbacks) callback(payload);
    afterDispatch?.(payload);
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

type EmbeddedTerminalDataPayload = { id: string; data: string; sequence: number };

const embeddedTerminalDataCallbacks = new Set<(payload: EmbeddedTerminalDataPayload) => void>();
const embeddedTerminalDataCallbacksById = new Map<string, Set<(payload: EmbeddedTerminalDataPayload) => void>>();
let embeddedTerminalDataListenerInstalled = false;

const embeddedTerminalDataListener = (_event: Electron.IpcRendererEvent, payload: EmbeddedTerminalDataPayload) => {
  for (const callback of embeddedTerminalDataCallbacks) callback(payload);
  const idCallbacks = embeddedTerminalDataCallbacksById.get(payload.id);
  if (idCallbacks) {
    for (const callback of idCallbacks) callback(payload);
  }
  ipcRenderer.send("embeddedTerminal:dataAck", payload.id, payload.sequence);
};

function embeddedTerminalDataSubscriberCount(): number {
  let count = embeddedTerminalDataCallbacks.size;
  for (const callbacks of embeddedTerminalDataCallbacksById.values()) count += callbacks.size;
  return count;
}

function updateEmbeddedTerminalDataListener(): void {
  const hasSubscribers = embeddedTerminalDataSubscriberCount() > 0;
  if (hasSubscribers && !embeddedTerminalDataListenerInstalled) {
    ipcRenderer.on("embedded-terminal:data", embeddedTerminalDataListener);
    embeddedTerminalDataListenerInstalled = true;
  } else if (!hasSubscribers && embeddedTerminalDataListenerInstalled) {
    ipcRenderer.removeListener("embedded-terminal:data", embeddedTerminalDataListener);
    embeddedTerminalDataListenerInstalled = false;
  }
}

function onEmbeddedTerminalData(callback: (payload: EmbeddedTerminalDataPayload) => void) {
  embeddedTerminalDataCallbacks.add(callback);
  updateEmbeddedTerminalDataListener();
  return () => {
    embeddedTerminalDataCallbacks.delete(callback);
    updateEmbeddedTerminalDataListener();
  };
}

function onEmbeddedTerminalDataFor(id: string, callback: (payload: EmbeddedTerminalDataPayload) => void) {
  let callbacks = embeddedTerminalDataCallbacksById.get(id);
  if (!callbacks) {
    callbacks = new Set();
    embeddedTerminalDataCallbacksById.set(id, callbacks);
  }
  callbacks.add(callback);
  updateEmbeddedTerminalDataListener();
  return () => {
    const current = embeddedTerminalDataCallbacksById.get(id);
    if (current) {
      current.delete(callback);
      if (current.size === 0) embeddedTerminalDataCallbacksById.delete(id);
    }
    updateEmbeddedTerminalDataListener();
  };
}
const onEmbeddedTerminalExit = createIpcSubscription<{ id: string; exitCode: number | null }>("embedded-terminal:exit");
const onEmbeddedTerminalSession = createIpcSubscription<EmbeddedTerminalSession>("embedded-terminal:session");
const onCodexTerminalData = createIpcSubscription<string>("codex-terminal:data");
const onCodexTerminalState = createIpcSubscription<CodexTerminalState>("codex-terminal:state");
const onWorkspaceOpen = createIpcSubscription<{ workspace: WorkspacePath; select: boolean }>("workspace:open");
const onWorkspaceClose = createIpcSubscription<{ workspace: WorkspacePath }>("workspace:close");

const api: WorkspaceApi = {
  getBackendState: () => ipcRenderer.invoke("backend:getState"),
  checkBackendHealth: () => ipcRenderer.invoke("backend:checkHealth"),
  restartBackend: () => ipcRenderer.invoke("backend:restart"),
  getControlState: () => ipcRenderer.invoke("control:getState"),
  checkControlHealth: () => ipcRenderer.invoke("control:checkHealth"),
  restartControl: () => ipcRenderer.invoke("control:restart"),
  getLaunchState: () => ipcRenderer.invoke("launchState:get"),
  clearTerminalRestorePause: () => ipcRenderer.invoke("launchState:clearTerminalRestorePause"),
  getPreferences: () => ipcRenderer.invoke("preferences:get"),
  setPreference: (key, value) => ipcRenderer.invoke("preferences:set", key, value),
  removePreference: (key) => ipcRenderer.invoke("preferences:remove", key),
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
  attachEmbeddedTerminalBuffer: (id, maxChars) => ipcRenderer.invoke("embeddedTerminal:attachBuffer", id, maxChars),
  getEmbeddedTerminalBuffer: (id) => ipcRenderer.invoke("embeddedTerminal:buffer", id),
  listAgentMessages: (workspace, limit) => ipcRenderer.invoke("agentMessages:list", workspace, limit),
  sendAgentMessage: (request) => ipcRenderer.invoke("agentMessages:send", request),
  getPerformanceDiagnostics: () => ipcRenderer.invoke("performance:diagnostics"),
  killEmbeddedTerminal: (id) => ipcRenderer.invoke("embeddedTerminal:kill", id),
  listAgentSessions: (workspace) => ipcRenderer.invoke("agentSessions:list", workspace),
  getDroppedFilePaths: async (files) => files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
  openExternalUrl: (url) => ipcRenderer.invoke("shell:openExternal", url),
  openPath: (path) => ipcRenderer.invoke("shell:openPath", path),
  playAttentionSound: () => ipcRenderer.invoke("shell:beep"),
  onEmbeddedTerminalData,
  onEmbeddedTerminalDataFor,
  onEmbeddedTerminalExit,
  onEmbeddedTerminalSession,
  onCodexTerminalData,
  onCodexTerminalState,
  selectWorkspace: () => ipcRenderer.invoke("dialog:selectWorkspace"),
  createWorkspaceFolder: () => ipcRenderer.invoke("dialog:createWorkspaceFolder"),
  onWorkspaceOpen,
  onWorkspaceClose,
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:toggleMaximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
};

contextBridge.exposeInMainWorld("contextWorkspace", api);
