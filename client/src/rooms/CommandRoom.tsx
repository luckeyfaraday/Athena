import "./command-room.css";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  EyeOff,
  FolderOpen,
  History,
  LayoutGrid,
  Maximize2,
  MessageSquare,
  Minimize2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  TerminalSquare,
  X,
} from "lucide-react";
import type { AgentSession, EmbeddedTerminalKind, EmbeddedTerminalSession } from "../electron";
import { AgentGlyph } from "../components/AgentGlyph";
import { EmbeddedChatTerminal } from "../components/LazyEmbeddedChatTerminal";
import { EmbeddedTerminal } from "../components/EmbeddedTerminal";
import { isMacPlatform, shortcutKeysFor, type ShortcutId } from "../shortcuts";
import {
  agentSessionKey,
  formatAbsoluteTime,
  formatRelativeTime,
  matchesSessionQuery,
  paneInstanceNumbers,
  paneStatusLabel,
  providerLabel,
  readDeletedAgentSessions,
  type SessionProviderFilter,
  terminalGridTitles,
  terminalPaneMeta,
  workspaceFolderName,
  writeDeletedAgentSessions,
} from "../session-utils";
import { normalizeWorkspaceKey, sameWorkspacePath } from "../workspace-utils";
import {
  clampTerminalPaneHeight,
  reconcileTerminalPaneHeights,
  terminalFocusAfterCollapse,
} from "../pane-layout";

export type CommandRoomView = "terminals" | "sessions";
type InterfaceMode = "terminal" | "chat";

type PaneDragState = {
  id: string;
  deltaX: number;
  deltaY: number;
  targetId: string | null;
};

export type CommandRoomProps = {
  workspace: string;
  sessions: EmbeddedTerminalSession[];
  agentSessions: AgentSession[];
  busy: boolean;
  layoutResetNonce: number;
  interfaceMode: InterfaceMode;
  // Terminals / Sessions, controlled by App (palette and shortcuts switch it too).
  view: CommandRoomView;
  onViewChange: (view: CommandRoomView) => void;
  // When the nonce changes, show and focus that pane, then report it handled so
  // App clears the request (a remount must not replay it).
  revealPaneRequest: { id: string; nonce: number } | null;
  onRevealPaneHandled?: () => void;
  onInterfaceModeChange: (mode: InterfaceMode) => void;
  onLaunch: (kind: EmbeddedTerminalKind, count?: number) => Promise<void>;
  onClose: (id: string) => Promise<void>;
  onResumeSession: (session: AgentSession) => Promise<void>;
  onRenameEmbeddedSession: (session: EmbeddedTerminalSession) => void;
  onRenameAgentSession: (session: AgentSession) => void;
  onRefreshAgentSessions: (maxAgeMs?: number) => Promise<void>;
  onToast: (message: string) => void;
  onAddWorkspace?: () => void;
  // agent CLIs not on PATH: marked in the launch menus (launching one offers to install it)
  missingAgents?: ReadonlySet<EmbeddedTerminalKind>;
  emptyMark: ReactNode;
};

type LaunchOption = { kind: EmbeddedTerminalKind; label: string; detail: string };

const launchOptions: readonly LaunchOption[] = [
  { kind: "shell", label: "Shell", detail: "A plain terminal in this workspace" },
  { kind: "claude", label: "Claude Code", detail: "Anthropic's coding agent" },
  { kind: "codex", label: "Codex", detail: "OpenAI's coding agent" },
  { kind: "opencode", label: "OpenCode", detail: "Open-source coding agent" },
  { kind: "athena", label: "Athena Code", detail: "The Athena Code CLI" },
  { kind: "grok", label: "Grok", detail: "The Grok Build CLI" },
  { kind: "hermes", label: "Hermes", detail: "Long-term memory; can drive Athena over MCP" },
];

const sessionProviders: readonly AgentSession["provider"][] = ["claude", "codex", "opencode", "athena", "grok", "hermes"];
const gridSize = 4;
const dragThresholdPx = 4;
const closeConfirmMs = 2_500;

function supportsGrid(kind: EmbeddedTerminalKind): boolean {
  return terminalGridTitles(kind).length > 1;
}

function shortcutTitle(label: string, id: ShortcutId): string {
  const keys = shortcutKeysFor(id);
  return keys.length ? `${label} (${keys.join(isMacPlatform() ? "" : "+")})` : label;
}

function KeyHint({ id }: { id: ShortcutId }) {
  return (
    <span className="kbdGroup">
      {shortcutKeysFor(id).map((key, index) => <kbd key={`${key}-${index}`} className="kbd">{key}</kbd>)}
    </span>
  );
}

