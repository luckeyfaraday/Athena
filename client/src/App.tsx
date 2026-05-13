import { type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bot,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  Database,
  Eye,
  FileText,
  FolderOpen,
  Layers3,
  Play,
  RefreshCw,
  ScrollText,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Maximize2,
  Minimize2,
  TerminalSquare,
  Trash2,
  Users,
  Wrench,
  XCircle,
} from "lucide-react";
import { BackendClient, type AdapterStatus, type BackendStatus, type HermesStatus, type RecallStatus } from "./api";
import { desktop, type AgentSession, type EmbeddedTerminalKind, type EmbeddedTerminalSession, type WorkspacePath } from "./electron";
import { EmbeddedTerminal } from "./components/EmbeddedTerminal";
import { roomRouteById, roomRoutes, type ActiveRoom } from "./routes";
import athenaMarkUrl from "./assets/athena-mark.png";
import athenaWordmarkUrl from "./assets/athena-wordmark.png";

type LoadState = {
  hermes: HermesStatus | null;
  recall: RecallStatus | null;
  adapters: Record<string, AdapterStatus>;
  memory: string[];
};

type SessionProviderFilter = AgentSession["provider"] | "all";

type AgentRole = {
  role: string;
  type: string;
  icon: ReactNode;
  status: "ready" | "running" | "waiting" | "offline";
  brief: string;
};

type PaneDragState = {
  id: string;
  deltaX: number;
  deltaY: number;
  targetId: string | null;
};

type AgentTranscriptState = {
  key: string;
  text: string;
  loading: boolean;
  error: string | null;
};

type HandoffSessionSource =
  | {
      key: string;
      kind: "embedded";
      title: string;
      label: string;
      status: string;
      id: string;
      workspace: string;
      provider: HandoffSourceProvider;
      session: EmbeddedTerminalSession;
    }
  | {
      key: string;
      kind: "native";
      title: string;
      label: string;
      status: string;
      id: string;
      workspace: string;
      provider: HandoffSourceProvider;
      session: AgentSession;
    };

type HandoffEvidence = HandoffSessionSource & {
  evidence: string;
};

type HandoffPreview = {
  markdown: string;
  bytes: number;
  sourceCount: number;
  workspace: string;
};

type HandoffSourceProvider = EmbeddedTerminalKind | AgentSession["provider"];

const emptyLoadState: LoadState = {
  hermes: null,
  recall: null,
  adapters: {},
  memory: [],
};

const workspaceStorageKey = "context-workspace:lastWorkspace";
const workspaceListStorageKey = "context-workspace:workspaces";
const deletedAgentSessionsStoragePrefix = "context-workspace:deleted-agent-sessions:";

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

function deletedAgentSessionsStorageKey(workspace: string): string {
  return `${deletedAgentSessionsStoragePrefix}${workspace || "none"}`;
}

function readDeletedAgentSessions(workspace: string): Set<string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(deletedAgentSessionsStorageKey(workspace)) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function writeDeletedAgentSessions(workspace: string, sessions: Set<string>): void {
  try {
    window.localStorage.setItem(deletedAgentSessionsStorageKey(workspace), JSON.stringify([...sessions]));
  } catch {
    // Ignore storage failures; deleting still applies for the current render.
  }
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

  async function saveHandoffToRecall(markdown: string) {
    if (!client || !workspace) throw new Error("Backend or workspace is not available.");
    const result = await client.writeRecall(workspace, markdown);
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
                onSaveHandoff={saveHandoffToRecall}
                onStartFreshFromHandoff={async (kind, markdown) => {
                  await saveHandoffToRecall(markdown);
                  await launchEmbedded(kind, 1);
                }}
              />
            )}
            {activeRoom === "memory" && <MemoryRoom entries={memoryEntries} busy={busy} onDelete={deleteMemoryEntry} />}
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

