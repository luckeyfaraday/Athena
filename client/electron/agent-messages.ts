import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { EmbeddedTerminalKind } from "./embedded-terminal.js";
export { agentHandle, agentHandleMap } from "./agent-routing.js";

export type AgentMessageStatus = "queued" | "injecting" | "written" | "output_seen" | "failed";

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
  toKind: EmbeddedTerminalKind | null;
  text: string;
  preview: string;
  status: AgentMessageStatus;
  replyRequested: boolean;
  hopCount: number;
  source: string;
  error: string | null;
};

export type AgentMessageInput = {
  workspace: string;
  from?: string | null;
  fromTerminalId?: string | null;
  to: string;
  toTerminalId?: string | null;
  toKind?: EmbeddedTerminalKind | null;
  text: string;
  threadId?: string | null;
  replyRequested?: boolean;
  hopCount?: number;
  source?: string;
  status?: AgentMessageStatus;
  error?: string | null;
};

const MAX_AGENT_MESSAGES = 500;
/**
 * The store is rewritten whole, and a single routed message updates it two or
 * three times in quick succession (queued -> injecting -> written). Coalesce
 * those into one compact, atomic background write; `flushAgentMessages` makes
 * the latest state durable synchronously at shutdown.
 */
const PERSIST_DEBOUNCE_MS = 250;
/**
 * Windows reports EPERM/EACCES/EBUSY while Defender or the indexer briefly
 * holds the destination. Retry the rename with short backoff; the destination
 * is never deleted, so a failure can only leave the previous complete store.
 */
const RENAME_RETRY_DELAYS_MS = [50, 100, 200];
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const PERSIST_RETRY_MIN_MS = 1_000;
const PERSIST_RETRY_MAX_MS = 60_000;
let messageCache: AgentMessage[] | null = null;
let writtenMessageTerminals = new Set<string>();
let cacheGeneration = 0;
let persistedGeneration = 0;
let persistTimer: NodeJS.Timeout | null = null;
let persistInFlight = false;
let persistRetryDelayMs = 0;
/** Complete snapshots kept after a failed rename; removed once a later write lands. */
const retainedTemporaryFiles = new Set<string>();

export function agentMessageStorePath(): string {
  return path.join(os.homedir(), ".context-workspace", "agent-messages.json");
}

export function listAgentMessages(workspace?: string | null, limit = 100): AgentMessage[] {
  const messages = readAgentMessages();
  const filtered = workspace
    ? messages.filter((message) => samePath(message.workspace, workspace))
    : messages;
  return filtered
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, Math.max(1, Math.min(Math.floor(limit), MAX_AGENT_MESSAGES)));
}

export function createAgentMessage(input: AgentMessageInput): AgentMessage {
  const now = new Date().toISOString();
  const message: AgentMessage = {
    id: crypto.randomUUID(),
    threadId: input.threadId?.trim() || crypto.randomUUID(),
    at: now,
    updatedAt: now,
    workspace: input.workspace,
    from: input.from?.trim() || input.fromTerminalId || input.source || "unknown",
    fromTerminalId: input.fromTerminalId?.trim() || null,
    to: input.to.trim(),
    toTerminalId: input.toTerminalId?.trim() || null,
    toKind: input.toKind ?? null,
    text: input.text,
    preview: previewText(input.text),
    status: input.status ?? "queued",
    replyRequested: Boolean(input.replyRequested),
    hopCount: Math.max(0, Math.floor(input.hopCount ?? 0)),
    source: input.source ?? "electron-control",
    error: input.error ?? null,
  };
  writeAgentMessages([message, ...readAgentMessages()].slice(0, MAX_AGENT_MESSAGES));
  return message;
}

export function updateAgentMessageStatus(id: string, status: AgentMessageStatus, error?: string | null): AgentMessage | null {
  const messages = readAgentMessages();
  const index = messages.findIndex((message) => message.id === id);
  if (index < 0) return null;
  const next = {
    ...messages[index],
    status,
    updatedAt: new Date().toISOString(),
    error: error ?? messages[index].error,
  };
  messages[index] = next;
  writeAgentMessages(messages);
  return next;
}

