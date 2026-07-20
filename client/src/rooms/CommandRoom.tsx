import { type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Code2,
  FileText,
  Maximize2,
  Minimize2,
  Pencil,
  Play,
  RefreshCw,
  ScrollText,
  Send,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { AthenaIcon, ClaudeIcon, GrokIcon, HermesIcon, OpenAIIcon, OpenCodeIcon } from "../components/BrandIcons";
import type { AgentSession, EmbeddedTerminalKind, EmbeddedTerminalSession } from "../electron";
import { EmbeddedChatTerminal } from "../components/EmbeddedChatTerminal";
import { EmbeddedTerminal } from "../components/EmbeddedTerminal";
import {
  agentSessionKey,
  formatSessionTime,
  providerLabel,
  readDeletedAgentSessions,
  type SessionProviderFilter,
  sessionInstanceNumber,
  terminalPaneMeta,
  writeDeletedAgentSessions,
} from "../session-utils";
import { normalizeWorkspaceKey, sameWorkspacePath } from "../workspace-utils";
import {
  clampTerminalPaneHeight,
  reconcileTerminalPaneHeights,
  terminalFocusAfterCollapse,
} from "../pane-layout";

type PaneDragState = {
  id: string;
  deltaX: number;
  deltaY: number;
  targetId: string | null;
};

export function CommandRoom({
  workspace,
  sessions,
  agentSessions,
  busy,
  focused,
  layoutResetNonce,
  interfaceMode,
  onFocusChange,
  onLaunch,
  onClose,
  onBroadcastPrompt,
  onResumeSession,
  onInspectEmbeddedSession,
  onRenameEmbeddedSession,
  onInspectAgentSession,
  onRenameAgentSession,
  onViewAgentTranscript,
  emptyMark,
}: {
  workspace: string;
  sessions: EmbeddedTerminalSession[];
  agentSessions: AgentSession[];
  busy: boolean;
  focused: boolean;
  layoutResetNonce: number;
  interfaceMode: "terminal" | "chat";
  onFocusChange: (focused: boolean) => void;
  onLaunch: (kind: EmbeddedTerminalKind, count?: number) => Promise<void>;
  onClose: (id: string) => Promise<void>;
  onBroadcastPrompt: (prompt: string, sessionIds: string[]) => Promise<void>;
  onResumeSession: (session: AgentSession) => Promise<void>;
  onInspectEmbeddedSession: (session: EmbeddedTerminalSession) => void;
  onRenameEmbeddedSession: (session: EmbeddedTerminalSession) => void;
  onInspectAgentSession: (session: AgentSession) => void;
  onRenameAgentSession: (session: AgentSession) => void;
  onViewAgentTranscript: (session: AgentSession) => Promise<string>;
  emptyMark: ReactNode;
}) {
  const [paneOrderByWorkspace, setPaneOrderByWorkspace] = useState<Record<string, string[]>>({});
  const [dragState, setDragState] = useState<PaneDragState | null>(null);
  const [broadcastPrompt, setBroadcastPrompt] = useState("");
  const [broadcasting, setBroadcasting] = useState(false);
  const [activeTab, setActiveTab] = useState<"terminals" | "sessions">("terminals");
  const [activeSessionProvider, setActiveSessionProvider] = useState<SessionProviderFilter>("all");
  const [deletedSessionKeys, setDeletedSessionKeys] = useState<Set<string>>(() => readDeletedAgentSessions(workspace));
  const [collapsedPaneIds, setCollapsedPaneIds] = useState<Set<string>>(new Set());
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null);
  const [activeTerminalPaneByWorkspace, setActiveTerminalPaneByWorkspace] = useState<Record<string, string>>({});
  const [paneHeightsByWorkspace, setPaneHeightsByWorkspace] = useState<Record<string, Record<string, number>>>({});
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const dragStartRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const dragTargetRef = useRef<string | null>(null);
  const paneSetSignatureByWorkspaceRef = useRef(new Map<string, string>());
  const newMenuRef = useRef<HTMLDivElement | null>(null);
  const workspaceOrderKey = normalizeWorkspaceKey(workspace || "none");
  const sessionIds = sessions.map((session) => session.id);
  const sessionSignature = sessionIds.join("|");
  const paneOrder = paneOrderByWorkspace[workspaceOrderKey] ?? sessionIds;
  const activeTerminalPaneId = activeTerminalPaneByWorkspace[workspaceOrderKey] ?? null;
  const paneHeights = paneHeightsByWorkspace[workspaceOrderKey] ?? {};

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
    const sessionIds = new Set(sessions.map((session) => session.id));
    const visibleSessionIds = new Set(
      sessions
        .filter((session) => sameWorkspacePath(session.workspace, workspace))
        .map((session) => session.id),
    );
    setCollapsedPaneIds((current) => new Set([...current].filter((id) => sessionIds.has(id))));
    setMaximizedPaneId((current) => current && visibleSessionIds.has(current) ? current : null);
  }, [sessions, workspace]);

  const orderedSessions = paneOrder
    .map((id) => sessions.find((session) => session.id === id))
    .filter((session): session is EmbeddedTerminalSession => Boolean(session));
  const visibleSessions = orderedSessions.filter((session) => sameWorkspacePath(session.workspace, workspace));
  const visibleSessionKey = visibleSessions.map((session) => session.id).join("|");
  const activeMaximizedPaneId = maximizedPaneId && visibleSessions.some((session) => session.id === maximizedPaneId)
    ? maximizedPaneId
    : null;
  const displayedTerminalSessions = activeMaximizedPaneId
    ? visibleSessions.filter((session) => session.id === activeMaximizedPaneId)
    : visibleSessions;
  const visibleAgentSessions = agentSessions.filter((session) => !deletedSessionKeys.has(agentSessionKey(session)));
  const providerTabs = useMemo(() => {
    const counts = new Map<SessionProviderFilter, number>([["all", visibleAgentSessions.length]]);
    for (const session of visibleAgentSessions) {
      counts.set(session.provider, (counts.get(session.provider) ?? 0) + 1);
    }
    return (["all", "codex", "opencode", "athena", "claude", "grok", "hermes"] as SessionProviderFilter[]).map((provider) => ({
      provider,
      label: provider === "all" ? "All" : providerLabel(provider),
      count: counts.get(provider) ?? 0,
    }));
  }, [visibleAgentSessions]);
  const filteredAgentSessions = activeSessionProvider === "all"
    ? visibleAgentSessions
    : visibleAgentSessions.filter((session) => session.provider === activeSessionProvider);
  const shownCount = visibleSessions.length;
  const promptTargets = visibleSessions.filter((session) => session.status === "running" && session.kind !== "shell");
  const canBroadcast = promptTargets.length > 0 && broadcastPrompt.trim().length > 0 && !broadcasting;
  const runningAgentSessions = visibleAgentSessions.filter((session) => session.status === "running").length;

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
  }, [workspace]);

  useEffect(() => {
    setActiveTerminalPaneByWorkspace((current) => {
      const activeTerminalPaneId = current[workspaceOrderKey];
      if (activeTerminalPaneId && visibleSessions.some((session) => session.id === activeTerminalPaneId)) return current;
      const nextActiveTerminalPaneId = visibleSessions[0]?.id ?? "";
      if (activeTerminalPaneId === nextActiveTerminalPaneId) return current;
      if (!nextActiveTerminalPaneId) {
        const next = { ...current };
        delete next[workspaceOrderKey];
        return next;
      }
      return { ...current, [workspaceOrderKey]: nextActiveTerminalPaneId };
    });
  }, [visibleSessionKey, workspaceOrderKey]);

  useEffect(() => {
    if (!newMenuOpen) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!newMenuRef.current?.contains(event.target as Node)) setNewMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNewMenuOpen(false);
    };

    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [newMenuOpen]);

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
    setActiveTab("terminals");
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

  function startPaneDrag(event: ReactPointerEvent, sessionId: string) {
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const chrome = event.currentTarget as HTMLElement;
    chrome.setPointerCapture(event.pointerId);
    dragStartRef.current = { id: sessionId, x: event.clientX, y: event.clientY };
    setDragState({ id: sessionId, deltaX: 0, deltaY: 0, targetId: null });

    const move = (moveEvent: PointerEvent) => {
      const dragStart = dragStartRef.current;
      if (!dragStart) return;
      const nextTargetId = nearestPaneDropTarget(moveEvent.clientX, moveEvent.clientY, dragStart.id);
      dragTargetRef.current = nextTargetId;
      setDragState({
        id: dragStart.id,
        deltaX: moveEvent.clientX - dragStart.x,
        deltaY: moveEvent.clientY - dragStart.y,
        targetId: nextTargetId,
      });
    };

    const end = () => {
      const dragStart = dragStartRef.current;
      const targetId = dragTargetRef.current;
      dragStartRef.current = null;
      dragTargetRef.current = null;
      if (dragStart && targetId) movePaneToSlot(dragStart.id, targetId);
      setDragState(null);
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

  async function submitBroadcastPrompt() {
    const trimmed = broadcastPrompt.trim();
    if (!trimmed || promptTargets.length === 0 || broadcasting) return;
    setBroadcasting(true);
    try {
      await onBroadcastPrompt(trimmed, promptTargets.map((session) => session.id));
      setBroadcastPrompt("");
    } finally {
      setBroadcasting(false);
    }
  }

  async function copySessionText(value: string | null) {
    if (!value) return;
    await navigator.clipboard?.writeText(value).catch(() => undefined);
  }

  function deleteAgentSession(session: AgentSession) {
    const next = new Set(deletedSessionKeys);
    next.add(agentSessionKey(session));
    setDeletedSessionKeys(next);
    writeDeletedAgentSessions(workspace, next);
  }

  return (
    <div className={focused ? "roomPanel commandRoom focused" : "roomPanel commandRoom"}>
      <div className="roomPanelHeader">
        <div>
          <span className="tinyLabel">Embedded PTY control</span>
          <h3>Real terminals inside the workspace</h3>
          <span className="panelMeta">
            {sessions.length ? `${shownCount} running sessions` : "No sessions running"}{interfaceMode === "chat" ? " · Chat view" : ""}
          </span>
        </div>
        <div className="buttonRow">
          <button className="ghostButton" onClick={() => onFocusChange(!focused)} title={focused ? "Exit shell focus (Esc)" : "Enter shell focus"}>
            {focused ? <Minimize2 size={15} /> : <Maximize2 size={15} />} {focused ? "Exit Focus" : "Shell Focus"}
          </button>
          <button className="ghostButton" onClick={() => void onLaunch("shell", 1)} disabled={!workspace || busy}>
            <TerminalSquare size={15} /> New Shell
          </button>
          <NewLaunchMenu
            open={newMenuOpen}
            workspace={workspace}
            menuRef={newMenuRef}
            onOpenChange={setNewMenuOpen}
            onLaunch={onLaunch}
          />
        </div>
      </div>

      <div className="commandRoomTabs" role="tablist" aria-label="Command room views">
        <button
          type="button"
          className={activeTab === "terminals" ? "active" : ""}
          onClick={() => setActiveTab("terminals")}
          role="tab"
          aria-selected={activeTab === "terminals"}
        >
          <TerminalSquare size={14} /> Terminals
        </button>
        <button
          type="button"
          className={activeTab === "sessions" ? "active" : ""}
          onClick={() => setActiveTab("sessions")}
          role="tab"
          aria-selected={activeTab === "sessions"}
        >
          <Code2 size={14} /> Sessions
          <span>{runningAgentSessions || visibleAgentSessions.length}</span>
        </button>
      </div>

      {activeTab === "terminals" ? (
        <div
          className={[
            "terminalStage embeddedStage slotTerminalStage",
            activeMaximizedPaneId ? "hasMaximized" : "",
          ].filter(Boolean).join(" ")}
        >
          {visibleSessions.map((session) => {
            const displayed = displayedTerminalSessions.some((item) => item.id === session.id);
            const customHeight = !collapsedPaneIds.has(session.id) && activeMaximizedPaneId !== session.id
              ? paneHeights[session.id]
              : undefined;
            const paneStyle: CSSProperties = {
              position: "relative",
              resize: "none",
              ...(customHeight ? { height: `${customHeight}px` } : {}),
              ...(dragState?.id === session.id
                ? { transform: `translate(${dragState.deltaX}px, ${dragState.deltaY}px)` }
                : {}),
            };
            return (
            <div
              key={session.id}
              data-pane-id={session.id}
              className={[
                "terminalPane liveTerminalPane slotPane",
                !displayed ? "workspaceHidden" : "",
                dragState?.id === session.id ? "dragging" : "",
                dragState?.targetId === session.id ? "dropTarget" : "",
                collapsedPaneIds.has(session.id) ? "collapsed" : "",
                activeMaximizedPaneId === session.id ? "maximized" : "",
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
              >
                <button className="terminalControl close" type="button" onClick={() => void onClose(session.id)} title={`Close ${session.title}`} aria-label={`Close ${session.title}`} />
                <button
                  className="terminalControl amber"
                  type="button"
                  onClick={() => togglePaneCollapsed(session.id)}
                  title={collapsedPaneIds.has(session.id) ? `Restore ${session.title}` : `Minimize ${session.title}`}
                  aria-label={collapsedPaneIds.has(session.id) ? `Restore ${session.title}` : `Minimize ${session.title}`}
                />
                <button
                  className="terminalControl green"
                  type="button"
                  onClick={() => togglePaneMaximized(session.id)}
                  title={maximizedPaneId === session.id ? `Restore ${session.title}` : `Maximize ${session.title}`}
                  aria-label={maximizedPaneId === session.id ? `Restore ${session.title}` : `Maximize ${session.title}`}
                />
                <strong>
                  <span className="paneInstanceBadge">#{sessionInstanceNumber(session, sessions)}</span>
                  {session.title}
                </strong>
                <em>{terminalPaneMeta(session)}</em>
                <button type="button" className="terminalChromeAction" onClick={() => onInspectEmbeddedSession(session)} title={`Inspect ${session.title}`}>
                  <FileText size={13} />
                </button>
                <button type="button" className="terminalChromeAction" onClick={() => onRenameEmbeddedSession(session)} title={`Rename ${session.title}`}>
                  <Pencil size={13} />
                </button>
              </div>
              {displayed && !collapsedPaneIds.has(session.id) && (
                interfaceMode === "chat"
                  ? <EmbeddedChatTerminal session={session} />
                  : <EmbeddedTerminal session={session} active={activeTerminalPaneId === session.id} />
              )}
              {displayed && !collapsedPaneIds.has(session.id) && activeMaximizedPaneId !== session.id && (
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
            <div className="terminalEmptyState">
              {emptyMark}
              <strong>No embedded terminals yet.</strong>
              <span>Select a workspace, then start a shell or launch a clean agent session.</span>
            </div>
          )}
        </div>
      ) : (
        <div className="agentSessionsPanel">
          <div className="agentProviderTabs" role="tablist" aria-label="Session providers">
            {providerTabs.map((tab) => (
              <button
                key={tab.provider}
                type="button"
                className={activeSessionProvider === tab.provider ? "active" : ""}
                onClick={() => setActiveSessionProvider(tab.provider)}
                role="tab"
                aria-selected={activeSessionProvider === tab.provider}
              >
                {tab.label}
                <span>{tab.count}</span>
              </button>
            ))}
          </div>
          <div className="agentSessionsHeader">
            <span>Provider</span>
            <span>Session</span>
            <span>Model / Agent</span>
            <span>Updated</span>
            <span>Status</span>
            <span>Actions</span>
          </div>
          {filteredAgentSessions.map((session) => (
            <div className="agentSessionRow" key={`${session.provider}:${session.id}`}>
              <div className="agentSessionProvider">
                <span className={`providerBadge ${session.provider}`}>{providerLabel(session.provider)}</span>
              </div>
              <div className="agentSessionTitle">
                <strong>{session.title}</strong>
                <span>{session.id}{session.branch ? ` · ${session.branch}` : ""}</span>
              </div>
              <div className="agentSessionMeta">
                <strong>{session.model ?? "unknown model"}</strong>
                <span>{session.agent ?? "default agent"}</span>
              </div>
              <span className="agentSessionTime">{formatSessionTime(session.updatedAt)}</span>
              <span className={`agentSessionStatus ${session.status}`}>{session.status}</span>
              <div className="agentSessionActions">
                {session.terminalId && (
                  <button type="button" onClick={() => {
                    if (session.terminalId) revealTerminalPane(session.terminalId);
                  }}>
                    <TerminalSquare size={13} /> Focus
                  </button>
                )}
                <button type="button" onClick={() => void copySessionText(session.id)}>
                  <Code2 size={13} /> ID
                </button>
                <button type="button" onClick={() => onInspectAgentSession(session)}>
                  <FileText size={13} /> Inspect
                </button>
                <button type="button" onClick={() => onRenameAgentSession(session)}>
                  <Pencil size={13} /> Rename
                </button>
                <button type="button" onClick={() => void onViewAgentTranscript(session)}>
                  <ScrollText size={13} /> Transcript
                </button>
                {session.resumeCommand && (
                  <button type="button" onClick={() => void onResumeSession(session)} disabled={busy}>
                    <RefreshCw size={13} /> Resume
                  </button>
                )}
                <button type="button" className="danger" onClick={() => deleteAgentSession(session)}>
                  <Trash2 size={13} /> Delete
                </button>
              </div>
            </div>
          ))}
          {filteredAgentSessions.length === 0 && (
            <div className="agentSessionsEmpty">
              <Code2 size={30} />
              <strong>No agent sessions found.</strong>
              <span>Launch Codex, OpenCode, Athena Code, Claude, Grok, or Hermes from this workspace to track live and historical sessions here.</span>
            </div>
          )}
        </div>
      )}

      <div className="sessionStrip embeddedSessionStrip">
        {sessions.map((session) => (
          <div key={session.id} className="sessionChip active">
            <TerminalSquare size={15} />
            <div>
              <strong>{session.title}</strong>
              <span>{session.kind} · {session.status}{session.promptPath ? " · Athena context" : ""}</span>
            </div>
          </div>
        ))}
        {sessions.length === 0 && <p>Embedded terminals replace the old pop-out launcher. This is the ATHENA surface.</p>}
      </div>

      <form
        className="broadcastComposer"
        onSubmit={(event) => {
          event.preventDefault();
          void submitBroadcastPrompt();
        }}
      >
        <span>{promptTargets.length ? `${promptTargets.length} ready` : "No agents"}</span>
        <input
          value={broadcastPrompt}
          onChange={(event) => setBroadcastPrompt(event.target.value)}
          placeholder="Prompt all ready agents"
          disabled={broadcasting || promptTargets.length === 0}
        />
        <button className="primaryButton" type="submit" disabled={!canBroadcast} title="Send prompt to all ready agents">
          <Send size={14} /> Send
        </button>
      </form>
    </div>
  );
}

function NewLaunchMenu({
  open,
  workspace,
  menuRef,
  onOpenChange,
  onLaunch,
}: {
  open: boolean;
  workspace: string;
  menuRef: RefObject<HTMLDivElement | null>;
  onOpenChange: (open: boolean) => void;
  onLaunch: (kind: EmbeddedTerminalKind, count?: number) => Promise<void>;
}) {
  const disabled = !workspace;
  const actions: Array<{ label: string; detail: string; icon: ReactNode; kind: EmbeddedTerminalKind; count: number }> = [
    { label: "Shell", detail: "Start one embedded terminal", icon: <TerminalSquare size={14} />, kind: "shell", count: 1 },
    { label: "Hermes", detail: "Spawn Hermes", icon: <HermesIcon size={14} />, kind: "hermes", count: 1 },
    { label: "Athena Code", detail: "Spawn one Athena Code agent", icon: <AthenaIcon size={14} />, kind: "athena", count: 1 },
    { label: "Athena Code Grid", detail: "Spawn four Athena Code panes", icon: <AthenaIcon size={14} />, kind: "athena", count: 4 },
    { label: "Codex", detail: "Spawn one Codex agent", icon: <OpenAIIcon size={14} />, kind: "codex", count: 1 },
    { label: "Codex Grid", detail: "Spawn four Codex panes", icon: <OpenAIIcon size={14} />, kind: "codex", count: 4 },
    { label: "OpenCode", detail: "Spawn one OpenCode agent", icon: <OpenCodeIcon size={14} />, kind: "opencode", count: 1 },
    { label: "OpenCode Grid", detail: "Spawn four OpenCode panes", icon: <OpenCodeIcon size={14} />, kind: "opencode", count: 4 },
    { label: "Claude", detail: "Spawn one Claude agent", icon: <ClaudeIcon size={14} />, kind: "claude", count: 1 },
    { label: "Claude Grid", detail: "Spawn four Claude panes", icon: <ClaudeIcon size={14} />, kind: "claude", count: 4 },
    { label: "Grok", detail: "Spawn one Grok agent", icon: <GrokIcon size={14} />, kind: "grok", count: 1 },
    { label: "Grok Grid", detail: "Spawn four Grok panes", icon: <GrokIcon size={14} />, kind: "grok", count: 4 },
  ];

  function launch(kind: EmbeddedTerminalKind, count: number) {
    onOpenChange(false);
    void onLaunch(kind, count);
  }

  return (
    <div className="newMenu" ref={menuRef}>
      <button
        className="primaryButton newMenuButton"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        <Play size={14} /> New <ChevronDown size={13} />
      </button>
      {open && (
        <div className="newMenuPanel" role="menu">
          <span className="newMenuSection">Native terminals</span>
          {actions.map((action) => (
            <button key={`${action.kind}-${action.count}-${action.label}`} type="button" role="menuitem" onClick={() => launch(action.kind, action.count)}>
              <span>{action.icon}</span>
              <span>
                <strong>{action.label}</strong>
                <small>{action.detail}</small>
              </span>
            </button>
          ))}
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
