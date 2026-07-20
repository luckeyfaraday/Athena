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
  rendererTerminalSubscribers: number;
  hiddenRawIpcBytes: number;
  terminalOutputRetries: number;
  terminalOutputResets: number;
  terminalOutputDroppedChars: number;
  terminalOutputDeliveredChars: number;
  terminalOutputAcknowledgedChars: number;
  terminalReplayCount: number;
  terminalReplayBytes: number;
  terminalReplayDurationMs: number;
  terminalReplayMaxDurationMs: number;
  sessionIndex: {
    filesSeen: number;
    filesStatted: number;
    filesParsed: number;
    bytesParsed: number;
    cacheHits: number;
    durationMs: number;
    lastError: string | null;
  } | null;
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

export type EmbeddedTerminalStreamSnapshot = {
  id: string;
  epoch: string;
  buffer: string;
  throughSequence: number;
};

export type EmbeddedTerminalDataPayload = {
  id: string;
  epoch: string;
  fromSequence: number;
  sequence: number;
  data: string;
  reset: boolean;
};

export type EmbeddedTerminalExitPayload = {
  id: string;
  exitCode: number | null;
  epoch?: string;
  throughSequence?: number;
};

export type EmbeddedTerminalDataSubscriptionOptions = {
  ackMode?: "after-dispatch" | "manual";
};

