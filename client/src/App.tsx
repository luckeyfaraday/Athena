import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Minus, Square, X } from "lucide-react";
import { BackendClient, type AdapterStatus, type BackendStatus, type ElectronControlStatus, type HermesStatus } from "./api";
import {
  desktop,
  type AgentCliKind,
  type AgentCliReport,
  type AgentCliStatus,
  type AgentSetupAction,
  type AgentSession,
  type AthenaLaunchState,
  type EmbeddedTerminalKind,
  type EmbeddedTerminalSession,
  type GraphicsPreference,
  type GraphicsRuntimeStatus,
  type PerformanceDiagnostics,
  type WorkspacePath,
} from "./electron";
import { AthenaMark } from "./components/AthenaMark";
import { AgentInstallDialog } from "./components/AgentInstallDialog";
import athenaMarkUrl from "./assets/athena-mark.png";
import { WorkspaceTabs } from "./components/WorkspaceTabs";
import { UsageMeters } from "./components/UsageMeters";
import { CommandRoom } from "./rooms/CommandRoom";
import { SettingsRoom } from "./rooms/SettingsRoom";
import { roomRoutes, type ActiveRoom } from "./routes";
import {
  sameAgentSessions,
  sameBackendStatus,
  sameElectronControlStatus,
  sameJsonValue,
  samePerformanceDiagnostics,
} from "./app-state";
import { chatStreamEndForBuffer, recordChatPromptForSession, writePromptSequence } from "./chat-mode";
import { mergeWorkspaceAttention, type WorkspaceAttention, type WorkspaceAttentionKind } from "./workspace-attention";
import {
  applyAgentSessionRenames,
  applyEmbeddedSessionRenames,
  appendEmbeddedSessions,
  embeddedSessionKey,
  providerLabel,
  readRenamedSessions,
  selectedAgentSessionKey,
  terminalGridTitles,
  writeRenamedSessions,
} from "./session-utils";
import {
  interfaceModeStorageKey,
  parseInterfaceMode,
  parseStoredWorkspace,
  parseTerminalFocus,
  parseUiTheme,
  readInterfaceMode,
  readTerminalFocus,
  readUiTheme,
  readWorkspaceList,
  readWorkspaceListValue,
  storedValue,
  terminalFocusStorageKey,
  uiThemeStorageKey,
  upsertWorkspace,
  workspaceListStorageKey,
  workspaceStorageKey,
  writeInterfaceMode,
  writeStoredWorkspace,
  writeTerminalFocus,
  writeUiTheme,
  writeWorkspaceList,
  type InterfaceMode,
  type UiTheme,
} from "./ui-preferences";
import { normalizeWorkspaceKey, sameWorkspacePath, workspaceDisplayName, workspaceKey } from "./workspace-utils";

// Cheap in-process health checks only. Anything that makes the backend spawn
// subprocesses (Hermes/adapter detection) is fetched on demand instead.
const statusPollIntervalMs = 15_000;
const agentSessionMaxAgeMs = 60_000;
const uiThemeStyleElementId = "athena-selected-ui-theme";

