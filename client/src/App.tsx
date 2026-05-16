import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Eye,
  Minus,
  Search,
  ShieldCheck,
  Square,
  Wrench,
  X,
} from "lucide-react";
import { BackendClient, type AdapterStatus, type BackendStatus, type HermesStatus, type RecallStatus } from "./api";
import { desktop, type AgentSession, type EmbeddedTerminalKind, type EmbeddedTerminalSession, type PerformanceDiagnostics, type WorkspacePath } from "./electron";
import { AppSidebar, AthenaMark } from "./components/AppSidebar";
import { ContextGlance, LiveWorkflow, SharedMemorySnapshot } from "./components/DashboardPanels";
import { WorkspaceTabs } from "./components/WorkspaceTabs";
import { CommandRoom } from "./rooms/CommandRoom";
import { MemoryRoom } from "./rooms/MemoryRoom";
import { ReviewRoom } from "./rooms/ReviewRoom";
import { SettingsRoom } from "./rooms/SettingsRoom";
import { SwarmRoom, type AgentRole } from "./rooms/SwarmRoom";
import { WorkspaceRoom, type WorkspaceSummary } from "./rooms/WorkspaceRoom";
import { roomRouteById, type ActiveRoom } from "./routes";
import {
  embeddedSessionKey,
  providerLabel,
  selectedAgentSessionKey,
  terminalGridTitles,
  type AgentTranscriptState,
  type HandoffPreview,
} from "./session-utils";
import { normalizeWorkspaceKey, sameWorkspacePath, workspaceDisplayName, workspaceKey } from "./workspace-utils";

type LoadState = {
  hermes: HermesStatus | null;
  recall: RecallStatus | null;
  adapters: Record<string, AdapterStatus>;
  memory: string[];
};

type InterfaceMode = "terminal" | "chat";

const emptyLoadState: LoadState = {
  hermes: null,
  recall: null,
  adapters: {},
  memory: [],
};

const workspaceStorageKey = "context-workspace:lastWorkspace";
const workspaceListStorageKey = "context-workspace:workspaces";
const interfaceModeStorageKey = "context-workspace:interfaceMode";
const terminalFocusStorageKey = "context-workspace:terminalFocus";
const nativeSessionRefreshIntervalMs = 60_000;

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

function readInterfaceMode(): InterfaceMode {
  try {
    return window.localStorage.getItem(interfaceModeStorageKey) === "chat" ? "chat" : "terminal";
  } catch {
    return "terminal";
  }
}

function writeInterfaceMode(mode: InterfaceMode): void {
  try {
    window.localStorage.setItem(interfaceModeStorageKey, mode);
  } catch {
    // Ignore storage failures; the selected mode still works for this session.
  }
}

function readTerminalFocus(): boolean {
  try {
    return window.localStorage.getItem(terminalFocusStorageKey) === "1";
  } catch {
    return false;
  }
}

function writeTerminalFocus(focused: boolean): void {
  try {
    if (focused) window.localStorage.setItem(terminalFocusStorageKey, "1");
    else window.localStorage.removeItem(terminalFocusStorageKey);
  } catch {
    // Ignore storage failures; focus mode still works for this session.
  }
}

function upsertWorkspace(workspaces: WorkspacePath[], workspace: WorkspacePath): WorkspacePath[] {
  const key = workspaceKey(workspace);
  return [workspace, ...workspaces.filter((item) => workspaceKey(item) !== key)].slice(0, 12);
}

