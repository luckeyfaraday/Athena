import { useEffect, useMemo, useRef, useState, type ReactNode, type WheelEvent } from "react";
import { FolderOpen, FolderPlus, Pencil, X, XCircle } from "lucide-react";
import type { EmbeddedTerminalSession, WorkspacePath } from "../electron";
import type { WorkspaceAttention } from "../workspace-attention";
import { normalizeWorkspaceKey, workspaceDisplayName, workspaceKey } from "../workspace-utils";

const contextMenuWidth = 210;
const contextMenuHeight = 140;

export function WorkspaceTabs({
  workspaces,
  activeWorkspace,
  terminalSessions,
  attentionByWorkspace = {},
  className = "",
  leading,
  addTitle = "Add an existing folder as a workspace",
  emptyText = "No workspace open. Add a project folder to begin.",
  onSelect,
  onClose,
  onAdd,
  onCreate,
  onRename,
  onOpenInFiles,
}: {
  workspaces: WorkspacePath[];
  activeWorkspace: WorkspacePath | null;
  terminalSessions: EmbeddedTerminalSession[];
  attentionByWorkspace?: Record<string, WorkspaceAttention>;
  className?: string;
  // Shown before the tabs (the machine switcher).
  leading?: ReactNode;
  addTitle?: string;
  emptyText?: string;
  onSelect: (workspace: WorkspacePath) => void;
  onClose: (workspace: WorkspacePath) => void;
  onAdd: () => Promise<void>;
  onCreate?: () => Promise<void>;
  onRename?: (workspace: WorkspacePath) => void;
  // Omitted for another machine's folders, which this machine cannot open.
  onOpenInFiles?: (workspace: WorkspacePath) => void;
}) {
  const [menu, setMenu] = useState<{ workspace: WorkspacePath; x: number; y: number } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const activeKey = activeWorkspace ? workspaceKey(activeWorkspace) : null;

  // One pass over the sessions instead of a filter per tab.
  const runningByWorkspace = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of terminalSessions) {
      if (session.status !== "running") continue;
      const key = normalizeWorkspaceKey(session.workspace);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [terminalSessions]);

  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menu]);

  // Keep the active tab visible when it changes (shortcut, palette, notification click).
  useEffect(() => {
    if (!activeKey) return;
    const tab = listRef.current?.querySelector<HTMLElement>(`[data-workspace-key="${CSS.escape(activeKey)}"]`);
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey]);

  // A vertical mouse wheel scrolls the tab strip sideways.
  function scrollTabs(event: WheelEvent<HTMLDivElement>) {
    const list = listRef.current;
    if (!list || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    list.scrollLeft += event.deltaY;
  }

  function openMenu(workspace: WorkspacePath, x: number, y: number) {
    // Nothing to offer (a single remote tab): no empty menu.
    if (!onOpenInFiles && !onRename && workspaces.length <= 1) return;
    setMenu({
      workspace,
      x: Math.min(x, window.innerWidth - contextMenuWidth - 8),
      y: Math.min(y, window.innerHeight - contextMenuHeight - 8),
    });
  }

  return (
    <div className={["workspaceTabs", leading ? "withLeading" : "", className].filter(Boolean).join(" ")}>
      {leading}
      <div className="workspaceTabList" ref={listRef} role="tablist" aria-label="Open workspaces" onWheel={scrollTabs}>
        {workspaces.map((workspace) => {
          const key = workspaceKey(workspace);
          const active = key === activeKey;
          const running = runningByWorkspace.get(key) ?? 0;
          const attention = active ? undefined : attentionByWorkspace[key];
          const name = workspaceDisplayName(workspace);
          return (
            <div
              key={workspace.nativePath}
              data-workspace-key={key}
              className={[
                "workspaceTab",
                active ? "active" : "",
                attention ? `hasAttention ${attention.kind}` : "",
              ].filter(Boolean).join(" ")}
              onContextMenu={(event) => {
                event.preventDefault();
                openMenu(workspace, event.clientX, event.clientY);
              }}
              onAuxClick={(event) => {
                // Middle-click closes, like browser tabs.
                if (event.button === 1 && workspaces.length > 1) {
                  event.preventDefault();
                  onClose(workspace);
                }
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onSelect(workspace)}
                title={`${workspace.displayPath}\n${running} running`}
              >
                <span className="workspaceTabName">{name}</span>
                {attention ? (
                  <em
                    className={`workspaceAttentionBadge ${attention.kind}`}
                    title={attention.kind === "action" ? "An agent here is waiting for you" : "An agent here finished"}
                  >
                    {attention.kind === "action" ? "Needs input" : "Done"}{attention.count > 1 ? ` ${attention.count}` : ""}
                  </em>
                ) : running > 0 ? (
                  <span className={active ? "workspaceTabCount live" : "workspaceTabCount"} aria-label={`${running} running`}>{running}</span>
                ) : null}
              </button>
              {workspaces.length > 1 && (
                <button
                  type="button"
                  className="workspaceTabClose"
                  aria-label={`Close ${name}`}
                  title={running > 0 ? `Close ${name} and stop its ${running} terminal${running === 1 ? "" : "s"}` : `Close ${name}`}
                  onClick={() => onClose(workspace)}
                >
                  <X size={13} />
                </button>
              )}
            </div>
          );
        })}
        {workspaces.length === 0 && <span className="workspaceTabEmpty">{emptyText}</span>}
      </div>
      {menu && (
        <div
          className="workspaceContextMenu"
          style={{ left: menu.x, top: menu.y, width: contextMenuWidth }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
        >
          {onOpenInFiles && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onOpenInFiles(menu.workspace);
                setMenu(null);
              }}
            >
              <FolderOpen size={14} /> Open in file manager
            </button>
          )}
          {onRename && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onRename(menu.workspace);
                setMenu(null);
              }}
            >
              <Pencil size={14} /> Rename…
            </button>
          )}
          {workspaces.length > 1 && (
            <>
              <div className="menuSeparator" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => {
                  onClose(menu.workspace);
                  setMenu(null);
                }}
              >
                <XCircle size={14} /> Close workspace
              </button>
            </>
          )}
        </div>
      )}
      <div className="workspaceTabActions">
        <button type="button" className="workspaceAddButton" onClick={() => void onAdd()} title={addTitle}>
          <FolderOpen size={14} /> Add
        </button>
        {onCreate && (
          <button type="button" className="workspaceAddButton" onClick={() => void onCreate()} title="Create a new folder and add it as a workspace">
            <FolderPlus size={14} /> New folder
          </button>
        )}
      </div>
    </div>
  );
}
