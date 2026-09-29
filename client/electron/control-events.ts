import type { EmbeddedTerminalKind } from "./embedded-terminal.js";

export type ControlEventKind =
  | "spawn.requested"
  | "spawn.succeeded"
  | "spawn.failed"
  | "input.requested"
  | "input.written"
  | "input.failed"
  | "terminal.output"
  | "terminal.exited";

export type ControlEvent = {
  id: string;
  at: string;
  kind: ControlEventKind;
  source: string;
  terminalId: string | null;
  terminalTitle: string | null;
  terminalKind: EmbeddedTerminalKind | null;
  detail: string | null;
  preview: string | null;
};

export type TerminalControlState = {
  terminalId: string;
  title: string;
  kind: EmbeddedTerminalKind;
  workspace: string;
  pid: number | null;
  status: "running" | "exited" | "failed";
  lastSpawnAt: string | null;
  spawnSource: string | null;
  lastSpawnResult: "requested" | "succeeded" | "failed" | null;
  lastInjectedAt: string | null;
  lastInjectedBy: string | null;
  lastInjectTextPreview: string | null;
  lastInjectResult: "requested" | "written" | "failed" | null;
  lastPtyWriteAt: string | null;
  lastOutputAt: string | null;
  attentionReason: string | null;
};

// Internal records keep epoch-millisecond timestamps. recordTerminalOutput()
// runs for every PTY batch of every terminal (hidden ones included), so it
// mutates in place and never formats dates; ISO strings are produced only
// when diagnostics are read.
type TimestampKey = "lastSpawnAt" | "lastInjectedAt" | "lastPtyWriteAt" | "lastOutputAt";
type TerminalControlRecord = Omit<TerminalControlState, TimestampKey> & {
  [K in TimestampKey]: number | null;
};
type ControlEventRecord = Omit<ControlEvent, "at"> & { at: number };

const MAX_CONTROL_EVENTS = 120;
const WAITING_FOR_OUTPUT_REASON = "waiting for output after injected input";
const events: ControlEventRecord[] = [];
const terminalStates = new Map<string, TerminalControlRecord>();

export function recordSpawnRequested(args: {
  terminalId: string;
  title: string;
  kind: EmbeddedTerminalKind;
  workspace: string;
  source?: string;
  pid?: number | null;
  detail?: string | null;
  preview?: string | null;
}): void {
  const at = Date.now();
  const existing = terminalStates.get(args.terminalId);
  terminalStates.set(args.terminalId, {
    terminalId: args.terminalId,
    title: args.title,
    kind: args.kind,
    workspace: args.workspace,
    pid: args.pid ?? existing?.pid ?? null,
    status: existing?.status ?? "running",
    lastSpawnAt: at,
    spawnSource: args.source ?? "ui",
    lastSpawnResult: "requested",
    lastInjectedAt: existing?.lastInjectedAt ?? null,
    lastInjectedBy: existing?.lastInjectedBy ?? null,
    lastInjectTextPreview: existing?.lastInjectTextPreview ?? null,
    lastInjectResult: existing?.lastInjectResult ?? null,
    lastPtyWriteAt: existing?.lastPtyWriteAt ?? null,
    lastOutputAt: existing?.lastOutputAt ?? null,
    attentionReason: args.detail ?? "spawn requested",
  });
  appendEvent({
    at,
    kind: "spawn.requested",
    source: args.source ?? "ui",
    terminalId: args.terminalId,
    terminalTitle: args.title,
    terminalKind: args.kind,
    detail: args.detail ?? null,
    preview: args.preview ?? null,
  });
}

