import type { ReactNode } from "react";
import { ChevronRight, Code2, FileText, TerminalSquare } from "lucide-react";
import type { AgentSession, EmbeddedTerminalSession } from "../electron";
import { StatusDot } from "../components/status";
import { formatSessionTime, providerLabel, selectedAgentSessionKey } from "../session-utils";

type AgentRole = {
  role: string;
  type: string;
  icon: ReactNode;
  status: "ready" | "running" | "waiting" | "offline";
  brief: string;
};

export function SwarmRoom({
  roles,
  sessions,
  agentSessions,
  onOpenCommand,
  onInspectEmbeddedSession,
  onInspectAgentSession,
}: {
  roles: AgentRole[];
  sessions: EmbeddedTerminalSession[];
  agentSessions: AgentSession[];
  onOpenCommand: () => void;
  onInspectEmbeddedSession: (session: EmbeddedTerminalSession) => void;
  onInspectAgentSession: (session: AgentSession) => void;
}) {
  const liveAgentSessions = sessions.filter((session) => session.kind !== "shell");
  const recentHistoricalSessions = agentSessions.filter((session) => session.status === "historical").slice(0, 6);
  return (
    <div className="roomPanel swarmRoom">
      <div className="agentRoleGrid">
        {roles.map((agent) => (
          <article key={agent.role} className={`agentCard ${agent.status}`}>
            <div className="agentCardTop">
              <div className="agentIcon">{agent.icon}</div>
              <StatusDot status={agent.status} />
            </div>
            <span className="tinyLabel">{agent.type}</span>
            <h3>{agent.role}</h3>
            <p>{agent.brief}</p>
            <div className="agentCardFooter">
              <span>{agent.status}</span>
              <ChevronRight size={16} />
            </div>
          </article>
        ))}
      </div>

      <div className="liveAgentBoard">
        <div className="roomPanelHeader compact">
          <div>
            <span className="tinyLabel">Live agent sessions</span>
            <h3>{liveAgentSessions.length ? "Active sessions" : "No live agents"}</h3>
          </div>
          <button type="button" className="ghostButton" onClick={onOpenCommand}>
            <TerminalSquare size={14} /> Open Command
          </button>
        </div>
        <div className="agentSessionBoard">
          {liveAgentSessions.map((session) => (
            <article key={session.id}>
              <StatusDot status={session.status === "running" ? "running" : "offline"} />
              <div>
                <strong>{session.title}</strong>
                <p>{session.kind} · {session.status}{session.sessionLabel ? ` · ${session.sessionLabel}` : ""}</p>
              </div>
              <span>{session.pid ? `pid ${session.pid}` : "no pid"}</span>
              <button type="button" className="ghostIconButton" onClick={() => onInspectEmbeddedSession(session)}>
                <FileText size={14} />
              </button>
            </article>
          ))}
          {liveAgentSessions.length === 0 && (
            <div className="emptyState">
              <TerminalSquare size={22} />
              <strong>No live agents.</strong>
              <span>Launch Codex, OpenCode, Claude, or Hermes from the Command Room to populate this board.</span>
            </div>
          )}
        </div>
      </div>

      <div className="historicalAgentBoard">
        <div className="roomPanelHeader compact">
          <div>
            <span className="tinyLabel">Recent native sessions</span>
            <h3>{recentHistoricalSessions.length ? "Available to inspect or resume" : "No historical sessions"}</h3>
          </div>
        </div>
        <div className="agentSessionBoard compact">
          {recentHistoricalSessions.map((session) => (
            <article key={selectedAgentSessionKey(session)}>
              <StatusDot status="ready" />
              <div>
                <strong>{session.title}</strong>
                <p>{providerLabel(session.provider)} · {formatSessionTime(session.updatedAt)}</p>
              </div>
              <span>{session.status}</span>
              <button type="button" className="ghostIconButton" onClick={() => onInspectAgentSession(session)}>
                <FileText size={14} />
              </button>
            </article>
          ))}
          {recentHistoricalSessions.length === 0 && (
            <div className="emptyState compact">
              <Code2 size={22} />
              <strong>No native history yet.</strong>
              <span>Sessions appear here after Codex, OpenCode, Claude, or Hermes writes history for this workspace.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
