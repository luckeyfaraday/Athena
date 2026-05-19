import { FolderOpen, XCircle } from "lucide-react";
import type { EmbeddedTerminalSession, WorkspacePath } from "../electron";
import type { WorkspaceAttention } from "../workspace-attention";
import { sameWorkspacePath, workspaceDisplayName, workspaceKey } from "../workspace-utils";

export function WorkspaceTabs({
  workspaces,
  activeWorkspace,
  terminalSessions,
  attentionByWorkspace = {},
  className = "",
  onSelect,
  onClose,
  onAdd,
}: {
  workspaces: WorkspacePath[];
  activeWorkspace: WorkspacePath | null;
  terminalSessions: EmbeddedTerminalSession[];
  attentionByWorkspace?: Record<string, WorkspaceAttention>;
  className?: string;
  onSelect: (workspace: WorkspacePath) => void;
  onClose: (workspace: WorkspacePath) => void;
  onAdd: () => Promise<void>;
}) {
  return (
    <div className={className ? `workspaceTabs ${className}` : "workspaceTabs"} aria-label="Open workspaces">
      <div className="workspaceTabList">
        {workspaces.map((workspace) => {
          const active = activeWorkspace ? workspaceKey(activeWorkspace) === workspaceKey(workspace) : false;
          const running = terminalSessions.filter((session) => sameWorkspacePath(session.workspace, workspace.nativePath) && session.status === "running").length;
          const attention = attentionByWorkspace[workspaceKey(workspace)];
          return (
            <div
              key={workspace.nativePath}
              className={[
                "workspaceTab",
                active ? "active" : "",
                attention && !active ? `hasAttention ${attention.kind}` : "",
              ].filter(Boolean).join(" ")}
            >
              <button type="button" onClick={() => onSelect(workspace)} title={workspace.displayPath}>
                <span>
                  <strong>{workspaceDisplayName(workspace)}</strong>
                  <small>
                    {running} running
                    {attention && !active ? (
                      <em className={`workspaceAttentionBadge ${attention.kind}`} title={attention.kind === "action" ? "Needs attention" : "New activity"}>
                        {attention.kind === "action" ? "Needs attention" : "Updated"}{attention.count > 1 ? ` ${attention.count}` : ""}
                      </em>
                    ) : null}
                  </small>
                </span>
              </button>
              {workspaces.length > 1 && (
                <button
                  type="button"
                  className="workspaceTabClose"
                  aria-label={`Close ${workspaceDisplayName(workspace)}`}
                  onClick={() => onClose(workspace)}
                >
                  <XCircle size={12} />
                </button>
              )}
            </div>
          );
        })}
        {workspaces.length === 0 && <span className="workspaceTabEmpty">No workspace selected</span>}
      </div>
      <button type="button" className="workspaceAddButton" onClick={() => void onAdd()} title="Add workspace">
        <FolderOpen size={13} /> Add
      </button>
    </div>
  );
}