export function recordSpawnSucceeded(args: {
  terminalId: string;
  title: string;
  kind: EmbeddedTerminalKind;
  workspace: string;
  source?: string;
  pid: number | null;
  detail?: string | null;
}): void {
  const at = Date.now();
  const existing = terminalStates.get(args.terminalId);
  terminalStates.set(args.terminalId, {
    terminalId: args.terminalId,
    title: args.title,
    kind: args.kind,
    workspace: args.workspace,
    pid: args.pid,
    status: "running",
    lastSpawnAt: existing?.lastSpawnAt ?? at,
    spawnSource: existing?.spawnSource ?? args.source ?? "ui",
    lastSpawnResult: "succeeded",
    lastInjectedAt: existing?.lastInjectedAt ?? null,
    lastInjectedBy: existing?.lastInjectedBy ?? null,
    lastInjectTextPreview: existing?.lastInjectTextPreview ?? null,
    lastInjectResult: existing?.lastInjectResult ?? null,
    lastPtyWriteAt: existing?.lastPtyWriteAt ?? null,
    lastOutputAt: existing?.lastOutputAt ?? null,
    attentionReason: null,
  });
  appendEvent({
    at,
    kind: "spawn.succeeded",
    source: args.source ?? existing?.spawnSource ?? "ui",
    terminalId: args.terminalId,
    terminalTitle: args.title,
    terminalKind: args.kind,
    detail: args.detail ?? (args.pid == null ? "PTY started" : `PTY started with PID ${args.pid}`),
    preview: null,
  });
}

export function recordSpawnFailed(args: {
  terminalId: string;
  title: string;
  kind: EmbeddedTerminalKind;
  workspace: string;
  source?: string;
  error: string;
}): void {
  const at = Date.now();
  const existing = terminalStates.get(args.terminalId);
  terminalStates.set(args.terminalId, {
    terminalId: args.terminalId,
    title: args.title,
    kind: args.kind,
    workspace: args.workspace,
    pid: existing?.pid ?? null,
    status: "failed",
    lastSpawnAt: existing?.lastSpawnAt ?? at,
    spawnSource: existing?.spawnSource ?? args.source ?? "ui",
    lastSpawnResult: "failed",
    lastInjectedAt: existing?.lastInjectedAt ?? null,
    lastInjectedBy: existing?.lastInjectedBy ?? null,
    lastInjectTextPreview: existing?.lastInjectTextPreview ?? null,
    lastInjectResult: existing?.lastInjectResult ?? null,
    lastPtyWriteAt: existing?.lastPtyWriteAt ?? null,
    lastOutputAt: existing?.lastOutputAt ?? null,
    attentionReason: args.error,
  });
  appendEvent({
    at,
    kind: "spawn.failed",
    source: args.source ?? "ui",
    terminalId: args.terminalId,
    terminalTitle: args.title,
    terminalKind: args.kind,
    detail: args.error,
    preview: null,
  });
}

export function recordControlFailure(args: {
  kind: "spawn.failed" | "input.failed";
  source?: string;
  detail: string;
  preview?: string | null;
}): void {
  appendEvent({
    at: Date.now(),
    kind: args.kind,
    source: args.source ?? "electron-control",
    terminalId: null,
    terminalTitle: null,
    terminalKind: null,
    detail: args.detail,
    preview: args.preview ? previewText(args.preview) : null,
  });
}

export function recordInputRequested(args: {
  terminalId: string;
  source?: string;
  preview: string;
}): void {
  const at = Date.now();
  const state = terminalStates.get(args.terminalId);
  if (state) {
    state.lastInjectedAt = at;
    state.lastInjectedBy = args.source ?? "electron-control";
    state.lastInjectTextPreview = previewText(args.preview);
    state.lastInjectResult = "requested";
    state.attentionReason = "input requested";
  }
  appendEvent({
    at,
    kind: "input.requested",
    source: args.source ?? "electron-control",
    terminalId: args.terminalId,
    terminalTitle: state?.title ?? null,
    terminalKind: state?.kind ?? null,
    detail: "input injection requested",
    preview: previewText(args.preview),
  });
}

