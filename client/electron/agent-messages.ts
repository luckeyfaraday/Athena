import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { EmbeddedTerminalKind, EmbeddedTerminalSession } from "./embedded-terminal.js";

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

export function agentHandle(session: EmbeddedTerminalSession, sessions: EmbeddedTerminalSession[]): string {
  const peers = sessions
    .filter((item) => item.kind === session.kind && item.kind !== "shell")
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id));
  const index = peers.findIndex((item) => item.id === session.id);
  return `${session.kind}#${Math.max(0, index) + 1}`;
}

export function agentHandleMap(sessions: EmbeddedTerminalSession[]): Map<string, string> {
  return new Map(sessions.map((session) => [session.id, agentHandle(session, sessions)]));
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
  try {
    const parsed = JSON.parse(fs.readFileSync(agentMessageStorePath(), "utf8"));
    return Array.isArray(parsed) ? parsed.filter(isAgentMessage) : [];
  } catch {
    return [];
  }
}

function writeAgentMessages(messages: AgentMessage[]): void {
  const filePath = agentMessageStorePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(messages, null, 2), { encoding: "utf8", mode: 0o600 });
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
