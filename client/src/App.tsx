import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Code2,
  Database,
  Eye,
  FileText,
  FolderOpen,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Users,
  Wrench,
  XCircle,
} from "lucide-react";
import { BackendClient, type AdapterStatus, type BackendStatus, type HermesStatus, type RecallStatus } from "./api";
import { desktop, type AgentSession, type EmbeddedTerminalKind, type EmbeddedTerminalSession, type WorkspacePath } from "./electron";
import { StatusDot, StatusPill } from "./components/status";
import { CommandRoom } from "./rooms/CommandRoom";
import { MemoryRoom } from "./rooms/MemoryRoom";
import { ReviewRoom } from "./rooms/ReviewRoom";
import { SettingsRoom } from "./rooms/SettingsRoom";
import { SwarmRoom } from "./rooms/SwarmRoom";
import { roomRouteById, roomRoutes, type ActiveRoom } from "./routes";
import {
  embeddedSessionKey,
  formatAge,
  providerLabel,
  recallAuditLines,
  selectedAgentSessionKey,
  terminalGridTitles,
  type AgentTranscriptState,
  type HandoffPreview,
} from "./session-utils";
import athenaMarkUrl from "./assets/athena-mark.png";
import athenaWordmarkUrl from "./assets/athena-wordmark.png";

type LoadState = {
  hermes: HermesStatus | null;
  recall: RecallStatus | null;
  adapters: Record<string, AdapterStatus>;
  memory: string[];
};

type AgentRole = {
  role: string;
  type: string;
  icon: ReactNode;
  status: "ready" | "running" | "waiting" | "offline";
  brief: string;
};

const emptyLoadState: LoadState = {
  hermes: null,
  recall: null,
  adapters: {},
  memory: [],
};

const workspaceStorageKey = "context-workspace:lastWorkspace";
const workspaceListStorageKey = "context-workspace:workspaces";

function storedWorkspaceValue(): string | null {
  try {
    return window.localStorage.getItem(workspaceStorageKey);
  } catch {
    return null;
  }
}

function parseStoredWorkspace(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<WorkspacePath>;
    return parsed.nativePath || null;
  } catch {
    return value;
  }
}

function normalizeWorkspaceKey(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function sameWorkspacePath(left: string, right: string): boolean {
  return Boolean(left && right && normalizeWorkspaceKey(left) === normalizeWorkspaceKey(right));
}

function workspaceDisplayName(workspace: WorkspacePath): string {
  const normalized = workspace.displayPath.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? workspace.displayPath;
}

function workspaceKey(workspace: WorkspacePath): string {
  return normalizeWorkspaceKey(workspace.nativePath);
}

function readWorkspaceList(): WorkspacePath[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(workspaceListStorageKey) ?? "[]") as Partial<WorkspacePath>[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is WorkspacePath =>
      typeof item?.nativePath === "string" &&
      typeof item.displayPath === "string" &&
      (typeof item.wslPath === "string" || item.wslPath === null),
    );
  } catch {
    return [];
  }
}

function writeWorkspaceList(workspaces: WorkspacePath[]): void {
  try {
    window.localStorage.setItem(workspaceListStorageKey, JSON.stringify(workspaces));
  } catch {
    // Ignore storage failures; tabs still work for this session.
  }
}

function upsertWorkspace(workspaces: WorkspacePath[], workspace: WorkspacePath): WorkspacePath[] {
  const key = workspaceKey(workspace);
  return [workspace, ...workspaces.filter((item) => workspaceKey(item) !== key)].slice(0, 12);
}

