import { Edit3, FolderOpen, Play, RefreshCw, TerminalSquare, Trash2 } from "lucide-react";
import type { RecallStatus } from "../api";
import type { AgentSession, EmbeddedTerminalSession, WorkspacePath } from "../electron";
import { StatusPill } from "../components/status";
import { formatAge } from "../session-utils";

export type WorkspaceSummary = {
  workspace: WorkspacePath;
  active: boolean;
  runningTerminals: number;
  totalTerminals: number;
  agentSessions: number | null;
  memoryEntries: number | null;
  recall: RecallStatus | null;
  lastActiveAt: string | null;
};

export function WorkspaceRoom({
  summaries,
  activeWorkspace,
  terminalSessions,
  agentSessions,
  busy,
  onAdd,
  onOpen,
  onRemove,
  onRename,
  onRefreshRecall,
}: {
  summaries: WorkspaceSummary[];
  activeWorkspace: WorkspacePath | null;
  terminalSessions: EmbeddedTerminalSession[];
  agentSessions: AgentSession[];
  busy: boolean;
  onAdd: () => Promise<void>;
  onOpen: (workspace: WorkspacePath) => void;
  onRemove: (workspace: WorkspacePath) => void;
  onRename: (workspace: WorkspacePath) => void;
  onRefreshRecall: () => void;
}) {
  const activeSummary = summaries.find((summary) => summary.active) ?? null;
  const totalRunning = summaries.reduce((count, summary) => count + summary.runningTerminals, 0);
  const staleActiveRecall = activeSummary?.recall?.status && activeSummary.recall.status !== "fresh";

  return (
    <section className="roomPanel workspaceRoom">
      <div className="workspaceRoomHero">
        <div>
          <span className="tinyLabel">Project workspaces</span>
          <h3>{activeWorkspace ? activeWorkspace.displayPath : "No active workspace"}</h3>
          <p>Saved projects stay available here so Command Room can stay focused on terminals.</p>
        </div>
        <div className="buttonRow">
          <button type="button" className="ghostButton" onClick={() => void onRefreshRecall()} disabled={!activeWorkspace || busy}>
            <RefreshCw size={14} /> Refresh Recall
          </button>
          <button type="button" className="primaryButton" onClick={() => void onAdd()} disabled={busy}>
            <FolderOpen size={14} /> Add Workspace
          </button>
        </div>
      </div>

      <div className="workspaceStats">
        <WorkspaceStat label="Saved Workspaces" value={summaries.length} detail={activeWorkspace ? "1 active" : "none active"} />
        <WorkspaceStat label="Live Terminals" value={totalRunning} detail={`${terminalSessions.length} total panes`} />
        <WorkspaceStat label="Native Sessions" value={agentSessions.length} detail="active workspace" />
        <WorkspaceStat label="Recall" value={activeSummary?.recall?.status ?? "unknown"} detail={staleActiveRecall ? "needs attention" : "active workspace"} />
      </div>

      <div className="workspaceTable" role="table" aria-label="Saved workspaces">
        <div className="workspaceTableHeader" role="row">
          <span>Workspace</span>
          <span>Terminals</span>
          <span>Sessions</span>
          <span>Recall</span>
          <span>Memory</span>
          <span>Last active</span>
          <span>Actions</span>
        </div>
        {summaries.map((summary) => (
          <article key={summary.workspace.nativePath} className={summary.active ? "workspaceRow active" : "workspaceRow"} role="row">
            <div className="workspaceIdentity">
              <strong>{workspaceName(summary.workspace)}</strong>
              <span>{summary.workspace.displayPath}</span>
              {summary.workspace.wslPath && <small>{summary.workspace.wslPath}</small>}
            </div>
            <WorkspaceCount value={summary.runningTerminals} detail={`${summary.totalTerminals} total`} />
            <WorkspaceCount value={summary.agentSessions ?? "Open"} detail={summary.agentSessions == null ? "to load" : "native"} />
            <StatusPill tone={recallTone(summary.recall, summary.active)}>{summary.active ? summary.recall?.status ?? "Unknown" : "Open to check"}</StatusPill>
            <WorkspaceCount value={summary.memoryEntries ?? "Open"} detail={summary.memoryEntries == null ? "to load" : "entries"} />
            <span className="workspaceLastActive">{summary.lastActiveAt ? formatWorkspaceAge(summary.lastActiveAt) : "No activity"}</span>
            <div className="workspaceActions">
              <button type="button" onClick={() => onOpen(summary.workspace)} disabled={summary.active}>
                <Play size={13} /> {summary.active ? "Active" : "Open"}
              </button>
              <button type="button" onClick={() => onRename(summary.workspace)}>
                <Edit3 size={13} /> Rename
              </button>
              <button type="button" className="danger" onClick={() => onRemove(summary.workspace)} disabled={summary.active && summaries.length === 1}>
                <Trash2 size={13} /> Remove
              </button>
            </div>
          </article>
        ))}
        {summaries.length === 0 && (
          <div className="workspaceEmpty">
            <TerminalSquare size={26} />
            <strong>No workspaces saved.</strong>
            <span>Add a project folder to start tracking terminals, sessions, recall, and memory by workspace.</span>
          </div>
        )}
      </div>
    </section>
  );
}

function WorkspaceStat({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return (
    <article>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function WorkspaceCount({ value, detail }: { value: string | number; detail: string }) {
  return (
    <span className="workspaceCount">
      <strong>{value}</strong>
      <small>{detail}</small>
    </span>
  );
}

function workspaceName(workspace: WorkspacePath): string {
  const normalized = workspace.displayPath.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? workspace.displayPath;
}

function formatWorkspaceAge(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Unknown";
  return formatAge(Math.max(0, (Date.now() - timestamp) / 1000));
}

function recallTone(recall: RecallStatus | null, active: boolean): "ok" | "warn" | "bad" {
  if (!active) return "warn";
  if (!recall) return "warn";
  if (recall.status === "fresh") return "ok";
  if (recall.status === "missing") return "bad";
  return "warn";
}
