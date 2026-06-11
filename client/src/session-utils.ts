import type { RecallStatus } from "./api";
import type { AgentSession, EmbeddedTerminalKind, EmbeddedTerminalSession } from "./electron";
import { agentSessionKey, appendEmbeddedSessions, embeddedSessionKey, selectedAgentSessionKey } from "./session-rename-keys";
import { normalizeWorkspaceKey } from "./workspace-utils";

export { agentSessionKey, appendEmbeddedSessions, embeddedSessionKey, selectedAgentSessionKey } from "./session-rename-keys";

export type SessionProviderFilter = AgentSession["provider"] | "all";

export type AgentTranscriptState = {
  key: string;
  text: string;
  loading: boolean;
  error: string | null;
};

export type HandoffPreview = {
  markdown: string;
  bytes: number;
  sourceCount: number;
  sourceTitles: string[];
  workspace: string;
};

const deletedAgentSessionsStoragePrefix = "context-workspace:deleted-agent-sessions:";
const renamedSessionsStoragePrefix = "context-workspace:renamed-sessions:";

function deletedAgentSessionsStorageKey(workspace: string): string {
  return `${deletedAgentSessionsStoragePrefix}${workspace ? normalizeWorkspaceKey(workspace) : "none"}`;
}

function legacyDeletedAgentSessionsStorageKey(workspace: string): string {
  return `${deletedAgentSessionsStoragePrefix}${workspace || "none"}`;
}

function parseDeletedAgentSessions(value: string | null): string[] {
  const parsed = JSON.parse(value ?? "[]");
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

export function readDeletedAgentSessions(workspace: string): Set<string> {
  try {
    const normalizedKey = deletedAgentSessionsStorageKey(workspace);
    const legacyKey = legacyDeletedAgentSessionsStorageKey(workspace);
    const values = parseDeletedAgentSessions(window.localStorage.getItem(normalizedKey));
    if (legacyKey !== normalizedKey) values.push(...parseDeletedAgentSessions(window.localStorage.getItem(legacyKey)));
    return new Set(values);
  } catch {
    return new Set();
  }
}

export function writeDeletedAgentSessions(workspace: string, sessions: Set<string>): void {
  try {
    window.localStorage.setItem(deletedAgentSessionsStorageKey(workspace), JSON.stringify([...sessions]));
  } catch {
    // Ignore storage failures; deleting still applies for the current render.
  }
}

function renamedSessionsStorageKey(workspace: string): string {
  return `${renamedSessionsStoragePrefix}${workspace ? normalizeWorkspaceKey(workspace) : "none"}`;
}

function parseRenamedSessions(value: string | null): Record<string, string> {
  const parsed = JSON.parse(value ?? "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed)
      .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].trim().length > 0),
  );
}

export function readRenamedSessions(workspace: string): Record<string, string> {
  try {
    return parseRenamedSessions(window.localStorage.getItem(renamedSessionsStorageKey(workspace)));
  } catch {
    return {};
  }
}

export function writeRenamedSessions(workspace: string, sessions: Record<string, string>): void {
  try {
    window.localStorage.setItem(renamedSessionsStorageKey(workspace), JSON.stringify(sessions));
  } catch {
    // Ignore storage failures; the active render still carries the rename.
  }
}

export function applyEmbeddedSessionRenames(sessions: EmbeddedTerminalSession[], renames: Record<string, string>): EmbeddedTerminalSession[] {
  return sessions.map((session) => {
    const title = renames[embeddedSessionKey(session)]?.trim();
    return title ? { ...session, title } : session;
  });
}

export function applyAgentSessionRenames(sessions: AgentSession[], renames: Record<string, string>): AgentSession[] {
  return sessions.map((session) => {
    const title = renames[selectedAgentSessionKey(session)]?.trim();
    return title ? { ...session, title } : session;
  });
}

export function formatAge(ageSeconds: number): string {
  if (ageSeconds < 60) return "just now";
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatAbsoluteTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

export function recallAuditLines(recall: RecallStatus | null): string[] {
  if (!recall) return [];
  return [
    recall.source ? `Source: ${recall.source}` : null,
    recall.source_count != null ? `Sources: ${recall.source_count}` : null,
    recall.source_titles.length ? `Source titles: ${recall.source_titles.slice(0, 3).join("; ")}` : null,
    recall.used_for_launch_at
      ? `Used for launch: ${formatAbsoluteTime(recall.used_for_launch_at)}${recall.last_launch_agent ? ` (${recall.last_launch_agent})` : ""}`
      : "Used for launch: not yet",
  ].filter((line): line is string => Boolean(line));
}

export function terminalGridTitles(kind: EmbeddedTerminalKind): string[] {
  if (kind === "hermes") return ["Hermes"];
  if (kind === "codex") return ["Codex Builder", "Codex Reviewer", "Codex Scout", "Codex Fixer"];
  if (kind === "opencode") return ["OpenCode Builder", "OpenCode Reviewer", "OpenCode Scout", "OpenCode Fixer"];
  if (kind === "claude") return ["Claude Builder", "Claude Reviewer", "Claude Scout", "Claude Fixer"];
  if (kind === "athena") return ["Athena Builder", "Athena Reviewer", "Athena Scout", "Athena Fixer"];
  return ["Shell"];
}

export function providerLabel(provider: AgentSession["provider"]): string {
  if (provider === "hermes") return "Hermes";
  if (provider === "opencode") return "OpenCode";
  if (provider === "athena") return "Athena Code";
  if (provider === "claude") return "Claude";
  return "Codex";
}

export function terminalPaneMeta(session: EmbeddedTerminalSession): string {
  if (session.kind === "shell") return `${session.status}${session.pid ? ` · pid ${session.pid}` : ""}`;
  return session.sessionLabel ?? "New";
}

export function formatSessionTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "unknown";
  const ageSeconds = Math.max(0, (Date.now() - timestamp) / 1000);
  return formatAge(ageSeconds);
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