export function App() {
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [workspacePath, setWorkspacePath] = useState<WorkspacePath | null>(null);
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspacePath[]>(() => readWorkspaceList());
  const [state, setState] = useState<LoadState>(emptyLoadState);
  const [embeddedSessions, setEmbeddedSessions] = useState<EmbeddedTerminalSession[]>([]);
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeRoom, setActiveRoom] = useState<ActiveRoom>("command");
  const [terminalFocus, setTerminalFocus] = useState(false);
  const [layoutResetNonce, setLayoutResetNonce] = useState(0);
  const [recallRefreshing, setRecallRefreshing] = useState(false);
  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(null);
  const [agentTranscript, setAgentTranscript] = useState<AgentTranscriptState | null>(null);
  const backendRefreshInFlight = useRef(false);
  const dataRefreshInFlight = useRef(false);
  const agentSessionsRefreshInFlight = useRef(false);
  const autoStartedTerminals = useRef<Set<string>>(new Set());
  const autoRecallRefreshWorkspace = useRef<string | null>(null);
  const workspace = workspacePath?.nativePath ?? "";
  const workspaceDisplay = workspacePath?.displayPath ?? workspace;

  const client = useMemo(() => {
    return backend?.healthy && backend.baseUrl ? new BackendClient(backend.baseUrl) : null;
  }, [backend?.baseUrl, backend?.healthy]);

  const refreshBackend = useCallback(async () => {
    if (backendRefreshInFlight.current) return null;
    backendRefreshInFlight.current = true;
    try {
      const status = await desktop.checkBackendHealth();
      setBackend(status);
      return status;
    } finally {
      backendRefreshInFlight.current = false;
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      setEmbeddedSessions(await desktop.listEmbeddedTerminals());
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const refreshAgentSessions = useCallback(async () => {
    if (!workspace) {
      setAgentSessions([]);
      return;
    }
    if (agentSessionsRefreshInFlight.current) return;
    agentSessionsRefreshInFlight.current = true;
    try {
      setAgentSessions(await desktop.listAgentSessions(workspace));
    } catch (err) {
      setError(String(err));
    } finally {
      agentSessionsRefreshInFlight.current = false;
    }
  }, [workspace]);

  const refreshData = useCallback(async () => {
    if (!client || dataRefreshInFlight.current) return;
    dataRefreshInFlight.current = true;
    try {
      const [hermes, recall, adapters, memory] = await Promise.all([
        client.hermesStatus(),
        workspace ? client.recallStatus(workspace) : Promise.resolve(null),
        client.adapters(),
        workspace ? client.projectMemory(workspace, 30) : client.recentMemory(30),
      ]);
      setState({ hermes, recall, adapters, memory });
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      dataRefreshInFlight.current = false;
    }
  }, [client, workspace]);

  useEffect(() => {
    try {
      if (workspacePath?.nativePath.trim()) {
        window.localStorage.setItem(workspaceStorageKey, JSON.stringify(workspacePath));
      } else {
        window.localStorage.removeItem(workspaceStorageKey);
      }
    } catch {
      // Ignore storage failures; the selected workspace still works for this session.
    }
  }, [workspacePath]);

  useEffect(() => {
    writeWorkspaceList(workspaceTabs);
  }, [workspaceTabs]);

  useEffect(() => {
    const stored = parseStoredWorkspace(storedWorkspaceValue());
    const workspacePromise = stored ? desktop.toWorkspacePath(stored) : desktop.getDefaultWorkspace();
    workspacePromise
      .then((resolved) => activateWorkspace(resolved))
      .catch((err) => setError(String(err)));

    desktop
      .getBackendState()
      .then((status) => {
        setBackend(status);
        if (status.healthy) void refreshData();
      })
      .catch((err) => setError(String(err)));
    void refreshSessions();
  }, [refreshData, refreshSessions]);

  useEffect(() => {
    void refreshAgentSessions();
  }, [refreshAgentSessions, embeddedSessions]);

  useEffect(() => {
    void refreshData();
  }, [refreshData]);

  useEffect(() => {
    const removeSession = desktop.onEmbeddedTerminalSession((session) => {
      setEmbeddedSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
    });
    const removeExit = desktop.onEmbeddedTerminalExit((payload) => {
      setEmbeddedSessions((current) =>
        current.map((item) => (item.id === payload.id ? { ...item, status: "exited", exitCode: payload.exitCode } : item)),
      );
    });
    return () => {
      removeSession();
      removeExit();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshBackend().then((status) => {
        if (status?.healthy) void refreshData();
      });
      void refreshSessions();
      void refreshAgentSessions();
    }, 8000);
    return () => window.clearInterval(timer);
  }, [refreshBackend, refreshData, refreshSessions, refreshAgentSessions]);

  useEffect(() => {
    if (!workspace) return;
    const key = normalizeWorkspaceKey(workspace);
    const hasWorkspaceTerminal = embeddedSessions.some((session) => sameWorkspacePath(session.workspace, workspace));
    if (autoStartedTerminals.current.has(key) || hasWorkspaceTerminal) return;
    autoStartedTerminals.current.add(key);
    void launchEmbedded("shell", 1);
  }, [workspace, embeddedSessions]);

  useEffect(() => {
    if (!workspace || !state.recall?.stale || !state.recall.refresh_configured) return;
    if (autoRecallRefreshWorkspace.current === workspace) return;
    autoRecallRefreshWorkspace.current = workspace;
    void refreshRecall("Workspace selected", { surfaceError: false });
  }, [workspace, state.recall?.stale, state.recall?.refresh_configured]);

  async function restartBackend() {
    setBusy(true);
    try {
      const status = await desktop.restartBackend();
      setBackend(status);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function selectWorkspace() {
    try {
      const selected = await desktop.selectWorkspace();
      if (selected) activateWorkspace(selected);
    } catch (err) {
      setError(String(err));
    }
  }

  function activateWorkspace(nextWorkspace: WorkspacePath) {
    setWorkspacePath(nextWorkspace);
    setWorkspaceTabs((current) => upsertWorkspace(current, nextWorkspace));
    setSelectedSessionKey(null);
    setState((current) => ({ ...current, recall: null }));
  }

  function closeWorkspaceTab(tab: WorkspacePath) {
    const key = workspaceKey(tab);
    setWorkspaceTabs((current) => {
      const next = current.filter((item) => workspaceKey(item) !== key);
      if (workspacePath && workspaceKey(workspacePath) === key) {
        const replacement = next[0] ?? null;
        setWorkspacePath(replacement);
        setSelectedSessionKey(null);
        setState((currentState) => ({ ...currentState, recall: null }));
      }
      return next;
    });
  }

  async function refreshRecall(taskHint = "Manual recall refresh", options: { surfaceError?: boolean } = {}) {
    if (!client || !workspace || recallRefreshing) return null;
    const surfaceError = options.surfaceError ?? true;
    setRecallRefreshing(true);
    if (surfaceError) setError(null);
    try {
      const result = await client.refreshRecall(workspace, taskHint);
      setState((current) => ({ ...current, recall: result.recall }));
      return result.recall;
    } catch (err) {
      if (surfaceError) setError(String(err));
      return null;
    } finally {
      setRecallRefreshing(false);
    }
  }

  async function launchEmbedded(kind: EmbeddedTerminalKind, count = 1) {
    if (!workspace || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (kind !== "shell" && kind !== "hermes" && (!state.recall || state.recall.stale)) {
        let recall = state.recall;
        if (recall?.refresh_configured) {
          recall = await refreshRecall(`Launching ${count > 1 ? `${count} ${kind} agents` : `${kind} agent`}`);
        }
        if (!recall || recall.stale) {
          const proceed = window.confirm(
            recall?.refresh_configured
              ? "Hermes recall is still stale after refresh. Launch agents anyway?"
              : "Hermes recall refresh is not configured. Launch agents with missing or stale recall?",
          );
          if (!proceed) return;
        }
        if (recall && !recall.stale) {
          void client?.markRecallUsed(workspace, kind).then((result) => {
            setState((current) => ({ ...current, recall: result.recall }));
          }).catch(() => undefined);
        }
      }
      const titles = terminalGridTitles(kind);
      const launchOptions = Array.from({ length: count }, (_, index) => ({
        kind,
        title: titles[index] ?? `${kind}-${index + 1}`,
        cols: 96,
        rows: 28,
        sessionLabel: kind === "shell" || kind === "hermes" ? undefined : "New",
      }));
      const created: EmbeddedTerminalSession[] = [];

      for (const [index, options] of launchOptions.entries()) {
        if (kind === "opencode" && index > 0) await delay(650);
        created.push(
          await desktop.spawnEmbeddedTerminal(workspace, {
            kind,
            title: options.title,
            cols: options.cols,
            rows: options.rows,
            sessionLabel: options.sessionLabel,
          }),
        );
      }
      setEmbeddedSessions((current) => [...created.reverse(), ...current.filter((item) => !created.some((createdItem) => createdItem.id === item.id))]);
      if (count > 1) setLayoutResetNonce((value) => value + 1);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function resumeAgentSession(session: AgentSession) {
    if (!workspace || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await desktop.spawnEmbeddedTerminal(workspace, {
        kind: session.provider,
        title: `${providerLabel(session.provider)} Resume`,
        cols: 96,
        rows: 28,
        resumeSessionId: session.id,
        sessionLabel: session.title,
        providerSessionId: session.id,
      });
      setEmbeddedSessions((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setTerminalFocus(true);
      setActiveRoom("command");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function closeEmbeddedTerminal(id: string) {
    try {
      await desktop.killEmbeddedTerminal(id);
      setEmbeddedSessions((current) => current.filter((session) => session.id !== id));
    } catch (err) {
      setError(String(err));
    }
  }

  async function broadcastPromptToAgents(prompt: string, sessionIds: string[]) {
    const trimmed = prompt.trim();
    if (!trimmed || sessionIds.length === 0) return;

    const sessionById = new Map(embeddedSessions.map((session) => [session.id, session]));
    const results = await Promise.allSettled(sessionIds.map(async (id) => {
      const session = sessionById.get(id);
      if (session?.kind === "codex") {
        await desktop.writeEmbeddedTerminal(id, trimmed);
        await delay(120);
        return desktop.writeEmbeddedTerminal(id, "\r");
      }
      return desktop.writeEmbeddedTerminal(id, `${trimmed}\r`);
    }));
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) {
      setError(`Prompt sent to ${sessionIds.length - failed} agents; ${failed} agent${failed === 1 ? "" : "s"} could not receive it.`);
      return;
    }
    setError(null);
  }

  async function deleteMemoryEntry(entry: string) {
    if (!client || busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.deleteMemory(entry);
      await refreshData();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveHandoffToRecall(markdown: string, metadata: { sourceCount?: number; sourceTitles?: string[] } = {}) {
    if (!client || !workspace) throw new Error("Backend or workspace is not available.");
    const result = await client.writeRecall(workspace, markdown, "athena-session-handoff", {
      source_count: metadata.sourceCount,
      source_titles: metadata.sourceTitles,
    });
    setState((current) => ({ ...current, recall: result.recall }));
    setError(null);
  }

  const activeEmbeddedSessions = useMemo(
    () => embeddedSessions.filter((session) => sameWorkspacePath(session.workspace, workspace)),
    [embeddedSessions, workspace],
  );
  const selectedEmbeddedSession = activeEmbeddedSessions.find((session) => embeddedSessionKey(session) === selectedSessionKey) ?? null;
  const selectedAgentSession = agentSessions.find((session) => selectedAgentSessionKey(session) === selectedSessionKey) ?? null;
  const memoryEntries = [...state.memory].reverse();
  const codexInstalled = Boolean(state.adapters.codex?.installed);
  const installedAdapters = Object.values(state.adapters).filter((adapter) => adapter.installed).length;
  const liveSessionCount = activeEmbeddedSessions.filter((session) => session.status === "running").length;
  const reviewSessionCount = activeEmbeddedSessions.length + agentSessions.length;
  const activeRoute = roomRouteById[activeRoom];

  const loadAgentTranscript = useCallback(async (session: AgentSession) => {
    const key = selectedAgentSessionKey(session);
    setSelectedSessionKey(key);
    setActiveRoom("review");
    setAgentTranscript({ key, text: "", loading: true, error: null });
    if (!client) {
      setAgentTranscript({ key, text: "", loading: false, error: "Backend is not available." });
      return;
    }
    try {
      const text = await client.agentSessionTranscript(session.provider, session.id);
      setAgentTranscript({ key, text, loading: false, error: null });
    } catch (err) {
      setAgentTranscript({ key, text: "", loading: false, error: String(err) });
    }
  }, [client]);

  const agentRoles: AgentRole[] = [
    {
      role: "Builder",
      type: "codex",
      icon: <Wrench size={18} />,
      status: liveSessionCount ? "running" : codexInstalled ? "ready" : "offline",
      brief: "Implements changes against the active workspace.",
    },
    {
      role: "Reviewer",
      type: "codex",
      icon: <Eye size={18} />,
      status: codexInstalled ? "ready" : "offline",
      brief: "Inspects diffs, checks, and session output.",
    },
    {
      role: "Scout",
      type: "opencode",
      icon: <Search size={18} />,
      status: state.adapters.opencode?.installed ? "ready" : "waiting",
      brief: "Explores code, docs, and Hermes memory for context.",
    },
    {
      role: "Fixer",
      type: "claude",
      icon: <ShieldCheck size={18} />,
      status: state.adapters.claude?.installed ? "ready" : "waiting",
      brief: "Works through failures and follow-up fixes.",
    },
  ];

  return (
    <main className="workspaceSurface">
      <aside className="appSidebar" aria-label="Workspace navigation">
        <div className="brandLockup">
          <AthenaMark />
          <img className="athenaWordmark" src={athenaWordmarkUrl} alt="ATHENA" />
        </div>
        <nav className="sidebarNav">
          <span>Workspace</span>
          {roomRoutes.map((route) => (
            <SidebarButton
              key={route.id}
              active={activeRoom === route.id}
              icon={route.icon}
              label={route.sidebarLabel}
              onClick={() => setActiveRoom(route.id)}
            />
          ))}
        </nav>
        <div className="sidebarStatus">
          <span>Status</span>
          <StatusLine label="Backend" ok={Boolean(backend?.healthy)} />
          <StatusLine label="Hermes" ok={Boolean(state.hermes?.installed)} />
        </div>
        <div className="sidebarUser">
          <div className="avatar">A</div>
          <div>
            <strong>Alan</strong>
            <span>Pro</span>
          </div>
          <ChevronRight size={14} />
        </div>
      </aside>

      <section className={terminalFocus && activeRoom === "command" ? "dashboardShell terminalFocusShell" : "dashboardShell"}>
        {(error || (!backend?.healthy && backend?.lastError)) && <div className="noticeBar">{error ?? backend?.lastError}</div>}
        <section className="dashboardGrid">
          <div className="commandColumn">
            <header className="dashboardHeader">
              <div>
                <h1>{activeRoute.label}</h1>
                <p>{activeRoute.description}</p>
              </div>
            </header>
            <WorkspaceTabs
              workspaces={workspaceTabs}
              activeWorkspace={workspacePath}
              terminalSessions={embeddedSessions}
              onSelect={activateWorkspace}
              onClose={closeWorkspaceTab}
              onAdd={selectWorkspace}
            />

            {activeRoom === "command" && (
              <CommandRoom
                workspace={workspace}
                sessions={activeEmbeddedSessions}
                agentSessions={agentSessions}
                busy={busy}
                focused={terminalFocus}
                layoutResetNonce={layoutResetNonce}
                onFocusChange={setTerminalFocus}
                onLaunch={launchEmbedded}
                onClose={closeEmbeddedTerminal}
                onBroadcastPrompt={broadcastPromptToAgents}
                onResumeSession={resumeAgentSession}
                onInspectEmbeddedSession={(session) => {
                  setSelectedSessionKey(embeddedSessionKey(session));
                  setActiveRoom("review");
                }}
                onInspectAgentSession={(session) => {
                  setSelectedSessionKey(selectedAgentSessionKey(session));
                  setActiveRoom("review");
                }}
                onViewAgentTranscript={loadAgentTranscript}
                emptyMark={<AthenaMark />}
              />
            )}
            {activeRoom === "swarm" && (
              <SwarmRoom
                roles={agentRoles}
                sessions={activeEmbeddedSessions}
                agentSessions={agentSessions}
                onOpenCommand={() => setActiveRoom("command")}
                onInspectEmbeddedSession={(session) => {
                  setSelectedSessionKey(embeddedSessionKey(session));
                  setActiveRoom("review");
                }}
                onInspectAgentSession={(session) => {
                  setSelectedSessionKey(selectedAgentSessionKey(session));
                  setActiveRoom("review");
                }}
              />
            )}
            {activeRoom === "review" && (
              <ReviewRoom
                embeddedSessions={activeEmbeddedSessions}
                agentSessions={agentSessions}
                selectedEmbeddedSession={selectedEmbeddedSession}
                selectedAgentSession={selectedAgentSession}
                selectedSessionKey={selectedSessionKey}
                agentTranscript={agentTranscript}
                workspace={workspace}
                onSelectEmbeddedSession={(session) => setSelectedSessionKey(embeddedSessionKey(session))}
                onSelectAgentSession={(session) => setSelectedSessionKey(selectedAgentSessionKey(session))}
                onLoadAgentTranscript={loadAgentTranscript}
                onSaveHandoff={(preview) => saveHandoffToRecall(preview.markdown, {
                  sourceCount: preview.sourceCount,
                  sourceTitles: preview.sourceTitles,
                })}
                onStartFreshFromHandoff={async (kind, preview) => {
                  await saveHandoffToRecall(preview.markdown, {
                    sourceCount: preview.sourceCount,
                    sourceTitles: preview.sourceTitles,
                  });
                  await launchEmbedded(kind, 1);
                }}
              />
            )}
            {activeRoom === "memory" && <MemoryRoom entries={memoryEntries} busy={busy} onDelete={deleteMemoryEntry} mark={<AthenaMark />} />}
            {activeRoom === "settings" && (
              <SettingsRoom
                workspace={workspaceDisplay}
                backend={backend}
                hermes={state.hermes}
                recall={state.recall}
                adapters={state.adapters}
                busy={busy}
                refreshing={recallRefreshing}
                onSelectWorkspace={selectWorkspace}
                onRestartBackend={restartBackend}
                onRefreshRecall={() => void refreshRecall("Manual recall refresh")}
              />
            )}

            <LiveWorkflow activeSessions={liveSessionCount} reviewSessions={reviewSessionCount} memoryCount={state.memory.length} />
          </div>

          <aside className="glanceColumn">
            <ContextGlance
              tasks={reviewSessionCount}
              active={liveSessionCount}
              agents={installedAdapters}
              memory={state.memory.length}
              reviews={reviewSessionCount}
              onNavigate={setActiveRoom}
            />
          </aside>

          <aside className="rightColumn">
            <ActiveAgents roles={agentRoles} embeddedSessions={activeEmbeddedSessions} />
            <MemoryTimeline entries={memoryEntries} embeddedSessions={activeEmbeddedSessions} agentSessions={agentSessions} />
          </aside>

          <SharedMemorySnapshot
            workspace={workspaceDisplay}
            entries={memoryEntries}
            hermes={state.hermes}
            recall={state.recall}
            embeddedSessions={activeEmbeddedSessions}
            agentSessions={agentSessions}
            refreshing={recallRefreshing}
            onRefresh={() => void refreshRecall("Manual recall refresh")}
          />
        </section>
      </section>
    </main>
  );
}

function SidebarButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button className={active ? "sidebarButton active" : "sidebarButton"} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function AthenaMark({ small = false }: { small?: boolean }) {
  return (
    <span className={small ? "athenaMark small" : "athenaMark"} aria-hidden="true">
      <img src={athenaMarkUrl} alt="" />
    </span>
  );
}

function StatusLine({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="statusLine">
      <span><i className={ok ? "ok" : "bad"} />{label}</span>
      <strong>{ok ? "Online" : "Offline"}</strong>
    </div>
  );
}

function WorkspaceTabs({
  workspaces,
  activeWorkspace,
  terminalSessions,
  onSelect,
  onClose,
  onAdd,
}: {
  workspaces: WorkspacePath[];
  activeWorkspace: WorkspacePath | null;
  terminalSessions: EmbeddedTerminalSession[];
  onSelect: (workspace: WorkspacePath) => void;
  onClose: (workspace: WorkspacePath) => void;
  onAdd: () => Promise<void>;
}) {
  return (
    <div className="workspaceTabs" aria-label="Open workspaces">
      <div className="workspaceTabList">
        {workspaces.map((workspace) => {
          const active = activeWorkspace ? workspaceKey(activeWorkspace) === workspaceKey(workspace) : false;
          const running = terminalSessions.filter((session) => sameWorkspacePath(session.workspace, workspace.nativePath) && session.status === "running").length;
          return (
            <div key={workspace.nativePath} className={active ? "workspaceTab active" : "workspaceTab"}>
              <button type="button" onClick={() => onSelect(workspace)} title={workspace.displayPath}>
                <span>
                  <strong>{workspaceDisplayName(workspace)}</strong>
                  <small>{running} running</small>
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

function FlowStep({ icon, label, active }: { icon: ReactNode; label: string; active?: boolean }) {
  return (
    <div className={active ? "flowStep active" : "flowStep"}>
      {icon}
      <span>{label}</span>
    </div>
  );
}

function ContextGlance({
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

function LiveWorkflow({ activeSessions, reviewSessions, memoryCount }: { activeSessions: number; reviewSessions: number; memoryCount: number }) {
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

function ActiveAgents({ roles, embeddedSessions }: { roles: AgentRole[]; embeddedSessions: EmbeddedTerminalSession[] }) {
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

function MemoryTimeline({ entries, embeddedSessions, agentSessions }: { entries: string[]; embeddedSessions: EmbeddedTerminalSession[]; agentSessions: AgentSession[] }) {
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

function SharedMemorySnapshot({
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
