import type { AgentSession, EmbeddedTerminalSession } from "./electron";

export function agentSessionKey(session: AgentSession): string {
  return `${session.provider}:${session.id}`;
}

export function selectedAgentSessionKey(session: AgentSession): string {
  return `agent:${agentSessionKey(session)}`;
}

export function embeddedSessionKey(session: EmbeddedTerminalSession): string {
  if (session.providerSessionId) return `embedded-provider:${session.kind}:${session.providerSessionId}`;
  return `embedded:${session.id}`;
}

export function appendEmbeddedSessions(
  current: EmbeddedTerminalSession[],
  incoming: EmbeddedTerminalSession[],
): EmbeddedTerminalSession[] {
  const incomingById = new Map(incoming.map((session) => [session.id, session]));
  const existing = current.map((session) => incomingById.get(session.id) ?? session);
  const existingIds = new Set(existing.map((session) => session.id));
  const added = incoming.filter((session) => !existingIds.has(session.id));
  return [...existing, ...added];
}
