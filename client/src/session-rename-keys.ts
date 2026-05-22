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
