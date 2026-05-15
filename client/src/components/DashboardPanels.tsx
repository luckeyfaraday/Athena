import type { ReactNode } from "react";
import { CheckCircle2, ChevronRight, Database, FileText, RefreshCw, ShieldCheck, Sparkles, Users } from "lucide-react";
import type { HermesStatus, RecallStatus } from "../api";
import type { AgentSession, EmbeddedTerminalSession } from "../electron";
import type { ActiveRoom } from "../routes";
import type { AgentRole } from "../rooms/SwarmRoom";
import { StatusPill } from "./status";
import { formatAge, recallAuditLines } from "../session-utils";

export function ContextGlance({
  tasks,
  active,
  agents,
  memory,
  reviews,
  onNavigate,
}: {
  tasks: number;
  active: number;
  agents: number;
  memory: number;
  reviews: number;
  onNavigate: (room: ActiveRoom) => void;
}) {
  return (
    <section className="dashboardCard contextGlance">
      <div className="cardHeader">
        <span>ATHENA at a glance</span>
      </div>
      <MetricRow icon={<CheckCircle2 size={15} />} tone="green" label="Sessions" value={tasks} detail={`${active} running`} onClick={() => onNavigate("swarm")} />
      <MetricRow icon={<Users size={15} />} tone="violet" label="Adapters" value={agents} detail="Installed locally" onClick={() => onNavigate("swarm")} />
      <MetricRow icon={<Database size={15} />} tone="blue" label="Memory Entries" value={memory} detail="Recent memory" onClick={() => onNavigate("memory")} />
      <MetricRow icon={<ShieldCheck size={15} />} tone="orange" label="Reviews" value={reviews} detail="Inspectable sessions" onClick={() => onNavigate("review")} />
    </section>
  );
}

export function LiveWorkflow({ activeSessions, reviewSessions, memoryCount }: { activeSessions: number; reviewSessions: number; memoryCount: number }) {
  return (
    <section className="dashboardCard liveWorkflow">
      <div className="cardHeader">
        <span>Session Workflow</span>
      </div>
      <div className="workflowTrack">
        <FlowStep icon={<FileText size={14} />} label="Session" active />
        <ChevronRight size={18} />
        <FlowStep icon={<Users size={14} />} label="Agents" active={activeSessions > 0} />
        <ChevronRight size={18} />
        <FlowStep icon={<ShieldCheck size={14} />} label="Review" active={reviewSessions > 0} />
        <ChevronRight size={18} />
        <FlowStep icon={<Database size={14} />} label="Memory" active={memoryCount > 0} />
      </div>
    </section>
  );
}

export function ActiveAgents({ roles, embeddedSessions }: { roles: AgentRole[]; embeddedSessions: EmbeddedTerminalSession[] }) {
  const liveByRole = new Set<string>(embeddedSessions.filter((session) => session.status === "running").map((session) => session.kind));
  return (
    <section className="dashboardCard activeAgents">
      <div className="cardHeader">
        <span>Active Agents</span>
      </div>
      <div className="agentRows">
        {roles.map((role) => {
          const busy = role.status === "running" || liveByRole.has(role.type);
          return (
            <article key={role.role}>
              <span className={`agentBadge ${busy ? "busy" : role.status}`}>{role.icon}</span>
              <div>
                <strong>{role.role}</strong>
                <small>{role.brief}</small>
              </div>
              <em className={busy ? "busy" : role.status}>{busy ? "Busy" : role.status === "ready" ? "Online" : role.status}</em>
              <ChevronRight size={14} />
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function MemoryTimeline({ entries, embeddedSessions, agentSessions }: { entries: string[]; embeddedSessions: EmbeddedTerminalSession[]; agentSessions: AgentSession[] }) {
  const latestSession = embeddedSessions.at(-1) ?? agentSessions.at(0) ?? null;
  const runningSessions = embeddedSessions.filter((session) => session.status === "running").length;
  const timeline = [
    { time: "Now", label: "ATHENA Updated", detail: entries[0] ?? "Shared context is ready", tone: "memory" },
    { time: "Session", label: "Latest Session", detail: latestSession?.title ?? "No session started yet", tone: "run" },
    { time: "Agent", label: "Agent State", detail: `${runningSessions} live sessions`, tone: "agent" },
    { time: "Memory", label: "Hermes Sync", detail: `${entries.length} memory entries available`, tone: "system" },
  ];
  return (
    <section className="dashboardCard memoryTimeline">
      <div className="cardHeader">
        <span>Memory Timeline</span>
      </div>
      <div className="timelineList">
        {timeline.map((item) => (
          <article key={item.label}>
            <time>{item.time}</time>
            <span className={`timelineDot ${item.tone}`}><Sparkles size={13} /></span>
            <div>
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </div>
            <em>{item.tone}</em>
          </article>
        ))}
      </div>
    </section>
  );
}

export function SharedMemorySnapshot({
  workspace,
  entries,
  hermes,
  recall,
  embeddedSessions,
  agentSessions,
  refreshing,
  onRefresh,
}: {
  workspace: string;
  entries: string[];
  hermes: HermesStatus | null;
  recall: RecallStatus | null;
  embeddedSessions: EmbeddedTerminalSession[];
  agentSessions: AgentSession[];
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const recallLabel = recall ? recall.status : "unknown";
  const recallAge = recall?.age_seconds == null ? "not refreshed" : formatAge(recall.age_seconds);
  const latestSession = embeddedSessions.at(-1) ?? agentSessions.at(0) ?? null;
  const runningSessions = embeddedSessions.filter((session) => session.status === "running").length;
  const lines = [
    "# ATHENA",
    `- Workspace: ${workspace || "not selected"}`,
    `- Hermes: ${hermes?.installed ? "online" : "setup required"}`,
    `- Recall: ${recallLabel} (${recallAge})`,
    `- Recall refresh: ${recall?.refresh_configured ? "configured" : "not configured"}`,
    ...recallAuditLines(recall).map((line) => `- ${line}`),
    `- Live sessions: ${runningSessions}`,
    `- Latest session: ${latestSession ? latestSession.title : "none"}`,
    `- Memory entries: ${entries.length}`,
    ...(entries[0] ? [`- Latest memory: ${entries[0]}`] : []),
  ];
  const recallTone = !recall ? "warn" : recall.status === "fresh" ? "ok" : recall.status === "missing" ? "bad" : "warn";
  return (
    <section className="dashboardCard sharedSnapshot">
      <div className="cardHeader">
        <span>Shared Memory Snapshot</span>
        <div className="cardHeaderActions">
          <StatusPill tone={recallTone}>Recall {recallLabel}</StatusPill>
          <button type="button" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw size={13} /> {refreshing ? "Refreshing" : "Refresh recall"}
          </button>
        </div>
      </div>
      <div className="snapshotBody">
        <pre>{lines.join("\n")}</pre>
      </div>
    </section>
  );
}

function MetricRow({ icon, tone, label, value, detail, onClick }: { icon: ReactNode; tone: string; label: string; value: number; detail: string; onClick: () => void }) {
  return (
    <button type="button" className="metricRow" onClick={onClick}>
      <span className={`metricIcon ${tone}`}>{icon}</span>
      <div>
        <strong>{label}</strong>
        <b>{value}</b>
        <small>{detail}</small>
      </div>
      <ChevronRight size={15} />
    </button>
  );
}

function FlowStep({ icon, label, active }: { icon: ReactNode; label: string; active?: boolean }) {
  return (
    <div className={active ? "flowStep active" : "flowStep"}>
      {icon}
      <span>{label}</span>
    </div>
  );
}
