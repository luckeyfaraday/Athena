export type HermesIndexedSession = {
  id: string;
  title: string;
  model: string | null;
  agent: string | null;
  createdAt: string;
  updatedAt: string;
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

export type SessionIndexRequest = {
  type: "list-hermes";
  requestId: string;
  workspaces: string[];
};

export type SessionIndexSuccess = {
  type: "response";
  requestId: string;
  ok: true;
  sessions: Record<string, HermesIndexedSession[]>;
  diagnostics: HermesIndexDiagnostics;
};

export type SessionIndexFailure = {
  type: "response";
  requestId: string;
  ok: false;
  error: string;
};

export type SessionIndexResponse = SessionIndexSuccess | SessionIndexFailure;
