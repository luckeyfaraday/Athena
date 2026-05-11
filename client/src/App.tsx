import { type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bot,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Code2,
  Database,
  Eye,
  FileText,
  FolderOpen,
  Layers3,
  Play,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Maximize2,
  Minimize2,
  TerminalSquare,
  Trash2,
  Users,
  Workflow,
  Wrench,
  XCircle,
} from "lucide-react";
import { BackendClient, type AdapterStatus, type BackendStatus, type HermesStatus, type RecallStatus, type Run } from "./api";
import { desktop, type AgentSession, type EmbeddedTerminalKind, type EmbeddedTerminalSession, type WorkspacePath } from "./electron";
import { EmbeddedTerminal } from "./components/EmbeddedTerminal";
import athenaMarkUrl from "./assets/athena-mark.png";
import athenaWordmarkUrl from "./assets/athena-wordmark.png";

type LoadState = {
  hermes: HermesStatus | null;
  recall: RecallStatus | null;
  adapters: Record<string, AdapterStatus>;
  memory: string[];
  runs: Run[];
};

type ActiveRoom = "command" | "swarm" | "review" | "memory" | "settings";
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

const emptyLoadState: LoadState = {
  hermes: null,
  recall: null,
  adapters: {},
  memory: [],
  runs: [],
};

const roomCopy: Record<ActiveRoom, { label: string; eyebrow: string; description: string }> = {
  command: {
    label: "Command Room",
    eyebrow: "01 · Native work",
    description: "Terminals, repo state, and agent context open in one controlled workspace.",
  },
  swarm: {
    label: "Swarm Room",
    eyebrow: "02 · Parallel agents",
    description: "Spin up builders, reviewers, scouts, and fixers with memory already attached.",
  },
  review: {
    label: "Review Room",
    eyebrow: "03 · Human control",
    description: "Turn agent output into a clean ship, revise, or investigate decision.",
  },
  memory: {
    label: "Memory Room",
    eyebrow: "04 · Persistent context",
    description: "Inspect what ATHENA knows, what agents asked, and what future runs inherit.",
  },
  settings: {
    label: "Settings",
    eyebrow: "05 · Workspace control",
    description: "Manage the active workspace, backend process, Hermes status, and recall refresh.",
  },
};