const loadUiThemeCss: Record<Exclude<UiTheme, "classic">, () => Promise<{ default: string }>> = {
  monolith: () => import("./themes/monolith.css?raw"),
  press: () => import("./themes/press.css?raw"),
  "mono-light": () => import("./themes/mono-light.css?raw"),
  "mono-dark": () => import("./themes/mono-dark.css?raw"),
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function documentVisible(): boolean {
  return document.visibilityState === "visible";
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

// What to start once a missing agent CLI is installed.
type PendingLaunch = { type: "new"; kind: AgentCliKind; count: number } | { type: "resume"; session: AgentSession };

function withAgentStatus(report: AgentCliReport, status: AgentCliStatus): AgentCliReport {
  const agents = report.agents.map((agent) => agent.kind === status.kind ? status : agent);
  return sameJsonValue(agents, report.agents) ? report : { ...report, agents };
}

export function App() {
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [electronControl, setElectronControl] = useState<ElectronControlStatus | null>(null);
  const [workspacePath, setWorkspacePath] = useState<WorkspacePath | null>(null);
  const workspace = workspacePath?.nativePath ?? "";
  const workspaceDisplay = workspacePath?.displayPath ?? workspace;
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspacePath[]>(() => readWorkspaceList());
  const [hermes, setHermes] = useState<HermesStatus | null>(null);
  const [adapters, setAdapters] = useState<Record<string, AdapterStatus>>({});
  const [embeddedSessions, setEmbeddedSessions] = useState<EmbeddedTerminalSession[]>([]);
  const [workspaceAttention, setWorkspaceAttention] = useState<Record<string, WorkspaceAttention>>({});
  const [agentSessionsByWorkspace, setAgentSessionsByWorkspace] = useState<Record<string, AgentSession[]>>({});
  const [sessionRenames, setSessionRenames] = useState<Record<string, string>>(() => readRenamedSessions(""));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeRoom, setActiveRoom] = useState<ActiveRoom>("command");
  const [terminalFocus, setTerminalFocusState] = useState(() => readTerminalFocus());
  const [interfaceMode, setInterfaceModeState] = useState<InterfaceMode>(() => readInterfaceMode());
  const [uiTheme, setUiThemeState] = useState<UiTheme>(() => readUiTheme());
  const [layoutResetNonce, setLayoutResetNonce] = useState(0);
  const [installingHermes, setInstallingHermes] = useState(false);
  const [performanceDiagnostics, setPerformanceDiagnostics] = useState<PerformanceDiagnostics | null>(null);
  const [launchState, setLaunchState] = useState<AthenaLaunchState | null>(null);
  const [graphicsStatus, setGraphicsStatus] = useState<GraphicsRuntimeStatus | null>(null);
  const [restoreRequest, setRestoreRequest] = useState<{ workspace: WorkspacePath; nonce: number } | null>(null);
  // Agent CLIs as the terminals find them, the install prompt for a missing one, and install/update panes still running
  // (by terminal id) with what to launch once they finish.
  const [agentClis, setAgentClis] = useState<AgentCliReport | null>(null);
  const [installPrompt, setInstallPrompt] = useState<{ status: AgentCliStatus; then: PendingLaunch } | null>(null);
  const setupRunsRef = useRef<Map<string, { kind: AgentCliKind; action: AgentSetupAction; then: PendingLaunch | null }>>(new Map());
  const setupExitRef = useRef<(id: string, exitCode: number | null) => void>(() => undefined);
  const missingAgents = useMemo<ReadonlySet<EmbeddedTerminalKind>>(
    () => new Set((agentClis?.agents ?? []).filter((agent) => !agent.installed).map((agent) => agent.kind)),
    [agentClis],
  );
  const backendRefreshInFlight = useRef(false);
  const agentSessionsRefreshInFlight = useRef<Set<string>>(new Set());
  const agentSessionsLastRefreshAt = useRef<Map<string, number>>(new Map());
  const activeWorkspaceRef = useRef("");
  const activeRoomRef = useRef<ActiveRoom>("command");
  const sessionRenamesRef = useRef(sessionRenames);
  const embeddedSessionsRef = useRef<EmbeddedTerminalSession[]>([]);
  const embeddedSessionWorkspaceKeysRef = useRef<Map<string, string>>(new Map());
  const lastWorkspaceAttentionAt = useRef<Map<string, number>>(new Map());
  const startupAttempted = useRef(false);
  const preferencesLoaded = useRef(false);

  activeWorkspaceRef.current = workspace;
  activeRoomRef.current = activeRoom;
  sessionRenamesRef.current = sessionRenames;

  function setInterfaceMode(mode: InterfaceMode) {
    setInterfaceModeState(mode);
    writeInterfaceMode(mode);
  }

  function setUiTheme(theme: UiTheme) {
    setUiThemeState(theme);
    writeUiTheme(theme);
  }

  function setTerminalFocus(focused: boolean) {
    setTerminalFocusState(focused);
    writeTerminalFocus(focused);
    if (focused) setActiveRoom("command");
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
    const key = embeddedSessionWorkspaceKeysRef.current.get(sessionId);
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

  function updateGraphicsPreference(preference: GraphicsPreference) {
    void desktop.setGraphicsPreference(preference)
      .then(setGraphicsStatus)
      .catch((err) => setError(String(err)));
  }

  const client = useMemo(() => {
    return backend?.healthy && backend.baseUrl ? new BackendClient(backend.baseUrl) : null;
  }, [backend?.baseUrl, backend?.healthy]);

  const agentSessions = useMemo(() => {
    return agentSessionsByWorkspace[normalizeWorkspaceKey(workspace)] ?? [];
  }, [agentSessionsByWorkspace, workspace]);

  const refreshBackend = useCallback(async () => {
    if (backendRefreshInFlight.current) return;
    backendRefreshInFlight.current = true;
    try {
      const status = await desktop.checkBackendHealth();
      setBackend((current) => sameBackendStatus(current, status) ? current : status);
    } catch (err) {
      setError(String(err));
    } finally {
      backendRefreshInFlight.current = false;
    }
  }, []);

  const refreshElectronControl = useCallback(async () => {
    let status: ElectronControlStatus;
    try {
      status = await desktop.checkControlHealth();
    } catch (err) {
      status = { baseUrl: null, port: null, running: false, lastError: String(err) };
    }
    setElectronControl((current) => sameElectronControlStatus(current, status) ? current : status);
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const nextSessions = applyEmbeddedSessionRenames(await desktop.listEmbeddedTerminals(), sessionRenamesRef.current);
      setEmbeddedSessions((current) => sameEmbeddedSessions(current, nextSessions) ? current : nextSessions);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  // Native session history is only needed while the Sessions tab is open, so
  // the Command Room pulls it on demand instead of App scanning on every
  // terminal change.
  const refreshAgentSessions = useCallback(async (maxAgeMs = agentSessionMaxAgeMs) => {
    const requestedWorkspace = activeWorkspaceRef.current;
    if (!requestedWorkspace) return;
    const requestedKey = normalizeWorkspaceKey(requestedWorkspace);
    if (agentSessionsRefreshInFlight.current.has(requestedKey)) return;
    const now = Date.now();
    if (now - (agentSessionsLastRefreshAt.current.get(requestedKey) ?? 0) < maxAgeMs) return;
    agentSessionsLastRefreshAt.current.set(requestedKey, now);
    agentSessionsRefreshInFlight.current.add(requestedKey);
    try {
      // Read renames for the requested workspace directly: this can run (from
      // the Sessions tab) before the workspace effect swaps sessionRenames.
      const sessions = applyAgentSessionRenames(
        await desktop.listAgentSessions(requestedWorkspace),
        readRenamedSessions(requestedWorkspace),
      );
      setAgentSessionsByWorkspace((current) => (
        sameAgentSessions(current[requestedKey] ?? [], sessions)
          ? current
          : { ...current, [requestedKey]: sessions }
      ));
    } catch (err) {
      if (normalizeWorkspaceKey(activeWorkspaceRef.current) === requestedKey) setError(String(err));
    } finally {
      agentSessionsRefreshInFlight.current.delete(requestedKey);
    }
  }, []);

  const refreshPerformanceDiagnostics = useCallback(async () => {
    try {
      const nextDiagnostics = await desktop.getPerformanceDiagnostics();
      setPerformanceDiagnostics((current) => samePerformanceDiagnostics(current, nextDiagnostics) ? current : nextDiagnostics);
    } catch {
      setPerformanceDiagnostics(null);
    }
  }, []);

  const refreshBackendDetails = useCallback(async () => {
    if (!client) return;
    const [nextHermes, nextAdapters] = await Promise.allSettled([client.hermesStatus(), client.adapters()]);
    if (nextHermes.status === "fulfilled") {
      setHermes((current) => sameJsonValue(current, nextHermes.value) ? current : nextHermes.value);
    }
    if (nextAdapters.status === "fulfilled") {
      setAdapters((current) => sameJsonValue(current, nextAdapters.value) ? current : nextAdapters.value);
    }
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    if (uiTheme === "classic") {
      delete document.documentElement.dataset.theme;
      delete document.documentElement.dataset.themeLoaded;
      document.getElementById(uiThemeStyleElementId)?.remove();
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
      const preferredMode = parseInterfaceMode(preferences[interfaceModeStorageKey] ?? null);
      if (preferredMode) setInterfaceModeState(preferredMode);
      else {
        const fallbackMode = parseInterfaceMode(storedValue(interfaceModeStorageKey));
        if (fallbackMode) writeInterfaceMode(fallbackMode);
      }
      const preferredFocus = parseTerminalFocus(preferences[terminalFocusStorageKey] ?? null);
      if (preferredFocus != null) setTerminalFocusState(preferredFocus);
      else {
        const fallbackFocus = parseTerminalFocus(storedValue(terminalFocusStorageKey));
        if (fallbackFocus != null) writeTerminalFocus(fallbackFocus);
      }
      const preferredTabs = readWorkspaceListValue(preferences[workspaceListStorageKey] ?? null);
      if (preferredTabs.length > 0) setWorkspaceTabs(preferredTabs);
      else {
        const fallbackTabs = readWorkspaceList();
        if (fallbackTabs.length > 0) writeWorkspaceList(fallbackTabs);
      }
      preferencesLoaded.current = true;

      const stored = parseStoredWorkspace(preferences[workspaceStorageKey] ?? storedValue(workspaceStorageKey));
      const workspacePromise = stored ? desktop.toWorkspacePath(stored) : desktop.getDefaultWorkspace();
      workspacePromise
        // Restoring here brings saved terminals back on app launch; the main
        // process skips the actual respawn while terminal restore is paused
        // (crash guard), so this stays safe after an unclean exit.
        .then((resolved) => activateWorkspace(resolved))
        .catch((err) => setError(String(err)));
    })();

    desktop.getBackendState().then(setBackend).catch((err) => setError(String(err)));
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
    desktop.getGraphicsStatus().then(setGraphicsStatus).catch(() => undefined);
  }, [refreshElectronControl]);

  useEffect(() => {
    if (!restoreRequest) return;
    desktop
      .restoreEmbeddedTerminals([restoreRequest.workspace.nativePath])
      .then((sessions) => {
        const nextSessions = applyEmbeddedSessionRenames(sessions, sessionRenamesRef.current);
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
  }, [refreshSessions, restoreRequest]);

  useEffect(() => {
    embeddedSessionsRef.current = embeddedSessions;
    embeddedSessionWorkspaceKeysRef.current = new Map(
      embeddedSessions.map((session) => [session.id, normalizeWorkspaceKey(session.workspace)]),
    );
  }, [embeddedSessions]);

  useEffect(() => {
    clearWorkspaceAttention(workspace);
    const nextRenames = readRenamedSessions(workspace);
    sessionRenamesRef.current = nextRenames;
    setSessionRenames(nextRenames);
    setEmbeddedSessions((current) => applyEmbeddedSessionRenames(current, nextRenames));
    if (workspace) agentSessionsLastRefreshAt.current.set(normalizeWorkspaceKey(workspace), 0);
  }, [workspace]);

  // Hermes and adapter detection can spawn subprocesses in the backend. Load
  // them when the backend (re)connects and whenever Settings is opened.
  useEffect(() => {
    void refreshBackendDetails();
  }, [refreshBackendDetails]);

  useEffect(() => {
    if (activeRoom !== "settings") return;
    void refreshBackendDetails();
    void refreshPerformanceDiagnostics();
  }, [activeRoom, refreshBackendDetails, refreshPerformanceDiagnostics]);

  const refreshAgentClis = useCallback(async (): Promise<AgentCliReport | null> => {
    try {
      const report = await desktop.getAgentClis();
      setAgentClis((current) => sameJsonValue(current, report) ? current : report);
      return report;
    } catch {
      return null;
    }
  }, []);

  // At start (so the New menu can mark missing agents) and whenever Settings opens.
  useEffect(() => {
    void refreshAgentClis();
  }, [refreshAgentClis]);
  useEffect(() => {
    if (activeRoom === "settings") void refreshAgentClis();
  }, [activeRoom, refreshAgentClis]);

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
    const removeAttention = desktop.onEmbeddedTerminalAttention((payload) => {
      markWorkspaceAttention(payload.id, payload.kind);
    });
    const removeExit = desktop.onEmbeddedTerminalExit((payload) => {
      setupExitRef.current(payload.id, payload.exitCode);
      markWorkspaceAttention(payload.id, "update");
      setEmbeddedSessions((current) =>
        current.map((item) => (item.id === payload.id ? { ...item, status: "exited", exitCode: payload.exitCode } : item)),
      );
    });
    return () => {
      removeSession();
      removeWorkspaceOpen();
      removeWorkspaceClose();
      removeAttention();
      removeExit();
    };
  }, []);

  // One stable poll loop. It does nothing while the window is hidden or
  // minimized, and catches up as soon as the window becomes visible again.
  useEffect(() => {
    const tick = () => {
      if (!documentVisible()) return;
      void refreshBackend();
      void refreshElectronControl();
      void refreshSessions();
      if (activeRoomRef.current === "settings") void refreshPerformanceDiagnostics();
    };
    const timer = window.setInterval(tick, statusPollIntervalMs);
    const handleVisibility = () => {
      if (documentVisible()) tick();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refreshBackend, refreshElectronControl, refreshPerformanceDiagnostics, refreshSessions]);

  // While the backend is starting (or down), check more often so the status
  // flips to Ready promptly; once healthy the regular poll takes over.
  const backendHealthy = Boolean(backend?.healthy);
  useEffect(() => {
    if (backendHealthy) return undefined;
    const timer = window.setInterval(() => {
      if (documentVisible()) void refreshBackend();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [backendHealthy, refreshBackend]);

  useEffect(() => {
    if (!terminalFocus) return undefined;
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTerminalFocus(false);
    };
    document.addEventListener("keydown", exitOnEscape);
    return () => document.removeEventListener("keydown", exitOnEscape);
  }, [terminalFocus]);

  async function runBusy(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  function restartBackend() {
    return runBusy(async () => setBackend(await desktop.restartBackend()));
  }

  function restartElectronControl() {
    return runBusy(async () => setElectronControl(await desktop.restartControl()));
  }

  async function clearTerminalRestorePause() {
    try {
      setLaunchState(await desktop.clearTerminalRestorePause());
      setError(null);
    } catch (err) {
      setError(String(err));
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

  async function createWorkspace() {
    try {
      const created = await desktop.createWorkspaceFolder();
      if (created) activateWorkspace(created);
    } catch (err) {
      setError(String(err));
    }
  }

  function activateWorkspace(nextWorkspace: WorkspacePath) {
    setWorkspacePath(nextWorkspace);
    setWorkspaceTabs((current) => upsertWorkspace(current, nextWorkspace));
    clearWorkspaceAttention(nextWorkspace);
    setRestoreRequest({ workspace: nextWorkspace, nonce: Date.now() });
  }

  function closeWorkspaceTab(tab: WorkspacePath) {
    const key = workspaceKey(tab);
    clearWorkspaceAttention(tab);
    const workspaceSessionIds = embeddedSessionsRef.current
      .filter((session) => sameWorkspacePath(session.workspace, tab.nativePath))
      .map((session) => session.id);
    if (workspaceSessionIds.length > 0) {
      const closing = new Set(workspaceSessionIds);
      setEmbeddedSessions((current) => current.filter((session) => !closing.has(session.id)));
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
      if (normalizeWorkspaceKey(activeWorkspaceRef.current) === key) setWorkspacePath(next[0] ?? null);
      return next;
    });
  }

  function renameWorkspaceTab(tab: WorkspacePath) {
    const trimmed = window.prompt("Workspace display name", workspaceDisplayName(tab))?.trim();
    if (!trimmed) return;
    setWorkspaceTabs((current) =>
      current.map((item) => workspaceKey(item) === workspaceKey(tab) ? { ...item, displayPath: trimmed } : item),
    );
    setWorkspacePath((current) => current && workspaceKey(current) === workspaceKey(tab) ? { ...current, displayPath: trimmed } : current);
  }

  async function openWorkspaceInFiles(tab: WorkspacePath) {
    try {
      const opened = await desktop.openPath(tab.nativePath);
      setError(opened ? null : `Unable to open workspace folder: ${tab.nativePath}`);
    } catch (err) {
      setError(String(err));
    }
  }

  async function installHermes() {
    if (!client || installingHermes) return;
    setInstallingHermes(true);
    setError(null);
    try {
      const result = await client.installHermes();
      setHermes(result.hermes);
      if (result.returncode !== 0) {
        setError(result.stderr.trim() || `Hermes install exited with status ${result.returncode}.`);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setInstallingHermes(false);
    }
  }

  // Before an agent launches: is its CLI where the terminals will look? If not, ask to install it instead of opening a
  // pane that can only print an error. When the check itself fails, launch anyway and let the pane explain.
  async function agentReady(kind: EmbeddedTerminalKind, then: PendingLaunch): Promise<boolean> {
    if (kind === "shell") return true;
    let status: AgentCliStatus;
    try {
      status = await desktop.checkAgentCli(kind);
    } catch {
      return true;
    }
    setAgentClis((current) => current && withAgentStatus(current, status));
    if (status.installed) return true;
    setInstallPrompt({ status, then });
    return false;
  }

  // Installs, updates or cleans up an agent CLI in a visible pane of the current workspace; when the pane exits,
  // handleSetupExit re-checks the CLI and launches whatever was waiting for it.
  async function runAgentSetup(kind: AgentCliKind, action: AgentSetupAction, then: PendingLaunch | null = null) {
    if (!workspace) {
      setError("Open a workspace first: the install runs in a terminal there, so you can watch it.");
      return;
    }
    try {
      const created = await desktop.spawnEmbeddedTerminal(workspace, { setup: { agent: kind, action }, cols: 96, rows: 28 });
      setupRunsRef.current.set(created.id, { kind, action, then });
      setEmbeddedSessions((current) => appendEmbeddedSessions(current, [created]));
      setActiveRoom("command");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleSetupExit(id: string, exitCode: number | null) {
    const run = setupRunsRef.current.get(id);
    if (!run) return;
    setupRunsRef.current.delete(id);
    // installers add their folder to PATH for new processes; pick that up before looking again
    await desktop.refreshAgentPath().catch(() => false);
    const report = await refreshAgentClis();
    if (run.action === "cleanup") {
      if (exitCode) setError(`Removing the old agent copies failed (exit code ${exitCode}). The pane shows why.`);
      return;
    }
    const status = report?.agents.find((agent) => agent.kind === run.kind) ?? await desktop.checkAgentCli(run.kind).catch(() => null);
    const label = status?.label ?? run.kind;
    if (!status?.installed) {
      setError(exitCode
        ? `${run.action === "install" ? "Installing" : "Updating"} ${label} failed (exit code ${exitCode}). The pane shows why.`
        : `${label} was installed, but \`${status?.executable ?? run.kind}\` is still not on PATH. Restart Athena, or add its folder to PATH.`);
      return;
    }
    if (exitCode) {
      setError(`${run.action === "install" ? "Installing" : "Updating"} ${label} ended with exit code ${exitCode}. The pane shows why.`);
      return;
    }
    if (run.then?.type === "new") await launchEmbedded(run.then.kind, run.then.count);
    else if (run.then?.type === "resume") await resumeAgentSession(run.then.session);
  }
  setupExitRef.current = (id, exitCode) => { void handleSetupExit(id, exitCode); };

  async function installAndContinue() {
    const prompt = installPrompt;
    if (!prompt) return;
    setInstallPrompt(null);
    await runAgentSetup(prompt.status.kind, "install", prompt.then);
  }

  async function recheckInstallPrompt() {
    const prompt = installPrompt;
    if (!prompt) return;
    try {
      const status = await desktop.checkAgentCli(prompt.status.kind);
      if (!status.installed) {
        setInstallPrompt({ ...prompt, status });
        return;
      }
      setInstallPrompt(null);
      void refreshAgentClis();
      if (prompt.then.type === "new") await launchEmbedded(prompt.then.kind, prompt.then.count);
      else await resumeAgentSession(prompt.then.session);
    } catch (err) {
      setError(String(err));
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError("Could not copy to the clipboard.");
    }
  }

  async function launchEmbedded(kind: EmbeddedTerminalKind, count = 1) {
    if (!workspace || busy) return;
    if (!(await agentReady(kind, { type: "new", kind: kind as AgentCliKind, count }))) return;
    await runBusy(async () => {
      const titles = terminalGridTitles(kind);
      const launchOptions = Array.from({ length: count }, (_, index) => ({
        kind,
        title: titles[index] ?? `${kind}-${index + 1}`,
        cols: 96,
        rows: 28,
        sessionLabel: kind === "shell" || kind === "hermes" ? undefined : "New",
      }));
      const created = await desktop.spawnEmbeddedTerminals(workspace, launchOptions);
      setEmbeddedSessions((current) => count > 1
        ? [...created.reverse(), ...current.filter((item) => !created.some((createdItem) => createdItem.id === item.id))]
        : appendEmbeddedSessions(current, created));
      if (count > 1) setLayoutResetNonce((value) => value + 1);
    });
  }

  async function resumeAgentSession(session: AgentSession) {
    if (!workspace || busy) return;
    if (!(await agentReady(session.provider, { type: "resume", session }))) return;
    await runBusy(async () => {
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
      setActiveRoom("command");
    });
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
    const nextRenames = { ...sessionRenames, [embeddedSessionKey(session)]: nextTitle };
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
    const activeWorkspace = sameWorkspacePath(renameWorkspace, workspace);
    const nextRenames = { ...(activeWorkspace ? sessionRenames : readRenamedSessions(renameWorkspace)), [key]: nextTitle };
    if (activeWorkspace) setSessionRenames(nextRenames);
    writeRenamedSessions(renameWorkspace, nextRenames);
    setAgentSessionsByWorkspace((current) => {
      const renameKey = normalizeWorkspaceKey(renameWorkspace);
      return {
        ...current,
        [renameKey]: (current[renameKey] ?? []).map((item) => selectedAgentSessionKey(item) === key ? { ...item, title: nextTitle } : item),
      };
    });
  }

  async function broadcastPromptToAgents(prompt: string, sessionIds: string[]) {
    const trimmed = prompt.trim();
    if (!trimmed || sessionIds.length === 0) return;

    const sessionById = new Map(embeddedSessions.map((session) => [session.id, session]));
    const chatView = interfaceMode === "chat";
    const results = await Promise.allSettled(sessionIds.map(async (id) => {
      const session = sessionById.get(id);
      if (!session) throw new Error(`Embedded session ${id} is no longer available.`);
      // Only the chat view needs a buffer marker to anchor the prompt bubble;
      // skip copying the whole terminal buffer over IPC otherwise.
      const marker = chatView
        ? await desktop.getEmbeddedTerminalBuffer(id).then((value) => chatStreamEndForBuffer(id, value)).catch(() => 0)
        : 0;
      await writePromptSequence(
        session.kind,
        trimmed,
        (data) => desktop.writeEmbeddedTerminal(id, data),
        delay,
      );
      if (chatView) recordChatPromptForSession(id, trimmed, marker);
    }));
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) {
      setError(`Prompt sent to ${sessionIds.length - failed} agents; ${failed} agent${failed === 1 ? "" : "s"} could not receive it.`);
      return;
    }
    setError(null);
  }

  const activeEmbeddedSessions = useMemo(
    () => embeddedSessions.filter((session) => sameWorkspacePath(session.workspace, workspace)),
    [embeddedSessions, workspace],
  );
  const shellFocus = terminalFocus && activeRoom === "command";
  const notice = error ?? (!backend?.healthy ? backend?.lastError : null) ?? (!electronControl?.running ? electronControl?.lastError : null) ?? null;

  return (
    <div className="appFrame">
      <AppTitleBar
        activeRoom={activeRoom}
        backendOnline={Boolean(backend?.healthy)}
        controlOnline={Boolean(electronControl?.running)}
        usage={<UsageMeters client={client} />}
        onNavigate={setActiveRoom}
      />
      <main className={shellFocus ? "workspaceSurface shellFocusSurface" : "workspaceSurface"}>
        <section className={shellFocus ? "dashboardShell terminalFocusShell" : "dashboardShell"}>
          <section className="dashboardGrid">
            <div className="commandColumn">
              {notice && (
                <div className="noticeBar" role="status">
                  <span>{notice}</span>
                  {error && (
                    <button type="button" className="noticeDismiss" onClick={() => setError(null)} aria-label="Dismiss message">
                      <X size={12} />
                    </button>
                  )}
                </div>
              )}
              <WorkspaceTabs
                className={shellFocus ? "focusWorkspaceTabs" : ""}
                workspaces={workspaceTabs}
                activeWorkspace={workspacePath}
                terminalSessions={embeddedSessions}
                attentionByWorkspace={workspaceAttention}
                onSelect={activateWorkspace}
                onClose={closeWorkspaceTab}
                onAdd={selectWorkspace}
                onCreate={createWorkspace}
                onRename={renameWorkspaceTab}
                onOpenInFiles={(tab) => void openWorkspaceInFiles(tab)}
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
                  onRenameEmbeddedSession={renameEmbeddedSession}
                  onRenameAgentSession={renameAgentSession}
                  onRefreshAgentSessions={refreshAgentSessions}
                  missingAgents={missingAgents}
                  emptyMark={<AthenaMark />}
                />
              )}
              {activeRoom === "settings" && (
                <SettingsRoom
                  workspace={workspaceDisplay}
                  backend={backend}
                  electronControl={electronControl}
                  hermes={hermes}
                  adapters={adapters}
                  busy={busy}
                  installingHermes={installingHermes}
                  onInstallHermes={installHermes}
                  agentClis={agentClis}
                  canRunSetup={Boolean(workspace)}
                  onAgentSetup={(kind, action) => void runAgentSetup(kind, action)}
                  interfaceMode={interfaceMode}
                  uiTheme={uiTheme}
                  terminalFocus={terminalFocus}
                  performance={performanceDiagnostics}
                  launchState={launchState}
                  graphics={graphicsStatus}
                  onSelectWorkspace={selectWorkspace}
                  onRestartBackend={restartBackend}
                  onRestartControl={restartElectronControl}
                  onClearTerminalRestorePause={clearTerminalRestorePause}
                  onRefreshDiagnostics={refreshPerformanceDiagnostics}
                  onInterfaceModeChange={setInterfaceMode}
                  onThemeChange={setUiTheme}
                  onTerminalFocusChange={setTerminalFocus}
                  onGraphicsPreferenceChange={updateGraphicsPreference}
                />
              )}
            </div>
          </section>
        </section>
      </main>
      {installPrompt && (
        <AgentInstallDialog
          status={installPrompt.status}
          action={installPrompt.then.type === "resume" ? "resume" : "launch"}
          onInstall={() => void installAndContinue()}
          onRecheck={() => void recheckInstallPrompt()}
          onCancel={() => setInstallPrompt(null)}
          onCopy={(text) => void copyText(text)}
          onOpenDocs={(url) => void desktop.openExternalUrl(url)}
        />
      )}
    </div>
  );
}

function AppTitleBar({
  activeRoom,
  backendOnline,
  controlOnline,
  usage,
  onNavigate,
}: {
  activeRoom: ActiveRoom;
  backendOnline: boolean;
  controlOnline: boolean;
  usage?: ReactNode;
  onNavigate: (room: ActiveRoom) => void;
}) {
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
        <span className="titleMark" aria-hidden="true"><img src={athenaMarkUrl} alt="" /></span>
        <strong>ATHENA</strong>
      </div>
      <nav className="titleNav" aria-label="Rooms">
        {roomRoutes.map((route) => (
          <button
            key={route.id}
            type="button"
            className={activeRoom === route.id ? "active" : ""}
            aria-current={activeRoom === route.id ? "page" : undefined}
            onClick={() => onNavigate(route.id)}
          >
            {route.icon}
            <span>{route.label}</span>
          </button>
        ))}
      </nav>
      <div className="titleEnd">
        {usage}
        <div className="titleStatus" title={`Backend ${backendOnline ? "online" : "offline"} · Control ${controlOnline ? "online" : "offline"}`}>
          <span className={backendOnline && controlOnline ? "online" : ""} />
          {backendOnline ? (controlOnline ? "Ready" : "Control stale") : "Offline"}
        </div>
      </div>
    </header>
  );
}