function sameEmbeddedSessions(a: EmbeddedTerminalSession[], b: EmbeddedTerminalSession[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((session, index) => {
    const other = b[index];
    return Boolean(other)
      && session.id === other.id
      && session.status === other.status
      && session.exitCode === other.exitCode
      && session.pid === other.pid
      && session.title === other.title
      && session.workspace === other.workspace
      && session.promptPath === other.promptPath;
  });
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
  const [terminalFocus, setTerminalFocusState] = useState(() => readTerminalFocus());
  const [interfaceMode, setInterfaceModeState] = useState<InterfaceMode>(() => readInterfaceMode());
  const [layoutResetNonce, setLayoutResetNonce] = useState(0);
  const [recallRefreshing, setRecallRefreshing] = useState(false);
  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(null);
  const [agentTranscript, setAgentTranscript] = useState<AgentTranscriptState | null>(null);
  const [performanceDiagnostics, setPerformanceDiagnostics] = useState<PerformanceDiagnostics | null>(null);
  const backendRefreshInFlight = useRef(false);
  const dataRefreshInFlight = useRef(false);
  const agentSessionsRefreshInFlight = useRef(false);
  const agentSessionsLastRefreshAt = useRef(0);
  const autoStartedTerminals = useRef<Set<string>>(new Set());
  const autoRecallRefreshWorkspace = useRef<string | null>(null);
  const workspace = workspacePath?.nativePath ?? "";
  const workspaceDisplay = workspacePath?.displayPath ?? workspace;

  function setInterfaceMode(mode: InterfaceMode) {
    setInterfaceModeState(mode);
    writeInterfaceMode(mode);
  }

  function setTerminalFocus(focused: boolean) {
    setTerminalFocusState(focused);
    writeTerminalFocus(focused);
    if (focused) setActiveRoom("command");
  }

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
      const nextSessions = await desktop.listEmbeddedTerminals();
      setEmbeddedSessions((current) => sameEmbeddedSessions(current, nextSessions) ? current : nextSessions);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const refreshAgentSessions = useCallback(async (options: { force?: boolean } = {}) => {
    if (!workspace) {
      setAgentSessions([]);
      return;
    }
    if (agentSessionsRefreshInFlight.current) return;
    const now = Date.now();
    if (!options.force && now - agentSessionsLastRefreshAt.current < nativeSessionRefreshIntervalMs) return;
    agentSessionsLastRefreshAt.current = now;
    agentSessionsRefreshInFlight.current = true;
    try {
      setAgentSessions(await desktop.listAgentSessions(workspace));
    } catch (err) {
      setError(String(err));
    } finally {
      agentSessionsRefreshInFlight.current = false;
    }
  }, [workspace]);

  const refreshPerformanceDiagnostics = useCallback(async () => {
    try {
      setPerformanceDiagnostics(await desktop.getPerformanceDiagnostics());
    } catch {
      setPerformanceDiagnostics(null);
    }
  }, []);

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
    void refreshAgentSessions({ force: true });
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
      if (activeRoom === "command" || activeRoom === "review" || activeRoom === "swarm") {
        void refreshAgentSessions();
      }
      if (activeRoom === "settings") void refreshPerformanceDiagnostics();
    }, 8000);
    return () => window.clearInterval(timer);
  }, [activeRoom, refreshBackend, refreshData, refreshSessions, refreshAgentSessions, refreshPerformanceDiagnostics]);

  useEffect(() => {
    if (activeRoom !== "settings") return;
    void refreshPerformanceDiagnostics();
  }, [activeRoom, refreshPerformanceDiagnostics]);

  useEffect(() => {
    if (!terminalFocus) return undefined;
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTerminalFocus(false);
    };
    document.addEventListener("keydown", exitOnEscape);
    return () => document.removeEventListener("keydown", exitOnEscape);
  }, [terminalFocus]);

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

  function renameWorkspaceTab(tab: WorkspacePath) {
    const nextName = window.prompt("Workspace display name", workspaceDisplayName(tab));
    const trimmed = nextName?.trim();
    if (!trimmed) return;
    setWorkspaceTabs((current) =>
      current.map((item) => workspaceKey(item) === workspaceKey(tab) ? { ...item, displayPath: trimmed } : item),
    );
    setWorkspacePath((current) => current && workspaceKey(current) === workspaceKey(tab) ? { ...current, displayPath: trimmed } : current);
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
  const workspaceSummaries = useMemo<WorkspaceSummary[]>(() => {
    return workspaceTabs.map((tab) => {
      const tabTerminals = embeddedSessions.filter((session) => sameWorkspacePath(session.workspace, tab.nativePath));
      const active = workspacePath ? workspaceKey(workspacePath) === workspaceKey(tab) : false;
      const latestTerminalAt = tabTerminals
        .map((session) => session.createdAt)
        .filter(Boolean)
        .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
      const latestAgentAt = active
        ? agentSessions
            .map((session) => session.updatedAt)
            .filter(Boolean)
            .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null
        : null;
      const lastActiveAt = [latestTerminalAt, latestAgentAt]
        .filter((value): value is string => Boolean(value))
        .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
      return {
        workspace: tab,
        active,
        runningTerminals: tabTerminals.filter((session) => session.status === "running").length,
        totalTerminals: tabTerminals.length,
        agentSessions: active ? agentSessions.length : null,
        memoryEntries: active ? state.memory.length : null,
        recall: active ? state.recall : null,
        lastActiveAt,
      };
    });
  }, [agentSessions, embeddedSessions, state.memory.length, state.recall, workspacePath, workspaceTabs]);

  const loadAgentTranscript = useCallback(async (session: AgentSession) => {
    const key = selectedAgentSessionKey(session);
    setSelectedSessionKey(key);
    setActiveRoom("review");
    setAgentTranscript({ key, text: "", loading: true, error: null });
    if (!client) {
      setAgentTranscript({ key, text: "", loading: false, error: "Backend is not available." });
      return "";
    }
    try {
      const text = await client.agentSessionTranscript(session.provider, session.id);
      setAgentTranscript({ key, text, loading: false, error: null });
      return text;
    } catch (err) {
      setAgentTranscript({ key, text: "", loading: false, error: String(err) });
      return "";
    }
  }, [client]);

  const readAgentTranscript = useCallback(async (session: AgentSession) => {
    if (!client) return "";
    return client.agentSessionTranscript(session.provider, session.id);
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
    <div className="appFrame">
      <AppTitleBar
        activeLabel={activeRoute.label}
        workspace={workspaceDisplay}
        backendOnline={Boolean(backend?.healthy)}
        shellFocus={terminalFocus && activeRoom === "command"}
      />
      <main className={terminalFocus && activeRoom === "command" ? "workspaceSurface shellFocusSurface" : "workspaceSurface"}>
      <AppSidebar
        activeRoom={activeRoom}
        backendOnline={Boolean(backend?.healthy)}
        hermesOnline={Boolean(state.hermes?.installed)}
        onNavigate={setActiveRoom}
      />

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
                interfaceMode={interfaceMode}
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
            {activeRoom === "workspace" && (
              <WorkspaceRoom
                summaries={workspaceSummaries}
                activeWorkspace={workspacePath}
                terminalSessions={embeddedSessions}
                agentSessions={agentSessions}
                busy={busy || recallRefreshing}
                onAdd={selectWorkspace}
                onOpen={activateWorkspace}
                onRemove={closeWorkspaceTab}
                onRename={renameWorkspaceTab}
                onRefreshRecall={() => void refreshRecall("Manual recall refresh")}
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
                onReadAgentTranscript={readAgentTranscript}
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
                interfaceMode={interfaceMode}
                terminalFocus={terminalFocus}
                performance={performanceDiagnostics}
                onSelectWorkspace={selectWorkspace}
                onRestartBackend={restartBackend}
                onRefreshRecall={() => void refreshRecall("Manual recall refresh")}
                onInterfaceModeChange={setInterfaceMode}
                onTerminalFocusChange={setTerminalFocus}
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
    </div>
  );
}

function AppTitleBar({
  activeLabel,
  workspace,
  backendOnline,
  shellFocus,
}: {
  activeLabel: string;
  workspace: string;
  backendOnline: boolean;
  shellFocus: boolean;
}) {
  const detail = workspace ? workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace : "No workspace";
  return (
    <header className="appTitleBar">
      <div className="windowControls" aria-label="Window controls">
        <button type="button" className="windowDot close" aria-label="Close window" onClick={() => void desktop.closeWindow()}>
          <X size={9} />
        </button>
        <button type="button" className="windowDot minimize" aria-label="Minimize window" onClick={() => void desktop.minimizeWindow()}>
          <Minus size={9} />
        </button>
        <button type="button" className="windowDot maximize" aria-label="Maximize window" onClick={() => void desktop.toggleMaximizeWindow()}>
          <Square size={8} />
        </button>
      </div>
      <div className="titleBrand">
        <span className="titleMark" aria-hidden="true" />
        <strong>ATHENA</strong>
      </div>
      <div className="titleContext">
        <strong>{activeLabel}</strong>
        <span>{shellFocus ? "Shell focus" : detail}</span>
      </div>
      <div className="titleStatus">
        <span className={backendOnline ? "online" : ""} />
        {backendOnline ? "Backend" : "Offline"}
      </div>
    </header>
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
