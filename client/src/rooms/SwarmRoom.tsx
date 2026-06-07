import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Code2, FileText, Send, TerminalSquare } from "lucide-react";
import type { AgentMessage, AgentSession, EmbeddedTerminalSession, TerminalControlState } from "../electron";
import { agentRoleLabel, embeddedSessionDotStatus, StatusDot, type DotStatus } from "../components/status";
import { formatSessionTime, providerLabel, selectedAgentSessionKey } from "../session-utils";

export type AgentRole = {
  role: string;
  type: string;
  icon: ReactNode;
  status: DotStatus;
  brief: string;
};

export function SwarmRoom({
  roles,
  sessions,
  agentSessions,
  agentMessages,
  terminalControl,
  onOpenCommand,
  onSendAgentMessage,
  onInspectEmbeddedSession,
  onInspectAgentSession,
}: {
  roles: AgentRole[];
  sessions: EmbeddedTerminalSession[];
  agentSessions: AgentSession[];
  agentMessages: AgentMessage[];
  terminalControl: TerminalControlState[];
  onOpenCommand: () => void;
  onSendAgentMessage: (to: string, text: string, replyRequested: boolean) => Promise<void>;
  onInspectEmbeddedSession: (session: EmbeddedTerminalSession) => void;
  onInspectAgentSession: (session: AgentSession) => void;
}) {
  const [selectedTarget, setSelectedTarget] = useState("");
  const [messageText, setMessageText] = useState("");
  const [replyRequested, setReplyRequested] = useState(true);
  const [sending, setSending] = useState(false);
  const liveAgentSessions = sessions.filter((session) => session.kind !== "shell");
  const recentHistoricalSessions = agentSessions.filter((session) => session.status === "historical").slice(0, 6);
  const handles = useMemo(() => agentHandles(liveAgentSessions), [liveAgentSessions]);
  const selectedTo = selectedTarget || handles[0]?.handle || "";
  const sortedMessages = [...agentMessages].sort((left, right) => Date.parse(left.at) - Date.parse(right.at)).slice(-50);

  async function submitMessage() {
    const text = messageText.trim();
    if (!selectedTo || !text || sending) return;
    setSending(true);
    try {
      await onSendAgentMessage(selectedTo, text, replyRequested);
      setMessageText("");
    } finally {
      setSending(false);
    }
  }

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
              <span>{agentRoleLabel(agent.status)}</span>
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
              <StatusDot status={embeddedSessionDotStatus(session.status)} />
              <div>
                <strong>{session.title}</strong>
                <p>{handles.find((item) => item.id === session.id)?.handle ?? session.kind} - {session.status}{session.sessionLabel ? ` - ${session.sessionLabel}` : ""}</p>
              </div>
              <span>{terminalStatusLabel(session, terminalControl)}</span>
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

      <div className="agentConversationBoard">
        <div className="roomPanelHeader compact">
          <div>
            <span className="tinyLabel">Agent messages</span>
            <h3>{sortedMessages.length ? "Conversation thread" : "No messages yet"}</h3>
          </div>
        </div>
        <div className="agentMessageThread">
          {sortedMessages.map((message) => (
            <article key={message.id} className={`agentMessage ${message.status}`}>
              <div>
                <strong>{message.from}</strong>
                <span>{message.to} - {message.status}</span>
              </div>
              <p>{message.preview}</p>
            </article>
          ))}
          {sortedMessages.length === 0 && (
            <div className="emptyState compact">
              <Send size={22} />
              <strong>No routed messages.</strong>
              <span>Messages sent through Athena control or MCP will appear here.</span>
            </div>
          )}
        </div>
        <div className="agentMessageComposer">
          <select value={selectedTo} onChange={(event) => setSelectedTarget(event.target.value)} disabled={handles.length === 0}>
            {handles.map((item) => (
              <option key={item.id} value={item.handle}>{item.handle} - {item.title}</option>
            ))}
          </select>
          <label>
            <input type="checkbox" checked={replyRequested} onChange={(event) => setReplyRequested(event.target.checked)} />
            Reply
          </label>
          <textarea
            value={messageText}
            onChange={(event) => setMessageText(event.target.value)}
            placeholder="Message an agent"
            rows={3}
            disabled={handles.length === 0}
          />
          <button type="button" className="primaryButton" onClick={() => void submitMessage()} disabled={!selectedTo || !messageText.trim() || sending}>
            <Send size={14} /> {sending ? "Sending" : "Send"}
          </button>
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
                <p>{providerLabel(session.provider)} - {formatSessionTime(session.updatedAt)}</p>
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

function agentHandles(sessions: EmbeddedTerminalSession[]): Array<{ id: string; handle: string; title: string }> {
  return sessions.map((session) => {
    const peers = sessions
      .filter((item) => item.kind === session.kind)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id));
    const index = peers.findIndex((item) => item.id === session.id);
    return {
      id: session.id,
      handle: `${session.kind}#${Math.max(0, index) + 1}`,
      title: session.title,
    };
  });
}

function terminalStatusLabel(session: EmbeddedTerminalSession, control: TerminalControlState[]): string {
  const state = control.find((item) => item.terminalId === session.id);
  if (state?.attentionReason) return state.attentionReason;
  if (session.pid) return `pid ${session.pid}`;
  return "no pid";
}
