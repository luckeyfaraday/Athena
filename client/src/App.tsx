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
import { BackendClient, type AdapterStatus, type BackendStatus, type ElectronControlStatus, type HermesStatus, type RecallStatus } from "./api";
import { desktop, type AgentMessage, type AgentSession, type AthenaLaunchState, type EmbeddedTerminalKind, type EmbeddedTerminalSession, type PerformanceDiagnostics, type WorkspacePath } from "./electron";
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
import { recordChatPromptForSession, writePromptSequence } from "./chat-mode";
import { classifyTerminalAttention, mergeWorkspaceAttention, type WorkspaceAttention, type WorkspaceAttentionKind } from "./workspace-attention";
import { handoffLaunchOptions, type HandoffAgentKind } from "./handoff-launch";
import {
  applyAgentSessionRenames,
  applyEmbeddedSessionRenames,
  appendEmbeddedSessions,
  embeddedSessionKey,
  providerLabel,
  readRenamedSessions,
  selectedAgentSessionKey,
  terminalGridTitles,
  type AgentTranscriptState,
  type HandoffPreview,
  writeRenamedSessions,
} from "./session-utils";
import { normalizeWorkspaceKey, sameWorkspacePath, workspaceDisplayName, workspaceKey } from "./workspace-utils";

type LoadState = {
  hermes: HermesStatus | null;
  recall: RecallStatus | null;
  adapters: Record<string, AdapterStatus>;
  memory: string[];
};

type InterfaceMode = "terminal" | "chat";
type UiTheme = "classic" | "monolith" | "press" | "mono-light" | "mono-dark";

const emptyLoadState: LoadState = {
  hermes: null,
  recall: null,
  adapters: {},
  memory: [],
};

const workspaceStorageKey = "context-workspace:lastWorkspace";
const workspaceListStorageKey = "context-workspace:workspaces";
const interfaceModeStorageKey = "context-workspace:interfaceMode";
const uiThemeStorageKey = "context-workspace:uiTheme";
const terminalFocusStorageKey = "context-workspace:terminalFocus";
const nativeSessionRefreshIntervalMs = 60_000;
const uiThemeStyleElementId = "athena-selected-ui-theme";
const loadUiThemeCss: Record<Exclude<UiTheme, "classic">, () => Promise<{ default: string }>> = {
  monolith: () => import("./themes/monolith.css?raw"),
  press: () => import("./themes/press.css?raw"),
  "mono-light": () => import("./themes/mono-light.css?raw"),
  "mono-dark": () => import("./themes/mono-dark.css?raw"),
};

function storedWorkspaceValue(): string | null {
  return storedValue(workspaceStorageKey);
}

function storedValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
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

function readWorkspaceListValue(value: string | null): WorkspacePath[] {
  try {
    const parsed = JSON.parse(value ?? "[]") as Partial<WorkspacePath>[];
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

function readWorkspaceList(): WorkspacePath[] {
  try {
    return readWorkspaceListValue(window.localStorage.getItem(workspaceListStorageKey));
  } catch {
    return [];
  }
}

function writeStorageValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures; Electron preferences remain authoritative.
  }
  void desktop.setPreference(key, value).catch(() => undefined);
}

function removeStorageValue(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures; Electron preferences remain authoritative.
  }
  void desktop.removePreference(key).catch(() => undefined);
}

function writeWorkspaceList(workspaces: WorkspacePath[]): void {
  writeStorageValue(workspaceListStorageKey, JSON.stringify(workspaces));
}

function readInterfaceMode(): InterfaceMode {
  try {
    return readInterfaceModeValue(window.localStorage.getItem(interfaceModeStorageKey)) ?? "terminal";
  } catch {
    return "terminal";
  }
}

function readInterfaceModeValue(value: string | null): InterfaceMode | null {
  if (value === "chat" || value === "terminal") return value;
  return null;
}

function writeInterfaceMode(mode: InterfaceMode): void {
  writeStorageValue(interfaceModeStorageKey, mode);
}

function readUiTheme(): UiTheme {
  try {
    return parseUiTheme(window.localStorage.getItem(uiThemeStorageKey)) ?? "classic";
  } catch {
    return "classic";
  }
}

function parseUiTheme(value: string | null): UiTheme | null {
  if (
    value === "classic" ||
    value === "monolith" ||
    value === "press" ||
    value === "mono-light" ||
    value === "mono-dark"
  ) {
    return value;
  }
  return null;
}

function writeUiTheme(theme: UiTheme): void {
  writeStorageValue(uiThemeStorageKey, theme);
}

