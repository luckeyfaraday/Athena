import path from "node:path";
import type { EmbeddedTerminalSession } from "./embedded-terminal.js";

export function agentHandle(session: EmbeddedTerminalSession, sessions: EmbeddedTerminalSession[]): string {
  const peers = sessions
    .filter((item) => sameWorkspace(item.workspace, session.workspace) && item.kind === session.kind && item.kind !== "shell")
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id));
  const index = peers.findIndex((item) => item.id === session.id);
  return `${session.kind}#${Math.max(0, index) + 1}`;
}

export function agentHandleMap(sessions: EmbeddedTerminalSession[]): Map<string, string> {
  return new Map(sessions.map((session) => [session.id, agentHandle(session, sessions)]));
}

export function resolveAgentTarget(
  target: string,
  sessions: EmbeddedTerminalSession[],
  workspace?: string | null,
): EmbeddedTerminalSession {
  const normalized = target.trim();
  if (!normalized) throw new Error("Agent target is required.");
  const scoped = workspace
    ? sessions.filter((session) => sameWorkspace(session.workspace, workspace))
    : sessions;

  const direct = scoped.find((session) => session.id === normalized || session.providerSessionId === normalized);
  if (direct) return direct;

  const handles = agentHandleMap(scoped);
  const matches = scoped.filter((session) => {
    const handle = handles.get(session.id);
    if (handle === normalized) return true;
    const peers = scoped.filter((item) => item.kind === session.kind && item.kind !== "shell");
    return peers.length === 1 && handle === `${normalized}#1`;
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Agent target is ambiguous across workspaces: ${target}. Pass workspace or terminal id.`);
  }
  throw new Error(`Embedded terminal target not found: ${target}`);
}

function sameWorkspace(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}
