import type { BackendStatus, ElectronControlStatus } from "./api";
import type { TerminalAttentionEvent } from "./workspace-attention";

export type EmbeddedTerminalKind = "shell" | "hermes" | "codex" | "opencode" | "claude" | "athena" | "grok";
export type AgentSessionProvider = "codex" | "opencode" | "athena" | "claude" | "hermes" | "grok";
export type WorkspacePath = {
  nativePath: string;
  wslPath: string | null;
  displayPath: string;
};

export type EmbeddedTerminalSession = {
  id: string;
  title: string;
  kind: EmbeddedTerminalKind;
  workspace: string;
  pid: number | null;
  promptPath: string | null;
  initialTask: string | null;
  sessionLabel: string | null;
  providerSessionId: string | null;
  createdAt: string;
  status: "running" | "exited" | "failed";
  exitCode: number | null;
  error: string | null;
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

export type AttentionNotificationRequest = {
  title: string;
  body: string;
  workspace: string;
  sessionId: string;
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

export type AgentCliKind = Exclude<EmbeddedTerminalKind, "shell">;
export type AgentSetupAction = "install" | "update" | "cleanup";

export type EmbeddedTerminalSpawnOptions = {
  kind?: EmbeddedTerminalKind;
  title?: string;
  task?: string;
  cols?: number;
  rows?: number;
  resumeSessionId?: string;
  sessionLabel?: string;
  providerSessionId?: string;
  // a pane that installs, updates or cleans up an agent CLI (the command comes from the main process)
  setup?: { agent: AgentCliKind; action: AgentSetupAction };
};

// One coding-agent CLI as the terminals would find it (electron/agent-cli.ts).
export type AgentCliStatus = {
  kind: AgentCliKind;
  label: string;
  executable: string;
  installed: boolean;
  path: string | null;
  installCommand: string;
  updateCommand: string;
  docsUrl: string;
  needsNpm: boolean;
  npmAvailable: boolean;
};

// Agent packages an older Athena installed into its private npm prefix, which it no longer uses.
export type PrivateAgentCopies = {
  prefix: string;
  kinds: AgentCliKind[];
  packages: string[];
  labels: string[];
  command: string;
};

export type AgentCliReport = { agents: AgentCliStatus[]; privateCopies: PrivateAgentCopies | null };

export type AgentSession = {
  id: string;
  provider: AgentSessionProvider;
  title: string;
  workspace: string;
  branch: string | null;
  model: string | null;
  agent: string | null;
  createdAt: string;
  updatedAt: string;
  status: "running" | "exited" | "historical";
  terminalId: string | null;
  pid: number | null;
  resumeCommand: string | null;
  metadata: Record<string, string>;
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
  terminalOutputRetries: number;
  terminalOutputResets: number;
  terminalOutputFlowPauses: number;
  terminalOutputFlowForcedResumes: number;
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
  controlEvents: ControlEvent[];
  terminalControl: TerminalControlState[];
  agentProcesses: AgentProcessDiagnostic[];
};

export type AgentProcessDiagnostic = {
  pid: number;
  ppid: number | null;
  agent: EmbeddedTerminalKind;
  command: string;
  managedTerminalId: string | null;
  managedTerminalTitle: string | null;
  workspace: string | null;
};

export type ControlEvent = {
  id: string;
  at: string;
  kind: string;
  source: string;
  terminalId: string | null;
  terminalTitle: string | null;
  terminalKind: string | null;
  detail: string | null;
  preview: string | null;
};

export type TerminalControlState = {
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
};

// Mirrors RemoteAccessState in electron/remote-control.ts.
export type RemoteAccessState = {
  enabled: boolean;
  port: number;
  urls: string[];
  dnsUrl: string | null;
  trustOwnDevices: boolean;
  tailscale: {
    detected: boolean;
    backendState: string | null;
    dnsName: string | null;
    hostName: string | null;
    account: string | null;
  };
  hasToken: boolean;
  errors: string[];
  lastRequest: {
    at: string;
    peer: string;
    device: string | null;
    via: "account" | "token";
    method: string;
    path: string;
  } | null;
  lastRejected: { at: string; peer: string; device: string | null; status: number; reason: string } | null;
};

// Mirrors RemoteMachine / RemoteMachinesState in electron/remote-machines.ts.
export type RemoteMachineStatus = "offline" | "no-athena" | "ready" | "needs-token" | "refused" | "unknown";

export type RemoteMachine = {
  id: string;
  name: string;
  dnsName: string | null;
  os: string | null;
  online: boolean;
  address: string | null;
  url: string | null;
  owner: string | null;
  ownDevice: boolean;
  status: RemoteMachineStatus;
  detail: string | null;
  version: string | null;
  platform: string | null;
  homedir: string | null;
  checkedAt: string | null;
};

export type RemoteMachinesState = {
  tailscale: "running" | "stopped" | "unavailable";
  account: string | null;
  port: number;
  machines: RemoteMachine[];
  refreshedAt: string | null;
};

// Mirrors RemoteMachineView / RemoteSnapshot / RemoteAttention in electron/remote-client.ts.
export type RemoteConnectionStatus = "idle" | "connecting" | "connected" | "error";

export type RemoteMachineView = RemoteMachine & {
  connection: RemoteConnectionStatus;
  connectionError: string | null;
  hasToken: boolean;
  sessions: EmbeddedTerminalSession[];
  workspaces: WorkspacePath[];
  activeWorkspace: WorkspacePath | null;
};

export type RemoteSnapshot = {
  tailscale: RemoteMachinesState["tailscale"];
  account: string | null;
  selfName: string | null;
  machines: RemoteMachineView[];
  refreshedAt: string | null;
};

export type RemoteAttention = {
  machineId: string;
  machineName: string;
  event: TerminalAttentionEvent;
  session: EmbeddedTerminalSession | null;
};

export type RemoteSpawnRequest = { workspace: string; kind: EmbeddedTerminalKind; count?: number; title?: string };

export type DirectoryListing = {
  path: string;
  parent: string | null;
  home: string;
  dirs: Array<{ name: string; path: string }>;
  truncated: boolean;
};

export type AthenaLaunchState = {
  pid: number;
  startedAt: string;
  cleanExit: boolean;
  terminalRestorePaused: boolean;
  previousCrashAt: string | null;
};

type WorkspaceApi = {
  getBackendState: () => Promise<BackendStatus>;
  checkBackendHealth: () => Promise<BackendStatus>;
  restartBackend: () => Promise<BackendStatus>;
  getControlState: () => Promise<ElectronControlStatus>;
  checkControlHealth: () => Promise<ElectronControlStatus>;
  restartControl: () => Promise<ElectronControlStatus>;
  getRemoteAccessState: () => Promise<RemoteAccessState>;
  refreshRemoteAccess: () => Promise<RemoteAccessState>;
  setRemoteAccessEnabled: (enabled: boolean) => Promise<RemoteAccessState>;
  setRemoteAccessPort: (port: number) => Promise<RemoteAccessState>;
  setRemoteAccessTrustOwnDevices: (trust: boolean) => Promise<RemoteAccessState>;
  regenerateRemoteAccessToken: () => Promise<RemoteAccessState>;
  getRemoteAccessToken: () => Promise<string>;
  getRemoteMachines: () => Promise<RemoteMachinesState>;
  reportWorkspaces: (paths: string[], active: string | null) => void;
  getRemoteSnapshot: () => Promise<RemoteSnapshot>;
  refreshRemote: () => Promise<RemoteSnapshot>;
  spawnRemoteTerminals: (machineId: string, request: RemoteSpawnRequest) => Promise<EmbeddedTerminalSession[]>;
  listRemoteDirectories: (machineId: string, directory?: string | null) => Promise<DirectoryListing>;
  openRemoteWorkspace: (machineId: string, workspace: string) => Promise<WorkspacePath>;
  closeRemoteWorkspace: (machineId: string, workspace: string) => Promise<void>;
  setRemoteMachineToken: (machineId: string, token: string | null) => Promise<RemoteSnapshot>;
  onRemoteUpdate: (callback: (snapshot: RemoteSnapshot) => void) => () => void;
  onRemoteAttention: (callback: (attention: RemoteAttention) => void) => () => void;
  refreshRemoteMachines: () => Promise<RemoteMachinesState>;
  getLaunchState: () => Promise<AthenaLaunchState | null>;
  clearTerminalRestorePause: () => Promise<AthenaLaunchState>;
  getPreferences: () => Promise<Record<string, string>>;
  setPreference: (key: string, value: string) => Promise<Record<string, string>>;
  removePreference: (key: string) => Promise<Record<string, string>>;
  getGraphicsStatus: () => Promise<GraphicsRuntimeStatus>;
  setGraphicsPreference: (value: GraphicsPreference) => Promise<GraphicsRuntimeStatus>;
  getDefaultWorkspace: () => Promise<WorkspacePath>;
  toWorkspacePath: (workspace: string) => Promise<WorkspacePath>;
  listEmbeddedTerminals: () => Promise<EmbeddedTerminalSession[]>;
  restoreEmbeddedTerminals: (allowedWorkspaces?: string[]) => Promise<EmbeddedTerminalSession[]>;
  spawnEmbeddedTerminal: (workspace: string, options?: EmbeddedTerminalSpawnOptions) => Promise<EmbeddedTerminalSession>;
  spawnEmbeddedTerminals: (workspace: string, options: EmbeddedTerminalSpawnOptions[]) => Promise<EmbeddedTerminalSession[]>;
  writeEmbeddedTerminal: (id: string, data: string) => Promise<EmbeddedTerminalSession>;
  renameEmbeddedTerminal: (id: string, title: string) => Promise<EmbeddedTerminalSession>;
  resizeEmbeddedTerminal: (id: string, cols: number, rows: number) => Promise<EmbeddedTerminalSession>;
  attachEmbeddedTerminalStream: (id: string) => Promise<EmbeddedTerminalStreamSnapshot>;
  ackEmbeddedTerminalData: (id: string, epoch: string, sequence: number) => void;
  getEmbeddedTerminalBuffer: (id: string) => Promise<string>;
  getPerformanceDiagnostics: () => Promise<PerformanceDiagnostics>;
  killEmbeddedTerminal: (id: string) => Promise<EmbeddedTerminalSession>;
  listAgentSessions: (workspace: string) => Promise<AgentSession[]>;
  getAgentClis: () => Promise<AgentCliReport>;
  checkAgentCli: (kind: AgentCliKind) => Promise<AgentCliStatus>;
  refreshAgentPath: () => Promise<boolean>;
  getDroppedFilePaths: (files: File[]) => Promise<string[]>;
  openExternalUrl: (url: string) => Promise<boolean>;
  openPath: (path: string) => Promise<boolean>;
  // Native notification; clicking it raises the window and fires onAttentionActivate.
  showAttentionNotification: (request: AttentionNotificationRequest) => Promise<boolean>;
  flashWindowForAttention: () => Promise<void>;
  onAttentionActivate: (callback: (payload: { workspace: string; sessionId: string }) => void) => () => void;
  onWorkspaceOpen: (callback: (payload: { workspace: WorkspacePath; select: boolean }) => void) => () => void;
  onWorkspaceClose: (callback: (payload: { workspace: WorkspacePath }) => void) => () => void;
  onEmbeddedTerminalDataFor: (
    id: string,
    callback: (payload: EmbeddedTerminalDataPayload) => void,
    options?: EmbeddedTerminalDataSubscriptionOptions,
  ) => () => void;
  onEmbeddedTerminalAttention: (callback: (payload: TerminalAttentionEvent) => void) => () => void;
  onEmbeddedTerminalExit: (callback: (payload: EmbeddedTerminalExitPayload) => void) => () => void;
  onEmbeddedTerminalSession: (callback: (session: EmbeddedTerminalSession) => void) => () => void;
  selectWorkspace: () => Promise<WorkspacePath | null>;
  createWorkspaceFolder: () => Promise<WorkspacePath | null>;
  minimizeWindow: () => Promise<void>;
  toggleMaximizeWindow: () => Promise<boolean>;
  closeWindow: () => Promise<void>;
};

declare global {
  interface Window {
    contextWorkspace?: WorkspaceApi;
  }
}

let previewTerminalCounter = 0;

const browserFallback: WorkspaceApi = {
  async getBackendState() { return fallbackBackendState(); },
  async checkBackendHealth() { return fallbackBackendState(); },
  async restartBackend() { return fallbackBackendState(); },
  async getControlState() { return fallbackControlState(); },
  async checkControlHealth() { return fallbackControlState(); },
  async restartControl() { return fallbackControlState(); },
  async getRemoteAccessState() { return fallbackRemoteAccessState(); },
  async refreshRemoteAccess() { return fallbackRemoteAccessState(); },
  async setRemoteAccessEnabled() { return fallbackRemoteAccessState(); },
  async setRemoteAccessPort() { return fallbackRemoteAccessState(); },
  async setRemoteAccessTrustOwnDevices() { return fallbackRemoteAccessState(); },
  async regenerateRemoteAccessToken() { return fallbackRemoteAccessState(); },
  async getRemoteAccessToken() { return ""; },
  async getRemoteMachines() { return fallbackRemoteMachinesState(); },
  reportWorkspaces() { return undefined; },
  async getRemoteSnapshot() { return fallbackRemoteSnapshot(); },
  async refreshRemote() { return fallbackRemoteSnapshot(); },
  async spawnRemoteTerminals() { throw new Error("Remote machines need the desktop app."); },
  async listRemoteDirectories() { throw new Error("Remote machines need the desktop app."); },
  async openRemoteWorkspace() { throw new Error("Remote machines need the desktop app."); },
  async closeRemoteWorkspace() { throw new Error("Remote machines need the desktop app."); },
  async setRemoteMachineToken() { return fallbackRemoteSnapshot(); },
  onRemoteUpdate() { return () => undefined; },
  onRemoteAttention() { return () => undefined; },
  async refreshRemoteMachines() { return fallbackRemoteMachinesState(); },
  async getLaunchState() { return null; },
  async clearTerminalRestorePause() {
    return {
      pid: 0,
      startedAt: new Date().toISOString(),
      cleanExit: true,
      terminalRestorePaused: false,
      previousCrashAt: null,
    };
  },
  async getPreferences() { return {}; },
  async setPreference() { return {}; },
  async removePreference() { return {}; },
  async getGraphicsStatus() {
    return {
      mode: "safe" as const,
      reason: "Browser preview uses safe graphics mode.",
      quarantined: false,
      preference: "auto" as const,
      recommendedMode: "safe" as const,
      restartRequired: false,
      lastGpuCrashAt: null,
      lastGpuCrashReason: null,
    };
  },
  async setGraphicsPreference() { return this.getGraphicsStatus(); },
  async getDefaultWorkspace() { return fallbackWorkspacePath(); },
  async toWorkspacePath(workspace: string) { return toFallbackWorkspacePath(workspace); },
  async listEmbeddedTerminals() { return []; },
  async restoreEmbeddedTerminals() { return []; },
  async spawnEmbeddedTerminal(workspace: string, options = {}) {
    return {
      id: `preview-${Date.now()}-${++previewTerminalCounter}`,
      title: options.title ?? fallbackTerminalTitle(options.kind ?? "shell"),
      kind: options.kind ?? "shell",
      workspace,
      pid: null,
      promptPath: null,
      initialTask: options.task?.trim() || null,
      sessionLabel: options.sessionLabel ?? (options.kind && options.kind !== "shell" && options.kind !== "hermes" ? "New" : null),
      providerSessionId: options.providerSessionId ?? options.resumeSessionId ?? null,
      createdAt: new Date().toISOString(),
      status: "running",
      exitCode: null,
      error: null,
    };
  },
  async spawnEmbeddedTerminals(workspace: string, options: EmbeddedTerminalSpawnOptions[]) {
    const sessions: EmbeddedTerminalSession[] = [];
    for (const item of options) sessions.push(await this.spawnEmbeddedTerminal(workspace, item));
    return sessions;
  },
  async writeEmbeddedTerminal() { return this.spawnEmbeddedTerminal("/preview"); },
  async renameEmbeddedTerminal(id: string, title: string) {
    return { ...(await this.spawnEmbeddedTerminal("/preview")), id, title };
  },
  async resizeEmbeddedTerminal() { return this.spawnEmbeddedTerminal("/preview"); },
  async attachEmbeddedTerminalStream(id: string) {
    return {
      id,
      epoch: "preview",
      buffer: "[preview terminal buffer]\r\n$ ",
      throughSequence: 0,
    };
  },
  ackEmbeddedTerminalData() {},
  async getEmbeddedTerminalBuffer() { return "[preview terminal buffer]\r\n$ "; },
  async getPerformanceDiagnostics() {
    return {
      activeTerminals: 0,
      bufferedTerminalChars: 0,
      pendingOutputBytes: 0,
      maxBufferChars: 200_000,
      ptyChunksPerSecond: 0,
      ptyBytesPerSecond: 0,
      ipcBatchesPerSecond: 0,
      ipcBytesPerSecond: 0,
      eventLoopLagMs: 0,
      maxEventLoopLagMs: 0,
      lastOutputBatchAt: null,
      rendererTerminalSubscribers: 0,
      terminalOutputRetries: 0,
      terminalOutputResets: 0,
      terminalOutputFlowPauses: 0,
      terminalOutputFlowForcedResumes: 0,
      terminalOutputDroppedChars: 0,
      terminalOutputDeliveredChars: 0,
      terminalOutputAcknowledgedChars: 0,
      terminalReplayCount: 0,
      terminalReplayBytes: 0,
      terminalReplayDurationMs: 0,
      terminalReplayMaxDurationMs: 0,
      sessionIndex: null,
      controlEvents: [],
      terminalControl: [],
      agentProcesses: [],
    };
  },
  async killEmbeddedTerminal() { return { ...(await this.spawnEmbeddedTerminal("/preview")), status: "exited" }; },
  async listAgentSessions(workspace: string) {
    return [
      {
        id: "preview-codex",
        provider: "codex" as const,
        title: "Preview Codex session",
        workspace,
        branch: "main",
        model: "gpt-5.5",
        agent: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "historical" as const,
        terminalId: null,
        pid: null,
        resumeCommand: "codex resume preview-codex",
        metadata: {},
      },
    ];
  },
  // The browser preview cannot look at the machine: report every agent as installed.
  async getAgentClis() {
    const kinds: AgentCliKind[] = ["claude", "codex", "opencode", "hermes", "grok", "athena"];
    return { agents: await Promise.all(kinds.map((kind) => this.checkAgentCli(kind))), privateCopies: null };
  },
  async checkAgentCli(kind: AgentCliKind) {
    return {
      kind, label: kind, executable: kind, installed: true, path: null, installCommand: "", updateCommand: "",
      docsUrl: "", needsNpm: false, npmAvailable: true,
    };
  },
  async refreshAgentPath() { return false; },
  async getDroppedFilePaths(files: File[]) { return files.map((file) => file.name).filter(Boolean); },
  async openExternalUrl(url: string) {
    if (!/^https?:\/\//i.test(url)) return false;
    window.open(url, "_blank", "noopener,noreferrer");
    return true;
  },
  async openPath() { return false; },
  async showAttentionNotification() { return false; },
  async flashWindowForAttention() { return undefined; },
  onAttentionActivate() { return () => undefined; },
  onWorkspaceOpen() { return () => undefined; },
  onWorkspaceClose() { return () => undefined; },
  onEmbeddedTerminalDataFor() { return () => undefined; },
  onEmbeddedTerminalAttention() { return () => undefined; },
  onEmbeddedTerminalExit() { return () => undefined; },
  onEmbeddedTerminalSession() { return () => undefined; },
  async selectWorkspace() { return fallbackWorkspacePath(); },
  async createWorkspaceFolder() { return null; },
  async minimizeWindow() { return undefined; },
  async toggleMaximizeWindow() { return false; },
  async closeWindow() { return undefined; },
};

function fallbackBackendState(): BackendStatus {
  return {
    baseUrl: null,
    healthy: false,
    running: false,
    port: null,
    lastError: "Electron preload is unavailable in browser preview. Run the desktop app for live backend control.",
  };
}

function fallbackControlState(): ElectronControlStatus {
  return {
    baseUrl: null,
    running: false,
    port: null,
    lastError: "Electron preload is unavailable in browser preview. Run the desktop app for Electron control.",
  };
}

function fallbackRemoteAccessState(): RemoteAccessState {
  return {
    enabled: false,
    port: 47821,
    urls: [],
    dnsUrl: null,
    trustOwnDevices: false,
    tailscale: { detected: false, backendState: null, dnsName: null, hostName: null, account: null },
    hasToken: false,
    errors: ["Remote access needs the desktop app."],
    lastRequest: null,
    lastRejected: null,
  };
}

function fallbackRemoteSnapshot(): RemoteSnapshot {
  return { tailscale: "unavailable", account: null, selfName: null, machines: [], refreshedAt: null };
}

function fallbackRemoteMachinesState(): RemoteMachinesState {
  return { tailscale: "unavailable", account: null, port: 47821, machines: [], refreshedAt: null };
}

export const desktop = window.contextWorkspace ?? browserFallback;

function fallbackWorkspacePath(): WorkspacePath {
  return toFallbackWorkspacePath("/preview/context-workspace");
}

function toFallbackWorkspacePath(workspace: string): WorkspacePath {
  return {
    nativePath: workspace,
    wslPath: null,
    displayPath: workspace,
  };
}

function fallbackTerminalTitle(kind: EmbeddedTerminalKind): string {
  if (kind === "hermes") return "Hermes";
  if (kind === "codex") return "Codex";
  if (kind === "opencode") return "OpenCode";
  if (kind === "claude") return "Claude";
  if (kind === "athena") return "Athena Code";
  if (kind === "grok") return "Grok";
  return "Shell";
}
