import type { ReactNode } from "react";
import type { AdapterStatus, BackendStatus, HermesStatus, RecallStatus, RunStatus } from "../api";
import type { AgentSession, EmbeddedTerminalSession, NativeTerminalSession } from "../electron";

export type StatusTone = "ok" | "warn" | "bad";
export type DotStatus = "ready" | "running" | "waiting" | "offline";

export type StatusView<TTone extends string = StatusTone> = {
  label: string;
  tone: TTone;
};

export function StatusPill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className={`statusPill ${tone}`}>
      <span />
      {children}
    </span>
  );
}

export function StatusDot({ status }: { status: DotStatus }) {
  return <span className={`statusDot ${status}`} />;
}

export function backendStatusView(backend: BackendStatus | null): StatusView {
  if (backend?.healthy) return { tone: "ok", label: "Healthy" };
  if (backend?.running) return { tone: "warn", label: "Starting" };
  return { tone: "bad", label: "Offline" };
}

export function hermesStatusView(hermes: HermesStatus | null): StatusView {
  if (hermes?.installed) return { tone: "ok", label: hermes.version ?? "Installed" };
  return { tone: "bad", label: "Missing" };
}

export function recallStatusView(recall: RecallStatus | null, options: { active?: boolean; inactiveLabel?: string } = {}): StatusView {
  if (options.active === false) return { tone: "warn", label: options.inactiveLabel ?? "Open to check" };
  if (!recall) return { tone: "warn", label: "Unknown" };
  if (recall.status === "fresh") return { tone: "ok", label: "fresh" };
  if (recall.status === "missing") return { tone: "bad", label: "missing" };
  return { tone: "warn", label: "stale" };
}

export function adapterInstallStatusView(adapters: AdapterStatus[]): StatusView {
  const installed = adapters.filter((adapter) => adapter.installed).length;
  return {
    tone: installed > 0 ? "ok" : "warn",
    label: `${installed}/${adapters.length || 0} installed`,
  };
}

export function agentRoleLabel(status: DotStatus): string {
  return status === "ready" ? "Online" : status;
}

export function activeAgentStatusView(roleStatus: DotStatus, busy: boolean): StatusView<DotStatus | "busy"> {
  if (busy) return { tone: "busy", label: "Busy" };
  return { tone: roleStatus, label: agentRoleLabel(roleStatus) };
}

export function embeddedSessionDotStatus(status: EmbeddedTerminalSession["status"]): DotStatus {
  return status === "running" ? "running" : "offline";
}

export function agentSessionDotStatus(status: AgentSession["status"]): DotStatus {
  if (status === "running") return "running";
  if (status === "exited") return "offline";
  return "ready";
}

export function inspectorStatusView({
  terminalId,
  hasTranscript,
  hasAgentSession,
}: {
  terminalId: string | null;
  hasTranscript: boolean;
  hasAgentSession: boolean;
}): StatusView {
  if (terminalId) return { tone: "ok", label: "Live buffer" };
  if (hasTranscript) return { tone: "ok", label: "Transcript" };
  if (hasAgentSession) return { tone: "warn", label: "Metadata only" };
  return { tone: "bad", label: "Empty" };
}

export function nativeTerminalStatusView(session: NativeTerminalSession): StatusView {
  return {
    tone: session.status === "launched" ? "ok" : "bad",
    label: session.pid ? `pid ${session.pid}` : session.status,
  };
}

const terminalRunStatuses = new Set<RunStatus>(["succeeded", "failed", "cancelled"]);

export function isTerminalRunStatus(status: RunStatus): boolean {
  return terminalRunStatuses.has(status);
}
