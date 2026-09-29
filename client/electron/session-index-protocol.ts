export type HermesIndexedSession = {
  id: string;
  title: string;
  model: string | null;
  agent: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentSessionProvider = "codex" | "opencode" | "athena" | "claude" | "hermes" | "grok";

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

export type HermesIndexDiagnostics = {
  filesSeen: number;
  filesStatted: number;
  filesParsed: number;
  bytesParsed: number;
  cacheHits: number;
  durationMs: number;
  lastError: string | null;
};

export type SessionIndexRequestKind = "list-hermes" | "list-agent-sessions";

export type SessionIndexRequest = {
  type: SessionIndexRequestKind;
  requestId: string;
  workspaces: string[];
};

export type SessionIndexSuccess<T = HermesIndexedSession> = {
  type: "response";
  requestId: string;
  ok: true;
  sessions: Record<string, T[]>;
  diagnostics: HermesIndexDiagnostics;
};

export type SessionIndexFailure = {
  type: "response";
  requestId: string;
  ok: false;
  error: string;
};

export type SessionIndexResponse<T = HermesIndexedSession> = SessionIndexSuccess<T> | SessionIndexFailure;