export type GraphicsPreference = "auto" | "safe" | "accelerated";
export type GraphicsRuntimeStatus = {
  mode: "safe" | "accelerated";
  reason: string;
  quarantined: boolean;
  preference: GraphicsPreference;
  recommendedMode: "safe" | "accelerated";
  restartRequired: boolean;
  lastGpuCrashAt: string | null;
  lastGpuCrashReason: string | null;
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
  getGraphicsStatus: () => Promise<GraphicsRuntimeStatus>;
  setGraphicsPreference: (value: GraphicsPreference) => Promise<GraphicsRuntimeStatus>;
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
  spawnEmbeddedTerminals: (workspace: string, options: EmbeddedTerminalSpawnOptions[]) => Promise<EmbeddedTerminalSession[]>;
  writeEmbeddedTerminal: (id: string, data: string) => Promise<EmbeddedTerminalSession>;
  renameEmbeddedTerminal: (id: string, title: string) => Promise<EmbeddedTerminalSession>;
  resizeEmbeddedTerminal: (id: string, cols: number, rows: number) => Promise<EmbeddedTerminalSession>;
  attachEmbeddedTerminalBuffer: (id: string) => Promise<string>;
  attachEmbeddedTerminalStream: (id: string) => Promise<EmbeddedTerminalStreamSnapshot>;
  ackEmbeddedTerminalData: (id: string, epoch: string, sequence: number) => void;
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
  onEmbeddedTerminalData: (callback: (payload: EmbeddedTerminalDataPayload) => void) => () => void;
  onEmbeddedTerminalDataFor: (
    id: string,
    callback: (payload: EmbeddedTerminalDataPayload) => void,
    options?: EmbeddedTerminalDataSubscriptionOptions,
  ) => () => void;
  onEmbeddedTerminalAttention: (callback: (payload: { id: string; kind: "action" | "update" }) => void) => () => void;
  onEmbeddedTerminalExit: (callback: (payload: EmbeddedTerminalExitPayload) => void) => () => void;
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

const embeddedTerminalDataCallbacks = new Set<(payload: EmbeddedTerminalDataPayload) => void>();
const embeddedTerminalDataCallbacksById = new Map<string, Set<(payload: EmbeddedTerminalDataPayload) => void>>();
const manualAckCallbacksById = new Map<string, Set<(payload: EmbeddedTerminalDataPayload) => void>>();
const acknowledgedTerminalSequences = new Map<string, { epoch: string; sequence: number }>();
let embeddedTerminalDataListenerInstalled = false;

const embeddedTerminalDataListener = (_event: Electron.IpcRendererEvent, payload: EmbeddedTerminalDataPayload) => {
  const acknowledged = acknowledgedTerminalSequences.get(payload.id);
  if (acknowledged?.epoch === payload.epoch && payload.sequence <= acknowledged.sequence) {
    ipcRenderer.send("embeddedTerminal:dataAck", payload.id, payload.epoch, payload.sequence);
    return;
  }
  for (const callback of embeddedTerminalDataCallbacks) callback(payload);
  const idCallbacks = embeddedTerminalDataCallbacksById.get(payload.id);
  if (idCallbacks) {
    for (const callback of idCallbacks) callback(payload);
  }
  if ((manualAckCallbacksById.get(payload.id)?.size ?? 0) === 0) {
    acknowledgeEmbeddedTerminalData(payload.id, payload.epoch, payload.sequence);
  }
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
  const wasEmpty = embeddedTerminalDataCallbacks.size === 0;
  embeddedTerminalDataCallbacks.add(callback);
  updateEmbeddedTerminalDataListener();
  if (wasEmpty) ipcRenderer.send("embeddedTerminal:subscribeAll");
  return () => {
    embeddedTerminalDataCallbacks.delete(callback);
    if (embeddedTerminalDataCallbacks.size === 0) ipcRenderer.send("embeddedTerminal:unsubscribeAll");
    updateEmbeddedTerminalDataListener();
  };
}

function onEmbeddedTerminalDataFor(
  id: string,
  callback: (payload: EmbeddedTerminalDataPayload) => void,
  options: EmbeddedTerminalDataSubscriptionOptions = {},
) {
  let callbacks = embeddedTerminalDataCallbacksById.get(id);
  const wasEmpty = !callbacks || callbacks.size === 0;
  if (!callbacks) {
    callbacks = new Set();
    embeddedTerminalDataCallbacksById.set(id, callbacks);
  }
  callbacks.add(callback);
  if (options.ackMode === "manual") {
    let manualCallbacks = manualAckCallbacksById.get(id);
    if (!manualCallbacks) {
      manualCallbacks = new Set();
      manualAckCallbacksById.set(id, manualCallbacks);
    }
    manualCallbacks.add(callback);
  }
  updateEmbeddedTerminalDataListener();
  if (wasEmpty) ipcRenderer.send("embeddedTerminal:subscribe", id);
  return () => {
    const current = embeddedTerminalDataCallbacksById.get(id);
    if (current) {
      current.delete(callback);
      if (current.size === 0) {
        embeddedTerminalDataCallbacksById.delete(id);
        acknowledgedTerminalSequences.delete(id);
        ipcRenderer.send("embeddedTerminal:unsubscribe", id);
      }
    }
    const manualCallbacks = manualAckCallbacksById.get(id);
    if (manualCallbacks) {
      manualCallbacks.delete(callback);
      if (manualCallbacks.size === 0) manualAckCallbacksById.delete(id);
    }
    updateEmbeddedTerminalDataListener();
  };
}

function acknowledgeEmbeddedTerminalData(id: string, epoch: string, sequence: number): void {
  const current = acknowledgedTerminalSequences.get(id);
  if (!current || current.epoch !== epoch || sequence > current.sequence) {
    acknowledgedTerminalSequences.set(id, { epoch, sequence });
  }
  ipcRenderer.send("embeddedTerminal:dataAck", id, epoch, sequence);
}
const onEmbeddedTerminalExit = createIpcSubscription<EmbeddedTerminalExitPayload>("embedded-terminal:exit");
const onEmbeddedTerminalSession = createIpcSubscription<EmbeddedTerminalSession>("embedded-terminal:session");
const onEmbeddedTerminalAttention = createIpcSubscription<{ id: string; kind: "action" | "update" }>("embedded-terminal:attention");
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
  getGraphicsStatus: () => ipcRenderer.invoke("graphics:getStatus"),
  setGraphicsPreference: (value) => ipcRenderer.invoke("graphics:setPreference", value),
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
  spawnEmbeddedTerminals: (workspace, options) => ipcRenderer.invoke("embeddedTerminal:spawnBatch", workspace, options),
  writeEmbeddedTerminal: (id, data) => ipcRenderer.invoke("embeddedTerminal:write", id, data),
  renameEmbeddedTerminal: (id, title) => ipcRenderer.invoke("embeddedTerminal:rename", id, title),
  resizeEmbeddedTerminal: (id, cols, rows) => ipcRenderer.invoke("embeddedTerminal:resize", id, cols, rows),
  attachEmbeddedTerminalBuffer: (id) => ipcRenderer.invoke("embeddedTerminal:attachBuffer", id),
  attachEmbeddedTerminalStream: (id) => ipcRenderer.invoke("embeddedTerminal:attachStream", id),
  ackEmbeddedTerminalData: acknowledgeEmbeddedTerminalData,
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
  onEmbeddedTerminalAttention,
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
