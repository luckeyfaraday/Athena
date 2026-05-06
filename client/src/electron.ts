import type { BackendStatus } from "./api";

export type CodexTerminalStatus = {
  running: boolean;
  workspace: string | null;
  pid: number | null;
  lastError: string | null;
};

export type NativeTerminalResult = {
  ok: boolean;
  command: string | null;
  pid: number | null;
  session: NativeTerminalSession | null;
  error: string | null;
};

export type NativeTerminalSession = {
  id: string;
  workspace: string;
  pid: number | null;
  command: string;
  promptPath: string | null;
  scriptPath: string | null;
  mode: "single" | "grid";
  panes: number;
  createdAt: string;
  status: "launched" | "failed";
  error: string | null;
};

export type EmbeddedTerminalKind = "shell" | "codex" | "opencode" | "claude";

export type EmbeddedTerminalSession = {
  id: string;
  title: string;
  kind: EmbeddedTerminalKind;
  workspace: string;
  pid: number | null;
  promptPath: string | null;
  createdAt: string;
  status: "running" | "exited" | "failed";
  exitCode: number | null;
  error: string | null;
};

type WorkspaceApi = {
  getBackendState: () => Promise<BackendStatus>;
  checkBackendHealth: () => Promise<BackendStatus>;
  restartBackend: () => Promise<BackendStatus>;
  getCodexTerminalState: () => Promise<CodexTerminalStatus>;
  startCodexTerminal: (workspace: string) => Promise<CodexTerminalStatus>;
  writeCodexTerminal: (data: string) => Promise<CodexTerminalStatus>;
  stopCodexTerminal: () => Promise<CodexTerminalStatus>;
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
  onEmbeddedTerminalData: (callback: (payload: { id: string; data: string }) => void) => () => void;
  onEmbeddedTerminalExit: (callback: (payload: { id: string; exitCode: number | null }) => void) => () => void;
  onEmbeddedTerminalSession: (callback: (session: EmbeddedTerminalSession) => void) => () => void;
  onCodexTerminalData: (callback: (data: string) => void) => () => void;
  onCodexTerminalState: (callback: (state: CodexTerminalStatus) => void) => () => void;
  selectWorkspace: () => Promise<string | null>;
};

declare global {
  interface Window {
    contextWorkspace?: WorkspaceApi;
  }
}

const browserFallback: WorkspaceApi = {
  async getBackendState() { return fallbackBackendState(); },
  async checkBackendHealth() { return fallbackBackendState(); },
  async restartBackend() { return fallbackBackendState(); },
  async getCodexTerminalState() { return { running: false, workspace: null, pid: null, lastError: null }; },
  async startCodexTerminal(workspace: string) { return { running: true, workspace, pid: null, lastError: null }; },
  async writeCodexTerminal() { return { running: false, workspace: null, pid: null, lastError: null }; },
  async stopCodexTerminal() { return { running: false, workspace: null, pid: null, lastError: null }; },
  async openNativeCodexTerminal(workspace: string) { return fallbackTerminalResult(workspace, "single", 1); },
  async openNativeCodexGrid(workspace: string, panes = 4) { return fallbackTerminalResult(workspace, "grid", panes); },
  async getNativeTerminalSessions() { return []; },
  async listEmbeddedTerminals() { return []; },
  async spawnEmbeddedTerminal(workspace: string, options = {}) {
    return {
      id: `preview-${Date.now()}`,
      title: options.title ?? fallbackTerminalTitle(options.kind ?? "shell"),
      kind: options.kind ?? "shell",
      workspace,
      pid: null,
      promptPath: null,
      createdAt: new Date().toISOString(),
      status: "running",
      exitCode: null,
      error: null,
    };
  },
  async writeEmbeddedTerminal() { return this.spawnEmbeddedTerminal("/preview"); },
  async resizeEmbeddedTerminal() { return this.spawnEmbeddedTerminal("/preview"); },
  async getEmbeddedTerminalBuffer() { return "[preview terminal buffer]\\r\\n$ "; },
  async killEmbeddedTerminal() { return { ...(await this.spawnEmbeddedTerminal("/preview")), status: "exited" }; },
  onEmbeddedTerminalData() { return () => undefined; },
  onEmbeddedTerminalExit() { return () => undefined; },
  onEmbeddedTerminalSession() { return () => undefined; },
  onCodexTerminalData() { return () => undefined; },
  onCodexTerminalState() { return () => undefined; },
  async selectWorkspace() { return "/home/you/home_ai/projects/context-workspace"; },
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

function fallbackTerminalResult(workspace: string, mode: "single" | "grid", panes: number): NativeTerminalResult {
  const session: NativeTerminalSession = {
    id: `preview-${Date.now()}`,
    workspace,
    pid: null,
    command: "preview-only",
    promptPath: null,
    scriptPath: null,
    mode,
    panes,
    createdAt: new Date().toISOString(),
    status: "launched",
    error: null,
  };
  return { ok: true, command: session.command, pid: null, session, error: null };
}

export const desktop = window.contextWorkspace ?? browserFallback;

function fallbackTerminalTitle(kind: EmbeddedTerminalKind): string {
  if (kind === "codex") return "Codex";
  if (kind === "opencode") return "OpenCode";
  if (kind === "claude") return "Claude";
  return "Shell";
}
