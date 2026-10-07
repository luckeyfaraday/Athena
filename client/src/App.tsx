import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Bell,
  Code2,
  Command,
  FolderOpen,
  FolderPlus,
  Keyboard,
  MessageSquare,
  Minus,
  Monitor,
  Palette,
  Pencil,
  RefreshCw,
  Rows3,
  Settings as SettingsIcon,
  Square,
  TerminalSquare,
  Type,
  X,
  XCircle,
} from "lucide-react";
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
  type RemoteAttention,
  type WorkspacePath,
} from "./electron";
import { MachineSwitcher } from "./components/MachineSwitcher";
import { RemoteMachineRoom, type RemoteMachineRoomHandle, type RemoteRevealRequest } from "./rooms/RemoteMachineRoom";
import { machineWorkspaceAttention, remoteAttentionKey, remoteMachineIdOf, remoteWorkspaceTabs, sessionsInWorkspace, switcherEntries } from "./remote-view";
import { useRemoteMachines } from "./use-remote-machines";
import { AthenaMark } from "./components/AthenaMark";
import { AgentInstallDialog } from "./components/AgentInstallDialog";
import athenaMarkUrl from "./assets/athena-mark.png";
import { WorkspaceTabs } from "./components/WorkspaceTabs";
import { UsageMeters } from "./components/UsageMeters";
import { AgentGlyph } from "./components/AgentGlyph";
import { ConfirmDialog, PromptDialog, type ConfirmRequest, type TextPromptRequest } from "./components/PromptDialog";
import { backendStatusView, electronControlStatusView } from "./components/status";
import { ToastStack, useToasts } from "./components/Toasts";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette";
import { CommandRoom } from "./rooms/CommandRoom";
import { roomRoutes, type ActiveRoom } from "./routes";
import { settingsSections, type SettingsSection } from "./settings-sections";
import { nextTheme, resolveTheme, themeLabel, themes, type ThemeId, type ThemePreference } from "./themes";
import {
  clampTerminalFontSize,
  defaultTerminalAppearance,
  parseTerminalFont,
  parseTerminalFontSize,
  setTerminalAppearance as publishTerminalAppearance,
  terminalFontSizeStorageKey,
  terminalFontStorageKey,
  type TerminalAppearance,
} from "./terminal-appearance";
import { isMacPlatform, shortcutKeysFor, type ShortcutId } from "./shortcuts";
import { useGlobalShortcuts } from "./use-shortcuts";
import {
  sameAgentSessions,
  sameBackendStatus,
  sameElectronControlStatus,
  sameJsonValue,
  samePerformanceDiagnostics,
} from "./app-state";
import { playAttentionSound } from "./attention-sounds";
import {
  attentionDelivery,
  attentionHeadline,
  mergeWorkspaceAttention,
  parseNotificationPreferences,
  type NotificationPreferences,
  type TerminalAttentionEvent,
  type WorkspaceAttention,
  type WorkspaceAttentionKind,
} from "./workspace-attention";
import {
  applyAgentSessionRenames,
  applyEmbeddedSessionRenames,
  appendEmbeddedSessions,
  embeddedSessionKey,
  formatSessionTime,
  providerLabel,
  readRenamedSessions,
  selectedAgentSessionKey,
  terminalGridTitles,
  writeRenamedSessions,
} from "./session-utils";
import {
  densityStorageKey,
  interfaceModeStorageKey,
  notificationsStorageKey,
  parseDensity,
  parseInterfaceMode,
  parseStoredWorkspace,
  parseUiTheme,
  readDensity,
  readInterfaceMode,
  readNotificationPreferences,
  readUiTheme,
  readWorkspaceList,
  readWorkspaceListValue,
  storedValue,
  uiThemeStorageKey,
  upsertWorkspace,
  workspaceListStorageKey,
  workspaceStorageKey,
  writeDensity,
  writeInterfaceMode,
  writeNotificationPreferences,
  writeStorageValue,
  writeStoredWorkspace,
  writeUiTheme,
  writeWorkspaceList,
  type Density,
  type InterfaceMode,
  type UiTheme,
} from "./ui-preferences";
import { normalizeWorkspaceKey, sameWorkspacePath, workspaceDisplayName, workspaceKey } from "./workspace-utils";

// Cheap in-process health checks only. Anything that makes the backend spawn
// subprocesses (Hermes/adapter detection) is fetched on demand instead.
const statusPollIntervalMs = 15_000;
const agentSessionMaxAgeMs = 60_000;
// Main reports each prompt or finished turn once; this only keeps a flapping terminal from alerting in a loop.
const attentionAlertThrottleMs = 5_000;
// How long "Starting…" may show before an unhealthy backend is reported as not responding.
const backendStartupGraceMs = 45_000;

// Loaded on first use: Settings is not needed to paint the Command Room. The palette
// stays in the main bundle so it opens in the same frame as its shortcut; while a
// chunk loaded, keystrokes typed after Ctrl+Shift+P would reach the focused terminal.
const SettingsRoom = lazy(() => import("./rooms/SettingsRoom").then((module) => ({ default: module.SettingsRoom })));

const launchableAgents: Array<{ kind: EmbeddedTerminalKind; label: string; grid: boolean }> = [
  { kind: "claude", label: "Claude Code", grid: true },
  { kind: "codex", label: "Codex", grid: true },
  { kind: "opencode", label: "OpenCode", grid: true },
  { kind: "athena", label: "Athena Code", grid: true },
  { kind: "grok", label: "Grok", grid: true },
  { kind: "hermes", label: "Hermes", grid: false },
];

function readTerminalAppearancePreference(read: (key: string) => string | null): TerminalAppearance {
  return {
    font: parseTerminalFont(read(terminalFontStorageKey)) ?? defaultTerminalAppearance.font,
    fontSize: parseTerminalFontSize(read(terminalFontSizeStorageKey)) ?? defaultTerminalAppearance.fontSize,
  };
}

function systemPrefersLight(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches;
}

function documentVisible(): boolean {
  return document.visibilityState === "visible";
}