export function markTerminalOutputForMessages(terminalId: string): void {
  if (!writtenMessageTerminals.has(terminalId)) return;
  const messages = readAgentMessages();
  let changed = false;
  const next = messages.map((message) => {
    if (message.toTerminalId !== terminalId || message.status !== "written") return message;
    changed = true;
    return {
      ...message,
      status: "output_seen" as const,
      updatedAt: new Date().toISOString(),
    };
  });
  if (changed) writeAgentMessages(next);
}

/** Queued messages awaiting delivery to a terminal, oldest first. */
export function queuedAgentMessagesForTerminal(terminalId: string): AgentMessage[] {
  return readAgentMessages()
    .filter((message) => message.toTerminalId === terminalId && message.status === "queued")
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

/** Fail every still-queued message for a terminal (e.g. it exited before delivery). */
export function failQueuedAgentMessages(terminalId: string, error: string): void {
  failAgentMessagesWhere((message) => message.toTerminalId === terminalId && message.status === "queued", error);
}

/**
 * Fail any message left mid-delivery by a previous run. Queued/injecting
 * messages target terminals that no longer exist after a restart, so they can
 * never be delivered — surface them as failed instead of leaving them pending.
 */
export function expireInFlightAgentMessages(error: string): void {
  failAgentMessagesWhere((message) => message.status === "queued" || message.status === "injecting", error);
}

function failAgentMessagesWhere(predicate: (message: AgentMessage) => boolean, error: string): void {
  const messages = readAgentMessages();
  let changed = false;
  const next = messages.map((message) => {
    if (!predicate(message)) return message;
    changed = true;
    return { ...message, status: "failed" as const, error, updatedAt: new Date().toISOString() };
  });
  if (changed) writeAgentMessages(next);
}

export function agentMessageEnvelope(message: AgentMessage): string {
  const replyLine = message.replyRequested && message.fromTerminalId
    ? `Reply target: ${message.fromTerminalId}\n`
    : "";
  return [
    `[athena-msg id=${message.id} thread=${message.threadId} from=${message.from} to=${message.to} hop=${message.hopCount}]`,
    `${replyLine}Message:`,
    message.text.trim(),
  ].filter(Boolean).join("\n");
}

function readAgentMessages(): AgentMessage[] {
  if (messageCache) return [...messageCache];
  try {
    const parsed = JSON.parse(fs.readFileSync(agentMessageStorePath(), "utf8"));
    messageCache = Array.isArray(parsed) ? parsed.filter(isAgentMessage) : [];
  } catch {
    messageCache = [];
  }
  writtenMessageTerminals = writtenTargets(messageCache);
  return [...messageCache];
}

function writeAgentMessages(messages: AgentMessage[]): void {
  messageCache = [...messages];
  writtenMessageTerminals = writtenTargets(messageCache);
  cacheGeneration += 1;
  schedulePersist();
}

/**
 * Synchronously write any pending message-store changes. Call on app quit so
 * the debounced background write cannot be lost.
 */
export function flushAgentMessages(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!messageCache || cacheGeneration === persistedGeneration) return;
  const generation = cacheGeneration;
  const filePath = agentMessageStorePath();
  const temporary = temporaryStorePath(filePath, generation, "flush");
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(messageCache), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    removeQuietly(temporary);
    console.warn("Failed to flush agent messages:", error);
    return;
  }
  const error = renameWithRetrySync(temporary, filePath);
  if (error) {
    // Keep the complete snapshot; the previous store is untouched.
    retainedTemporaryFiles.add(temporary);
    console.warn("Failed to flush agent messages:", error);
    return;
  }
  markPersisted(generation, temporary);
}

function schedulePersist(delayMs = PERSIST_DEBOUNCE_MS): void {
  // An in-flight write reschedules itself on completion if newer changes exist.
  if (persistTimer || persistInFlight) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistAgentMessages();
  }, delayMs);
  persistTimer.unref?.();
}

