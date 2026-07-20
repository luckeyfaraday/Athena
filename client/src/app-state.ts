import type { AdapterStatus, BackendStatus, ElectronControlStatus, HermesStatus, RecallStatus } from "./api";
import type {
  AgentMessage,
  AgentProcessDiagnostic,
  AgentSession,
  ControlEvent,
  PerformanceDiagnostics,
  TerminalControlState,
} from "./electron";

export type LoadState = {
  hermes: HermesStatus | null;
  recall: RecallStatus | null;
  adapters: Record<string, AdapterStatus>;
  memory: string[];
};

export const emptyLoadState: LoadState = {
  hermes: null,
  recall: null,
  adapters: {},
  memory: [],
};

export function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

export function sameJsonValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function sameBackendStatus(a: BackendStatus | null, b: BackendStatus): boolean {
  return a?.baseUrl === b.baseUrl
    && a.healthy === b.healthy
    && a.running === b.running
    && a.port === b.port
    && a.lastError === b.lastError;
}

export function sameElectronControlStatus(a: ElectronControlStatus | null, b: ElectronControlStatus): boolean {
  return a?.baseUrl === b.baseUrl
    && a.running === b.running
    && a.port === b.port
    && a.lastError === b.lastError;
}

export function sameAgentSessions(a: AgentSession[], b: AgentSession[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((session, index) => sameAgentSession(session, b[index]!));
}

export function sameAgentMessages(a: AgentMessage[], b: AgentMessage[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((message, index) => sameAgentMessage(message, b[index]!));
}

export function samePerformanceDiagnostics(a: PerformanceDiagnostics | null, b: PerformanceDiagnostics | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.activeTerminals === b.activeTerminals
    && a.bufferedTerminalChars === b.bufferedTerminalChars
    && a.pendingOutputBytes === b.pendingOutputBytes
    && a.maxBufferChars === b.maxBufferChars
    && a.ptyChunksPerSecond === b.ptyChunksPerSecond
    && a.ptyBytesPerSecond === b.ptyBytesPerSecond
    && a.ipcBatchesPerSecond === b.ipcBatchesPerSecond
    && a.ipcBytesPerSecond === b.ipcBytesPerSecond
    && a.eventLoopLagMs === b.eventLoopLagMs
    && a.maxEventLoopLagMs === b.maxEventLoopLagMs
    && a.lastOutputBatchAt === b.lastOutputBatchAt
    && a.rendererTerminalSubscribers === b.rendererTerminalSubscribers
    && a.hiddenRawIpcBytes === b.hiddenRawIpcBytes
    && a.terminalOutputRetries === b.terminalOutputRetries
    && a.terminalOutputResets === b.terminalOutputResets
    && a.terminalOutputDroppedChars === b.terminalOutputDroppedChars
    && a.terminalOutputDeliveredChars === b.terminalOutputDeliveredChars
    && a.terminalOutputAcknowledgedChars === b.terminalOutputAcknowledgedChars
    && a.terminalReplayCount === b.terminalReplayCount
    && a.terminalReplayBytes === b.terminalReplayBytes
    && a.terminalReplayDurationMs === b.terminalReplayDurationMs
    && a.terminalReplayMaxDurationMs === b.terminalReplayMaxDurationMs
    && JSON.stringify(a.sessionIndex) === JSON.stringify(b.sessionIndex)
    && sameControlEvents(a.controlEvents, b.controlEvents)
    && sameTerminalControlStates(a.terminalControl, b.terminalControl)
    && sameAgentProcessDiagnostics(a.agentProcesses, b.agentProcesses);
}

export function sameLoadState(a: LoadState, b: LoadState): boolean {
  return sameJsonValue(a.hermes, b.hermes)
    && sameJsonValue(a.recall, b.recall)
    && sameJsonValue(a.adapters, b.adapters)
    && sameStringArray(a.memory, b.memory);
}

function sameAgentSession(a: AgentSession, b: AgentSession): boolean {
  return a.id === b.id
    && a.provider === b.provider
    && a.title === b.title
    && a.workspace === b.workspace
    && a.branch === b.branch
    && a.model === b.model
    && a.agent === b.agent
    && a.createdAt === b.createdAt
    && a.updatedAt === b.updatedAt
    && a.status === b.status
    && a.terminalId === b.terminalId
    && a.pid === b.pid
    && a.resumeCommand === b.resumeCommand
    && sameJsonValue(a.metadata, b.metadata);
}

function sameAgentMessage(a: AgentMessage, b: AgentMessage): boolean {
  return a.id === b.id
    && a.threadId === b.threadId
    && a.at === b.at
    && a.updatedAt === b.updatedAt
    && a.workspace === b.workspace
    && a.from === b.from
    && a.fromTerminalId === b.fromTerminalId
    && a.to === b.to
    && a.toTerminalId === b.toTerminalId
    && a.toKind === b.toKind
    && a.text === b.text
    && a.preview === b.preview
    && a.status === b.status
    && a.replyRequested === b.replyRequested
    && a.hopCount === b.hopCount
    && a.source === b.source
    && a.error === b.error;
}

function sameControlEvents(a: ControlEvent[], b: ControlEvent[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((event, index) => sameControlEvent(event, b[index]!));
}

function sameControlEvent(a: ControlEvent, b: ControlEvent): boolean {
  return a.id === b.id
    && a.at === b.at
    && a.kind === b.kind
    && a.source === b.source
    && a.terminalId === b.terminalId
    && a.terminalTitle === b.terminalTitle
    && a.terminalKind === b.terminalKind
    && a.detail === b.detail
    && a.preview === b.preview;
}

function sameTerminalControlStates(a: TerminalControlState[], b: TerminalControlState[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((state, index) => sameTerminalControlState(state, b[index]!));
}

function sameTerminalControlState(a: TerminalControlState, b: TerminalControlState): boolean {
  return a.terminalId === b.terminalId
    && a.title === b.title
    && a.kind === b.kind
    && a.workspace === b.workspace
    && a.pid === b.pid
    && a.status === b.status
    && a.lastSpawnAt === b.lastSpawnAt
    && a.spawnSource === b.spawnSource
    && a.lastSpawnResult === b.lastSpawnResult
    && a.lastInjectedAt === b.lastInjectedAt
    && a.lastInjectedBy === b.lastInjectedBy
    && a.lastInjectTextPreview === b.lastInjectTextPreview
    && a.lastInjectResult === b.lastInjectResult
    && a.lastPtyWriteAt === b.lastPtyWriteAt
    && a.lastOutputAt === b.lastOutputAt
    && a.attentionReason === b.attentionReason;
}

function sameAgentProcessDiagnostics(a: AgentProcessDiagnostic[], b: AgentProcessDiagnostic[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((process, index) => sameAgentProcessDiagnostic(process, b[index]!));
}

function sameAgentProcessDiagnostic(a: AgentProcessDiagnostic, b: AgentProcessDiagnostic): boolean {
  return a.pid === b.pid
    && a.ppid === b.ppid
    && a.agent === b.agent
    && a.command === b.command
    && a.managedTerminalId === b.managedTerminalId
    && a.managedTerminalTitle === b.managedTerminalTitle
    && a.workspace === b.workspace;
}