function workspaceBasename(workspacePath: string): string {
  return workspacePath.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || workspacePath;
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
  const [interfaceMode, setInterfaceModeState] = useState<InterfaceMode>(() => readInterfaceMode());
  const [uiTheme, setUiThemeState] = useState<UiTheme>(() => readUiTheme());
  const [prefersLight, setPrefersLight] = useState(() => systemPrefersLight());
  // A theme highlighted in the command palette, shown live until it closes.
  const [previewTheme, setPreviewTheme] = useState<ThemeId | null>(null);
  const resolvedTheme = resolveTheme(uiTheme, prefersLight);
  const [density, setDensityState] = useState<Density>(() => readDensity());
  const [terminalAppearance, setTerminalAppearanceState] = useState<TerminalAppearance>(() => {
    // Publish synchronously: terminal panes read the store in their own
    // mount effects, which run before this component's effects.
    const stored = readTerminalAppearancePreference(storedValue);
    publishTerminalAppearance(stored);
    return stored;
  });
  const [commandView, setCommandView] = useState<"terminals" | "sessions">("terminals");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("appearance");
  const [palette, setPalette] = useState<{ open: boolean; query: string }>({ open: false, query: "" });
  const [promptRequest, setPromptRequest] = useState<TextPromptRequest | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const confirmResolveRef = useRef<((confirmed: boolean) => void) | null>(null);
  const [backendStalled, setBackendStalled] = useState(false);
  const promptResolveRef = useRef<((value: string | null) => void) | null>(null);
  const [revealPaneRequest, setRevealPaneRequest] = useState<{ id: string; nonce: number } | null>(null);
  const toasts = useToasts();
  const [notificationPreferences, setNotificationPreferencesState] = useState<NotificationPreferences>(() => readNotificationPreferences());
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
  // Another machine's terminals in the Command Room (null: this machine's).
  const remoteSnapshot = useRemoteMachines();
  const [activeMachineId, setActiveMachineId] = useState<string | null>(null);
  const [activeRemoteWorkspace, setActiveRemoteWorkspace] = useState<string | null>(null);
  const [remoteAttention, setRemoteAttention] = useState<Record<string, WorkspaceAttention>>({});
  const [remoteReveal, setRemoteReveal] = useState<(RemoteRevealRequest & { machineId: string }) | null>(null);
  const remoteRoomRef = useRef<RemoteMachineRoomHandle | null>(null);
  const pendingRemoteAction = useRef<{ machineId: string; run: (room: RemoteMachineRoomHandle) => void } | null>(null);
  const activeMachineIdRef = useRef<string | null>(null);
  const activeRemoteWorkspaceRef = useRef<string | null>(null);
  const activeMachine = activeMachineId ? remoteSnapshot?.machines.find((machine) => machine.id === activeMachineId) ?? null : null;
  activeMachineIdRef.current = activeMachine ? activeMachineId : null;
  activeRemoteWorkspaceRef.current = activeRemoteWorkspace;
  const missingAgents = useMemo<ReadonlySet<EmbeddedTerminalKind>>(
    () => new Set((agentClis?.agents ?? []).filter((agent) => !agent.installed).map((agent) => agent.kind)),
    [agentClis],
  );
  const backendRefreshInFlight = useRef(false);
  const agentSessionsRefreshInFlight = useRef<Set<string>>(new Set());
  const agentSessionsLastRefreshAt = useRef<Map<string, number>>(new Map());
  const activeWorkspaceRef = useRef("");
  const activeRoomRef = useRef<ActiveRoom>("command");
  const notificationPreferencesRef = useRef(notificationPreferences);
  const sessionRenamesRef = useRef(sessionRenames);
  const embeddedSessionsRef = useRef<EmbeddedTerminalSession[]>([]);
  const embeddedSessionWorkspaceKeysRef = useRef<Map<string, string>>(new Map());
  const lastWorkspaceAttentionAt = useRef<Map<string, number>>(new Map());
  const startupAttempted = useRef(false);
  const preferencesLoaded = useRef(false);

  activeWorkspaceRef.current = workspace;
  activeRoomRef.current = activeRoom;
  notificationPreferencesRef.current = notificationPreferences;
  sessionRenamesRef.current = sessionRenames;

  function setInterfaceMode(mode: InterfaceMode) {
    setInterfaceModeState(mode);
    writeInterfaceMode(mode);
  }

  function setUiTheme(theme: UiTheme) {
    setPreviewTheme(null);
    setUiThemeState(theme);
    writeUiTheme(theme);
  }

  function setDensity(next: Density) {
    setDensityState(next);
    writeDensity(next);
  }

  function setTerminalAppearance(next: TerminalAppearance) {
    const normalized = { font: next.font, fontSize: clampTerminalFontSize(next.fontSize) };
    setTerminalAppearanceState(normalized);
    writeStorageValue(terminalFontStorageKey, normalized.font);
    writeStorageValue(terminalFontSizeStorageKey, String(normalized.fontSize));
  }

  // window.prompt() is not implemented in Electron; this is the in-app equivalent.
  function requestText(request: TextPromptRequest): Promise<string | null> {
    promptResolveRef.current?.(null);
    return new Promise((resolve) => {
      promptResolveRef.current = resolve;
      setPromptRequest(request);
    });
  }

  function closePrompt(value: string | null) {
    const resolve = promptResolveRef.current;
    promptResolveRef.current = null;
    setPromptRequest(null);
    resolve?.(value);
  }

  function requestConfirm(request: ConfirmRequest): Promise<boolean> {
    confirmResolveRef.current?.(false);
    return new Promise((resolve) => {
      confirmResolveRef.current = resolve;
      setConfirmRequest(request);
    });
  }

  function closeConfirm(confirmed: boolean) {
    const resolve = confirmResolveRef.current;
    confirmResolveRef.current = null;
    setConfirmRequest(null);
    resolve?.(confirmed);
  }

  function openPalette(query = "") {
    setPalette({ open: true, query });
  }

  function closePalette() {
    setPreviewTheme(null);
    setPalette((current) => current.open ? { open: false, query: "" } : current);
  }

  function setNotificationPreferences(preferences: NotificationPreferences) {
    const previous = notificationPreferencesRef.current;
    setNotificationPreferencesState(preferences);
    writeNotificationPreferences(preferences);
    // Picking a sound plays it.
    if (preferences.sound !== previous.sound) playAttentionSound("action", preferences.sound, preferences.volume, { force: true });
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

  // Runs from a subscription made on first render, so everything it reads comes from refs.
  function handleTerminalAttention(event: TerminalAttentionEvent) {
    const key = embeddedSessionWorkspaceKeysRef.current.get(event.id) ?? null;
    const preferences = notificationPreferencesRef.current;
    const delivery = attentionDelivery(event.kind, {
      sessionWorkspaceKey: key,
      activeWorkspaceKey: normalizeWorkspaceKey(activeWorkspaceRef.current),
      windowFocused: document.hasFocus(),
      commandRoomVisible: activeRoomRef.current === "command",
    }, preferences);
    if (key && delivery.badge) {
      setWorkspaceAttention((current) => ({
        ...current,
        [key]: mergeWorkspaceAttention(current[key], event.kind),
      }));
    }
    if (!delivery.sound && !delivery.desktop && !delivery.flash) return;
    const throttleKey = `${event.id}:${event.kind}`;
    const now = Date.now();
    if (now - (lastWorkspaceAttentionAt.current.get(throttleKey) ?? 0) < attentionAlertThrottleMs) return;
    lastWorkspaceAttentionAt.current.set(throttleKey, now);
    if (delivery.sound) playAttentionSound(event.kind, preferences.sound, preferences.volume);
    if (delivery.flash) void desktop.flashWindowForAttention().catch(() => undefined);
    const session = embeddedSessionsRef.current.find((item) => item.id === event.id);
    if (delivery.desktop && session) {
      const place = workspaceBasename(session.workspace);
      void desktop.showAttentionNotification({
        title: attentionHeadline(session.title, event),
        body: event.reason === "notification" && event.message ? `${event.message} · ${place}` : place,
        workspace: session.workspace,
        sessionId: session.id,
      }).catch(() => undefined);
    }
  }

  // Same rules as local attention, keyed by machine and workspace so a badge
  // lands on that machine's tab and the switcher.
  function handleRemoteAttention(attention: RemoteAttention) {
    const session = attention.session;
    if (!session) return;
    const key = remoteAttentionKey(attention.machineId, session.workspace);
    const viewingMachine = activeMachineIdRef.current;
    const activeKey = viewingMachine
      ? remoteAttentionKey(viewingMachine, activeRemoteWorkspaceRef.current ?? "")
      : normalizeWorkspaceKey(activeWorkspaceRef.current);
    const preferences = notificationPreferencesRef.current;
    const delivery = attentionDelivery(attention.event.kind, {
      sessionWorkspaceKey: key,
      activeWorkspaceKey: activeKey,
      windowFocused: document.hasFocus(),
      commandRoomVisible: activeRoomRef.current === "command",
    }, preferences);
    if (delivery.badge) {
      setRemoteAttention((current) => ({ ...current, [key]: mergeWorkspaceAttention(current[key], attention.event.kind) }));
    }
    if (!delivery.sound && !delivery.desktop && !delivery.flash) return;
    const throttleKey = `${attention.event.id}:${attention.event.kind}`;
    const now = Date.now();
    if (now - (lastWorkspaceAttentionAt.current.get(throttleKey) ?? 0) < attentionAlertThrottleMs) return;
    lastWorkspaceAttentionAt.current.set(throttleKey, now);
    if (delivery.sound) playAttentionSound(attention.event.kind, preferences.sound, preferences.volume);
    if (delivery.flash) void desktop.flashWindowForAttention().catch(() => undefined);
    if (delivery.desktop) {
      const place = `${workspaceBasename(session.workspace)} on ${attention.machineName}`;
      void desktop.showAttentionNotification({
        title: `${attention.machineName}: ${attentionHeadline(session.title, attention.event)}`,
        body: attention.event.reason === "notification" && attention.event.message ? `${attention.event.message} · ${place}` : place,
        workspace: session.workspace,
        sessionId: session.id,
      }).catch(() => undefined);
    }
  }

  function previewAttentionSound(kind: WorkspaceAttentionKind) {
    const preferences = notificationPreferencesRef.current;
    playAttentionSound(kind, preferences.sound, preferences.volume, { force: true });
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

  // Themes are token blocks keyed by [data-theme]: switching is one attribute
  // write, with no stylesheet to fetch or inject.
  const appliedTheme = previewTheme ?? resolvedTheme;
  useEffect(() => {
    document.documentElement.dataset.theme = appliedTheme;
  }, [appliedTheme]);

  useEffect(() => {
    if (density === "default") delete document.documentElement.dataset.density;
    else document.documentElement.dataset.density = density;
  }, [density]);

  useEffect(() => {
    publishTerminalAppearance(terminalAppearance);
  }, [terminalAppearance]);

  // "Match system" follows the OS light/dark setting live.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia("(prefers-color-scheme: light)");
    const update = () => setPrefersLight(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

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
      const preferredDensity = parseDensity(preferences[densityStorageKey] ?? null);
      if (preferredDensity) setDensityState(preferredDensity);
      else {
        const fallbackDensity = parseDensity(storedValue(densityStorageKey));
        if (fallbackDensity) writeDensity(fallbackDensity);
      }
      if (preferences[terminalFontStorageKey] || preferences[terminalFontSizeStorageKey]) {
        setTerminalAppearanceState(readTerminalAppearancePreference((key) => preferences[key] ?? storedValue(key)));
      }
      const preferredNotifications = parseNotificationPreferences(preferences[notificationsStorageKey] ?? null);
      if (preferredNotifications) setNotificationPreferencesState(preferredNotifications);
      else {
        const fallbackNotifications = parseNotificationPreferences(storedValue(notificationsStorageKey));
        if (fallbackNotifications) writeNotificationPreferences(fallbackNotifications);
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
    const removeAttention = desktop.onEmbeddedTerminalAttention(handleTerminalAttention);
    const removeRemoteAttention = desktop.onRemoteAttention(handleRemoteAttention);
    // A desktop notification was clicked: show that terminal's workspace.
    const removeAttentionActivate = desktop.onAttentionActivate(({ workspace: nextWorkspace, sessionId }) => {
      setActiveRoom("command");
      const machineId = remoteMachineIdOf(sessionId);
      if (machineId) {
        setActiveMachineId(machineId);
        setRemoteReveal({ machineId, workspace: nextWorkspace, sessionId, nonce: Date.now() });
        return;
      }
      setActiveMachineId(null);
      if (sameWorkspacePath(activeWorkspaceRef.current, nextWorkspace)) return;
      desktop.toWorkspacePath(nextWorkspace).then(activateWorkspace).catch((err) => setError(String(err)));
    });
    // Natural exits are reported through the attention channel; kills are not news.
    const removeExit = desktop.onEmbeddedTerminalExit((payload) => {
      setupExitRef.current(payload.id, payload.exitCode);
      setEmbeddedSessions((current) =>
        current.map((item) => (item.id === payload.id ? { ...item, status: "exited", exitCode: payload.exitCode } : item)),
      );
    });
    return () => {
      removeSession();
      removeWorkspaceOpen();
      removeWorkspaceClose();
      removeAttention();
      removeRemoteAttention();
      removeAttentionActivate();
      removeExit();
    };
  }, []);

  // Remote Athenas show the same tabs this window has open.
  useEffect(() => {
    desktop.reportWorkspaces(workspaceTabs.map((tab) => tab.nativePath), workspacePath?.nativePath ?? null);
  }, [workspaceTabs, workspacePath]);

  // Looking at a remote workspace clears its badge, as it does for local tabs.
  useEffect(() => {
    if (activeRoom !== "command" || !activeMachineId || !activeRemoteWorkspace) return;
    const key = remoteAttentionKey(activeMachineId, activeRemoteWorkspace);
    setRemoteAttention((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, [activeRoom, activeMachineId, activeRemoteWorkspace, remoteAttention]);

  // The machine being viewed left the tailnet entirely: fall back to this one.
  useEffect(() => {
    if (!activeMachineId || !remoteSnapshot || activeMachine) return;
    setActiveMachineId(null);
    toasts.show("That machine is no longer on your tailnet. Showing this machine.");
  }, [activeMachineId, remoteSnapshot, activeMachine]);

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
  const backendRunning = Boolean(backend?.running);
  // "Starting…" is only honest for a while: a backend that runs but never gets
  // healthy (hung, port conflict) is reported as not responding.
  useEffect(() => {
    setBackendStalled(false);
    if (backendHealthy) return undefined;
    const timer = window.setTimeout(() => setBackendStalled(true), backendStartupGraceMs);
    return () => window.clearTimeout(timer);
  }, [backendHealthy, backendRunning]);
  useEffect(() => {
    if (backendHealthy) return undefined;
    const timer = window.setInterval(() => {
      if (documentVisible()) void refreshBackend();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [backendHealthy, refreshBackend]);

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

  // Closing from the UI (tab button, middle-click, menu, palette) confirms first
  // when it would stop running terminals; closes requested over MCP do not ask.
  async function requestCloseWorkspaceTab(tab: WorkspacePath) {
    const running = embeddedSessionsRef.current.filter((session) =>
      session.status === "running" && sameWorkspacePath(session.workspace, tab.nativePath)).length;
    if (running > 0) {
      const confirmed = await requestConfirm({
        title: `Close ${workspaceDisplayName(tab)}?`,
        message: `This stops ${running === 1 ? "the terminal" : `all ${running} terminals`} running in this workspace, including any agent that is working there.`,
        confirmLabel: running === 1 ? "Stop and close" : `Stop ${running} and close`,
      });
      if (!confirmed) return;
    }
    closeWorkspaceTab(tab);
  }

  async function renameWorkspaceTab(tab: WorkspacePath) {
    const trimmed = await requestText({
      title: "Rename workspace",
      label: `Display name for ${tab.nativePath}`,
      initialValue: workspaceDisplayName(tab),
      confirmLabel: "Rename",
    });
    if (!trimmed || trimmed === workspaceDisplayName(tab)) return;
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

  // Renames await a dialog, during which the active workspace can change (a
  // notification click, a shortcut). Always write to the workspace captured
  // before the dialog, reading its map from storage if it is no longer active.
  function renamesFor(renameWorkspace: string): { renames: Record<string, string>; active: boolean } {
    const active = sameWorkspacePath(renameWorkspace, activeWorkspaceRef.current);
    return { renames: active ? sessionRenamesRef.current : readRenamedSessions(renameWorkspace), active };
  }

  async function renameEmbeddedSession(session: EmbeddedTerminalSession) {
    const renameWorkspace = workspace;
    const nextTitle = await requestText({ title: "Rename pane", initialValue: session.title, confirmLabel: "Rename" });
    if (!nextTitle || nextTitle === session.title) return;
    const { renames, active } = renamesFor(renameWorkspace);
    const nextRenames = { ...renames, [embeddedSessionKey(session)]: nextTitle };
    if (active) setSessionRenames(nextRenames);
    writeRenamedSessions(renameWorkspace, nextRenames);
    setEmbeddedSessions((current) => current.map((item) => item.id === session.id ? { ...item, title: nextTitle } : item));
    await desktop.renameEmbeddedTerminal(session.id, nextTitle).catch(() => undefined);
  }

  async function renameAgentSession(session: AgentSession) {
    const renameWorkspace = session.workspace || workspace;
    const nextTitle = await requestText({ title: "Rename session", initialValue: session.title, confirmLabel: "Rename" });
    if (!nextTitle || nextTitle === session.title) return;
    const key = selectedAgentSessionKey(session);
    const { renames, active } = renamesFor(renameWorkspace);
    const nextRenames = { ...renames, [key]: nextTitle };
    if (active) setSessionRenames(nextRenames);
    writeRenamedSessions(renameWorkspace, nextRenames);
    setAgentSessionsByWorkspace((current) => {
      const renameKey = normalizeWorkspaceKey(renameWorkspace);
      return {
        ...current,
        [renameKey]: (current[renameKey] ?? []).map((item) => selectedAgentSessionKey(item) === key ? { ...item, title: nextTitle } : item),
      };
    });
  }

  const activeEmbeddedSessions = useMemo(
    () => embeddedSessions.filter((session) => sameWorkspacePath(session.workspace, workspace)),
    [embeddedSessions, workspace],
  );
  const notice = error ?? (!backend?.healthy ? backend?.lastError : null) ?? (!electronControl?.running ? electronControl?.lastError : null) ?? null;

  function showCommandRoom(view?: "terminals" | "sessions") {
    setActiveRoom("command");
    if (view) setCommandView(view);
  }

  function goToWorkspace(tab: WorkspacePath | undefined) {
    if (!tab) return;
    showCommandRoom();
    if (workspacePath && workspaceKey(workspacePath) === workspaceKey(tab)) return;
    activateWorkspace(tab);
  }

  function switchWorkspaceBy(offset: number) {
    if (workspaceTabs.length < 2) return;
    const index = workspacePath ? workspaceTabs.findIndex((tab) => workspaceKey(tab) === workspaceKey(workspacePath)) : -1;
    goToWorkspace(workspaceTabs[(index + offset + workspaceTabs.length) % workspaceTabs.length]);
  }

  function openSettings(section?: SettingsSection) {
    if (section) setSettingsSection(section);
    setActiveRoom("settings");
  }

  function applyTheme(theme: ThemePreference) {
    setUiTheme(theme);
    toasts.show(`Theme: ${themeLabel(theme)}`);
  }

  function nudgeTerminalFontSize(delta: number) {
    const fontSize = delta === 0 ? defaultTerminalAppearance.fontSize : terminalAppearance.fontSize + delta;
    setTerminalAppearance({ ...terminalAppearance, fontSize });
    toasts.show(`Terminal text: ${clampTerminalFontSize(fontSize)}px`);
  }

  // Settings unmounts the remote room. Consume its next action only after the
  // selected machine's room has mounted, and never replay it on another host.
  useEffect(() => {
    const pending = pendingRemoteAction.current;
    if (!pending) return;
    if (pending.machineId !== activeMachine?.id) {
      pendingRemoteAction.current = null;
      return;
    }
    if (activeRoom !== "command" || !remoteRoomRef.current) return;
    pendingRemoteAction.current = null;
    pending.run(remoteRoomRef.current);
  }, [activeRoom, activeMachine?.id]);

  function runInRemoteRoom(run: (room: RemoteMachineRoomHandle) => void) {
    if (!activeMachine) return;
    showCommandRoom("terminals");
    if (remoteRoomRef.current) run(remoteRoomRef.current);
    else pendingRemoteAction.current = { machineId: activeMachine.id, run };
  }

  // Launches go to whichever machine the Command Room is showing.
  function launchInActiveMachine(kind: EmbeddedTerminalKind, count: number) {
    if (activeMachine) runInRemoteRoom((room) => room.launch(kind, count));
    else void launchEmbedded(kind, count);
  }

  function selectMachine(machineId: string | null) {
    setActiveMachineId(machineId);
    setActiveRoom("command");
  }

  const machineEntries = switcherEntries(remoteSnapshot, activeMachine ? activeMachineId : null);
  const attentionByMachine: Record<string, WorkspaceAttentionKind> = {};
  for (const [key, value] of Object.entries(remoteAttention)) {
    const machineId = remoteMachineIdOf(key);
    if (machineId && attentionByMachine[machineId] !== "action") attentionByMachine[machineId] = value.kind;
  }
  const machineSwitcher = machineEntries.length ? (
    <MachineSwitcher
      entries={machineEntries}
      activeMachineId={activeMachine ? activeMachineId : null}
      localName={remoteSnapshot?.selfName ?? "This machine"}
      localRunning={embeddedSessions.filter((session) => session.status === "running").length}
      attentionByMachine={attentionByMachine}
      onSelect={selectMachine}
      onManage={() => openSettings("system")}
    />
  ) : null;

  const shortcutHandlers: Partial<Record<ShortcutId, () => void>> = {};
  if (!promptRequest && !confirmRequest && !installPrompt) {
    shortcutHandlers.palette = () => (palette.open ? closePalette() : openPalette());
    if (!palette.open) {
      shortcutHandlers.settings = () => (activeRoom === "settings" ? showCommandRoom() : openSettings());
      shortcutHandlers.newShell = () => {
        showCommandRoom("terminals");
        launchInActiveMachine("shell", 1);
      };
      shortcutHandlers.launchAgent = () => openPalette("launch ");
      if (activeMachine) shortcutHandlers.toggleSessions = () => runInRemoteRoom((room) => room.toggleSessions());
      shortcutHandlers.toggleInterfaceMode = () => {
        const next = interfaceMode === "chat" ? "terminal" : "chat";
        setInterfaceMode(next);
        toasts.show(next === "chat" ? "Chat view" : "Terminal view");
      };
      if (!activeMachine) {
        shortcutHandlers.toggleSessions = () =>
          showCommandRoom(activeRoom !== "command" || commandView === "terminals" ? "sessions" : "terminals");
      }
      shortcutHandlers.nextWorkspace = () => (activeMachine ? runInRemoteRoom((room) => room.switchWorkspaceBy(1)) : switchWorkspaceBy(1));
      shortcutHandlers.previousWorkspace = () => (activeMachine ? runInRemoteRoom((room) => room.switchWorkspaceBy(-1)) : switchWorkspaceBy(-1));
      for (let position = 1; position <= 9; position += 1) {
        shortcutHandlers[`workspace${position}` as ShortcutId] = () => (activeMachine
          ? runInRemoteRoom((room) => room.goToWorkspace(position - 1))
          : goToWorkspace(workspaceTabs[position - 1]));
      }
    }
  }
  useGlobalShortcuts(shortcutHandlers);

  function buildPaletteCommands(): PaletteCommand[] {
    const commands: PaletteCommand[] = [];
    const launchTarget = activeMachine ? activeRemoteWorkspace : workspace;
    const workspaceGate = launchTarget
      ? {}
      : { disabled: true, disabledReason: activeMachine ? `Open a folder on ${activeMachine.name} first` : "Open a workspace first" };
    const launch = (kind: EmbeddedTerminalKind, count: number) => () => {
      showCommandRoom("terminals");
      launchInActiveMachine(kind, count);
    };
    if (machineEntries.length) {
      commands.push({
        id: "machine:local",
        group: "Machines",
        title: `Show this machine${remoteSnapshot?.selfName ? ` (${remoteSnapshot.selfName})` : ""}`,
        subtitle: activeMachine ? undefined : "Current",
        icon: <Monitor size={15} />,
        keywords: ["machine", "computer", "local", "switch"],
        run: () => selectMachine(null),
      });
      for (const entry of machineEntries) {
        commands.push({
          id: `machine:${entry.id}`,
          group: "Machines",
          title: `Show ${entry.name}`,
          subtitle: entry.id === activeMachineId && activeMachine ? `Current · ${entry.state}` : entry.state,
          icon: <Monitor size={15} />,
          keywords: ["machine", "computer", "remote", "switch", "tailscale"],
          ...(entry.available ? {} : { disabled: true, disabledReason: entry.state }),
          run: () => selectMachine(entry.id),
        });
      }
      if (activeMachine) {
        commands.push({
          id: "machine:open-folder",
          group: "Machines",
          title: `Open a folder on ${activeMachine.name}…`,
          icon: <FolderOpen size={15} />,
          keywords: ["workspace", "project", "remote", "folder"],
          run: () => runInRemoteRoom((room) => room.openFolder()),
        });
      }
    }

    commands.push({
      id: "launch:shell",
      group: "Launch",
      title: "New shell",
      icon: <AgentGlyph kind="shell" size="small" />,
      keys: shortcutKeysFor("newShell"),
      keywords: ["launch", "terminal", "console", "pty"],
      ...workspaceGate,
      run: launch("shell", 1),
    });
    for (const agent of launchableAgents) {
      const missing = !activeMachine && missingAgents.has(agent.kind);
      commands.push({
        id: `launch:${agent.kind}`,
        group: "Launch",
        title: `Launch ${agent.label}`,
        subtitle: missing ? "Not installed: Athena will offer to install it" : undefined,
        icon: <AgentGlyph kind={agent.kind} size="small" />,
        keywords: ["new", "agent", "start", agent.kind],
        ...workspaceGate,
        run: launch(agent.kind, 1),
      });
      if (agent.grid) {
        commands.push({
          id: `launch:${agent.kind}:grid`,
          group: "Launch",
          title: `Launch ${agent.label} grid`,
          subtitle: "Four panes side by side",
          icon: <AgentGlyph kind={agent.kind} size="small" />,
          keywords: ["new", "agent", "four", "4", "parallel", agent.kind],
          ...workspaceGate,
          run: launch(agent.kind, 4),
        });
      }
    }

    const paletteTabs = activeMachine ? remoteWorkspaceTabs(activeMachine) : workspaceTabs;
    const paletteWorkspace = activeMachine ? activeRemoteWorkspace : workspace;
    paletteTabs.forEach((tab, index) => {
      const current = Boolean(paletteWorkspace && sameWorkspacePath(paletteWorkspace, tab.nativePath));
      commands.push({
        id: `workspace:${activeMachine ? `${activeMachine.id}:` : ""}${workspaceKey(tab)}`,
        group: "Workspaces",
        title: `Switch to ${workspaceDisplayName(tab)}`,
        subtitle: [current ? "Current" : null, activeMachine?.name, tab.nativePath].filter(Boolean).join(" · "),
        icon: <FolderOpen size={15} />,
        keys: index < 9 ? shortcutKeysFor(`workspace${index + 1}` as ShortcutId) : undefined,
        keywords: ["workspace", "project", "folder", "tab"],
        run: () => activeMachine ? runInRemoteRoom((room) => room.selectWorkspace(tab.nativePath)) : goToWorkspace(tab),
      });
    });
    if (activeMachine) {
      commands.push({
        id: "workspace:add", group: "Workspaces", title: "Add a workspace folder…",
        subtitle: `On ${activeMachine.name}`, icon: <FolderOpen size={15} />, keywords: ["open", "project"],
        run: () => runInRemoteRoom((room) => room.openFolder()),
      });
      if (activeRemoteWorkspace) {
        const current = activeRemoteWorkspace;
        commands.push({
          id: "workspace:close", group: "Workspaces", title: "Close this workspace",
          subtitle: `Stops its terminals on ${activeMachine.name}`, icon: <XCircle size={15} />,
          run: () => runInRemoteRoom((room) => room.closeWorkspace(current)),
        });
      }
    } else {
      commands.push(
        { id: "workspace:add", group: "Workspaces", title: "Add a workspace folder…", icon: <FolderOpen size={15} />, keywords: ["open", "project"], run: () => void selectWorkspace() },
        { id: "workspace:create", group: "Workspaces", title: "Create a new workspace folder…", icon: <FolderPlus size={15} />, keywords: ["new", "mkdir", "project"], run: () => void createWorkspace() },
      );
      if (workspacePath) {
        const current = workspacePath;
        commands.push(
          { id: "workspace:rename", group: "Workspaces", title: "Rename this workspace…", icon: <Pencil size={15} />, run: () => void renameWorkspaceTab(current) },
          { id: "workspace:reveal", group: "Workspaces", title: "Open this workspace in the file manager", icon: <FolderOpen size={15} />, keywords: ["explorer", "finder", "files"], run: () => void openWorkspaceInFiles(current) },
        );
        if (workspaceTabs.length > 1) {
          commands.push({ id: "workspace:close", group: "Workspaces", title: "Close this workspace", subtitle: "Stops its terminals", icon: <XCircle size={15} />, run: () => void requestCloseWorkspaceTab(current) });
        }
      }
    }

    const paletteSessions = activeMachine ? sessionsInWorkspace(activeMachine.sessions, activeRemoteWorkspace ?? "") : activeEmbeddedSessions;
    for (const session of paletteSessions) {
      commands.push({
        id: `pane:${session.id}`,
        group: "Panes",
        title: `Go to ${session.title}`,
        subtitle: session.status === "running"
          ? `${session.kind === "shell" ? "Shell" : providerLabel(session.kind)} · running`
          : `Exited${session.exitCode == null ? "" : ` (code ${session.exitCode})`}`,
        icon: <AgentGlyph kind={session.kind} size="small" />,
        keywords: ["pane", "terminal", "focus", session.kind],
        run: () => {
          showCommandRoom("terminals");
          if (activeMachine) runInRemoteRoom((room) => room.revealPane(session.workspace, session.id));
          else setRevealPaneRequest({ id: session.id, nonce: Date.now() });
        },
      });
    }

    for (const session of (activeMachine ? [] : agentSessions).filter((item) => item.resumeCommand).slice(0, 30)) {
      commands.push({
        id: `resume:${session.provider}:${session.id}`,
        group: "Sessions",
        title: `Resume ${session.title}`,
        subtitle: `${providerLabel(session.provider)} · ${formatSessionTime(session.updatedAt)}`,
        icon: <AgentGlyph kind={session.provider} size="small" />,
        keywords: ["resume", "history", "continue", session.provider, session.id],
        ...workspaceGate,
        run: () => void resumeAgentSession(session),
      });
    }

    commands.push(
      { id: "view:terminals", group: "View", title: "Show terminals", icon: <TerminalSquare size={15} />, run: () => activeMachine ? runInRemoteRoom((room) => room.showView("terminals")) : showCommandRoom("terminals") },
      { id: "view:settings", group: "View", title: "Open Settings", icon: <SettingsIcon size={15} />, keys: shortcutKeysFor("settings"), keywords: ["preferences", "options"], run: () => openSettings() },
      { id: "view:sessions", group: "View", title: "Show session history", icon: <Code2 size={15} />, keys: shortcutKeysFor("toggleSessions"), keywords: ["resume", "native", "history"], run: () => activeMachine ? runInRemoteRoom((room) => room.showView("sessions")) : showCommandRoom("sessions") },
    );
    commands.push(
      {
        id: "view:mode",
        group: "View",
        title: interfaceMode === "chat" ? "Use terminal view for agent panes" : "Use chat view for agent panes",
        icon: interfaceMode === "chat" ? <TerminalSquare size={15} /> : <MessageSquare size={15} />,
        keys: shortcutKeysFor("toggleInterfaceMode"),
        keywords: ["chat", "terminal", "interface", "mode"],
        run: () => setInterfaceMode(interfaceMode === "chat" ? "terminal" : "chat"),
      },
    );

    for (const option of ["system", ...themes.map((theme) => theme.id)] as ThemePreference[]) {
      const definition = option === "system" ? null : themes.find((theme) => theme.id === option);
      commands.push({
        id: `theme:${option}`,
        group: "Appearance",
        title: `Theme: ${themeLabel(option)}`,
        subtitle: option === uiTheme
          ? "Current theme"
          : option === "system"
            ? `Follows your OS appearance (now ${themeLabel(resolveTheme("system", prefersLight))})`
            : definition?.description,
        icon: <Palette size={15} />,
        keywords: ["theme", "color", "appearance", "colour", definition?.appearance ?? "auto"],
        preview: () => setPreviewTheme(resolveTheme(option, prefersLight)),
        run: () => applyTheme(option),
      });
    }
    commands.push({
      id: "theme:next",
      group: "Appearance",
      title: "Next theme",
      icon: <Palette size={15} />,
      keywords: ["cycle", "theme"],
      run: () => applyTheme(nextTheme(resolvedTheme)),
    });
    for (const option of ["compact", "default", "comfortable"] as Density[]) {
      commands.push({
        id: `density:${option}`,
        group: "Appearance",
        title: `Density: ${option[0].toUpperCase()}${option.slice(1)}`,
        subtitle: option === density ? "Current density" : undefined,
        icon: <Rows3 size={15} />,
        keywords: ["spacing", "size", "density"],
        run: () => setDensity(option),
      });
    }
    commands.push(
      { id: "terminal:bigger", group: "Appearance", title: "Terminal text: larger", subtitle: `Now ${terminalAppearance.fontSize}px`, icon: <Type size={15} />, keywords: ["font", "zoom", "size", "increase"], run: () => nudgeTerminalFontSize(1) },
      { id: "terminal:smaller", group: "Appearance", title: "Terminal text: smaller", subtitle: `Now ${terminalAppearance.fontSize}px`, icon: <Type size={15} />, keywords: ["font", "zoom", "size", "decrease"], run: () => nudgeTerminalFontSize(-1) },
      { id: "terminal:reset", group: "Appearance", title: "Terminal text: reset size", subtitle: `${defaultTerminalAppearance.fontSize}px`, icon: <Type size={15} />, keywords: ["font", "zoom", "size", "default"], run: () => nudgeTerminalFontSize(0) },
    );

    commands.push({
      id: "notifications:toggle",
      group: "Settings",
      title: notificationPreferences.level === "off" ? "Turn agent alerts on" : "Mute agent alerts",
      icon: <Bell size={15} />,
      keywords: ["notifications", "sound", "alerts", "quiet"],
      run: () => setNotificationPreferences({ ...notificationPreferences, level: notificationPreferences.level === "off" ? "all" : "off" }),
    });
    for (const section of settingsSections) {
      commands.push({
        id: `settings:${section.id}`,
        group: "Settings",
        title: `Settings: ${section.label}`,
        subtitle: section.description,
        icon: section.id === "shortcuts" ? <Keyboard size={15} /> : <SettingsIcon size={15} />,
        keywords: ["preferences", "options", section.id],
        run: () => openSettings(section.id),
      });
    }
    commands.push(
      { id: "system:restart-backend", group: "System", title: "Restart the backend", icon: <RefreshCw size={15} />, keywords: ["fastapi", "server", "python"], run: () => void restartBackend() },
      { id: "system:restart-control", group: "System", title: "Restart Electron control", icon: <RefreshCw size={15} />, keywords: ["mcp", "hermes", "control"], run: () => void restartElectronControl() },
    );
    return commands;
  }

  return (
    <div className="appFrame">
      <AppTitleBar
        activeRoom={activeRoom}
        status={titleStatusView(backend, electronControl, backendStalled)}
        usage={<UsageMeters client={client} />}
        paletteKeys={shortcutKeysFor("palette")}
        onNavigate={setActiveRoom}
        onOpenPalette={() => openPalette()}
      />
      {/* The Command Room fills the window edge to edge; Settings keeps the padded surface. */}
      <main className={activeRoom === "command" ? "workspaceSurface commandSurface" : "workspaceSurface"}>
        <section className="dashboardShell">
          <section className="dashboardGrid">
            <div className="commandColumn">
              {notice && (
                <div className="noticeBar" role="status">
                  <AlertTriangle size={15} />
                  <span>{notice}</span>
                  {error && (
                    <button type="button" className="noticeDismiss" onClick={() => setError(null)} aria-label="Dismiss message">
                      <X size={14} />
                    </button>
                  )}
                </div>
              )}
              {!activeMachine && <WorkspaceTabs
                leading={machineSwitcher}
                workspaces={workspaceTabs}
                activeWorkspace={workspacePath}
                terminalSessions={embeddedSessions}
                attentionByWorkspace={workspaceAttention}
                onSelect={activateWorkspace}
                onClose={(tab) => void requestCloseWorkspaceTab(tab)}
                onAdd={selectWorkspace}
                onCreate={createWorkspace}
                onRename={(tab) => void renameWorkspaceTab(tab)}
                onOpenInFiles={(tab) => void openWorkspaceInFiles(tab)}
              />}

              {activeRoom === "command" && activeMachine && (
                <RemoteMachineRoom
                  ref={remoteRoomRef}
                  key={activeMachine.id}
                  machine={activeMachine}
                  interfaceMode={interfaceMode}
                  onInterfaceModeChange={setInterfaceMode}
                  switcher={machineSwitcher}
                  attentionByWorkspace={machineWorkspaceAttention(remoteAttention, activeMachine.id)}
                  revealRequest={remoteReveal?.machineId === activeMachine.id ? remoteReveal : null}
                  onRevealHandled={() => setRemoteReveal(null)}
                  onActiveWorkspaceChange={setActiveRemoteWorkspace}
                  onToast={(message) => toasts.show(message)}
                  onError={(message) => setError(message)}
                  requestText={requestText}
                  requestConfirm={requestConfirm}
                  emptyMark={<AthenaMark />}
                />
              )}
              {/* Kept mounted while another machine is shown, so this machine's layout survives the switch. */}
              {activeRoom === "command" && (
                <div className="machineView" hidden={Boolean(activeMachine)}>
                <CommandRoom
                  workspace={workspace}
                  sessions={activeEmbeddedSessions}
                  sessionHistoryActive={!activeMachine}
                  agentSessions={agentSessions}
                  busy={busy}
                  layoutResetNonce={layoutResetNonce}
                  interfaceMode={interfaceMode}
                  view={commandView}
                  onViewChange={setCommandView}
                  revealPaneRequest={revealPaneRequest}
                  onRevealPaneHandled={() => setRevealPaneRequest(null)}
                  onInterfaceModeChange={setInterfaceMode}
                  onToast={(message) => toasts.show(message)}
                  onAddWorkspace={() => void selectWorkspace()}
                  onLaunch={launchEmbedded}
                  onClose={closeEmbeddedTerminal}
                  onResumeSession={resumeAgentSession}
                  onRenameEmbeddedSession={(session) => void renameEmbeddedSession(session)}
                  onRenameAgentSession={(session) => void renameAgentSession(session)}
                  onRefreshAgentSessions={refreshAgentSessions}
                  missingAgents={missingAgents}
                  emptyMark={<AthenaMark />}
                />
                </div>
              )}
              {activeRoom === "settings" && (
                <Suspense fallback={<section className="roomPanel" aria-busy="true" />}>
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
                    resolvedTheme={resolvedTheme}
                    density={density}
                    terminalAppearance={terminalAppearance}
                    section={settingsSection}
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
                    onDensityChange={setDensity}
                    onTerminalAppearanceChange={setTerminalAppearance}
                    onSectionChange={setSettingsSection}
                    onGraphicsPreferenceChange={updateGraphicsPreference}
                    notificationPreferences={notificationPreferences}
                    onNotificationPreferencesChange={setNotificationPreferences}
                    onPreviewAttentionSound={previewAttentionSound}
                  />
                </Suspense>
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
      {confirmRequest && (
        <ConfirmDialog request={confirmRequest} onConfirm={() => closeConfirm(true)} onCancel={() => closeConfirm(false)} />
      )}
      {promptRequest && (
        <PromptDialog request={promptRequest} onSubmit={(value) => closePrompt(value)} onCancel={() => closePrompt(null)} />
      )}
      {palette.open && (
        <CommandPalette
          open
          commands={buildPaletteCommands()}
          initialQuery={palette.query}
          placeholder="Launch an agent, switch workspace, change theme…"
          onClose={closePalette}
          onPreviewReset={() => setPreviewTheme(null)}
        />
      )}
      <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </div>
  );
}

type TitleStatus = { tone: "ready" | "starting" | "degraded" | "offline"; label: string; detail: string };

// Built on the same status mapping Settings uses, so the two never disagree.
function titleStatusView(backend: BackendStatus | null, control: ElectronControlStatus | null, backendStalled: boolean): TitleStatus {
  const backendView = backendStatusView(backend);
  if (!backend || (backendView.tone === "warn" && !backendStalled)) {
    return { tone: "starting", label: "Starting…", detail: "The Athena backend is starting up." };
  }
  if (backendView.tone !== "ok") {
    return {
      tone: "offline",
      label: backend.running ? "Backend not responding" : "Backend offline",
      detail: backend.lastError ?? (backend.running
        ? "The Athena backend is running but not answering health checks. Restart it from Settings > System."
        : "The Athena backend is not running. Restart it from Settings > System."),
    };
  }
  const controlView = electronControlStatusView(control);
  if (controlView.tone !== "ok") {
    return {
      tone: "degraded",
      label: `Control ${controlView.label.toLowerCase()}`,
      detail: control?.lastError ?? "Electron control is not running, so Hermes cannot drive this window.",
    };
  }
  return { tone: "ready", label: "Ready", detail: "Backend and Electron control are healthy." };
}

function AppTitleBar({
  activeRoom,
  status,
  usage,
  paletteKeys,
  onNavigate,
  onOpenPalette,
}: {
  activeRoom: ActiveRoom;
  status: TitleStatus;
  usage?: ReactNode;
  paletteKeys: string[];
  onNavigate: (room: ActiveRoom) => void;
  onOpenPalette: () => void;
}) {
  const mac = isMacPlatform();
  const controls = mac ? (
    <div className="windowControls mac" aria-label="Window controls">
      <button type="button" className="windowDot close" aria-label="Close window" onClick={() => void desktop.closeWindow()}>
        <X size={8} strokeWidth={3} />
      </button>
      <button type="button" className="windowDot minimize" aria-label="Minimize window" onClick={() => void desktop.minimizeWindow()}>
        <Minus size={8} strokeWidth={3} />
      </button>
      <button type="button" className="windowDot maximize" aria-label="Maximize window" onClick={() => void desktop.toggleMaximizeWindow()}>
        <Square size={7} strokeWidth={3} />
      </button>
    </div>
  ) : (
    <div className="windowControls caption" aria-label="Window controls">
      <button type="button" aria-label="Minimize window" title="Minimize" onClick={() => void desktop.minimizeWindow()}>
        <Minus size={15} strokeWidth={1.5} />
      </button>
      <button type="button" aria-label="Maximize window" title="Maximize" onClick={() => void desktop.toggleMaximizeWindow()}>
        <Square size={12} strokeWidth={1.5} />
      </button>
      <button type="button" className="close" aria-label="Close window" title="Close" onClick={() => void desktop.closeWindow()}>
        <X size={16} strokeWidth={1.5} />
      </button>
    </div>
  );

  return (
    <header className="appTitleBar">
      <div className="titleStart">
        {mac && controls}
        <div className="titleBrand">
          <span className="titleMark" aria-hidden="true"><img src={athenaMarkUrl} alt="" /></span>
          <strong>ATHENA</strong>
        </div>
      </div>
      <div className="titleCenter">
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
        <button type="button" className="titleCommand" onClick={onOpenPalette} title="Command palette" aria-label="Open the command palette">
          <Command size={13} />
          <span className="titleCommandLabel">Search commands</span>
          <span className="kbdGroup">{paletteKeys.map((key) => <kbd key={key} className="kbd">{key}</kbd>)}</span>
        </button>
      </div>
      <div className="titleEnd">
        {usage}
        <div className={`titleStatus ${status.tone}`} title={status.detail} role="status">
          <i aria-hidden="true" />
          {status.label}
        </div>
        {!mac && controls}
      </div>
    </header>
  );
}