export function CommandRoom({
  workspace,
  sessions,
  agentSessions,
  busy,
  layoutResetNonce,
  interfaceMode,
  view,
  onViewChange,
  revealPaneRequest,
  onRevealPaneHandled,
  onInterfaceModeChange,
  onLaunch,
  onClose,
  onResumeSession,
  onRenameEmbeddedSession,
  onRenameAgentSession,
  onRefreshAgentSessions,
  onToast,
  onAddWorkspace,
  missingAgents,
  emptyMark,
}: CommandRoomProps) {
  const [paneOrderByWorkspace, setPaneOrderByWorkspace] = useState<Record<string, string[]>>({});
  const [dragState, setDragState] = useState<PaneDragState | null>(null);
  // Falls back to local state when rendered without App (browser harness).
  const [localView, setLocalView] = useState<CommandRoomView>("terminals");
  const activeView: CommandRoomView = view ?? localView;
  const [activeSessionProvider, setActiveSessionProvider] = useState<SessionProviderFilter>("all");
  const [sessionQuery, setSessionQuery] = useState("");
  const [deletedSessionKeys, setDeletedSessionKeys] = useState<Set<string>>(() => readDeletedAgentSessions(workspace));
  const [collapsedPaneIds, setCollapsedPaneIds] = useState<Set<string>>(new Set());
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null);
  const [activeTerminalPaneByWorkspace, setActiveTerminalPaneByWorkspace] = useState<Record<string, string>>({});
  const [paneHeightsByWorkspace, setPaneHeightsByWorkspace] = useState<Record<string, Record<string, number>>>({});
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [terminalViewIds, setTerminalViewIds] = useState<Set<string>>(new Set());
  const [armedCloseId, setArmedCloseId] = useState<string | null>(null);
  const [refreshingSessions, setRefreshingSessions] = useState(false);
  const armedCloseTimerRef = useRef(0);
  const dragTargetRef = useRef<string | null>(null);
  const paneSetSignatureByWorkspaceRef = useRef(new Map<string, string>());
  const lastRevealNonceRef = useRef<number | null>(null);
  const workspaceOrderKey = normalizeWorkspaceKey(workspace || "none");
  const sessionIds = sessions.map((session) => session.id);
  const sessionSignature = sessionIds.join("|");
  const paneOrder = paneOrderByWorkspace[workspaceOrderKey] ?? sessionIds;
  const activeTerminalPaneId = activeTerminalPaneByWorkspace[workspaceOrderKey] ?? null;
  const paneHeights = paneHeightsByWorkspace[workspaceOrderKey] ?? {};

  const setActiveView = useCallback((next: CommandRoomView) => {
    setLocalView(next);
    onViewChange?.(next);
  }, [onViewChange]);

  useEffect(() => {
    setPaneOrderByWorkspace((current) => {
      const existing = current[workspaceOrderKey] ?? [];
      const known = existing.filter((id) => sessionIds.includes(id));
      const added = sessionIds.filter((id) => !known.includes(id));
      const nextOrder = [...known, ...added];
      if (arraysEqual(existing, nextOrder)) return current;
      return { ...current, [workspaceOrderKey]: nextOrder };
    });
  }, [sessionSignature, workspaceOrderKey]);

  useEffect(() => {
    if (layoutResetNonce === 0 || sessions.length === 0) return;
    setPaneOrderByWorkspace((current) => ({ ...current, [workspaceOrderKey]: sessionIds }));
  }, [layoutResetNonce, sessionSignature, workspaceOrderKey]);

  useEffect(() => {
    const ids = new Set(sessions.map((session) => session.id));
    const visibleIds = new Set(
      sessions
        .filter((session) => sameWorkspacePath(session.workspace, workspace))
        .map((session) => session.id),
    );
    setCollapsedPaneIds((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
    setMaximizedPaneId((current) => current && visibleIds.has(current) ? current : null);
  }, [sessions, workspace]);

  const sessionById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const instanceNumbers = useMemo(() => paneInstanceNumbers(sessions), [sessions]);
  const visibleSessions = useMemo(
    () => paneOrder
      .map((id) => sessionById.get(id))
      .filter((session): session is EmbeddedTerminalSession => Boolean(session && sameWorkspacePath(session.workspace, workspace))),
    [paneOrder, sessionById, workspace],
  );
  const visibleSessionKey = visibleSessions.map((session) => session.id).join("|");
  const activeMaximizedPaneId = maximizedPaneId && visibleSessions.some((session) => session.id === maximizedPaneId)
    ? maximizedPaneId
    : null;

  const visibleAgentSessions = useMemo(
    () => agentSessions.filter((session) => !deletedSessionKeys.has(agentSessionKey(session))),
    [agentSessions, deletedSessionKeys],
  );
  const searchedAgentSessions = useMemo(
    () => visibleAgentSessions.filter((session) => matchesSessionQuery(session, sessionQuery)),
    [visibleAgentSessions, sessionQuery],
  );
  const providerTabs = useMemo(() => {
    const counts = new Map<SessionProviderFilter, number>();
    for (const session of searchedAgentSessions) counts.set(session.provider, (counts.get(session.provider) ?? 0) + 1);
    const tabs: Array<{ provider: SessionProviderFilter; label: string; count: number }> = [
      { provider: "all", label: "All", count: searchedAgentSessions.length },
    ];
    for (const provider of sessionProviders) {
      const count = counts.get(provider) ?? 0;
      if (count > 0 || provider === activeSessionProvider) tabs.push({ provider, label: providerLabel(provider), count });
    }
    return tabs;
  }, [searchedAgentSessions, activeSessionProvider]);
  const filteredAgentSessions = useMemo(
    () => activeSessionProvider === "all"
      ? searchedAgentSessions
      : searchedAgentSessions.filter((session) => session.provider === activeSessionProvider),
    [activeSessionProvider, searchedAgentSessions],
  );
  const runningAgentSessions = visibleAgentSessions.filter((session) => session.status === "running").length;
  const liveSessionSignature = sessions.map((session) => `${session.id}:${session.status}`).join("|");

  // Native session history is only scanned while the Sessions view is open.
  // Opening it (or a live pane starting/exiting) refreshes anything older
  // than a few seconds; while it stays open, refresh at most once a minute.
  useEffect(() => {
    if (activeView !== "sessions" || !workspace) return undefined;
    void onRefreshAgentSessions(5_000);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void onRefreshAgentSessions();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [activeView, workspace, liveSessionSignature, onRefreshAgentSessions]);

  useEffect(() => {
    const previousSignature = paneSetSignatureByWorkspaceRef.current.get(workspaceOrderKey);
    paneSetSignatureByWorkspaceRef.current.set(workspaceOrderKey, visibleSessionKey);
    setPaneHeightsByWorkspace((current) => {
      const existing = current[workspaceOrderKey] ?? {};
      const next = reconcileTerminalPaneHeights(
        existing,
        visibleSessions.map((session) => session.id),
        previousSignature !== undefined && previousSignature !== visibleSessionKey,
      );
      if (next === existing) return current;
      if (Object.keys(next).length === 0) {
        if (!current[workspaceOrderKey]) return current;
        const withoutWorkspace = { ...current };
        delete withoutWorkspace[workspaceOrderKey];
        return withoutWorkspace;
      }
      return { ...current, [workspaceOrderKey]: next };
    });
  }, [visibleSessionKey, workspaceOrderKey]);

  useEffect(() => {
    setDeletedSessionKeys(readDeletedAgentSessions(workspace));
    setSessionQuery("");
  }, [workspace]);

  useEffect(() => {
    setActiveTerminalPaneByWorkspace((current) => {
      const currentActiveId = current[workspaceOrderKey];
      if (currentActiveId && visibleSessions.some((session) => session.id === currentActiveId)) return current;
      const nextActiveId = visibleSessions[0]?.id ?? "";
      if (currentActiveId === nextActiveId) return current;
      if (!nextActiveId) {
        const next = { ...current };
        delete next[workspaceOrderKey];
        return next;
      }
      return { ...current, [workspaceOrderKey]: nextActiveId };
    });
  }, [visibleSessionKey, workspaceOrderKey]);

  useEffect(() => {
    if (!revealPaneRequest || revealPaneRequest.nonce === lastRevealNonceRef.current) return;
    lastRevealNonceRef.current = revealPaneRequest.nonce;
    revealTerminalPane(revealPaneRequest.id);
    onRevealPaneHandled?.();
  }, [revealPaneRequest]);

  useEffect(() => () => window.clearTimeout(armedCloseTimerRef.current), []);

  function togglePaneCollapsed(sessionId: string) {
    const collapsing = !collapsedPaneIds.has(sessionId);
    if (collapsing) {
      const nextActive = terminalFocusAfterCollapse(
        sessionId,
        activeTerminalPaneId,
        visibleSessions.map((session) => session.id),
        collapsedPaneIds,
      );
      setActiveTerminalPaneByWorkspace((current) => {
        if (nextActive) return current[workspaceOrderKey] === nextActive
          ? current
          : { ...current, [workspaceOrderKey]: nextActive };
        if (!current[workspaceOrderKey]) return current;
        const next = { ...current };
        delete next[workspaceOrderKey];
        return next;
      });
    }
    setCollapsedPaneIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
    setMaximizedPaneId((current) => current === sessionId ? null : current);
  }

  function togglePaneMaximized(sessionId: string) {
    setCollapsedPaneIds((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
    setMaximizedPaneId((current) => current === sessionId ? null : sessionId);
  }

  function revealTerminalPane(sessionId: string) {
    setActiveView("terminals");
    setActiveTerminalPaneForWorkspace(workspaceOrderKey, sessionId);
    setCollapsedPaneIds((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
    setMaximizedPaneId((current) => current && current !== sessionId ? sessionId : current);
    window.setTimeout(() => scrollTerminalPaneIntoView(sessionId), 0);
  }

  function setActiveTerminalPaneForWorkspace(workspaceKey: string, sessionId: string) {
    setActiveTerminalPaneByWorkspace((current) => (
      current[workspaceKey] === sessionId ? current : { ...current, [workspaceKey]: sessionId }
    ));
  }

  function requestClose(session: EmbeddedTerminalSession) {
    window.clearTimeout(armedCloseTimerRef.current);
    // A running agent is one click from losing its process: the first click arms, the second closes.
    if (session.status !== "running" || armedCloseId === session.id) {
      setArmedCloseId(null);
      void onClose(session.id);
      return;
    }
    setArmedCloseId(session.id);
    armedCloseTimerRef.current = window.setTimeout(() => {
      setArmedCloseId((current) => current === session.id ? null : current);
    }, closeConfirmMs);
  }

  function movePaneToSlot(sourceSessionId: string, targetSessionId: string) {
    if (sourceSessionId === targetSessionId) return;
    setPaneOrderByWorkspace((current) => {
      const existing = current[workspaceOrderKey] ?? sessionIds;
      const sourceIndex = existing.indexOf(sourceSessionId);
      const targetIndex = existing.indexOf(targetSessionId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const next = [...existing];
      next[sourceIndex] = targetSessionId;
      next[targetIndex] = sourceSessionId;
      return { ...current, [workspaceOrderKey]: next };
    });
  }

  // Dragging starts only past a small threshold, so clicks and double-clicks on
  // the chrome never re-render the grid.
  function startPaneDrag(event: ReactPointerEvent<HTMLDivElement>, sessionId: string) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const chrome = event.currentTarget;
    const pointerId = event.pointerId;
    chrome.setPointerCapture(pointerId);
    const start = { x: event.clientX, y: event.clientY };
    let lastPointer = start;
    let dragging = false;
    let moveFrame = 0;

    const commitMove = () => {
      moveFrame = 0;
      const targetId = nearestPaneDropTarget(lastPointer.x, lastPointer.y, sessionId);
      dragTargetRef.current = targetId;
      setDragState({ id: sessionId, deltaX: lastPointer.x - start.x, deltaY: lastPointer.y - start.y, targetId });
    };
    const move = (moveEvent: PointerEvent) => {
      lastPointer = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (!dragging) {
        if (Math.hypot(lastPointer.x - start.x, lastPointer.y - start.y) < dragThresholdPx) return;
        dragging = true;
      }
      if (!moveFrame) moveFrame = window.requestAnimationFrame(commitMove);
    };
    const end = () => {
      if (moveFrame) window.cancelAnimationFrame(moveFrame);
      moveFrame = 0;
      const targetId = dragTargetRef.current;
      dragTargetRef.current = null;
      if (dragging) {
        if (targetId) movePaneToSlot(sessionId, targetId);
        setDragState(null);
      }
      if (chrome.hasPointerCapture(pointerId)) chrome.releasePointerCapture(pointerId);
      chrome.removeEventListener("pointermove", move);
      chrome.removeEventListener("pointerup", end);
      chrome.removeEventListener("pointercancel", end);
    };

    chrome.addEventListener("pointermove", move);
    chrome.addEventListener("pointerup", end);
    chrome.addEventListener("pointercancel", end);
  }

  function startPaneResize(event: ReactPointerEvent<HTMLDivElement>, sessionId: string) {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const pane = handle.closest<HTMLElement>("[data-pane-id]");
    const stage = pane?.parentElement;
    if (!pane || !stage) return;
    handle.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = pane.getBoundingClientRect().height;
    let pendingHeight = startHeight;
    let resizeFrame: number | null = null;

    const commitHeight = () => {
      resizeFrame = null;
      const nextHeight = clampTerminalPaneHeight(pendingHeight, stage.clientHeight);
      setPaneHeightsByWorkspace((current) => ({
        ...current,
        [workspaceOrderKey]: {
          ...(current[workspaceOrderKey] ?? {}),
          [sessionId]: nextHeight,
        },
      }));
    };
    const move = (moveEvent: PointerEvent) => {
      pendingHeight = startHeight + moveEvent.clientY - startY;
      if (resizeFrame == null) {
        resizeFrame = window.requestAnimationFrame(commitHeight);
      }
    };
    const end = () => {
      if (resizeFrame != null) window.cancelAnimationFrame(resizeFrame);
      commitHeight();
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  async function copySessionId(session: AgentSession) {
    try {
      await navigator.clipboard.writeText(session.id);
      onToast?.("Session ID copied");
    } catch {
      onToast?.("Could not copy the session ID");
    }
  }

  async function resumeSession(session: AgentSession) {
    await onResumeSession(session);
    setActiveView("terminals");
  }

  function hideAgentSession(session: AgentSession) {
    const next = new Set(deletedSessionKeys);
    next.add(agentSessionKey(session));
    setDeletedSessionKeys(next);
    writeDeletedAgentSessions(workspace, next);
  }

  async function refreshSessionsNow() {
    setRefreshingSessions(true);
    try {
      await onRefreshAgentSessions(0);
    } finally {
      setRefreshingSessions(false);
    }
  }

  function launch(kind: EmbeddedTerminalKind, count: number) {
    void onLaunch(kind, count);
  }

  const stageClassName = [
    "terminalStage embeddedStage slotTerminalStage",
    activeMaximizedPaneId ? "hasMaximized" : "",
    visibleSessions.length > 1 ? "multiPane" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className="roomPanel commandRoom">
      <div className="roomPanelHeader commandToolbar">
        <div className="commandRoomTabs" role="tablist" aria-label="Command room views">
          <button
            type="button"
            className={activeView === "terminals" ? "active" : ""}
            onClick={() => setActiveView("terminals")}
            role="tab"
            aria-selected={activeView === "terminals"}
            title={shortcutTitle("Live terminals", "toggleSessions")}
          >
            <TerminalSquare size={14} /> Terminals
            {visibleSessions.length > 0 && <span className="commandTabCount">{visibleSessions.length}</span>}
          </button>
          <button
            type="button"
            className={activeView === "sessions" ? "active" : ""}
            onClick={() => setActiveView("sessions")}
            role="tab"
            aria-selected={activeView === "sessions"}
            title={shortcutTitle("Native session history", "toggleSessions")}
          >
            <History size={14} /> Sessions
            {visibleAgentSessions.length > 0 && (
              <span className={runningAgentSessions ? "commandTabCount live" : "commandTabCount"}>
                {runningAgentSessions || visibleAgentSessions.length}
              </span>
            )}
          </button>
        </div>
        <div className="commandToolbarActions">
          <div className="segmentedControl viewModeToggle" role="group" aria-label="Pane view">
            <button
              type="button"
              className={interfaceMode === "terminal" ? "active" : ""}
              aria-pressed={interfaceMode === "terminal"}
              aria-label="Terminal view"
              title={shortcutTitle("Terminal view", "toggleInterfaceMode")}
              onClick={() => onInterfaceModeChange?.("terminal")}
            >
              <TerminalSquare size={14} />
            </button>
            <button
              type="button"
              className={interfaceMode === "chat" ? "active" : ""}
              aria-pressed={interfaceMode === "chat"}
              aria-label="Chat view"
              title={shortcutTitle("Chat view: conversation bubbles over the same terminals", "toggleInterfaceMode")}
              onClick={() => onInterfaceModeChange?.("chat")}
            >
              <MessageSquare size={14} />
            </button>
          </div>
          <button
            type="button"
            className="ghostButton"
            onClick={() => launch("shell", 1)}
            disabled={!workspace || busy}
            title={shortcutTitle("New shell", "newShell")}
          >
            <TerminalSquare size={14} /> <span className="toolbarLabel">New Shell</span>
          </button>
          <LaunchMenu
            open={newMenuOpen}
            workspace={workspace}
            busy={busy}
            onOpenChange={setNewMenuOpen}
            onLaunch={launch}
            missingAgents={missingAgents}
          />
        </div>
      </div>

      {activeView === "terminals" ? (
        <div className={stageClassName}>
          {visibleSessions.map((session) => {
            const displayed = !activeMaximizedPaneId || activeMaximizedPaneId === session.id;
            const collapsed = collapsedPaneIds.has(session.id);
            const maximized = activeMaximizedPaneId === session.id;
            const customHeight = !collapsed && !maximized ? paneHeights[session.id] : undefined;
            const dragging = dragState?.id === session.id;
            const paneStyle: CSSProperties = {
              ...(customHeight ? { height: `${customHeight}px` } : {}),
              ...(dragging && dragState ? { transform: `translate(${dragState.deltaX}px, ${dragState.deltaY}px)` } : {}),
            };
            const instance = instanceNumbers.get(session.id);
            const statusLabel = paneStatusLabel(session);
            const armed = armedCloseId === session.id;
            return (
              <div
                key={session.id}
                data-pane-id={session.id}
                className={[
                  "terminalPane liveTerminalPane slotPane",
                  !displayed ? "workspaceHidden" : "",
                  dragging ? "dragging" : "",
                  dragState?.targetId === session.id ? "dropTarget" : "",
                  collapsed ? "collapsed" : "",
                  maximized ? "maximized" : "",
                  activeTerminalPaneId === session.id ? "activeTerminalPane" : "",
                ].filter(Boolean).join(" ")}
                aria-hidden={!displayed}
                aria-label={`${session.title} terminal pane`}
                onPointerDownCapture={() => setActiveTerminalPaneForWorkspace(workspaceOrderKey, session.id)}
                style={paneStyle}
              >
                <div
                  className="terminalChrome draggableChrome"
                  onPointerDown={(event) => startPaneDrag(event, session.id)}
                  onDoubleClick={(event) => {
                    if (!(event.target as HTMLElement).closest("button")) togglePaneMaximized(session.id);
                  }}
                >
                  <AgentGlyph kind={session.kind} size="small" />
                  <strong className="paneTitle" title={session.title}>{session.title}</strong>
                  {instance && instance.total > 1 && (
                    <span className="paneInstanceBadge" title={`${session.kind}#${instance.number}`}>#{instance.number}</span>
                  )}
                  <span className={`paneStatusDot ${session.status}`} role="img" aria-label={statusLabel} title={statusLabel} />
                  <em className="paneMeta">{terminalPaneMeta(session)}</em>
                  <div className="paneActions">
                    <button
                      type="button"
                      className="iconButton"
                      onClick={() => onRenameEmbeddedSession(session)}
                      title="Rename"
                      aria-label={`Rename ${session.title}`}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      className="iconButton"
                      onClick={() => togglePaneCollapsed(session.id)}
                      title={collapsed ? "Restore" : "Minimize"}
                      aria-label={collapsed ? `Restore ${session.title}` : `Minimize ${session.title}`}
                    >
                      {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                    </button>
                    <button
                      type="button"
                      className="iconButton"
                      onClick={() => togglePaneMaximized(session.id)}
                      title={maximized ? "Restore size" : "Maximize (or double-click the title bar)"}
                      aria-label={maximized ? `Restore ${session.title}` : `Maximize ${session.title}`}
                    >
                      {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                    </button>
                    <button
                      type="button"
                      className={armed ? "iconButton paneCloseButton armed" : "iconButton danger paneCloseButton"}
                      onClick={() => requestClose(session)}
                      title={armed
                        ? "Click again to close the pane and stop its process"
                        : session.status === "running" ? "Close (stops the process)" : "Close"}
                      aria-label={armed ? `Confirm closing ${session.title}` : `Close ${session.title}`}
                    >
                      <X size={13} />
                      {armed && <span>Close?</span>}
                    </button>
                  </div>
                </div>
                {displayed && !collapsed && (
                  interfaceMode === "chat" && session.kind !== "shell"
                    ? terminalViewIds.has(session.id)
                      ? <div className="chatTerminalFallback">
                          <button type="button" className="chatViewReturn" onClick={() => setTerminalViewIds((current) => {
                            const next = new Set(current); next.delete(session.id); return next;
                          })}>← Back to chat</button>
                          <EmbeddedTerminal session={session} active={activeTerminalPaneId === session.id} />
                        </div>
                      : <EmbeddedChatTerminal session={session} onOpenTerminal={() => setTerminalViewIds((current) => new Set(current).add(session.id))} />
                    : <EmbeddedTerminal session={session} active={activeTerminalPaneId === session.id} />
                )}
                {displayed && !collapsed && !maximized && (
                  <div
                    className="terminalPaneResizeHandle"
                    role="separator"
                    aria-label={`Resize ${session.title}`}
                    aria-orientation="horizontal"
                    onPointerDown={(event) => startPaneResize(event, session.id)}
                  />
                )}
              </div>
            );
          })}
          {visibleSessions.length === 0 && (
            <EmptyStage
              workspace={workspace}
              busy={busy}
              emptyMark={emptyMark}
              missingAgents={missingAgents}
              onLaunch={launch}
              onAddWorkspace={onAddWorkspace}
            />
          )}
        </div>
      ) : (
        <div className="agentSessionsPanel">
          <div className="agentSessionsToolbar">
            <label className="searchField sessionSearch">
              <Search size={14} aria-hidden="true" />
              <input
                type="text"
                value={sessionQuery}
                onChange={(event) => setSessionQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && sessionQuery) {
                    event.stopPropagation();
                    setSessionQuery("");
                  }
                }}
                placeholder="Search title, id, branch, model…"
                aria-label="Search sessions"
                spellCheck={false}
              />
              {sessionQuery && (
                <button type="button" className="iconButton" onClick={() => setSessionQuery("")} aria-label="Clear search" title="Clear search (Esc)">
                  <X size={13} />
                </button>
              )}
            </label>
            <div className="agentProviderTabs" role="tablist" aria-label="Session providers">
              {providerTabs.map((tab) => (
                <button
                  key={tab.provider}
                  type="button"
                  className={activeSessionProvider === tab.provider ? "chip active" : "chip"}
                  onClick={() => setActiveSessionProvider(tab.provider)}
                  role="tab"
                  aria-selected={activeSessionProvider === tab.provider}
                >
                  {tab.provider !== "all" && <AgentGlyph kind={tab.provider} size="small" />}
                  {tab.label}
                  <span className="chipCount">{tab.count}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="iconButton outlined sessionRefresh"
              onClick={() => void refreshSessionsNow()}
              disabled={!workspace || refreshingSessions}
              aria-label="Refresh sessions"
              title="Rescan native session history"
            >
              <RefreshCw size={13} className={refreshingSessions ? "spinning" : undefined} />
            </button>
          </div>
          <div className="agentSessionList" role="list" aria-label="Agent sessions">
            {filteredAgentSessions.length > 0 && (
              <div className="agentSessionsHeader" aria-hidden="true">
                <span>Provider</span>
                <span>Session</span>
                <span className="agentSessionMetaColumn">Model / Agent</span>
                <span>Updated</span>
                <span className="agentSessionStatusColumn">Status</span>
                <span />
              </div>
            )}
            {filteredAgentSessions.map((session) => (
              <div className="agentSessionRow" role="listitem" key={`${session.provider}:${session.id}`}>
                <div className="agentSessionProvider">
                  <span className={`providerBadge ${session.provider}`}>{providerLabel(session.provider)}</span>
                </div>
                <div className="agentSessionTitle">
                  <strong title={session.title}>{session.title}</strong>
                  <span title={session.id}>{session.id}{session.branch ? ` · ${session.branch}` : ""}</span>
                </div>
                <div className="agentSessionMeta agentSessionMetaColumn">
                  <strong>{session.model ?? "Unknown model"}</strong>
                  <span>{session.agent ?? "Default agent"}</span>
                </div>
                <time className="agentSessionTime" dateTime={session.updatedAt} title={formatAbsoluteTime(session.updatedAt)}>
                  {formatRelativeTime(session.updatedAt)}
                </time>
                <span className={`statusPill agentSessionStatus agentSessionStatusColumn${session.status === "running" ? " ok" : ""}`}>
                  <span />{session.status === "running" ? "Running" : session.status === "exited" ? "Exited" : "History"}
                </span>
                <div className="agentSessionActions">
                  {session.terminalId && (
                    <button
                      type="button"
                      className="primaryButton small"
                      onClick={() => { if (session.terminalId) revealTerminalPane(session.terminalId); }}
                      title="Show this session's pane"
                    >
                      <TerminalSquare size={12} /> Focus
                    </button>
                  )}
                  {session.resumeCommand && (
                    <button
                      type="button"
                      className={session.terminalId ? "ghostButton small" : "primaryButton small"}
                      onClick={() => void resumeSession(session)}
                      disabled={busy}
                      title={`Resume in a new pane: ${session.resumeCommand}`}
                    >
                      <Play size={12} /> Resume
                    </button>
                  )}
                  <button type="button" className="iconButton sessionIconAction" onClick={() => void copySessionId(session)} aria-label={`Copy ID of ${session.title}`} title="Copy session ID">
                    <Copy size={13} />
                  </button>
                  <button type="button" className="iconButton sessionIconAction" onClick={() => onRenameAgentSession(session)} aria-label={`Rename ${session.title}`} title="Rename">
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    className="iconButton danger sessionIconAction"
                    onClick={() => hideAgentSession(session)}
                    aria-label={`Hide ${session.title}`}
                    title="Hide from this list — session files are untouched"
                  >
                    <EyeOff size={13} />
                  </button>
                </div>
              </div>
            ))}
            {filteredAgentSessions.length === 0 && (
              <SessionsEmptyState
                hasSessions={visibleAgentSessions.length > 0}
                query={sessionQuery}
                provider={activeSessionProvider}
                onClearQuery={() => setSessionQuery("")}
                onShowAll={() => setActiveSessionProvider("all")}
              />
            )}
          </div>
        </div>
      )}

    </div>
  );
}

function EmptyStage({
  workspace,
  busy,
  emptyMark,
  missingAgents,
  onLaunch,
  onAddWorkspace,
}: {
  workspace: string;
  busy: boolean;
  emptyMark: ReactNode;
  missingAgents?: ReadonlySet<EmbeddedTerminalKind>;
  onLaunch: (kind: EmbeddedTerminalKind, count: number) => void;
  onAddWorkspace?: () => void;
}) {
  if (!workspace) {
    return (
      <div className="terminalEmptyState">
        <div className="emptyHero">
          {emptyMark}
          <h2>No workspace open</h2>
          <p>Athena runs agents and shells inside a project folder. Open one to get started.</p>
        </div>
        {onAddWorkspace && (
          <button type="button" className="primaryButton" onClick={onAddWorkspace}>
            <FolderOpen size={15} /> Open a project folder
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="terminalEmptyState">
      <div className="emptyHero">
        {emptyMark}
        <h2>Start something in <span>{workspaceFolderName(workspace)}</span></h2>
        <p>Every agent runs in a real terminal in this folder. Launch one, or a grid of four to work in parallel.</p>
      </div>
      <div className="emptyLaunchGrid">
        {launchOptions.map((option) => {
          const missing = Boolean(missingAgents?.has(option.kind));
          return (
            <div key={option.kind} className={missing ? "emptyLaunchCard missing" : "emptyLaunchCard"}>
              <button
                type="button"
                className="emptyLaunchMain"
                disabled={busy}
                onClick={() => onLaunch(option.kind, 1)}
                title={missing ? `${option.label} is not installed: Athena will offer to install it` : `Launch ${option.label}`}
              >
                <AgentGlyph kind={option.kind} size="large" />
                <span className="emptyLaunchText">
                  <strong>{option.label}</strong>
                  <small>{option.detail}</small>
                </span>
                {missing && <em className="launchMissingTag">Not installed</em>}
              </button>
              {supportsGrid(option.kind) && (
                <button
                  type="button"
                  className="ghostButton small quiet emptyLaunchGridButton"
                  disabled={busy}
                  onClick={() => onLaunch(option.kind, gridSize)}
                  aria-label={`Launch four ${option.label} panes`}
                  title={`Launch a grid of four ${option.label} panes`}
                >
                  <LayoutGrid size={12} /> ×4 grid
                </button>
              )}
            </div>
          );
        })}
      </div>
      <p className="emptyHint">Press <KeyHint id="palette" /> for every command</p>
    </div>
  );
}

function SessionsEmptyState({
  hasSessions,
  query,
  provider,
  onClearQuery,
  onShowAll,
}: {
  hasSessions: boolean;
  query: string;
  provider: SessionProviderFilter;
  onClearQuery: () => void;
  onShowAll: () => void;
}) {
  if (query.trim()) {
    return (
      <div className="agentSessionsEmpty">
        <Search size={26} />
        <strong>No sessions match “{query.trim()}”</strong>
        <span>Search looks at titles, session ids, branches, models and agents.</span>
        <button type="button" className="ghostButton small" onClick={onClearQuery}>
          <X size={12} /> Clear search
        </button>
      </div>
    );
  }
  if (hasSessions && provider !== "all") {
    return (
      <div className="agentSessionsEmpty">
        <AgentGlyph kind={provider} size="large" />
        <strong>No {providerLabel(provider)} sessions here</strong>
        <button type="button" className="ghostButton small" onClick={onShowAll}>Show all sessions</button>
      </div>
    );
  }
  return (
    <div className="agentSessionsEmpty">
      <History size={28} />
      <strong>No agent sessions yet</strong>
      <span>Sessions from Claude Code, Codex, OpenCode, Athena Code, Grok and Hermes in this workspace show up here, ready to resume.</span>
    </div>
  );
}

function LaunchMenu({
  open,
  workspace,
  busy,
  onOpenChange,
  onLaunch,
  missingAgents,
}: {
  open: boolean;
  workspace: string;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onLaunch: (kind: EmbeddedTerminalKind, count: number) => void;
  missingAgents?: ReadonlySet<EmbeddedTerminalKind>;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    panelRef.current?.querySelector<HTMLElement>(".launchMenuItem:not(:disabled)")?.focus();
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onOpenChange(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open, onOpenChange]);

  function launch(kind: EmbeddedTerminalKind, count: number) {
    onOpenChange(false);
    onLaunch(kind, count);
  }

  function moveFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(".launchMenuItem"));
    const row = (document.activeElement as HTMLElement | null)?.closest(".launchMenuRow") ?? null;
    const index = items.findIndex((item) => item.closest(".launchMenuRow") === row);
    let target: HTMLElement | null | undefined = null;
    if (event.key === "ArrowDown") target = items[(index + 1) % items.length];
    else if (event.key === "ArrowUp") target = items[(index - 1 + items.length) % items.length];
    else if (event.key === "Home") target = items[0];
    else if (event.key === "End") target = items.at(-1);
    else if (event.key === "ArrowRight") target = row?.querySelector<HTMLElement>(".launchGridButton");
    else if (event.key === "ArrowLeft") target = row?.querySelector<HTMLElement>(".launchMenuItem");
    else return;
    event.preventDefault();
    target?.focus();
  }

  return (
    <div className="newMenu" ref={rootRef}>
      <button
        ref={triggerRef}
        className="primaryButton newMenuButton"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!workspace}
        onClick={() => onOpenChange(!open)}
        title={shortcutTitle("Launch an agent", "launchAgent")}
      >
        <Plus size={14} /> New <ChevronDown size={13} className="newMenuChevron" />
      </button>
      {open && (
        <div className="menuPanel launchMenu" role="menu" aria-label="Launch" ref={panelRef} onKeyDown={moveFocus}>
          <div className="menuLabel">Launch in {workspaceFolderName(workspace)}</div>
          {launchOptions.map((option) => {
            const missing = Boolean(missingAgents?.has(option.kind));
            return (
              <div className="launchMenuRow" key={option.kind} role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="menuItem launchMenuItem"
                  disabled={busy}
                  onClick={() => launch(option.kind, 1)}
                >
                  <AgentGlyph kind={option.kind} />
                  <span className="launchMenuText">
                    <strong>{option.label}</strong>
                    <small className={missing ? "launchMissing" : undefined}>
                      {missing ? "Not installed: Athena will offer to install it" : option.detail}
                    </small>
                  </span>
                </button>
                {supportsGrid(option.kind) && (
                  <button
                    type="button"
                    role="menuitem"
                    className="iconButton outlined launchGridButton"
                    disabled={busy}
                    onClick={() => launch(option.kind, gridSize)}
                    aria-label={`Launch four ${option.label} panes`}
                    title={`Launch a grid of four ${option.label} panes`}
                  >
                    ×4
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function scrollTerminalPaneIntoView(sessionId: string): void {
  const pane = Array.from(document.querySelectorAll<HTMLElement>("[data-pane-id]"))
    .find((item) => item.dataset.paneId === sessionId);
  pane?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function nearestPaneDropTarget(clientX: number, clientY: number, sourceSessionId: string): string | null {
  const panes = Array.from(document.querySelectorAll<HTMLElement>("[data-pane-id]"))
    .filter((pane) => pane.dataset.paneId && pane.dataset.paneId !== sourceSessionId);
  let best: { id: string; distance: number } | null = null;

  for (const pane of panes) {
    const rect = pane.getBoundingClientRect();
    const inflated = 56;
    const inside =
      clientX >= rect.left - inflated &&
      clientX <= rect.right + inflated &&
      clientY >= rect.top - inflated &&
      clientY <= rect.bottom + inflated;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const distance = Math.hypot(clientX - centerX, clientY - centerY);
    if (inside) return pane.dataset.paneId ?? null;
    if (!best || distance < best.distance) best = { id: pane.dataset.paneId ?? "", distance };
  }

  return best && best.distance < 360 ? best.id : null;
}
