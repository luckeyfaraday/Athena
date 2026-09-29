import type { AgentSession, EmbeddedTerminalKind, EmbeddedTerminalSession } from "./electron";
import { agentSessionKey, appendEmbeddedSessions, embeddedSessionKey, selectedAgentSessionKey } from "./session-rename-keys.ts";
import { normalizeWorkspaceKey } from "./workspace-utils.ts";

export { agentSessionKey, appendEmbeddedSessions, embeddedSessionKey, selectedAgentSessionKey } from "./session-rename-keys.ts";

export type SessionProviderFilter = AgentSession["provider"] | "all";

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

export function terminalGridTitles(kind: EmbeddedTerminalKind): string[] {
  if (kind === "hermes") return ["Hermes"];
  if (kind === "codex") return ["Codex Builder", "Codex Reviewer", "Codex Scout", "Codex Fixer"];
  if (kind === "opencode") return ["OpenCode Builder", "OpenCode Reviewer", "OpenCode Scout", "OpenCode Fixer"];
  if (kind === "claude") return ["Claude Builder", "Claude Reviewer", "Claude Scout", "Claude Fixer"];
  if (kind === "athena") return ["Athena Builder", "Athena Reviewer", "Athena Scout", "Athena Fixer"];
  if (kind === "grok") return ["Grok Builder", "Grok Reviewer", "Grok Scout", "Grok Fixer"];
  return ["Shell"];
}

export function providerLabel(provider: AgentSession["provider"]): string {
  if (provider === "hermes") return "Hermes";
  if (provider === "opencode") return "OpenCode";
  if (provider === "athena") return "Athena Code";
  if (provider === "claude") return "Claude";
  if (provider === "grok") return "Grok";
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

// Friendlier relative time for the Sessions list ("3 min ago", "yesterday").
export function formatRelativeTime(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "unknown";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  if (hours < 48) return "yesterday";
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? "last week" : `${weeks} weeks ago`;
  }
  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

export function formatAbsoluteTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "Unknown time";
}

// Every whitespace-separated term must appear in the title, id, branch, model, agent or provider.
export function matchesSessionQuery(session: AgentSession, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [session.title, session.id, session.branch, session.model, session.agent, providerLabel(session.provider)]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

// Every pane's number among panes of its kind in its workspace (oldest first),
// and how many such panes there are. Mirrors agentHandle() in
// client/electron/agent-routing.ts so visible numbers line up with the handles
// the routing layer accepts ("claude#2"). Shell panes are numbered too.
export function paneInstanceNumbers(sessions: EmbeddedTerminalSession[]): Map<string, { number: number; total: number }> {
  const groups = new Map<string, EmbeddedTerminalSession[]>();
  for (const session of sessions) {
    const workspaceKey = normalizeWorkspaceKey(session.workspace);
    if (!workspaceKey) continue;
    const key = `${session.kind}|${workspaceKey}`;
    const group = groups.get(key);
    if (group) group.push(session);
    else groups.set(key, [session]);
  }
  const numbers = new Map<string, { number: number; total: number }>();
  for (const session of sessions) numbers.set(session.id, { number: 1, total: 1 });
  for (const group of groups.values()) {
    group.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id));
    group.forEach((session, index) => numbers.set(session.id, { number: index + 1, total: group.length }));
  }
  return numbers;
}

export function paneStatusLabel(session: EmbeddedTerminalSession): string {
  if (session.status === "running") return "Running";
  if (session.status === "failed") return session.error ? `Failed: ${session.error}` : "Failed";
  return session.exitCode == null ? "Exited" : `Exited with code ${session.exitCode}`;
}

export function workspaceFolderName(workspace: string): string {
  return workspace.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).at(-1) ?? workspace;
}