function StatusPill({ tone, children }: { tone: "ok" | "warn" | "bad"; children: ReactNode }) {
  return (
    <span className={`statusPill ${tone}`}>
      <span />
      {children}
    </span>
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

function NewLaunchMenu({
  busy,
  open,
  workspace,
  menuRef,
  onOpenChange,
  onLaunch,
}: {
  busy: boolean;
  open: boolean;
  workspace: string;
  menuRef: RefObject<HTMLDivElement | null>;
  onOpenChange: (open: boolean) => void;
  onLaunch: (kind: EmbeddedTerminalKind, count?: number) => Promise<void>;
}) {
  const disabled = !workspace || busy;
  const actions: Array<{ label: string; detail: string; icon: ReactNode; kind: EmbeddedTerminalKind; count: number }> = [
    { label: "Shell", detail: "Start one embedded terminal", icon: <TerminalSquare size={14} />, kind: "shell", count: 1 },
    { label: "Hermes", detail: "Spawn Hermes", icon: <BrainCircuit size={14} />, kind: "hermes", count: 1 },
    { label: "Codex", detail: "Spawn one Codex agent", icon: <Bot size={14} />, kind: "codex", count: 1 },
    { label: "Codex Grid", detail: "Spawn four Codex panes", icon: <Layers3 size={14} />, kind: "codex", count: 4 },
    { label: "OpenCode", detail: "Spawn one OpenCode agent", icon: <Bot size={14} />, kind: "opencode", count: 1 },
    { label: "OpenCode Grid", detail: "Spawn four OpenCode panes", icon: <Users size={14} />, kind: "opencode", count: 4 },
    { label: "Claude", detail: "Spawn one Claude agent", icon: <ShieldCheck size={14} />, kind: "claude", count: 1 },
    { label: "Claude Grid", detail: "Spawn four Claude panes", icon: <ShieldCheck size={14} />, kind: "claude", count: 4 },
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

function SettingsRoom({
  workspace,
  backend,
  hermes,
  recall,
  adapters,
  busy,
  refreshing,
  onSelectWorkspace,
  onRestartBackend,
  onRefreshRecall,
}: {
  workspace: string;
  backend: BackendStatus | null;
  hermes: HermesStatus | null;
  recall: RecallStatus | null;
  adapters: Record<string, AdapterStatus>;
  busy: boolean;
  refreshing: boolean;
  onSelectWorkspace: () => Promise<void>;
  onRestartBackend: () => Promise<void>;
  onRefreshRecall: () => void;
}) {
  const recallTone = !recall ? "warn" : recall.status === "fresh" ? "ok" : recall.status === "missing" ? "bad" : "warn";
  const backendTone = backend?.healthy ? "ok" : backend?.running ? "warn" : "bad";
  const hermesTone = hermes?.installed ? "ok" : "bad";
  const adapterList = Object.values(adapters);
  const installedAdapters = adapterList.filter((adapter) => adapter.installed);
  const adapterSummary = adapterList.length
    ? adapterList.map((adapter) => `${adapter.agent_type}: ${adapter.installed ? adapter.command_path ?? adapter.executable : "missing"}`).join("\n")
    : "No adapter status loaded";

  return (
    <section className="roomPanel settingsRoom">
      <div className="roomPanelHeader">
        <div>
          <span className="eyebrow">Workspace Settings</span>
          <h3>Real controls for the active environment</h3>
        </div>
      </div>
      <div className="settingsGrid">
        <article className="settingsSection">
          <div>
            <strong>Workspace</strong>
            <span>{workspace || "No workspace selected"}</span>
          </div>
          <button className="ghostButton" type="button" onClick={() => void onSelectWorkspace()}>
            <FolderOpen size={14} /> Change
          </button>
        </article>
        <article className="settingsSection">
          <div>
            <strong>Backend</strong>
            <span>{backend?.baseUrl ?? "Not connected"}</span>
          </div>
          <StatusPill tone={backendTone}>{backend?.healthy ? "Healthy" : backend?.running ? "Starting" : "Offline"}</StatusPill>
          <button className="ghostButton" type="button" onClick={() => void onRestartBackend()} disabled={busy}>
            <RefreshCw size={14} /> {busy ? "Restarting" : "Restart"}
          </button>
        </article>
        <article className="settingsSection">
          <div>
            <strong>Hermes</strong>
            <span>
              {[
                hermes?.message ?? "Status unavailable",
                hermes?.command_path ? `Command: ${hermes.command_path}` : null,
                hermes?.hermes_home ? `Home: ${hermes.hermes_home}` : null,
                hermes?.memory_path ? `Memory: ${hermes.memory_path}` : null,
              ].filter(Boolean).join("\n")}
            </span>
          </div>
          <StatusPill tone={hermesTone}>{hermes?.installed ? hermes.version ?? "Installed" : "Missing"}</StatusPill>
        </article>
        <article className="settingsSection">
          <div>
            <strong>Recall</strong>
            <span>
              {recall
                ? [
                    `Cache: ${recall.path}`,
                    `Age: ${recall.age_seconds == null ? "not refreshed" : formatAge(recall.age_seconds)}`,
                    `Refresh command: ${recall.refresh_configured ? "configured" : "not configured"}`,
                    recall.source ? `Source: ${recall.source}` : null,
                  ].filter(Boolean).join("\n")
                : "No recall status"}
            </span>
          </div>
          <StatusPill tone={recallTone}>{recall?.status ?? "Unknown"}</StatusPill>
          <button className="ghostButton" type="button" onClick={onRefreshRecall} disabled={refreshing || !recall?.refresh_configured}>
            <RefreshCw size={14} /> {refreshing ? "Refreshing" : "Refresh"}
          </button>
        </article>
        <article className="settingsSection wide">
          <div>
            <strong>Agent adapters</strong>
            <span>{adapterSummary}</span>
          </div>
          <StatusPill tone={installedAdapters.length ? "ok" : "warn"}>{installedAdapters.length}/{adapterList.length || 0} installed</StatusPill>
        </article>
      </div>
    </section>
  );
}

function formatAge(ageSeconds: number): string {
  if (ageSeconds < 60) return "just now";
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function CommandRoom({
  workspace,
  sessions,
  agentSessions,
  busy,
  focused,
  layoutResetNonce,
  onFocusChange,
  onLaunch,
  onClose,
  onBroadcastPrompt,
  onResumeSession,
  onInspectEmbeddedSession,
  onInspectAgentSession,
  onViewAgentTranscript,
}: {
  workspace: string;
  sessions: EmbeddedTerminalSession[];
  agentSessions: AgentSession[];
  busy: boolean;
  focused: boolean;
  layoutResetNonce: number;
  onFocusChange: (focused: boolean) => void;
  onLaunch: (kind: EmbeddedTerminalKind, count?: number) => Promise<void>;
  onClose: (id: string) => Promise<void>;
  onBroadcastPrompt: (prompt: string, sessionIds: string[]) => Promise<void>;
  onResumeSession: (session: AgentSession) => Promise<void>;
  onInspectEmbeddedSession: (session: EmbeddedTerminalSession) => void;
  onInspectAgentSession: (session: AgentSession) => void;
  onViewAgentTranscript: (session: AgentSession) => Promise<void>;
}) {
  const [paneOrder, setPaneOrder] = useState<string[]>([]);
  const [dragState, setDragState] = useState<PaneDragState | null>(null);
  const [broadcastPrompt, setBroadcastPrompt] = useState("");
  const [broadcasting, setBroadcasting] = useState(false);
  const [activeTab, setActiveTab] = useState<"terminals" | "sessions">("terminals");
  const [activeSessionProvider, setActiveSessionProvider] = useState<SessionProviderFilter>("all");
  const [deletedSessionKeys, setDeletedSessionKeys] = useState<Set<string>>(() => readDeletedAgentSessions(workspace));
  const [collapsedPaneIds, setCollapsedPaneIds] = useState<Set<string>>(new Set());
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const dragStartRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const dragTargetRef = useRef<string | null>(null);
  const newMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setPaneOrder((current) => {
      const sessionIds = sessions.map((session) => session.id);
      const known = current.filter((id) => sessionIds.includes(id));
      const added = sessionIds.filter((id) => !known.includes(id));
      return [...known, ...added];
    });
  }, [sessions]);

  useEffect(() => {
    if (layoutResetNonce === 0 || sessions.length === 0) return;
    setPaneOrder(sessions.map((session) => session.id));
  }, [layoutResetNonce, sessions]);

  useEffect(() => {
    const sessionIds = new Set(sessions.map((session) => session.id));
    setCollapsedPaneIds((current) => new Set([...current].filter((id) => sessionIds.has(id))));
    setMaximizedPaneId((current) => current && sessionIds.has(current) ? current : null);
  }, [sessions]);

  const visibleSessions = paneOrder
    .map((id) => sessions.find((session) => session.id === id))
    .filter((session): session is EmbeddedTerminalSession => Boolean(session));
  const displayedTerminalSessions = maximizedPaneId
    ? visibleSessions.filter((session) => session.id === maximizedPaneId)
    : visibleSessions;
  const visibleAgentSessions = agentSessions.filter((session) => !deletedSessionKeys.has(agentSessionKey(session)));
  const providerTabs = useMemo(() => {
    const counts = new Map<SessionProviderFilter, number>([["all", visibleAgentSessions.length]]);
    for (const session of visibleAgentSessions) {
      counts.set(session.provider, (counts.get(session.provider) ?? 0) + 1);
    }
    return (["all", "codex", "opencode", "claude", "hermes"] as SessionProviderFilter[]).map((provider) => ({
      provider,
      label: provider === "all" ? "All" : providerLabel(provider),
      count: counts.get(provider) ?? 0,
    }));
  }, [visibleAgentSessions]);
  const filteredAgentSessions = activeSessionProvider === "all"
    ? visibleAgentSessions
    : visibleAgentSessions.filter((session) => session.provider === activeSessionProvider);
  const shownCount = visibleSessions.length;
  const promptTargets = sessions.filter((session) => session.status === "running" && session.kind !== "shell");
  const canBroadcast = promptTargets.length > 0 && broadcastPrompt.trim().length > 0 && !broadcasting;
  const runningAgentSessions = visibleAgentSessions.filter((session) => session.status === "running").length;

  useEffect(() => {
    setDeletedSessionKeys(readDeletedAgentSessions(workspace));
  }, [workspace]);

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

  function movePaneToSlot(sourceSessionId: string, targetSessionId: string) {
    if (sourceSessionId === targetSessionId) return;
    setPaneOrder((current) => {
      const sourceIndex = current.indexOf(sourceSessionId);
      const targetIndex = current.indexOf(targetSessionId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const next = [...current];
      next[sourceIndex] = targetSessionId;
      next[targetIndex] = sourceSessionId;
      return next;
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
          <span className="panelMeta">{sessions.length ? `${shownCount} running sessions` : "No sessions running"}</span>
        </div>
        <div className="buttonRow">
          <button className="ghostButton" onClick={() => onFocusChange(!focused)} title={focused ? "Exit terminal focus" : "Focus terminals"}>
            {focused ? <Minimize2 size={15} /> : <Maximize2 size={15} />} {focused ? "Exit Focus" : "Focus"}
          </button>
          <button className="ghostButton" onClick={() => void onLaunch("shell", 1)} disabled={!workspace || busy}>
            <TerminalSquare size={15} /> New Shell
          </button>
          <NewLaunchMenu
            busy={busy}
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
        <div className="terminalStage embeddedStage slotTerminalStage">
          {displayedTerminalSessions.map((session) => (
            <div
              key={session.id}
              data-pane-id={session.id}
              className={[
                "terminalPane liveTerminalPane slotPane",
                dragState?.id === session.id ? "dragging" : "",
                dragState?.targetId === session.id ? "dropTarget" : "",
                collapsedPaneIds.has(session.id) ? "collapsed" : "",
                maximizedPaneId === session.id ? "maximized" : "",
              ].filter(Boolean).join(" ")}
              style={
                dragState?.id === session.id
                  ? { transform: `translate(${dragState.deltaX}px, ${dragState.deltaY}px)` }
                  : undefined
              }
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
                <strong>{session.title}</strong>
                <em>{terminalPaneMeta(session)}</em>
                <button type="button" className="terminalChromeAction" onClick={() => onInspectEmbeddedSession(session)} title={`Inspect ${session.title}`}>
                  <FileText size={13} />
                </button>
              </div>
              {!collapsedPaneIds.has(session.id) && <EmbeddedTerminal session={session} />}
            </div>
          ))}
          {visibleSessions.length === 0 && (
            <div className="terminalEmptyState">
              <AthenaMark />
              <strong>No embedded terminals yet.</strong>
              <span>Select a workspace, then start a shell or launch an agent session with Hermes recall attached.</span>
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
                  <button type="button" onClick={() => setActiveTab("terminals")}>
                    <TerminalSquare size={13} /> Focus
                  </button>
                )}
                <button type="button" onClick={() => void copySessionText(session.id)}>
                  <Code2 size={13} /> ID
                </button>
                <button type="button" onClick={() => onInspectAgentSession(session)}>
                  <FileText size={13} /> Inspect
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
              <span>Launch Codex, OpenCode, Claude, or Hermes from this workspace to track live and historical sessions here.</span>
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
              <span>{session.kind} · {session.status}{session.promptPath ? " · Hermes prompt" : ""}</span>
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

function terminalGridTitles(kind: EmbeddedTerminalKind): string[] {
  if (kind === "hermes") return ["Hermes"];
  if (kind === "codex") return ["Codex Builder", "Codex Reviewer", "Codex Scout", "Codex Fixer"];
  if (kind === "opencode") return ["OpenCode Builder", "OpenCode Reviewer", "OpenCode Scout", "OpenCode Fixer"];
  if (kind === "claude") return ["Claude Builder", "Claude Reviewer", "Claude Scout", "Claude Fixer"];
  return ["Shell"];
}

function providerLabel(provider: AgentSession["provider"]): string {
  if (provider === "hermes") return "Hermes";
  if (provider === "opencode") return "OpenCode";
  if (provider === "claude") return "Claude";
  return "Codex";
}

function agentSessionKey(session: AgentSession): string {
  return `${session.provider}:${session.id}`;
}

function selectedAgentSessionKey(session: AgentSession): string {
  return `agent:${agentSessionKey(session)}`;
}

function embeddedSessionKey(session: EmbeddedTerminalSession): string {
  return `embedded:${session.id}`;
}

async function loadHandoffEvidence(source: HandoffSessionSource): Promise<HandoffEvidence> {
  const terminalId = source.kind === "embedded" ? source.session.id : source.session.terminalId;
  if (!terminalId) {
    return {
      ...source,
      evidence: "Metadata only. No live terminal buffer is attached to this historical session.",
    };
  }
  try {
    const buffer = await desktop.getEmbeddedTerminalBuffer(terminalId);
    return {
      ...source,
      evidence: tailText(buffer || "No terminal output captured yet.", 1800),
    };
  } catch (err) {
    return {
      ...source,
      evidence: `Unable to read live buffer: ${String(err)}`,
    };
  }
}

function buildHandoffMarkdown(workspace: string, sources: HandoffEvidence[]): string {
  const generated = new Date().toISOString();
  const selectedSessions = sources
    .map((source) => `- ${source.label}: ${source.title} (${source.status}, ${source.id})`)
    .join("\n");
  const evidenceSections: string[] = [];
  let remainingEvidenceChars = 12000;
  for (const source of sources) {
    if (remainingEvidenceChars <= 0) {
      evidenceSections.push(`### ${source.title}\n\n[omitted because handoff evidence reached its size cap]`);
      continue;
    }
    const evidence = tailText(source.evidence.trim() || "No evidence available.", Math.min(1800, remainingEvidenceChars));
    remainingEvidenceChars -= evidence.length;
    evidenceSections.push([`### ${source.title}`, evidence].join("\n\n"));
  }
  const evidence = evidenceSections.join("\n\n");
  return [
    "# Athena Session Handoff",
    "",
    `Generated: ${generated}`,
    `Workspace: ${workspace}`,
    `Sources: ${sources.length}`,
    "",
    "## Summary",
    "- Bounded handoff generated from selected Athena sessions.",
    "- Review the selected sessions and evidence before launching the next agent.",
    "",
    "## Selected Sessions",
    selectedSessions || "- None",
    "",
    "## Recent Evidence",
    evidence || "No evidence selected.",
    "",
    "## Next Suggested Context",
    "- Use this handoff as short-lived project context.",
    "- Verify current git state and latest user instructions before making changes.",
  ].join("\n");
}

function tailText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) return normalized;
  return `[truncated to last ${maxChars} chars]\n${normalized.slice(-maxChars)}`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function terminalPaneMeta(session: EmbeddedTerminalSession): string {
  if (session.kind === "shell") return `${session.status}${session.pid ? ` · pid ${session.pid}` : ""}`;
  return session.sessionLabel ?? "New";
}

function formatSessionTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "unknown";
  const ageSeconds = Math.max(0, (Date.now() - timestamp) / 1000);
  return formatAge(ageSeconds);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function SwarmRoom({
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

function ReviewRoom({
  embeddedSessions,
  agentSessions,
  selectedEmbeddedSession,
  selectedAgentSession,
  selectedSessionKey,
  agentTranscript,
  workspace,
  onSelectEmbeddedSession,
  onSelectAgentSession,
  onLoadAgentTranscript,
  onSaveHandoff,
  onStartFreshFromHandoff,
}: {
  embeddedSessions: EmbeddedTerminalSession[];
  agentSessions: AgentSession[];
  selectedEmbeddedSession: EmbeddedTerminalSession | null;
  selectedAgentSession: AgentSession | null;
  selectedSessionKey: string | null;
  agentTranscript: AgentTranscriptState | null;
  workspace: string;
  onSelectEmbeddedSession: (session: EmbeddedTerminalSession) => void;
  onSelectAgentSession: (session: AgentSession) => void;
  onLoadAgentTranscript: (session: AgentSession) => Promise<void>;
  onSaveHandoff: (markdown: string) => Promise<void>;
  onStartFreshFromHandoff: (kind: Extract<EmbeddedTerminalKind, "codex" | "opencode" | "claude">, markdown: string) => Promise<void>;
}) {
  const [handoffSelection, setHandoffSelection] = useState<Set<string>>(() => new Set());
  const [handoffPreview, setHandoffPreview] = useState<HandoffPreview | null>(null);
  const [handoffGenerating, setHandoffGenerating] = useState(false);
  const [handoffSaving, setHandoffSaving] = useState(false);
  const [handoffLaunching, setHandoffLaunching] = useState<EmbeddedTerminalKind | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [handoffSavedAt, setHandoffSavedAt] = useState<string | null>(null);
  const [handoffProviderTab, setHandoffProviderTab] = useState<HandoffSourceProvider | "all">("all");
  const selectedLabel = selectedEmbeddedSession?.title ?? selectedAgentSession?.title ?? "No session selected";
  const liveAgentSessions = embeddedSessions.filter((session) => session.kind !== "shell" && session.status === "running");
  const historicalAgentSessions = agentSessions.filter((session) => session.status === "historical");
  const handoffSources = useMemo<HandoffSessionSource[]>(
    () => [
      ...embeddedSessions.map((session) => ({
        key: embeddedSessionKey(session),
        kind: "embedded" as const,
        title: session.title,
        label: `embedded ${session.kind}`,
        status: session.status,
        id: session.id,
        workspace: session.workspace,
        session,
        provider: session.kind,
      })),
      ...agentSessions.map((session) => ({
        key: selectedAgentSessionKey(session),
        kind: "native" as const,
        title: session.title,
        label: `native ${providerLabel(session.provider)}`,
        status: session.status,
        id: session.id,
        workspace: session.workspace,
        session,
        provider: session.provider,
      })),
    ],
    [agentSessions, embeddedSessions],
  );
  const handoffProviderTabs = useMemo(() => {
    const counts = new Map<HandoffSourceProvider | "all", number>([["all", handoffSources.length]]);
    for (const source of handoffSources) {
      counts.set(source.provider, (counts.get(source.provider) ?? 0) + 1);
    }
    return (["all", "codex", "opencode", "claude", "hermes", "shell"] as (HandoffSourceProvider | "all")[])
      .filter((provider) => provider === "all" || (counts.get(provider) ?? 0) > 0)
      .map((provider) => ({
        provider,
        label: provider === "all" ? "All" : provider === "shell" ? "Shell" : providerLabel(provider as AgentSession["provider"]),
        count: counts.get(provider) ?? 0,
      }));
  }, [handoffSources]);
  const visibleHandoffSources = handoffProviderTab === "all"
    ? handoffSources
    : handoffSources.filter((source) => source.provider === handoffProviderTab);
  const selectedHandoffSources = handoffSelection.size > 0
    ? handoffSources.filter((source) => handoffSelection.has(source.key))
    : handoffSources.filter((source) => source.key === selectedSessionKey);
  const canCreateHandoff = selectedHandoffSources.length > 0 && !handoffGenerating;

  useEffect(() => {
    const available = new Set(handoffSources.map((source) => source.key));
    setHandoffSelection((current) => {
      const next = new Set([...current].filter((key) => available.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [handoffSources]);

  useEffect(() => {
    if (handoffProviderTab === "all") return;
    if (handoffSources.some((source) => source.provider === handoffProviderTab)) return;
    setHandoffProviderTab("all");
  }, [handoffProviderTab, handoffSources]);

  function toggleHandoffSource(key: string) {
    setHandoffSelection((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setHandoffPreview(null);
    setHandoffError(null);
    setHandoffSavedAt(null);
  }

  async function createHandoffPreview() {
    if (!workspace || selectedHandoffSources.length === 0) return;
    setHandoffGenerating(true);
    setHandoffError(null);
    try {
      const evidence = await Promise.all(selectedHandoffSources.map(loadHandoffEvidence));
      const markdown = buildHandoffMarkdown(workspace, evidence);
      setHandoffPreview({
        markdown,
        bytes: byteLength(markdown),
        sourceCount: evidence.length,
        workspace,
      });
    } catch (err) {
      setHandoffError(String(err));
    } finally {
      setHandoffGenerating(false);
    }
  }

  async function saveHandoffPreview() {
    if (!handoffPreview) return;
    setHandoffSaving(true);
    setHandoffError(null);
    try {
      await onSaveHandoff(handoffPreview.markdown);
      setHandoffSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setHandoffError(String(err));
    } finally {
      setHandoffSaving(false);
    }
  }

  async function startFreshFromHandoff(kind: Extract<EmbeddedTerminalKind, "codex" | "opencode" | "claude">) {
    if (!handoffPreview) return;
    setHandoffLaunching(kind);
    setHandoffError(null);
    try {
      await onStartFreshFromHandoff(kind, handoffPreview.markdown);
      setHandoffSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setHandoffError(String(err));
    } finally {
      setHandoffLaunching(null);
    }
  }

  return (
    <div className="roomPanel reviewRoom">
      <div className="decisionHero">
        <div>
          <span className="tinyLabel">Session review</span>
          <h3>{selectedLabel}</h3>
          <p>Inspect live buffers, prompt paths, provider session IDs, and native metadata.</p>
        </div>
        <div className={liveAgentSessions.length ? "decisionBadge ship" : historicalAgentSessions.length ? "decisionBadge idle" : "decisionBadge risk"}>
          {liveAgentSessions.length ? <Activity size={20} /> : historicalAgentSessions.length ? <Code2 size={20} /> : <XCircle size={20} />}
          <span>{liveAgentSessions.length ? `${liveAgentSessions.length} live` : historicalAgentSessions.length ? `${historicalAgentSessions.length} historical` : "No sessions"}</span>
        </div>
      </div>

      <div className="reviewColumns">
        <ReviewCard title="Live buffers" icon={<TerminalSquare size={17} />} items={[`${embeddedSessions.length} embedded terminals`, `${liveAgentSessions.length} live agent panes`, "Terminal output captured from panes"]} />
        <ReviewCard title="Native history" icon={<Code2 size={17} />} items={[`${historicalAgentSessions.length} historical sessions`, "Provider metadata", "Transcript reads when available"]} />
        <ReviewCard title="Inspector scope" icon={<Play size={17} />} items={["Inspect live pane output", "Inspect provider metadata", "Read native transcripts"]} />
      </div>

      <section className="handoffPanel">
        <div className="handoffPanelHeader">
          <div>
            <span className="tinyLabel">Session continuity</span>
            <strong>{selectedHandoffSources.length ? `${selectedHandoffSources.length} selected` : "Select sessions for handoff"}</strong>
          </div>
          <div className="sessionInspectorActions">
            <button type="button" className="ghostButton" onClick={() => void createHandoffPreview()} disabled={!canCreateHandoff}>
              <FileText size={14} /> {handoffGenerating ? "Creating" : "Create handoff"}
            </button>
            <button type="button" className="ghostButton" onClick={() => void saveHandoffPreview()} disabled={!handoffPreview || handoffSaving}>
              <CheckCircle2 size={14} /> {handoffSaving ? "Saving" : "Save to recall"}
            </button>
          </div>
        </div>
        <p>Bounded handoff preview for the active workspace.</p>
        <div className="handoffProviderTabs" aria-label="Handoff source providers">
          {handoffProviderTabs.map((tab) => (
            <button
              key={tab.provider}
              type="button"
              className={handoffProviderTab === tab.provider ? "active" : ""}
              onClick={() => setHandoffProviderTab(tab.provider)}
            >
              {tab.label}
              <span>{tab.count}</span>
            </button>
          ))}
        </div>
        <div className="handoffSourcePicker" aria-label="Handoff sources">
          {visibleHandoffSources.slice(0, 12).map((source) => {
            const selected = handoffSelection.has(source.key) || (handoffSelection.size === 0 && selectedSessionKey === source.key);
            return (
              <button
                key={source.key}
                type="button"
                className={selected ? "handoffSourceChip selected" : "handoffSourceChip"}
                onClick={() => toggleHandoffSource(source.key)}
              >
                {selected ? <CheckCircle2 size={13} /> : <span />}
                <strong>{source.title}</strong>
                <em>{source.label}</em>
              </button>
            );
          })}
          {handoffSources.length === 0 && <span className="handoffSourceEmpty">No sessions available for handoff.</span>}
          {handoffSources.length > 0 && visibleHandoffSources.length === 0 && <span className="handoffSourceEmpty">No sessions for this provider.</span>}
        </div>
        {handoffError && <p className="handoffError">{handoffError}</p>}
        {handoffSavedAt && <p className="handoffSaved">Saved to recall at {handoffSavedAt}</p>}
        {handoffPreview && (
          <div className="handoffPreview">
            <div>
              <span>{handoffPreview.sourceCount} sources</span>
              <span>{handoffPreview.bytes} bytes</span>
              <span>{handoffPreview.workspace}</span>
            </div>
            <pre>{handoffPreview.markdown}</pre>
            <div className="handoffLaunchActions">
              <button type="button" className="ghostButton" onClick={() => void startFreshFromHandoff("codex")} disabled={Boolean(handoffLaunching)}>
                <Bot size={14} /> {handoffLaunching === "codex" ? "Launching" : "Start Codex"}
              </button>
              <button type="button" className="ghostButton" onClick={() => void startFreshFromHandoff("opencode")} disabled={Boolean(handoffLaunching)}>
                <Code2 size={14} /> {handoffLaunching === "opencode" ? "Launching" : "Start OpenCode"}
              </button>
              <button type="button" className="ghostButton" onClick={() => void startFreshFromHandoff("claude")} disabled={Boolean(handoffLaunching)}>
                <Sparkles size={14} /> {handoffLaunching === "claude" ? "Launching" : "Start Claude"}
              </button>
            </div>
          </div>
        )}
      </section>

      <div className="sessionReviewList">
        {embeddedSessions.map((session) => (
          <article
            key={embeddedSessionKey(session)}
            className={selectedSessionKey === embeddedSessionKey(session) || handoffSelection.has(embeddedSessionKey(session)) ? "selected" : ""}
            onClick={() => onSelectEmbeddedSession(session)}
          >
            <button
              type="button"
              className={handoffSelection.has(embeddedSessionKey(session)) ? "handoffSelectButton selected" : "handoffSelectButton"}
              aria-pressed={handoffSelection.has(embeddedSessionKey(session))}
              onClick={(event) => {
                event.stopPropagation();
                toggleHandoffSource(embeddedSessionKey(session));
              }}
            >
              {handoffSelection.has(embeddedSessionKey(session)) ? <CheckCircle2 size={14} /> : <span />}
              {handoffSelection.has(embeddedSessionKey(session)) ? "Selected" : "Include"}
            </button>
            <StatusDot status={session.status === "running" ? "running" : "offline"} />
            <div>
              <strong>{session.title}</strong>
              <span>{session.kind} · {session.status}{session.promptPath ? " · prompt attached" : ""}</span>
            </div>
            <em>{session.pid ? `pid ${session.pid}` : "no pid"}</em>
            <button type="button" className="ghostIconButton" onClick={(event) => {
              event.stopPropagation();
              onSelectEmbeddedSession(session);
            }}>
              <FileText size={14} />
            </button>
          </article>
        ))}
        {agentSessions.slice(0, 8).map((session) => (
          <article
            key={selectedAgentSessionKey(session)}
            className={selectedSessionKey === selectedAgentSessionKey(session) || handoffSelection.has(selectedAgentSessionKey(session)) ? "selected" : ""}
            onClick={() => onSelectAgentSession(session)}
          >
            <button
              type="button"
              className={handoffSelection.has(selectedAgentSessionKey(session)) ? "handoffSelectButton selected" : "handoffSelectButton"}
              aria-pressed={handoffSelection.has(selectedAgentSessionKey(session))}
              onClick={(event) => {
                event.stopPropagation();
                toggleHandoffSource(selectedAgentSessionKey(session));
              }}
            >
              {handoffSelection.has(selectedAgentSessionKey(session)) ? <CheckCircle2 size={14} /> : <span />}
              {handoffSelection.has(selectedAgentSessionKey(session)) ? "Selected" : "Include"}
            </button>
            <StatusDot status={session.status === "running" ? "running" : session.status === "exited" ? "offline" : "ready"} />
            <div>
              <strong>{session.title}</strong>
              <span>{providerLabel(session.provider)} · {session.id}</span>
            </div>
            <em>{session.status}</em>
            <button type="button" className="ghostIconButton" onClick={(event) => {
              event.stopPropagation();
              onSelectAgentSession(session);
            }}>
              <FileText size={14} />
            </button>
            <button type="button" className="ghostIconButton" onClick={(event) => {
              event.stopPropagation();
              void onLoadAgentTranscript(session);
            }}>
              <ScrollText size={14} />
            </button>
          </article>
        ))}
        {embeddedSessions.length === 0 && agentSessions.length === 0 && <p>No sessions yet. Launch an embedded agent or resume a native session from the Command Room.</p>}
      </div>
      <SessionInspector embeddedSession={selectedEmbeddedSession} agentSession={selectedAgentSession} agentTranscript={agentTranscript} onLoadAgentTranscript={onLoadAgentTranscript} />
    </div>
  );
}

function SessionInspector({
  embeddedSession,
  agentSession,
  agentTranscript,
  onLoadAgentTranscript,
}: {
  embeddedSession: EmbeddedTerminalSession | null;
  agentSession: AgentSession | null;
  agentTranscript: AgentTranscriptState | null;
  onLoadAgentTranscript: (session: AgentSession) => Promise<void>;
}) {
  const [buffer, setBuffer] = useState("");
  const terminalId = embeddedSession?.id ?? agentSession?.terminalId ?? null;
  const transcriptKey = agentSession ? selectedAgentSessionKey(agentSession) : null;
  const transcript = transcriptKey && agentTranscript?.key === transcriptKey ? agentTranscript : null;

  useEffect(() => {
    if (!terminalId) {
      setBuffer("");
      return;
    }

    let cancelled = false;
    desktop
      .getEmbeddedTerminalBuffer(terminalId)
      .then((content) => {
        if (!cancelled) setBuffer(content);
      })
      .catch((error) => {
        if (!cancelled) setBuffer(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [terminalId]);

  useEffect(() => {
    if (!terminalId) return undefined;
    return desktop.onEmbeddedTerminalData((payload) => {
      if (payload.id !== terminalId) return;
      setBuffer((current) => `${current}${payload.data}`);
    });
  }, [terminalId]);

  const metadata = embeddedSession
    ? [
        `Type: embedded ${embeddedSession.kind}`,
        `Status: ${embeddedSession.status}`,
        `Workspace: ${embeddedSession.workspace}`,
        `PID: ${embeddedSession.pid ?? "none"}`,
        `Prompt path: ${embeddedSession.promptPath ?? "none"}`,
        `Provider session: ${embeddedSession.providerSessionId ?? "none"}`,
      ]
    : agentSession
      ? [
          `Type: native ${providerLabel(agentSession.provider)}`,
          `Status: ${agentSession.status}`,
          `Workspace: ${agentSession.workspace}`,
          `Session ID: ${agentSession.id}`,
          `Model: ${agentSession.model ?? "unknown"}`,
          `Agent: ${agentSession.agent ?? "default"}`,
          `Branch: ${agentSession.branch ?? "unknown"}`,
          `Resume: ${agentSession.resumeCommand ?? "none"}`,
        ]
      : ["Select a session to inspect metadata and live buffer output."];

  return (
    <section className="sessionInspector">
      <div className="sessionInspectorHeader">
        <div>
          <span className="tinyLabel">Session inspector</span>
          <strong>{embeddedSession?.title ?? agentSession?.title ?? "No session selected"}</strong>
        </div>
        <div className="sessionInspectorActions">
          {agentSession && !terminalId && (
            <button type="button" className="ghostButton" onClick={() => void onLoadAgentTranscript(agentSession)} disabled={transcript?.loading}>
              <ScrollText size={14} /> {transcript?.loading ? "Loading" : "Transcript"}
            </button>
          )}
          <StatusPill tone={terminalId ? "ok" : transcript?.text ? "ok" : agentSession ? "warn" : "bad"}>
            {terminalId ? "Live buffer" : transcript?.text ? "Transcript" : agentSession ? "Metadata only" : "Empty"}
          </StatusPill>
        </div>
      </div>
      <div className="sessionInspectorGrid">
        <pre>{metadata.join("\n")}</pre>
        <pre>
          {terminalId
            ? buffer || "No terminal output captured yet."
            : transcript?.loading
              ? "Loading native session transcript..."
              : transcript?.error
                ? transcript.error
                : transcript?.text
                  ? transcript.text
                  : "No live terminal buffer is attached to this session. Use Transcript for native session content."}
        </pre>
      </div>
    </section>
  );
}

function ReviewCard({ title, icon, items }: { title: string; icon: ReactNode; items: string[] }) {
  return (
    <article className="reviewCard">
      <div className="reviewCardIcon">{icon}</div>
      <h4>{title}</h4>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </article>
  );
}

function MemoryRoom({ entries, busy, onDelete }: { entries: string[]; busy: boolean; onDelete: (entry: string) => Promise<void> }) {
  return (
    <div className="roomPanel memoryRoomFull">
      <div className="memoryHero">
        <AthenaMark />
        <div>
          <span className="tinyLabel">ATHENA source of truth</span>
          <h3>Every future agent inherits this trail.</h3>
          <p>Project decisions, agent questions, task outcomes, and user preferences stay available across sessions.</p>
        </div>
      </div>
      <div className="memoryGrid">
        {entries.map((entry, index) => (
          <article key={`${index}-${entry.slice(0, 24)}`} className="memoryCard">
            <div className="memoryCardTop">
              <span>memory · {String(index + 1).padStart(2, "0")}</span>
              <button type="button" className="dangerIconButton" onClick={() => void onDelete(entry)} disabled={busy} title="Delete memory entry">
                <Trash2 size={13} />
              </button>
            </div>
            <p>{entry}</p>
          </article>
        ))}
        {entries.length === 0 && <p className="emptyStateText">No memory entries loaded.</p>}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: "ready" | "running" | "waiting" | "offline" }) {
  return <span className={`statusDot ${status}`} />;
}