export function recordInputWritten(args: {
  terminalId: string;
  source?: string;
  preview: string;
}): void {
  const at = Date.now();
  const state = terminalStates.get(args.terminalId);
  if (state) {
    state.lastInjectedAt = state.lastInjectedAt ?? at;
    state.lastInjectedBy = state.lastInjectedBy ?? args.source ?? "electron-control";
    state.lastInjectTextPreview = state.lastInjectTextPreview ?? previewText(args.preview);
    state.lastInjectResult = "written";
    state.lastPtyWriteAt = at;
    state.attentionReason = WAITING_FOR_OUTPUT_REASON;
  }
  appendEvent({
    at,
    kind: "input.written",
    source: args.source ?? "electron-control",
    terminalId: args.terminalId,
    terminalTitle: state?.title ?? null,
    terminalKind: state?.kind ?? null,
    detail: "input written to PTY",
    preview: previewText(args.preview),
  });
}

export function recordInputFailed(args: {
  terminalId: string | null;
  source?: string;
  preview: string;
  error: string;
}): void {
  const at = Date.now();
  const state = args.terminalId ? terminalStates.get(args.terminalId) : undefined;
  if (state) {
    state.lastInjectedAt = at;
    state.lastInjectedBy = args.source ?? "electron-control";
    state.lastInjectTextPreview = previewText(args.preview);
    state.lastInjectResult = "failed";
    state.attentionReason = args.error;
  }
  appendEvent({
    at,
    kind: "input.failed",
    source: args.source ?? "electron-control",
    terminalId: args.terminalId,
    terminalTitle: state?.title ?? null,
    terminalKind: state?.kind ?? null,
    detail: args.error,
    preview: previewText(args.preview),
  });
}

/** Hot path: called for every PTY output batch. No allocation in steady state. */
export function recordTerminalOutput(terminalId: string): void {
  const state = terminalStates.get(terminalId);
  if (!state) return;
  const at = Date.now();
  const shouldLog = state.lastInjectResult === "written"
    && state.lastInjectedAt != null
    && (state.lastOutputAt == null || state.lastOutputAt < state.lastInjectedAt);
  state.lastOutputAt = at;
  if (state.attentionReason === WAITING_FOR_OUTPUT_REASON) state.attentionReason = null;
  if (!shouldLog) return;
  appendEvent({
    at,
    kind: "terminal.output",
    source: "pty",
    terminalId,
    terminalTitle: state.title,
    terminalKind: state.kind,
    detail: "terminal produced output after injected input",
    preview: null,
  });
}

export function recordTerminalExited(terminalId: string, exitCode: number | null): void {
  const reason = exitCode == null ? "terminal exited" : `terminal exited with code ${exitCode}`;
  const state = terminalStates.get(terminalId);
  if (state) {
    state.status = "exited";
    state.attentionReason = reason;
  }
  appendEvent({
    at: Date.now(),
    kind: "terminal.exited",
    source: "pty",
    terminalId,
    terminalTitle: state?.title ?? null,
    terminalKind: state?.kind ?? null,
    detail: reason,
    preview: null,
  });
}

export function recentControlEvents(): ControlEvent[] {
  const result: ControlEvent[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    result.push({ ...event, at: isoTimestamp(event.at) });
  }
  return result;
}

export function terminalControlStates(): TerminalControlState[] {
  return Array.from(terminalStates.values())
    .sort((a, b) => b.terminalId.localeCompare(a.terminalId))
    .map((state) => ({
      ...state,
      lastSpawnAt: isoTimestampOrNull(state.lastSpawnAt),
      lastInjectedAt: isoTimestampOrNull(state.lastInjectedAt),
      lastPtyWriteAt: isoTimestampOrNull(state.lastPtyWriteAt),
      lastOutputAt: isoTimestampOrNull(state.lastOutputAt),
    }));
}

function appendEvent(event: Omit<ControlEventRecord, "id">): void {
  events.push({ ...event, id: `${event.at}-${Math.random().toString(16).slice(2)}` });
  if (events.length > MAX_CONTROL_EVENTS) events.splice(0, events.length - MAX_CONTROL_EVENTS);
}

function previewText(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 180 ? `${singleLine.slice(0, 177)}...` : singleLine;
}

function isoTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

function isoTimestampOrNull(ms: number | null): string | null {
  return ms == null ? null : isoTimestamp(ms);
}