async function persistAgentMessages(): Promise<void> {
  if (persistInFlight || !messageCache || cacheGeneration === persistedGeneration) return;
  const generation = cacheGeneration;
  const content = JSON.stringify(messageCache);
  const filePath = agentMessageStorePath();
  const temporary = temporaryStorePath(filePath, generation, "async");
  const superseded = () => generation <= persistedGeneration;
  persistInFlight = true;
  let failure: unknown = null;
  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    // A partial temporary file (e.g. a full disk) is not a usable snapshot.
    removeQuietly(temporary);
    failure = error;
  }
  if (!failure) {
    // Renames run on the main thread so they are ordered against
    // flushAgentMessages; a newer synchronous flush must never be replaced by
    // this older snapshot.
    const error = await renameWithRetry(temporary, filePath, superseded);
    if (superseded()) {
      // A newer snapshot landed first (the rename was skipped).
      removeQuietly(temporary);
    } else if (error) {
      retainedTemporaryFiles.add(temporary);
      failure = error;
    } else {
      markPersisted(generation, temporary);
    }
  }
  persistInFlight = false;
  if (failure) {
    // Keep state in memory and retry with backoff instead of spinning on a
    // persistent failure; the shutdown flush also retries.
    persistRetryDelayMs = Math.min(Math.max(persistRetryDelayMs * 2, PERSIST_RETRY_MIN_MS), PERSIST_RETRY_MAX_MS);
    console.warn("Failed to persist agent messages:", failure);
    if (cacheGeneration !== persistedGeneration) schedulePersist(persistRetryDelayMs);
  } else if (cacheGeneration !== persistedGeneration) {
    schedulePersist();
  }
}

function markPersisted(generation: number, renamedTemporary: string): void {
  persistedGeneration = Math.max(persistedGeneration, generation);
  persistRetryDelayMs = 0;
  retainedTemporaryFiles.delete(renamedTemporary);
  for (const retained of retainedTemporaryFiles) removeQuietly(retained);
  retainedTemporaryFiles.clear();
}

// The shutdown flush and the background writer never share a temporary file,
// even for the same generation.
function temporaryStorePath(filePath: string, generation: number, writer: "async" | "flush"): string {
  return `${filePath}.${process.pid}.${generation}.${writer}.tmp`;
}

function isRetryableRenameError(error: unknown): boolean {
  return RETRYABLE_RENAME_CODES.has((error as NodeJS.ErrnoException | null)?.code ?? "");
}

/** Rename with short synchronous backoff (shutdown path). Returns the final error, if any. */
function renameWithRetrySync(temporary: string, filePath: string): unknown {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temporary, filePath);
      return null;
    } catch (error) {
      if (!isRetryableRenameError(error) || attempt >= RENAME_RETRY_DELAYS_MS.length) return error;
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/**
 * Rename with short asynchronous backoff. Each attempt runs synchronously on
 * the main thread and is skipped once a newer snapshot has been persisted.
 */
async function renameWithRetry(temporary: string, filePath: string, superseded: () => boolean): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    if (superseded()) return null;
    try {
      fs.renameSync(temporary, filePath);
      return null;
    } catch (error) {
      if (!isRetryableRenameError(error) || attempt >= RENAME_RETRY_DELAYS_MS.length) return error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]));
    }
  }
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Blocking waits are unavailable in this context; retry immediately.
  }
}

function removeQuietly(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best effort cleanup of a temporary file.
  }
}

function writtenTargets(messages: AgentMessage[]): Set<string> {
  return new Set(
    messages
      .filter((message) => message.status === "written" && message.toTerminalId)
      .map((message) => message.toTerminalId as string),
  );
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<AgentMessage>;
  return typeof item.id === "string"
    && typeof item.threadId === "string"
    && typeof item.workspace === "string"
    && typeof item.from === "string"
    && typeof item.to === "string"
    && typeof item.text === "string"
    && typeof item.preview === "string"
    && typeof item.status === "string";
}

function previewText(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 180 ? `${singleLine.slice(0, 177)}...` : singleLine;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}
