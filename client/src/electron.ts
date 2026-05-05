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
  onCodexTerminalData: (callback: (data: string) => void) => () => void;
  onCodexTerminalState: (callback: (state: CodexTerminalStatus) => void) => () => void;
  selectWorkspace: () => Promise<string | null>;
};

declare global {
  interface Window {
    contextWorkspace: WorkspaceApi;
  }
}

export const desktop = window.contextWorkspace;