function readTerminalFocus(): boolean {
  try {
    return readTerminalFocusValue(window.localStorage.getItem(terminalFocusStorageKey)) ?? false;
  } catch {
    return false;
  }
}

function readTerminalFocusValue(value: string | null): boolean | null {
  if (value === "1") return true;
  if (value === "0") return false;
  return null;
}

function writeTerminalFocus(focused: boolean): void {
  writeStorageValue(terminalFocusStorageKey, focused ? "1" : "0");
}

function writeStoredWorkspace(workspacePath: WorkspacePath | null): void {
  if (workspacePath?.nativePath.trim()) writeStorageValue(workspaceStorageKey, JSON.stringify(workspacePath));
  else removeStorageValue(workspaceStorageKey);
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
      && session.promptPath === other.promptPath
      && session.initialTask === other.initialTask;
  });
}

export function App() {
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [electronControl, setElectronControl] = useState<ElectronControlStatus | null>(null);
  const [workspacePath, setWorkspacePath] = useState<WorkspacePath | null>(null);
  const workspace = workspacePath?.nativePath ?? "";
  const workspaceDisplay = workspacePath?.displayPath ?? workspace;
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspacePath[]>(() => readWorkspaceList());
  const [state, setState] = useState<LoadState>(emptyLoadState);
  const [embeddedSessions, setEmbeddedSessions] = useState<EmbeddedTerminalSession[]>([]);
  const [workspaceAttention, setWorkspaceAttention] = useState<Record<string, WorkspaceAttention>>({});
  const [agentSessionsByWorkspace, setAgentSessionsByWorkspace] = useState<Record<string, AgentSession[]>>({});
  const [sessionRenames, setSessionRenames] = useState<Record<string, string>>(() => readRenamedSessions(workspace));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeRoom, setActiveRoom] = useState<ActiveRoom>("command");
  const [terminalFocus, setTerminalFocusState] = useState(() => readTerminalFocus());
  const [interfaceMode, setInterfaceModeState] = useState<InterfaceMode>(() => readInterfaceMode());
  const [uiTheme, setUiThemeState] = useState<UiTheme>(() => readUiTheme());
  const [layoutResetNonce, setLayoutResetNonce] = useState(0);
  const [recallRefreshing, setRecallRefreshing] = useState(false);
  const [installingHermes, setInstallingHermes] = useState(false);
  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(null);
  const [agentTranscript, setAgentTranscript] = useState<AgentTranscriptState | null>(null);
  const [performanceDiagnostics, setPerformanceDiagnostics] = useState<PerformanceDiagnostics | null>(null);
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([]);
  const [launchState, setLaunchState] = useState<AthenaLaunchState | null>(null);
  const [restoreRequest, setRestoreRequest] = useState<{ workspaceKey: string; nonce: number } | null>(null);
  const backendRefreshInFlight = useRef(false);
  const dataRefreshInFlight = useRef(false);
  const agentSessionsRefreshInFlight = useRef<Set<string>>(new Set());
  const agentSessionsLastRefreshAt = useRef<Map<string, number>>(new Map());
  const activeWorkspaceRef = useRef("");
  const embeddedSessionsRef = useRef<EmbeddedTerminalSession[]>([]);
  const lastWorkspaceAttentionAt = useRef<Map<string, number>>(new Map());
  const autoRecallRefreshWorkspace = useRef<string | null>(null);
  const startupAttempted = useRef(false);
  const preferencesLoaded = useRef(false);

  function setInterfaceMode(mode: InterfaceMode) {
    setInterfaceModeState(mode);
    writeInterfaceMode(mode);
  }

  function setUiTheme(theme: UiTheme) {
    setUiThemeState(theme);
    writeUiTheme(theme);
  }

  function clearWorkspaceAttention(nextWorkspace: WorkspacePath | string) {
    const key = typeof nextWorkspace === "string" ? normalizeWorkspaceKey(nextWorkspace) : workspaceKey(nextWorkspace);
    setWorkspaceAttention((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function markWorkspaceAttention(sessionId: string, kind: WorkspaceAttentionKind) {
    const session = embeddedSessionsRef.current.find((item) => item.id === sessionId);
    if (!session) return;
    const key = normalizeWorkspaceKey(session.workspace);
    if (!key || key === normalizeWorkspaceKey(activeWorkspaceRef.current)) return;
    const throttleKey = `${sessionId}:${kind}`;
    const now = Date.now();
    if (now - (lastWorkspaceAttentionAt.current.get(throttleKey) ?? 0) < 30_000) return;
    lastWorkspaceAttentionAt.current.set(throttleKey, now);
    void desktop.playAttentionSound();
    setWorkspaceAttention((current) => ({
      ...current,
      [key]: mergeWorkspaceAttention(current[key], kind),
    }));
  }

  function setTerminalFocus(focused: boolean) {
    setTerminalFocusState(focused);
    writeTerminalFocus(focused);
    if (focused) setActiveRoom("command");
  }

  const client = useMemo(() => {
    return backend?.healthy && backend.baseUrl ? new BackendClient(backend.baseUrl) : null;
  }, [backend?.baseUrl, backend?.healthy]);

  const agentSessions = useMemo(() => {
    return agentSessionsByWorkspace[normalizeWorkspaceKey(workspace)] ?? [];
  }, [agentSessionsByWorkspace, workspace]);

  const reviewAgentSessions = useMemo(() => {
    const orderedKeys = new Set<string>();
    if (workspace) orderedKeys.add(normalizeWorkspaceKey(workspace));
    for (const tab of workspaceTabs) orderedKeys.add(workspaceKey(tab));
    for (const key of Object.keys(agentSessionsByWorkspace)) orderedKeys.add(key);
    const sessions: AgentSession[] = [];
    const seen = new Set<string>();
    for (const key of orderedKeys) {
      for (const session of agentSessionsByWorkspace[key] ?? []) {
        const sessionKey = `${normalizeWorkspaceKey(session.workspace)}:${selectedAgentSessionKey(session)}`;
        if (seen.has(sessionKey)) continue;
        seen.add(sessionKey);
        sessions.push(session);
      }
    }
    return sessions;
  }, [agentSessionsByWorkspace, workspace, workspaceTabs]);

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

  const refreshElectronControl = useCallback(async () => {
    try {
      const status = await desktop.checkControlHealth();
      setElectronControl(status);
      return status;
    } catch (err) {
      const status = {
        baseUrl: null,
        port: null,
        running: false,
        lastError: String(err),
      };
      setElectronControl(status);
      return status;
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const nextSessions = applyEmbeddedSessionRenames(await desktop.listEmbeddedTerminals(), sessionRenames);
      setEmbeddedSessions((current) => sameEmbeddedSessions(current, nextSessions) ? current : nextSessions);
    } catch (err) {
      setError(String(err));
    }
  }, [sessionRenames]);

  async function clearTerminalRestorePause() {
    const nextState = await desktop.clearTerminalRestorePause();
    setLaunchState(nextState);
    setError(null);
  }

  const refreshWorkspaceAgentSessions = useCallback(async (targetWorkspace: string, options: { force?: boolean } = {}) => {
    if (!targetWorkspace) return;
    const requestedWorkspace = targetWorkspace;
    const requestedWorkspaceKey = normalizeWorkspaceKey(requestedWorkspace);
    if (agentSessionsRefreshInFlight.current.has(requestedWorkspaceKey)) return;
    const now = Date.now();
    const lastRefreshAt = agentSessionsLastRefreshAt.current.get(requestedWorkspaceKey) ?? 0;
    if (!options.force && now - lastRefreshAt < nativeSessionRefreshIntervalMs) return;
    agentSessionsLastRefreshAt.current.set(requestedWorkspaceKey, now);
    agentSessionsRefreshInFlight.current.add(requestedWorkspaceKey);
    try {
      const renames = sameWorkspacePath(requestedWorkspace, workspace) ? sessionRenames : readRenamedSessions(requestedWorkspace);
      const sessions = applyAgentSessionRenames(await desktop.listAgentSessions(requestedWorkspace), renames);
      setAgentSessionsByWorkspace((current) => ({ ...current, [requestedWorkspaceKey]: sessions }));
    } catch (err) {
      if (normalizeWorkspaceKey(activeWorkspaceRef.current) === requestedWorkspaceKey) setError(String(err));
    } finally {
      agentSessionsRefreshInFlight.current.delete(requestedWorkspaceKey);
    }
  }, [sessionRenames, workspace]);

  const refreshAgentSessions = useCallback(async (options: { force?: boolean } = {}) => {
    if (!workspace) return;
    await refreshWorkspaceAgentSessions(workspace, options);
  }, [refreshWorkspaceAgentSessions, workspace]);

  const refreshPerformanceDiagnostics = useCallback(async () => {
    try {
      setPerformanceDiagnostics(await desktop.getPerformanceDiagnostics());
    } catch {
      setPerformanceDiagnostics(null);
    }
  }, []);

  const refreshAgentMessages = useCallback(async () => {
    if (!workspace) {
      setAgentMessages([]);
      return;
    }
    try {
      setAgentMessages(await desktop.listAgentMessages(workspace, 100));
    } catch {
      setAgentMessages([]);
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
    let cancelled = false;
    if (uiTheme === "classic") {
      delete document.documentElement.dataset.theme;
      delete document.documentElement.dataset.themeLoaded;
      const themeStyle = document.getElementById(uiThemeStyleElementId);
      themeStyle?.remove();
      return;
    }

    document.documentElement.dataset.theme = uiTheme;
    delete document.documentElement.dataset.themeLoaded;
    loadUiThemeCss[uiTheme]().then(({ default: css }) => {
      if (cancelled) return;
      let themeStyle = document.getElementById(uiThemeStyleElementId) as HTMLStyleElement | null;
      if (!themeStyle) {
        themeStyle = document.createElement("style");
        themeStyle.id = uiThemeStyleElementId;
        document.head.appendChild(themeStyle);
      }
      themeStyle.textContent = css;
      document.documentElement.dataset.themeLoaded = uiTheme;
    });
    return () => {
      cancelled = true;
    };
  }, [uiTheme]);

  useEffect(() => {
    if (preferencesLoaded.current) writeStoredWorkspace(workspacePath);
  }, [workspacePath]);

  useEffect(() => {
    if (preferencesLoaded.current) writeWorkspaceList(workspaceTabs);
  }, [workspaceTabs]);

  useEffect(() => {
    if (startupAttempted.current) return;
    startupAttempted.current = true;
    void (async () => {
      const preferences = await desktop.getPreferences().catch(() => ({} as Record<string, string>));
      const preferredTheme = parseUiTheme(preferences[uiThemeStorageKey] ?? null);
      if (preferredTheme) setUiThemeState(preferredTheme);
      else {
        const fallbackTheme = parseUiTheme(storedValue(uiThemeStorageKey));
        if (fallbackTheme) writeUiTheme(fallbackTheme);
      }
      const preferredMode = readInterfaceModeValue(preferences[interfaceModeStorageKey] ?? null);
      if (preferredMode) setInterfaceModeState(preferredMode);
      else {
        const fallbackMode = readInterfaceModeValue(storedValue(interfaceModeStorageKey));
        if (fallbackMode) writeInterfaceMode(fallbackMode);
      }
      const preferredFocus = readTerminalFocusValue(preferences[terminalFocusStorageKey] ?? null);
      if (preferredFocus != null) setTerminalFocusState(preferredFocus);
      else {
        const fallbackFocus = readTerminalFocusValue(storedValue(terminalFocusStorageKey));
        if (fallbackFocus != null) writeTerminalFocus(fallbackFocus);
      }
      const preferredTabs = readWorkspaceListValue(preferences[workspaceListStorageKey] ?? null);
      if (preferredTabs.length > 0) setWorkspaceTabs(preferredTabs);
      else if (readWorkspaceList().length > 0) writeWorkspaceList(readWorkspaceList());
      preferencesLoaded.current = true;

      const stored = parseStoredWorkspace(preferences[workspaceStorageKey] ?? storedWorkspaceValue());
      const workspacePromise = stored ? desktop.toWorkspacePath(stored) : desktop.getDefaultWorkspace();
      workspacePromise
        // Restoring here brings saved terminals back on app launch; the main
        // process skips the actual respawn while terminal restore is paused
        // (crash guard), so this stays safe after an unclean exit.
        .then((resolved) => activateWorkspace(resolved))
        .catch((err) => setError(String(err)));
    })();

    desktop
      .getBackendState()
      .then((status) => {
        setBackend(status);
        if (status.healthy) void refreshData();
      })
      .catch((err) => setError(String(err)));
    desktop
      .getControlState()
      .then((status) => {
        setElectronControl(status);
        if (status.running) void refreshElectronControl();
      })
      .catch((err) => setError(String(err)));
    desktop
      .getLaunchState()
      .then((status) => {
        setLaunchState(status);
        if (status?.terminalRestorePaused) {
          setError("Terminal restore is paused because the previous Athena launch did not exit cleanly. Open Settings to resume restore when ready.");
        }
      })
      .catch(() => undefined);
  }, [refreshData, refreshElectronControl, refreshSessions, sessionRenames]);

  useEffect(() => {
    if (!workspacePath || !restoreRequest || restoreRequest.workspaceKey !== workspaceKey(workspacePath)) return;
    const allowedWorkspaces = [workspacePath.nativePath].filter(Boolean);
    desktop
      .restoreEmbeddedTerminals(allowedWorkspaces)
      .then((sessions) => {
        const nextSessions = applyEmbeddedSessionRenames(sessions, sessionRenames);
        setEmbeddedSessions((current) => {
          const byId = new Map(current.map((session) => [session.id, session]));
          for (const session of nextSessions) byId.set(session.id, session);
          const merged = Array.from(byId.values());
          return sameEmbeddedSessions(current, merged) ? current : merged;
        });
      })
      .catch((err) => {
        setError(String(err));
        void refreshSessions();
      });
  }, [refreshSessions, restoreRequest, sessionRenames, workspacePath]);

  useEffect(() => {
    void refreshAgentSessions({ force: true });
  }, [refreshAgentSessions, embeddedSessions]);

  useEffect(() => {
    const workspaces = new Set(workspaceTabs.map((tab) => tab.nativePath).filter(Boolean));
    if (workspace) workspaces.add(workspace);
    for (const reviewWorkspace of workspaces) void refreshWorkspaceAgentSessions(reviewWorkspace);
  }, [embeddedSessions, refreshWorkspaceAgentSessions, workspace, workspaceTabs]);

  useEffect(() => {
    embeddedSessionsRef.current = embeddedSessions;
  }, [embeddedSessions]);

  useEffect(() => {
    activeWorkspaceRef.current = workspace;
    clearWorkspaceAttention(workspace);
    const nextRenames = readRenamedSessions(workspace);
    setSessionRenames(nextRenames);
    setEmbeddedSessions((current) => applyEmbeddedSessionRenames(current, nextRenames));
    if (workspace) agentSessionsLastRefreshAt.current.set(normalizeWorkspaceKey(workspace), 0);
  }, [workspace]);

  useEffect(() => {
    void refreshData();
  }, [refreshData]);

  useEffect(() => {
    const removeSession = desktop.onEmbeddedTerminalSession((session) => {
      setEmbeddedSessions((current) => appendEmbeddedSessions(current, [session]));
    });
    const removeWorkspaceOpen = desktop.onWorkspaceOpen(({ workspace: nextWorkspace, select }) => {
      if (select) {
        activateWorkspace(nextWorkspace);
        setActiveRoom("command");
        return;
      }
      setWorkspaceTabs((current) => upsertWorkspace(current, nextWorkspace));
    });
    const removeWorkspaceClose = desktop.onWorkspaceClose(({ workspace: closedWorkspace }) => {
      closeWorkspaceTab(closedWorkspace);
    });
    const removeData = desktop.onEmbeddedTerminalData((payload) => {
      const kind = classifyTerminalAttention(payload.data);
      if (kind) markWorkspaceAttention(payload.id, kind);
    });
    const removeExit = desktop.onEmbeddedTerminalExit((payload) => {
      markWorkspaceAttention(payload.id, "update");
      setEmbeddedSessions((current) =>
        current.map((item) => (item.id === payload.id ? { ...item, status: "exited", exitCode: payload.exitCode } : item)),
      );
    });
    return () => {
      removeSession();
      removeWorkspaceOpen();
      removeWorkspaceClose();
      removeData();
      removeExit();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshBackend().then((status) => {
        if (status?.healthy) void refreshData();
      });
      void refreshElectronControl();
      void refreshSessions();
      if (activeRoom === "command" || activeRoom === "review" || activeRoom === "swarm") {
        void refreshAgentSessions();
      }
      if (activeRoom === "settings") void refreshPerformanceDiagnostics();
      if (activeRoom === "swarm") void refreshAgentMessages();
    }, 8000);
    return () => window.clearInterval(timer);
  }, [activeRoom, refreshBackend, refreshData, refreshElectronControl, refreshSessions, refreshAgentSessions, refreshPerformanceDiagnostics, refreshAgentMessages]);

  useEffect(() => {
    if (activeRoom !== "settings") return;
    void refreshPerformanceDiagnostics();
  }, [activeRoom, refreshPerformanceDiagnostics]);

  useEffect(() => {
    if (activeRoom !== "swarm") return;
    void Promise.all([refreshAgentMessages(), refreshPerformanceDiagnostics()]);
  }, [activeRoom, refreshAgentMessages, refreshPerformanceDiagnostics]);

  useEffect(() => {
    if (!terminalFocus) return undefined;
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTerminalFocus(false);
    };
    document.addEventListener("keydown", exitOnEscape);
    return () => document.removeEventListener("keydown", exitOnEscape);
  }, [terminalFocus]);

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

  async function restartElectronControl() {
    setBusy(true);
    try {
      const status = await desktop.restartControl();
      setElectronControl(status);
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

  function activateWorkspace(nextWorkspace: WorkspacePath, options: { restoreTerminals?: boolean } = {}) {
    setWorkspacePath(nextWorkspace);
    setWorkspaceTabs((current) => upsertWorkspace(current, nextWorkspace));
    clearWorkspaceAttention(nextWorkspace);
    setSelectedSessionKey(null);
    setState((current) => ({ ...current, recall: null }));
    if (options.restoreTerminals !== false) {
      setRestoreRequest({ workspaceKey: workspaceKey(nextWorkspace), nonce: Date.now() });
    }
  }

  function closeWorkspaceTab(tab: WorkspacePath) {
    const key = workspaceKey(tab);
    clearWorkspaceAttention(tab);
    const workspaceSessionIds = embeddedSessionsRef.current
      .filter((session) => sameWorkspacePath(session.workspace, tab.nativePath))
      .map((session) => session.id);
    if (workspaceSessionIds.length > 0) {
      setEmbeddedSessions((current) => current.filter((session) => !workspaceSessionIds.includes(session.id)));
      void Promise.allSettled(workspaceSessionIds.map((id) => desktop.killEmbeddedTerminal(id))).then((results) => {
        const failure = results.find((result): result is PromiseRejectedResult =>
          result.status === "rejected" && !String(result.reason).includes("Embedded terminal not found"),
        );
        if (failure) setError(String(failure.reason));
      });
    }
    setAgentSessionsByWorkspace((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
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

  async function openWorkspaceInFiles(tab: WorkspacePath) {
    try {
      const opened = await desktop.openPath(tab.nativePath);
      if (!opened) setError(`Unable to open workspace folder: ${tab.nativePath}`);
      else setError(null);
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

  async function installHermes() {
    if (!client || installingHermes) return;
    setInstallingHermes(true);
    setError(null);
    try {
      const result = await client.installHermes();
      setState((current) => ({ ...current, hermes: result.hermes }));
      if (result.returncode !== 0) {
        setError(result.stderr.trim() || `Hermes install exited with status ${result.returncode}.`);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setInstallingHermes(false);
    }
  }

  async function launchEmbedded(kind: EmbeddedTerminalKind, count = 1) {
    if (!workspace || busy) return;
    setBusy(true);
    setError(null);
    try {
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
        if ((kind === "opencode" || kind === "athena" || kind === "grok") && index > 0) await delay(650);
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
      setEmbeddedSessions((current) => count > 1
        ? [...created.reverse(), ...current.filter((item) => !created.some((createdItem) => createdItem.id === item.id))]
        : appendEmbeddedSessions(current, created));
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
      setEmbeddedSessions((current) => appendEmbeddedSessions(current, [created]));
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

  async function renameEmbeddedSession(session: EmbeddedTerminalSession) {
    const nextTitle = window.prompt("Rename session", session.title)?.trim();
    if (!nextTitle || nextTitle === session.title) return;
    const key = embeddedSessionKey(session);
    const nextRenames = { ...sessionRenames, [key]: nextTitle };
    setSessionRenames(nextRenames);
    writeRenamedSessions(workspace, nextRenames);
    setEmbeddedSessions((current) => current.map((item) => item.id === session.id ? { ...item, title: nextTitle } : item));
    await desktop.renameEmbeddedTerminal(session.id, nextTitle).catch(() => undefined);
  }

  function renameAgentSession(session: AgentSession) {
    const nextTitle = window.prompt("Rename session", session.title)?.trim();
    if (!nextTitle || nextTitle === session.title) return;
    const key = selectedAgentSessionKey(session);
    const renameWorkspace = session.workspace || workspace;
    const existingRenames = sameWorkspacePath(renameWorkspace, workspace) ? sessionRenames : readRenamedSessions(renameWorkspace);
    const nextRenames = { ...existingRenames, [key]: nextTitle };
    if (sameWorkspacePath(renameWorkspace, workspace)) setSessionRenames(nextRenames);
    writeRenamedSessions(renameWorkspace, nextRenames);
    setAgentSessionsByWorkspace((current) => {
      const workspaceKey = normalizeWorkspaceKey(renameWorkspace);
      return {
        ...current,
        [workspaceKey]: (current[workspaceKey] ?? []).map((item) => selectedAgentSessionKey(item) === key ? { ...item, title: nextTitle } : item),
      };
    });
  }

  async function broadcastPromptToAgents(prompt: string, sessionIds: string[]) {
    const trimmed = prompt.trim();
    if (!trimmed || sessionIds.length === 0) return;

    const sessionById = new Map(embeddedSessions.map((session) => [session.id, session]));
    const results = await Promise.allSettled(sessionIds.map(async (id) => {
      const session = sessionById.get(id);
      if (!session) throw new Error(`Embedded session ${id} is no longer available.`);
      const marker = await desktop.getEmbeddedTerminalBuffer(id).then((value) => value.length).catch(() => 0);
      await writePromptSequence(
        session.kind,
        trimmed,
        (data) => desktop.writeEmbeddedTerminal(id, data),
        delay,
      );
      recordChatPromptForSession(id, trimmed, marker);
    }));
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) {
      setError(`Prompt sent to ${sessionIds.length - failed} agents; ${failed} agent${failed === 1 ? "" : "s"} could not receive it.`);
      return;
    }
    setError(null);
  }

  async function sendAgentMessage(toTerminalId: string, text: string, replyRequested: boolean) {
    if (!toTerminalId.trim() || !text.trim()) return;
    try {
      await desktop.sendAgentMessage({ to: toTerminalId, text, workspace, replyRequested });
      await Promise.all([refreshAgentMessages(), refreshPerformanceDiagnostics()]);
      setError(null);
    } catch (err) {
      setError(String(err));
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

  async function saveHandoffToRecall(markdown: string, metadata: {
    sourceCount?: number;
    sourceTitles?: string[];
    schemaVersion?: number;
    handoffId?: string;
    confidence?: string;
    sourceWorkspaces?: string[];
    sourceSessions?: HandoffPreview["sourceSessions"];
  } = {}) {
    if (!client || !workspace) throw new Error("Backend or workspace is not available.");
    const result = await client.writeRecall(workspace, markdown, "athena-session-handoff", {
      source_count: metadata.sourceCount,
      source_titles: metadata.sourceTitles,
      schema_version: metadata.schemaVersion,
      handoff_id: metadata.handoffId,
      confidence: metadata.confidence,
      source_workspaces: metadata.sourceWorkspaces,
      source_sessions: metadata.sourceSessions,
    });
    setState((current) => ({ ...current, recall: result.recall }));
    setError(null);
  }

  const loadWorkspaceSnapshot = useCallback(async () => {
    if (!client || !workspace) return null;
    return client.workspaceSnapshot(workspace);
  }, [client, workspace]);

  async function startFreshFromHandoff(
    kind: HandoffAgentKind,
    preview: HandoffPreview,
  ) {
    if (!client || !workspace) throw new Error("Backend or workspace is not available.");
    if (!sameWorkspacePath(preview.workspace, workspace)) {
      throw new Error("This handoff was generated for a different workspace. Create a new preview before launching.");
    }

    await saveHandoffToRecall(preview.markdown, {
      sourceCount: preview.sourceCount,
      sourceTitles: preview.sourceTitles,
      schemaVersion: preview.schemaVersion,
      handoffId: preview.handoffId,
      confidence: preview.confidence,
      sourceWorkspaces: preview.sourceWorkspaces,
      sourceSessions: preview.sourceSessions,
    });
    const created = await desktop.spawnEmbeddedTerminal(workspace, handoffLaunchOptions(kind, preview.markdown));
    if (created.status === "failed") {
      throw new Error(created.error || `Unable to launch ${providerLabel(kind)} from the handoff.`);
    }

    setEmbeddedSessions((current) => appendEmbeddedSessions(current, [created]));
    setTerminalFocus(true);
    setActiveRoom("command");
    try {
      const result = await client.markRecallUsed(workspace, kind);
      setState((current) => ({ ...current, recall: result.recall }));
    } catch (err) {
      setError(`Handoff launched, but recall usage could not be recorded: ${String(err)}`);
    }
  }

  const activeEmbeddedSessions = useMemo(
    () => embeddedSessions.filter((session) => sameWorkspacePath(session.workspace, workspace)),
    [embeddedSessions, workspace],
  );
  const selectedEmbeddedSession = embeddedSessions.find((session) => embeddedSessionKey(session) === selectedSessionKey) ?? null;
  const selectedAgentSession = reviewAgentSessions.find((session) => selectedAgentSessionKey(session) === selectedSessionKey) ?? null;
  const memoryEntries = [...state.memory].reverse();
  const codexInstalled = Boolean(state.adapters.codex?.installed);
  const installedAdapters = Object.values(state.adapters).filter((adapter) => adapter.installed).length;
  const liveSessionCount = activeEmbeddedSessions.filter((session) => session.status === "running").length;
  const reviewSessionCount = embeddedSessions.length + reviewAgentSessions.length;
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
        controlOnline={Boolean(electronControl?.running)}
        shellFocus={terminalFocus && activeRoom === "command"}
      />
      <main className={terminalFocus && activeRoom === "command" ? "workspaceSurface shellFocusSurface" : "workspaceSurface"}>
      <AppSidebar
        activeRoom={activeRoom}
        backendOnline={Boolean(backend?.healthy)}
        controlOnline={Boolean(electronControl?.running)}
        hermesOnline={Boolean(state.hermes?.installed)}
        onNavigate={setActiveRoom}
      />

      <section className={terminalFocus && activeRoom === "command" ? "dashboardShell terminalFocusShell" : "dashboardShell"}>
        {(error || (!backend?.healthy && backend?.lastError) || (!electronControl?.running && electronControl?.lastError)) && (
          <div className="noticeBar">{error ?? backend?.lastError ?? electronControl?.lastError}</div>
        )}
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
              attentionByWorkspace={workspaceAttention}
              onSelect={activateWorkspace}
              onClose={closeWorkspaceTab}
              onAdd={selectWorkspace}
              onOpenInFiles={(workspace) => void openWorkspaceInFiles(workspace)}
            />

            {terminalFocus && activeRoom === "command" && (
              <WorkspaceTabs
                className="focusWorkspaceTabs"
                workspaces={workspaceTabs}
                activeWorkspace={workspacePath}
                terminalSessions={embeddedSessions}
                attentionByWorkspace={workspaceAttention}
                onSelect={activateWorkspace}
                onClose={closeWorkspaceTab}
                onAdd={selectWorkspace}
                onOpenInFiles={(workspace) => void openWorkspaceInFiles(workspace)}
              />
            )}

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
                onRenameEmbeddedSession={renameEmbeddedSession}
                onInspectAgentSession={(session) => {
                  setSelectedSessionKey(selectedAgentSessionKey(session));
                  setActiveRoom("review");
                }}
                onRenameAgentSession={renameAgentSession}
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
                onOpenInFiles={(workspace) => void openWorkspaceInFiles(workspace)}
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
                agentMessages={agentMessages}
                terminalControl={performanceDiagnostics?.terminalControl ?? []}
                onOpenCommand={() => setActiveRoom("command")}
                onSendAgentMessage={sendAgentMessage}
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
                embeddedSessions={embeddedSessions}
                agentSessions={reviewAgentSessions}
                selectedEmbeddedSession={selectedEmbeddedSession}
                selectedAgentSession={selectedAgentSession}
                selectedSessionKey={selectedSessionKey}
                agentTranscript={agentTranscript}
                workspace={workspace}
                onSelectEmbeddedSession={(session) => setSelectedSessionKey(embeddedSessionKey(session))}
                onSelectAgentSession={(session) => setSelectedSessionKey(selectedAgentSessionKey(session))}
                onLoadAgentTranscript={loadAgentTranscript}
                onReadAgentTranscript={readAgentTranscript}
                onLoadWorkspaceSnapshot={loadWorkspaceSnapshot}
                onSaveHandoff={(preview) => saveHandoffToRecall(preview.markdown, {
                  sourceCount: preview.sourceCount,
                  sourceTitles: preview.sourceTitles,
                  schemaVersion: preview.schemaVersion,
                  handoffId: preview.handoffId,
                  confidence: preview.confidence,
                  sourceWorkspaces: preview.sourceWorkspaces,
                  sourceSessions: preview.sourceSessions,
                })}
                onStartFreshFromHandoff={startFreshFromHandoff}
              />
            )}
            {activeRoom === "memory" && <MemoryRoom entries={memoryEntries} busy={busy} onDelete={deleteMemoryEntry} mark={<AthenaMark />} />}
            {activeRoom === "settings" && (
              <SettingsRoom
                workspace={workspaceDisplay}
                backend={backend}
                electronControl={electronControl}
                hermes={state.hermes}
                recall={state.recall}
                adapters={state.adapters}
                busy={busy}
                refreshing={recallRefreshing}
                installingHermes={installingHermes}
                onInstallHermes={installHermes}
                interfaceMode={interfaceMode}
                uiTheme={uiTheme}
                terminalFocus={terminalFocus}
                performance={performanceDiagnostics}
                launchState={launchState}
                onSelectWorkspace={selectWorkspace}
                onRestartBackend={restartBackend}
                onRestartControl={restartElectronControl}
                onClearTerminalRestorePause={clearTerminalRestorePause}
                onRefreshRecall={() => void refreshRecall("Manual recall refresh")}
                onInterfaceModeChange={setInterfaceMode}
                onThemeChange={setUiTheme}
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
  controlOnline,
  shellFocus,
}: {
  activeLabel: string;
  workspace: string;
  backendOnline: boolean;
  controlOnline: boolean;
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
        <span className={backendOnline && controlOnline ? "online" : ""} />
        {backendOnline ? (controlOnline ? "Ready" : "Control stale") : "Offline"}
      </div>
    </header>
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