const workspaceStorageKey = "context-workspace:lastWorkspace";
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
  const [state, setState] = useState<LoadState>(emptyLoadState);
  const [embeddedSessions, setEmbeddedSessions] = useState<EmbeddedTerminalSession[]>([]);
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeRoom, setActiveRoom] = useState<ActiveRoom>("command");
  const [terminalFocus, setTerminalFocus] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [layoutResetNonce, setLayoutResetNonce] = useState(0);
  const [recallRefreshing, setRecallRefreshing] = useState(false);
  const backendRefreshInFlight = useRef(false);
  const dataRefreshInFlight = useRef(false);
  const agentSessionsRefreshInFlight = useRef(false);
  const autoStartedTerminals = useRef(false);
  const autoRecallRefreshWorkspace = useRef<string | null>(null);
  const newMenuRef = useRef<HTMLDivElement | null>(null);
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
      const [hermes, recall, adapters, memory, runs] = await Promise.all([
        client.hermesStatus(),
        workspace ? client.recallStatus(workspace) : Promise.resolve(null),
        client.adapters(),
        client.recentMemory(30),
        client.runs(),
      ]);
      setState({ hermes, recall, adapters, memory, runs });
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      dataRefreshInFlight.current = false;
    }
  }, [client, workspace]);

  useEffect(() => {
    try {
      if (workspacePath?.nativePath.trim()) window.localStorage.setItem(workspaceStorageKey, JSON.stringify(workspacePath));
    } catch {
      // Ignore storage failures; the selected workspace still works for this session.
    }
  }, [workspacePath]);

  useEffect(() => {
    const stored = parseStoredWorkspace(storedWorkspaceValue());
    const workspacePromise = stored ? desktop.toWorkspacePath(stored) : desktop.getDefaultWorkspace();
    workspacePromise
      .then((resolved) => setWorkspacePath(resolved))
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
    if (autoStartedTerminals.current || !workspace || embeddedSessions.length > 0) return;
    autoStartedTerminals.current = true;
    void launchEmbedded("shell", 1);
  }, [workspace, embeddedSessions.length]);

  useEffect(() => {
    if (!workspace || !state.recall?.stale || !state.recall.refresh_configured) return;
    if (autoRecallRefreshWorkspace.current === workspace) return;
    autoRecallRefreshWorkspace.current = workspace;
    void refreshRecall("Workspace selected", { surfaceError: false });
  }, [workspace, state.recall?.stale, state.recall?.refresh_configured]);

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
      if (selected) setWorkspacePath(selected);
    } catch (err) {
      setError(String(err));
    }
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

    const results = await Promise.allSettled(
      sessionIds.map((id) => desktop.writeEmbeddedTerminal(id, `${trimmed}\r`)),
    );
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) {
      setError(`Prompt sent to ${sessionIds.length - failed} agents; ${failed} agent${failed === 1 ? "" : "s"} could not receive it.`);
      return;
    }
    setError(null);
  }

  async function cancelBackendRun(runId: string) {
    if (!client || busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.cancelRun(runId);
      await refreshData();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
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

  const activeRuns = state.runs.filter((run) => run.status === "running" || run.status === "pending");
  const completedRuns = state.runs.filter((run) => run.status === "succeeded" || run.status === "failed" || run.status === "cancelled");
  const latestRun = state.runs.at(-1) ?? null;
  const memoryEntries = [...state.memory].reverse();
  const codexInstalled = Boolean(state.adapters.codex?.installed);
  const installedAdapters = Object.values(state.adapters).filter((adapter) => adapter.installed).length;

  const agentRoles: AgentRole[] = [
    {
      role: "Builder",
      type: "codex",
      icon: <Wrench size={18} />,
      status: activeRuns.length ? "running" : codexInstalled ? "ready" : "offline",
      brief: "Implements the selected task against the live repo.",
    },
    {
      role: "Reviewer",
      type: "codex",
      icon: <Eye size={18} />,
      status: codexInstalled ? "ready" : "offline",
      brief: "Reads diffs, tests, and artifacts before anything ships.",
    },
    {
      role: "Scout",
      type: "opencode",
      icon: <Search size={18} />,
      status: state.adapters.opencode?.installed ? "ready" : "waiting",
      brief: "Explores code, docs, and prior Hermes memory for context.",
    },
    {
      role: "Fixer",
      type: "claude",
      icon: <ShieldCheck size={18} />,
      status: state.adapters.claude?.installed ? "ready" : "waiting",
      brief: "Takes failed runs and drives them back to green.",
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
          <SidebarButton active={activeRoom === "command"} icon={<TerminalSquare size={14} />} label="Command Room" onClick={() => setActiveRoom("command")} />
          <SidebarButton active={activeRoom === "swarm"} icon={<Users size={14} />} label="Agents" onClick={() => setActiveRoom("swarm")} />
          <SidebarButton active={activeRoom === "memory"} icon={<Database size={14} />} label="Memory" onClick={() => setActiveRoom("memory")} />
          <SidebarButton active={activeRoom === "review"} icon={<Eye size={14} />} label="Reviews" onClick={() => setActiveRoom("review")} />
          <SidebarButton active={activeRoom === "settings"} icon={<Settings size={14} />} label="Settings" onClick={() => setActiveRoom("settings")} />
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
                <h1>{roomCopy[activeRoom].label}</h1>
                <p>{roomCopy[activeRoom].description}</p>
              </div>
              <div className="topbarActions">
                <button className="ghostButton" onClick={() => void selectWorkspace()}>
                  <FolderOpen size={14} /> Open Workspace
                </button>
                <button className="ghostButton" onClick={() => void launchEmbedded("shell", 1)} disabled={!workspace || busy}>
                  <TerminalSquare size={14} /> Open in Terminal
                </button>
                <NewLaunchMenu
                  busy={busy}
                  open={newMenuOpen}
                  workspace={workspace}
                  menuRef={newMenuRef}
                  onOpenChange={setNewMenuOpen}
                  onLaunch={launchEmbedded}
                />
              </div>
            </header>

            {activeRoom === "command" && (
              <CommandRoom
                workspace={workspace}
                sessions={embeddedSessions}
                agentSessions={agentSessions}
                busy={busy}
                focused={terminalFocus}
                layoutResetNonce={layoutResetNonce}
                onFocusChange={setTerminalFocus}
                onLaunch={launchEmbedded}
                onClose={closeEmbeddedTerminal}
                onBroadcastPrompt={broadcastPromptToAgents}
                onResumeSession={resumeAgentSession}
              />
            )}
            {activeRoom === "swarm" && (
              <SwarmRoom
                roles={agentRoles}
                runs={activeRuns}
                adapters={state.adapters}
                busy={busy}
                onCancelRun={cancelBackendRun}
              />
            )}
            {activeRoom === "review" && <ReviewRoom latestRun={latestRun} completedRuns={completedRuns} />}
            {activeRoom === "memory" && <MemoryRoom entries={memoryEntries} busy={busy} onDelete={deleteMemoryEntry} />}
            {activeRoom === "settings" && (
              <SettingsRoom
                workspace={workspaceDisplay}
                backend={backend}
                hermes={state.hermes}
                recall={state.recall}
                busy={busy}
                refreshing={recallRefreshing}
                onSelectWorkspace={selectWorkspace}
                onRestartBackend={restartBackend}
                onRefreshRecall={() => void refreshRecall(latestRun?.task ?? "Manual recall refresh")}
              />
            )}

            <LiveWorkflow activeRuns={activeRuns.length} completedRuns={completedRuns.length} memoryCount={state.memory.length} />
          </div>

          <aside className="glanceColumn">
            <ContextGlance
              tasks={state.runs.length}
              active={activeRuns.length}
              agents={installedAdapters || agentRoles.length}
              memory={state.memory.length}
              reviews={completedRuns.length}
              onNavigate={setActiveRoom}
            />
          </aside>

          <aside className="rightColumn">
            <ActiveAgents roles={agentRoles} runs={activeRuns} />
            <MemoryTimeline entries={memoryEntries} runs={state.runs} />
          </aside>

          <SharedMemorySnapshot
            workspace={workspaceDisplay}
            entries={memoryEntries}
            hermes={state.hermes}
            recall={state.recall}
            latestRun={latestRun}
            refreshing={recallRefreshing}
            onRefresh={() => void refreshRecall(latestRun?.task ?? "Manual recall refresh")}
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
      <MetricRow icon={<CheckCircle2 size={15} />} tone="green" label="Tasks" value={tasks} detail={`${active} running`} onClick={() => onNavigate("swarm")} />
      <MetricRow icon={<Users size={15} />} tone="violet" label="Agents" value={agents} detail="All nominal" onClick={() => onNavigate("swarm")} />
      <MetricRow icon={<Database size={15} />} tone="blue" label="Memory Entries" value={memory} detail="Recent memory" onClick={() => onNavigate("memory")} />
      <MetricRow icon={<ShieldCheck size={15} />} tone="orange" label="Reviews" value={reviews} detail="Completed runs" onClick={() => onNavigate("review")} />
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

function LiveWorkflow({ activeRuns, completedRuns, memoryCount }: { activeRuns: number; completedRuns: number; memoryCount: number }) {
  return (
    <section className="dashboardCard liveWorkflow">
      <div className="cardHeader">
        <span>Live Workflow</span>
      </div>
      <div className="workflowTrack">
        <FlowStep icon={<FileText size={14} />} label="Task" active />
        <ChevronRight size={18} />
        <FlowStep icon={<Users size={14} />} label="Agents" active={activeRuns > 0} />
        <ChevronRight size={18} />
        <FlowStep icon={<ShieldCheck size={14} />} label="Review" active={completedRuns > 0} />
        <ChevronRight size={18} />
        <FlowStep icon={<Database size={14} />} label="Memory" active={memoryCount > 0} />
      </div>
    </section>
  );
}

function ActiveAgents({ roles, runs }: { roles: AgentRole[]; runs: Run[] }) {
  const liveByRole = new Set(runs.map((run) => run.agent_type));
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
                <strong>{role.role === "Builder" ? "Code Runner" : role.role === "Reviewer" ? "Review Agent" : role.role === "Scout" ? "Memory Manager" : "Hermes Orchestrator"}</strong>
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

function MemoryTimeline({ entries, runs }: { entries: string[]; runs: Run[] }) {
  const timeline = [
    { time: "Now", label: "ATHENA Updated", detail: entries[0] ?? "Shared context is ready", tone: "memory" },
    { time: "Run", label: "Latest Agent Run", detail: runs.at(-1)?.task ?? "No run started yet", tone: "run" },
    { time: "Agent", label: "Agent State", detail: `${runs.filter((run) => run.status === "running" || run.status === "pending").length} active runs`, tone: "agent" },
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
  latestRun,
  refreshing,
  onRefresh,
}: {
  workspace: string;
  entries: string[];
  hermes: HermesStatus | null;
  recall: RecallStatus | null;
  latestRun: Run | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const recallLabel = recall ? recall.status : "unknown";
  const recallAge = recall?.age_seconds == null ? "not refreshed" : formatAge(recall.age_seconds);
  const lines = [
    "# ATHENA",
    `- Workspace: ${workspace || "not selected"}`,
    `- Hermes: ${hermes?.installed ? "online" : "setup required"}`,
    `- Recall: ${recallLabel} (${recallAge})`,
    `- Recall refresh: ${recall?.refresh_configured ? "configured" : "not configured"}`,
    `- Latest run: ${latestRun ? `${latestRun.agent_id} / ${latestRun.status}` : "none"}`,
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
  busy: boolean;
  refreshing: boolean;
  onSelectWorkspace: () => Promise<void>;
  onRestartBackend: () => Promise<void>;
  onRefreshRecall: () => void;
}) {
  const recallTone = !recall ? "warn" : recall.status === "fresh" ? "ok" : recall.status === "missing" ? "bad" : "warn";
  const backendTone = backend?.healthy ? "ok" : backend?.running ? "warn" : "bad";
  const hermesTone = hermes?.installed ? "ok" : "bad";

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
            <span>{hermes?.command_path ?? hermes?.message ?? "Status unavailable"}</span>
          </div>
          <StatusPill tone={hermesTone}>{hermes?.installed ? hermes.version ?? "Installed" : "Missing"}</StatusPill>
        </article>
        <article className="settingsSection">
          <div>
            <strong>Recall</strong>
            <span>{recall ? `${recall.path} · ${recall.age_seconds == null ? "not refreshed" : formatAge(recall.age_seconds)}` : "No recall status"}</span>
          </div>
          <StatusPill tone={recallTone}>{recall?.status ?? "Unknown"}</StatusPill>
          <button className="ghostButton" type="button" onClick={onRefreshRecall} disabled={refreshing || !recall?.refresh_configured}>
            <RefreshCw size={14} /> {refreshing ? "Refreshing" : "Refresh"}
          </button>
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
  const dragStartRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const dragTargetRef = useRef<string | null>(null);

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

  function arrangeGrid() {
    setPaneOrder(sessions.map((session) => session.id));
    setCollapsedPaneIds(new Set());
    setMaximizedPaneId(null);
  }

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
          <button className="ghostButton" onClick={arrangeGrid} disabled={sessions.length === 0}>
            <Layers3 size={15} /> Arrange Grid
          </button>
          <button className="primaryButton" onClick={() => void onLaunch("opencode", 4)} disabled={!workspace || busy}>
            <Bot size={15} /> OpenCode Grid
          </button>
          <button className="primaryButton" onClick={() => void onLaunch("claude", 4)} disabled={!workspace || busy}>
            <Bot size={15} /> Claude Grid
          </button>
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
                <button className="terminalControl close" onClick={() => void onClose(session.id)} title={`Close ${session.title}`} />
                <button
                  className="terminalControl amber"
                  onClick={() => togglePaneCollapsed(session.id)}
                  title={collapsedPaneIds.has(session.id) ? `Restore ${session.title}` : `Minimize ${session.title}`}
                />
                <button
                  className="terminalControl green"
                  onClick={() => togglePaneMaximized(session.id)}
                  title={maximizedPaneId === session.id ? `Restore ${session.title}` : `Maximize ${session.title}`}
                />
                <strong>{session.title}</strong>
                <em>{terminalPaneMeta(session)}</em>
              </div>
              {!collapsedPaneIds.has(session.id) && <EmbeddedTerminal session={session} />}
            </div>
          ))}
          {visibleSessions.length === 0 && (
            <div className="terminalEmptyState">
              <AthenaMark />
              <strong>No embedded terminals yet.</strong>
              <span>Select a workspace, then start a shell or launch a four-pane Codex grid with Hermes memory attached.</span>
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
  runs,
  adapters,
  busy,
  onCancelRun,
}: {
  roles: AgentRole[];
  runs: Run[];
  adapters: Record<string, AdapterStatus>;
  busy: boolean;
  onCancelRun: (runId: string) => Promise<void>;
}) {
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

      <div className="liveRunBoard">
        <div className="roomPanelHeader compact">
          <div>
            <span className="tinyLabel">Live agents</span>
            <h3>{runs.length ? "Work in motion" : "Ready room"}</h3>
          </div>
          <StatusPill tone={adapters.codex?.installed ? "ok" : "warn"}>{adapters.codex?.installed ? "Codex installed" : "Codex missing"}</StatusPill>
        </div>
        <div className="runTimeline">
          {runs.map((run) => (
            <article key={run.run_id}>
              <CircleDot size={16} />
              <div>
                <strong>{run.agent_id}</strong>
                <p>{run.task}</p>
              </div>
              <span>{run.status}</span>
              <button type="button" className="dangerIconButton" onClick={() => void onCancelRun(run.run_id)} disabled={busy}>
                <XCircle size={14} />
              </button>
            </article>
          ))}
          {runs.length === 0 && (
            <div className="emptyState">
              <Workflow size={22} />
              <strong>No active swarm yet.</strong>
              <span>Launch a run from Hermes and this board becomes the live crew map.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ReviewRoom({ latestRun, completedRuns }: { latestRun: Run | null; completedRuns: Run[] }) {
  const failed = completedRuns.filter((run) => run.status === "failed" || run.status === "cancelled");
  const passed = completedRuns.filter((run) => run.status === "succeeded");
  return (
    <div className="roomPanel reviewRoom">
      <div className="decisionHero">
        <div>
          <span className="tinyLabel">Decision point</span>
          <h3>{latestRun ? latestRun.task : "No run selected yet"}</h3>
          <p>Hermes turns terminal noise into a concise review packet before anything ships.</p>
        </div>
        <div className={failed.length ? "decisionBadge risk" : passed.length ? "decisionBadge ship" : "decisionBadge idle"}>
          {failed.length ? <XCircle size={20} /> : passed.length ? <CheckCircle2 size={20} /> : <Activity size={20} />}
          <span>{failed.length ? "Needs work" : passed.length ? "Ready to review" : "Waiting"}</span>
        </div>
      </div>

      <div className="reviewColumns">
        <ReviewCard title="Changed files" icon={<Code2 size={17} />} items={["Artifacts captured per run", "stdout.log / stderr.log", "result.md summary"]} />
        <ReviewCard title="Checks" icon={<ShieldCheck size={17} />} items={[`${passed.length} successful runs`, `${failed.length} blocked runs`, "Human approval required"]} />
        <ReviewCard title="Next actions" icon={<Play size={17} />} items={["Spawn reviewer", "Fix failures", "Save decision to memory"]} />
      </div>

      <div className="completedRuns">
        {completedRuns.slice(-6).reverse().map((run) => (
          <article key={run.run_id}>
            <StatusDot status={run.status === "succeeded" ? "ready" : "offline"} />
            <div>
              <strong>{run.agent_id}</strong>
              <span>{run.task}</span>
            </div>
            <em>{run.status}</em>
          </article>
        ))}
        {completedRuns.length === 0 && <p>No completed runs yet. The first finished agent will produce the review packet.</p>}
      </div>
    </div>
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

function HermesMemoryPanel({ entries, hermes, latestRun }: { entries: string[]; hermes: HermesStatus | null; latestRun: Run | null }) {
  return (
    <aside className="memorySidecar">
      <div className="sidecarHeader">
        <div>
          <span className="tinyLabel">ATHENA context layer</span>
          <h3>Shared Memory</h3>
        </div>
        <AthenaMark small />
      </div>
      <div className="contextStack">
        <article className="contextCard highlighted">
          <span>What agents receive</span>
          <strong>Task context + relevant memory + dynamic lookup URL</strong>
        </article>
        <article className="contextCard">
          <span>Hermes home</span>
          <strong>{hermes?.hermes_home ?? "checking"}</strong>
        </article>
        <article className="contextCard">
          <span>Latest run</span>
          <strong>{latestRun ? `${latestRun.agent_id} · ${latestRun.status}` : "none yet"}</strong>
        </article>
      </div>
      <div className="memoryListHeader">
        <span>Recent memory</span>
        <Sparkles size={15} />
      </div>
      <div className="sideMemoryList">
        {entries.slice(0, 8).map((entry, index) => (
          <article key={`${index}-${entry.slice(0, 18)}`}>
            <Layers3 size={14} />
            <p>{entry}</p>
          </article>
        ))}
        {entries.length === 0 && <p>No entries loaded.</p>}
      </div>
    </aside>
  );
}

function StatusDot({ status }: { status: "ready" | "running" | "waiting" | "offline" }) {
  return <span className={`statusDot ${status}`} />;
}
