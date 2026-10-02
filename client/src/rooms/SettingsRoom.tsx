import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Activity,
  Bell,
  BellOff,
  Bot,
  Check,
  Copy,
  Download,
  FolderOpen,
  Globe,
  Keyboard,
  MessageSquare,
  Minus,
  Palette,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  TerminalSquare,
  Volume2,
} from "lucide-react";
import "./settings.css";
import type { AdapterStatus, BackendStatus, ElectronControlStatus, HermesStatus } from "../api";
import { AgentGlyph } from "../components/AgentGlyph";
import { adapterInstallStatusView, backendStatusView, electronControlStatusView, hermesStatusView, StatusPill, type StatusTone } from "../components/status";
import { ThemePreviewCard } from "../components/ThemePreviewCard";
import type {
  AgentCliKind,
  AgentCliReport,
  AgentSetupAction,
  AthenaLaunchState,
  GraphicsPreference,
  GraphicsRuntimeStatus,
  PerformanceDiagnostics,
} from "../electron";
import { desktop, type RemoteAccessState, type RemoteMachinesState } from "../electron";
import {
  machineDetail,
  machinesSummary,
  machineStatusView,
  parseRemotePortInput,
  preferredRemoteUrl,
  remoteAccessCurlExample,
  remoteAccessStatusView,
  remoteActivitySummary,
  trustOwnDevicesHelp,
} from "../remote-access-view";
import { settingsSections, type SettingsSection } from "../settings-sections";
import { shortcutReference } from "../shortcuts";
import {
  defaultTerminalAppearance,
  maxTerminalFontSize,
  minTerminalFontSize,
  terminalFontFamily,
  terminalFonts,
  type TerminalAppearance,
} from "../terminal-appearance";
import { systemThemes, themeDefinition, themes, type ThemeId, type ThemePreference } from "../themes";
import type { Density } from "../ui-preferences";
import type {
  AttentionSoundStyle,
  NotificationLevel,
  NotificationPreferences,
  WorkspaceAttentionKind,
} from "../workspace-attention";

export type { SettingsSection } from "../settings-sections";

const sectionIcons: Record<SettingsSection, ReactNode> = {
  appearance: <Palette size={15} />,
  workspace: <FolderOpen size={15} />,
  notifications: <Bell size={15} />,
  agents: <Bot size={15} />,
  system: <Server size={15} />,
  diagnostics: <Activity size={15} />,
  shortcuts: <Keyboard size={15} />,
};

const densityOptions: Array<{ id: Density; label: string }> = [
  { id: "compact", label: "Compact" },
  { id: "default", label: "Default" },
  { id: "comfortable", label: "Comfortable" },
];

const notificationLevelOptions: Array<{ id: NotificationLevel; label: string }> = [
  { id: "all", label: "Needs input + finished" },
  { id: "action", label: "Needs input only" },
  { id: "off", label: "Off" },
];

const soundOptions: Array<{ id: AttentionSoundStyle; label: string }> = [
  { id: "chime", label: "Chime" },
  { id: "soft", label: "Soft" },
  { id: "digital", label: "Digital" },
  { id: "none", label: "Silent" },
];

const HERMES_BRIDGE_SNIPPET = `mcp_servers:
  context_workspace:
    command: "python"
    args:
      - "/path/to/context-workspace/mcp_server/server.py"
    timeout: 120
    connect_timeout: 30
    env:
      CONTEXT_WORKSPACE_BACKEND_STATE: "~/.context-workspace/backend.json"`;

// "Match system" first, then every theme in registry order.
const themeChoices: ThemePreference[] = ["system", ...themes.map((theme) => theme.id)];

function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard?.writeText(text) ?? Promise.resolve();
}

function worseTone(a: StatusTone, b: StatusTone): StatusTone {
  if (a === "bad" || b === "bad") return "bad";
  if (a === "warn" || b === "warn") return "warn";
  return "ok";
}

export function SettingsRoom({
  workspace,
  backend,
  electronControl,
  hermes,
  adapters,
  busy,
  installingHermes,
  interfaceMode,
  uiTheme,
  resolvedTheme,
  performance,
  launchState,
  graphics,
  onSelectWorkspace,
  onRestartBackend,
  onRestartControl,
  onClearTerminalRestorePause,
  onInstallHermes,
  agentClis,
  canRunSetup,
  onAgentSetup,
  onRefreshDiagnostics,
  onInterfaceModeChange,
  onThemeChange,
  onGraphicsPreferenceChange,
  notificationPreferences,
  onNotificationPreferencesChange,
  onPreviewAttentionSound,
  density,
  onDensityChange,
  terminalAppearance,
  onTerminalAppearanceChange,
  section,
  onSectionChange,
}: {
  workspace: string;
  backend: BackendStatus | null;
  electronControl: ElectronControlStatus | null;
  hermes: HermesStatus | null;
  adapters: Record<string, AdapterStatus>;
  busy: boolean;
  installingHermes: boolean;
  interfaceMode: "terminal" | "chat";
  uiTheme: ThemePreference;
  // what "system" currently resolves to
  resolvedTheme: ThemeId;
  performance: PerformanceDiagnostics | null;
  launchState: AthenaLaunchState | null;
  graphics: GraphicsRuntimeStatus | null;
  onSelectWorkspace: () => Promise<void>;
  onRestartBackend: () => Promise<void>;
  onRestartControl: () => Promise<void>;
  onClearTerminalRestorePause: () => Promise<void>;
  onInstallHermes: () => Promise<void>;
  // agent CLIs as the terminals find them (null until loaded, or in the browser preview)
  agentClis: AgentCliReport | null;
  // installs and updates run in a terminal of the open workspace
  canRunSetup: boolean;
  onAgentSetup: (kind: AgentCliKind, action: AgentSetupAction) => void;
  onRefreshDiagnostics: () => Promise<void>;
  onInterfaceModeChange: (mode: "terminal" | "chat") => void;
  onThemeChange: (theme: ThemePreference) => void;
  onGraphicsPreferenceChange: (preference: GraphicsPreference) => void;
  notificationPreferences: NotificationPreferences;
  onNotificationPreferencesChange: (preferences: NotificationPreferences) => void;
  onPreviewAttentionSound: (kind: WorkspaceAttentionKind) => void;
  density: Density;
  onDensityChange: (density: Density) => void;
  terminalAppearance: TerminalAppearance;
  onTerminalAppearanceChange: (next: TerminalAppearance) => void;
  // controlled so the command palette can deep-link into a section
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const backendStatus = backendStatusView(backend);
  const electronControlStatus = electronControlStatusView(electronControl);
  const systemTone = worseTone(backendStatus.tone, electronControlStatus.tone);
  const agentsMissing = Boolean(agentClis?.agents.some((agent) => !agent.installed));
  const activeSection = settingsSections.find((item) => item.id === section) ?? settingsSections[0];

  // A new section starts at its top, not wherever the last one was scrolled to.
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [section]);

  function navDot(id: SettingsSection): ReactNode {
    if (id === "system" && systemTone !== "ok") {
      return <span className={`settingsNavDot ${systemTone}`} title={systemTone === "bad" ? "A service is offline" : "A service is starting"} />;
    }
    if (id === "agents" && agentsMissing) {
      return <span className="settingsNavDot warn" title="Some agent CLIs are not installed" />;
    }
    return null;
  }

  return (
    <section className="roomPanel settingsRoom">
      <nav className="settingsNav" aria-label="Settings sections">
        <div className="settingsNavTitle">
          <span className="eyebrow">Athena</span>
          <strong>Settings</strong>
        </div>
        <ul>
          {settingsSections.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={item.id === activeSection.id ? "active" : ""}
                aria-current={item.id === activeSection.id ? "page" : undefined}
                onClick={() => onSectionChange(item.id)}
              >
                {sectionIcons[item.id]}
                <span>{item.label}</span>
                {navDot(item.id)}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="settingsContent" ref={contentRef}>
        <div className="settingsContentInner">
          <header className="settingsSectionHeader">
            <h2>{activeSection.label}</h2>
            <p>{activeSection.description}</p>
          </header>

          {activeSection.id === "appearance" && (
            <AppearanceSection
              uiTheme={uiTheme}
              resolvedTheme={resolvedTheme}
              density={density}
              interfaceMode={interfaceMode}
              terminalAppearance={terminalAppearance}
              onThemeChange={onThemeChange}
              onDensityChange={onDensityChange}
              onInterfaceModeChange={onInterfaceModeChange}
              onTerminalAppearanceChange={onTerminalAppearanceChange}
            />
          )}

          {activeSection.id === "workspace" && (
            <>
              <SettingsGroup title="Project">
                <SettingsRow
                  label="Current workspace"
                  help={workspace ? <code className="settingsPath">{workspace}</code> : "No workspace selected. Agents and shells start in this folder."}
                >
                  <button className="ghostButton" type="button" onClick={() => void onSelectWorkspace()}>
                    <FolderOpen size={14} /> Change
                  </button>
                </SettingsRow>
              </SettingsGroup>
              <SettingsGroup title="Terminal restore">
                <SettingsRow
                  label="Restore terminals on launch"
                  help={launchState?.terminalRestorePaused
                    ? `Paused after the previous launch did not exit cleanly${launchState.previousCrashAt ? ` (${launchState.previousCrashAt})` : ""}. Enabling starts fresh.`
                    : "Saved terminals come back when a workspace is opened or selected."}
                >
                  <div className="settingsControlCluster">
                    <StatusPill tone={launchState?.terminalRestorePaused ? "warn" : "ok"}>
                      {launchState?.terminalRestorePaused ? "Paused" : "Enabled"}
                    </StatusPill>
                    {launchState?.terminalRestorePaused && (
                      <button className="ghostButton" type="button" onClick={() => void onClearTerminalRestorePause()} disabled={busy}>
                        <RefreshCw size={14} /> Enable restore
                      </button>
                    )}
                  </div>
                </SettingsRow>
              </SettingsGroup>
            </>
          )}

          {activeSection.id === "notifications" && (
            <NotificationsSection
              preferences={notificationPreferences}
              onChange={onNotificationPreferencesChange}
              onPreview={onPreviewAttentionSound}
            />
          )}

          {activeSection.id === "agents" && (
            <AgentsSection
              adapters={adapters}
              agentClis={agentClis}
              busy={busy}
              canRunSetup={canRunSetup}
              hermes={hermes}
              installingHermes={installingHermes}
              onAgentSetup={onAgentSetup}
              onInstallHermes={onInstallHermes}
            />
          )}

          {activeSection.id === "system" && (
            <>
              <SettingsGroup title="Services">
                <SettingsRow
                  label="Backend"
                  help={backend?.baseUrl ? <code className="settingsPath">{backend.baseUrl}</code> : (backend?.lastError ?? "Not connected")}
                >
                  <div className="settingsControlCluster">
                    <StatusPill tone={backendStatus.tone}>{backendStatus.label}</StatusPill>
                    <button className="ghostButton" type="button" onClick={() => void onRestartBackend()} disabled={busy}>
                      <RefreshCw size={14} className={busy ? "spinning" : undefined} /> {busy ? "Restarting" : "Restart"}
                    </button>
                  </div>
                </SettingsRow>
                <SettingsRow
                  label="Electron control"
                  help={electronControl?.lastError ?? (electronControl?.baseUrl ? <code className="settingsPath">{electronControl.baseUrl}</code> : "Not connected")}
                >
                  <div className="settingsControlCluster">
                    <StatusPill tone={electronControlStatus.tone}>{electronControlStatus.label}</StatusPill>
                    <button className="ghostButton" type="button" onClick={() => void onRestartControl()} disabled={busy}>
                      <RefreshCw size={14} className={busy ? "spinning" : undefined} /> {busy ? "Restarting" : "Restart"}
                    </button>
                  </div>
                </SettingsRow>
              </SettingsGroup>
              <RemoteAccessGroup />
              <YourMachinesGroup />
              <SettingsGroup title="Graphics">
                <SettingsRow
                  label="Rendering mode"
                  help={graphics
                    ? `${graphics.mode === "accelerated" ? "Hardware acceleration is active." : "Crash-safe software mode is active."} ${graphics.reason}${graphics.restartRequired ? " Restart Athena to apply the selected mode." : ""}`
                    : "Graphics status unavailable."}
                >
                  <div className="segmentedControl" role="group" aria-label="Graphics mode">
                    {(["auto", "safe", "accelerated"] as GraphicsPreference[]).map((preference) => (
                      <button
                        key={preference}
                        type="button"
                        className={graphics?.preference === preference ? "active" : ""}
                        aria-pressed={graphics?.preference === preference}
                        onClick={() => onGraphicsPreferenceChange(preference)}
                        title={preference === "accelerated" ? "Retry acceleration and automatically quarantine it after a GPU-process crash" : undefined}
                      >
                        {preference === "safe" ? "Safe" : preference === "accelerated" ? "Accelerated" : "Auto"}
                      </button>
                    ))}
                  </div>
                </SettingsRow>
              </SettingsGroup>
            </>
          )}

          {activeSection.id === "diagnostics" && (
            <DiagnosticsSection performance={performance} onRefresh={onRefreshDiagnostics} />
          )}

          {activeSection.id === "shortcuts" && <ShortcutsSection />}
        </div>
      </div>
    </section>
  );
}

function SettingsGroup({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="settingsGroup">
      <div className="settingsGroupHead">
        <h3>{title}</h3>
        {actions}
      </div>
      <div className="settingsGroupBody">{children}</div>
    </section>
  );
}

function SettingsRow({
  label,
  help,
  children,
  wide = false,
  labelId,
}: {
  label: string;
  help?: ReactNode;
  children?: ReactNode;
  // control spans the full row under the label
  wide?: boolean;
  labelId?: string;
}) {
  return (
    <div className={wide ? "settingsRow wide" : "settingsRow"}>
      <div className="settingsRowLabel">
        <strong id={labelId}>{label}</strong>
        {help ? <span>{help}</span> : null}
      </div>
      {children ? <div className="settingsRowControl">{children}</div> : null}
    </div>
  );
}

function AppearanceSection({
  uiTheme,
  resolvedTheme,
  density,
  interfaceMode,
  terminalAppearance,
  onThemeChange,
  onDensityChange,
  onInterfaceModeChange,
  onTerminalAppearanceChange,
}: {
  uiTheme: ThemePreference;
  resolvedTheme: ThemeId;
  density: Density;
  interfaceMode: "terminal" | "chat";
  terminalAppearance: TerminalAppearance;
  onThemeChange: (theme: ThemePreference) => void;
  onDensityChange: (density: Density) => void;
  onInterfaceModeChange: (mode: "terminal" | "chat") => void;
  onTerminalAppearanceChange: (next: TerminalAppearance) => void;
}) {
  const cardRefs = useRef(new Map<ThemePreference, HTMLButtonElement>());

  // Radio-group keyboard model: arrows move the selection (and apply it).
  function handleThemeKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: ThemePreference) {
    const index = themeChoices.indexOf(current);
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % themeChoices.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + themeChoices.length) % themeChoices.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = themeChoices.length - 1;
    if (next == null) return;
    event.preventDefault();
    const choice = themeChoices[next];
    onThemeChange(choice);
    cardRefs.current.get(choice)?.focus();
  }

  function bindCard(choice: ThemePreference) {
    return (element: HTMLButtonElement | null) => {
      if (element) cardRefs.current.set(choice, element);
      else cardRefs.current.delete(choice);
    };
  }

  const fontSize = terminalAppearance.fontSize;
  const selectedTheme = uiTheme === "system" ? null : themeDefinition(uiTheme);

  return (
    <>
      <SettingsGroup
        title="Theme"
        actions={<span className="settingsGroupNote">{uiTheme === "system" ? `Following your system: ${themeDefinition(resolvedTheme).label}` : selectedTheme?.label}</span>}
      >
        <div className="themeGallery" role="radiogroup" aria-label="Theme">
          <ThemePreviewCard
            cardRef={bindCard("system")}
            label="Match system"
            description={`${themeDefinition(systemThemes.dark).label} in dark mode, ${themeDefinition(systemThemes.light).label} in light mode.`}
            appearance="auto"
            tag={uiTheme === "system" ? `Now ${themeDefinition(resolvedTheme).label}` : "Auto"}
            preview={systemThemes}
            selected={uiTheme === "system"}
            onSelect={() => onThemeChange("system")}
            onKeyDown={(event) => handleThemeKeyDown(event, "system")}
          />
          {themes.map((theme) => (
            <ThemePreviewCard
              key={theme.id}
              cardRef={bindCard(theme.id)}
              label={theme.label}
              description={theme.description}
              appearance={theme.appearance}
              preview={theme.id}
              selected={uiTheme === theme.id}
              onSelect={() => onThemeChange(theme.id)}
              onKeyDown={(event) => handleThemeKeyDown(event, theme.id)}
            />
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Layout">
        <SettingsRow label="Density" help="How much room controls, tabs, and panels get around them." labelId="settingsDensityLabel">
          <div className="segmentedControl" role="group" aria-labelledby="settingsDensityLabel">
            {densityOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={density === option.id ? "active" : ""}
                aria-pressed={density === option.id}
                onClick={() => onDensityChange(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow
          label="Interface mode"
          labelId="settingsInterfaceLabel"
          help={interfaceMode === "chat"
            ? "Agent panes show a chat view. The terminal process still runs underneath; open it from a pane for approvals and menus."
            : "Agent panes show the live embedded terminal."}
        >
          <div className="segmentedControl" role="group" aria-labelledby="settingsInterfaceLabel">
            <button type="button" className={interfaceMode === "terminal" ? "active" : ""} aria-pressed={interfaceMode === "terminal"} onClick={() => onInterfaceModeChange("terminal")}>
              <TerminalSquare size={14} /> Terminal
            </button>
            <button type="button" className={interfaceMode === "chat" ? "active" : ""} aria-pressed={interfaceMode === "chat"} onClick={() => onInterfaceModeChange("chat")}>
              <MessageSquare size={14} /> Chat
            </button>
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Terminal text">
        <SettingsRow label="Font" help="Used by every embedded terminal pane." wide labelId="settingsTerminalFontLabel">
          <div className="terminalFontOptions" role="radiogroup" aria-labelledby="settingsTerminalFontLabel">
            {terminalFonts.map((font) => {
              const selected = terminalAppearance.font === font.id;
              return (
                <button
                  key={font.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={selected ? "terminalFontOption selected" : "terminalFontOption"}
                  onClick={() => onTerminalAppearanceChange({ ...terminalAppearance, font: font.id })}
                >
                  <strong style={{ fontFamily: font.family }}>{font.label}</strong>
                  <small>{font.detail}</small>
                  {selected && <Check size={13} className="terminalFontCheck" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </SettingsRow>
        <SettingsRow label="Size" help={`${minTerminalFontSize}–${maxTerminalFontSize} px. Panes refit their columns and rows to the new size.`}>
          <div className="settingsControlCluster">
            <div className="settingsStepper" role="group" aria-label="Terminal font size">
              <button
                type="button"
                className="iconButton"
                aria-label="Smaller terminal text"
                disabled={fontSize <= minTerminalFontSize}
                onClick={() => onTerminalAppearanceChange({ ...terminalAppearance, fontSize: fontSize - 1 })}
              >
                <Minus size={14} />
              </button>
              <output aria-live="polite">{fontSize}<small>px</small></output>
              <button
                type="button"
                className="iconButton"
                aria-label="Larger terminal text"
                disabled={fontSize >= maxTerminalFontSize}
                onClick={() => onTerminalAppearanceChange({ ...terminalAppearance, fontSize: fontSize + 1 })}
              >
                <Plus size={14} />
              </button>
            </div>
            <button
              type="button"
              className="ghostButton quiet small"
              disabled={fontSize === defaultTerminalAppearance.fontSize}
              onClick={() => onTerminalAppearanceChange({ ...terminalAppearance, fontSize: defaultTerminalAppearance.fontSize })}
              title={`Reset to ${defaultTerminalAppearance.fontSize} px`}
            >
              <RotateCcw size={13} /> Reset
            </button>
          </div>
        </SettingsRow>
        <div
          className="terminalSample"
          aria-label="Terminal text preview"
          style={{ fontFamily: terminalFontFamily(terminalAppearance.font), fontSize: `${fontSize}px` }}
        >
          <div>
            <span className="ansiGreen">athena</span> <span className="ansiBlue">~/project</span>{" "}
            <span className="ansiYellow">(main)</span> <span className="ansiMuted">$</span> codex --resume
          </div>
          <div><span className="ansiMagenta">●</span> Reading src/App.tsx, src/styles.css</div>
          <div>
            <span className="ansiGreen">+ 42 insertions</span>  <span className="ansiRed">- 7 deletions</span>{" "}
            <span className="ansiMuted">0O il1| {"{}"} =&gt; != ===</span>
          </div>
        </div>
      </SettingsGroup>
    </>
  );
}

function NotificationsSection({
  preferences,
  onChange,
  onPreview,
}: {
  preferences: NotificationPreferences;
  onChange: (preferences: NotificationPreferences) => void;
  onPreview: (kind: WorkspaceAttentionKind) => void;
}) {
  const off = preferences.level === "off";
  return (
    <>
      <p className="settingsCallout">
        <Bell size={14} aria-hidden="true" />
        <span>{notificationDescription(preferences)}</span>
      </p>
      <SettingsGroup title="Alerts">
        <SettingsRow label="Alert me" help="Which agent events count as news." labelId="notificationLevelLabel">
          <div className="segmentedControl" role="group" aria-labelledby="notificationLevelLabel">
            {notificationLevelOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={preferences.level === option.id ? "active" : ""}
                aria-pressed={preferences.level === option.id}
                onClick={() => onChange({ ...preferences, level: option.id })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow label="Desktop notifications" help="Only while Athena is not the focused window." labelId="notificationDesktopLabel">
          <div className="segmentedControl" role="group" aria-labelledby="notificationDesktopLabel">
            <button
              type="button"
              className={preferences.desktop ? "active" : ""}
              aria-pressed={preferences.desktop}
              disabled={off}
              onClick={() => onChange({ ...preferences, desktop: true })}
            >
              <Bell size={14} /> In background
            </button>
            <button
              type="button"
              className={!preferences.desktop ? "active" : ""}
              aria-pressed={!preferences.desktop}
              disabled={off}
              onClick={() => onChange({ ...preferences, desktop: false })}
            >
              <BellOff size={14} /> Never
            </button>
          </div>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Sound">
        <SettingsRow label="Sound" help="Picking a sound plays it." labelId="notificationSoundLabel">
          <div className="segmentedControl" role="group" aria-labelledby="notificationSoundLabel">
            {soundOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={preferences.sound === option.id ? "active" : ""}
                aria-pressed={preferences.sound === option.id}
                disabled={off}
                onClick={() => onChange({ ...preferences, sound: option.id })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow label="Volume" help="Preview the two alert sounds at this volume.">
          <div className="notificationVolume">
            <input
              id="notificationVolume"
              type="range"
              min={0}
              max={100}
              step={5}
              aria-label="Alert volume"
              value={Math.round(preferences.volume * 100)}
              disabled={off || preferences.sound === "none"}
              onChange={(event) => onChange({ ...preferences, volume: Number(event.currentTarget.value) / 100 })}
            />
            <output htmlFor="notificationVolume">{Math.round(preferences.volume * 100)}%</output>
          </div>
        </SettingsRow>
        <SettingsRow label="Test" help="Needs input plays when an agent waits on you; Finished when it ends a turn.">
          <div className="settingsControlCluster">
            {(["action", "update"] as WorkspaceAttentionKind[]).map((kind) => (
              <button
                key={kind}
                className="ghostButton small"
                type="button"
                disabled={preferences.sound === "none" || preferences.volume === 0}
                title={kind === "action" ? "Play the sound for an agent waiting on you" : "Play the sound for an agent finishing"}
                onClick={() => onPreview(kind)}
              >
                <Volume2 size={13} /> {kind === "action" ? "Needs input" : "Finished"}
              </button>
            ))}
          </div>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function AgentsSection({
  adapters,
  agentClis,
  busy,
  canRunSetup,
  hermes,
  installingHermes,
  onAgentSetup,
  onInstallHermes,
}: {
  adapters: Record<string, AdapterStatus>;
  agentClis: AgentCliReport | null;
  busy: boolean;
  canRunSetup: boolean;
  hermes: HermesStatus | null;
  installingHermes: boolean;
  onAgentSetup: (kind: AgentCliKind, action: AgentSetupAction) => void;
  onInstallHermes: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1_600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const hermesStatus = hermesStatusView(hermes);
  const adapterList = Object.values(adapters);
  const adapterStatus = adapterInstallStatusView(adapterList);
  const adapterSummary = adapterList.length
    ? adapterList.map((adapter) => `${adapter.agent_type}: ${adapter.installed ? adapter.command_path ?? adapter.executable : "missing"}`).join("\n")
    : "No adapter status loaded";
  const installedAgents = agentClis ? agentClis.agents.filter((agent) => agent.installed).length : 0;
  const agentPill = agentClis
    ? { tone: installedAgents === agentClis.agents.length ? "ok" as const : "warn" as const, label: `${installedAgents} of ${agentClis.agents.length} installed` }
    : adapterStatus;
  const privateCopies = agentClis?.privateCopies ?? null;
  const hermesPaths = [
    hermes?.command_path ? ["Command", hermes.command_path] : null,
    hermes?.hermes_home ? ["Home", hermes.hermes_home] : null,
    hermes?.memory_path ? ["Memory", hermes.memory_path] : null,
  ].filter((item): item is [string, string] => Boolean(item));

  return (
    <>
      <SettingsGroup title="Coding agents" actions={<StatusPill tone={agentPill.tone}>{agentPill.label}</StatusPill>}>
        <p className="settingsGroupIntro">
          Athena runs the copy on your PATH, the same one your other terminals use, so updating an agent here or anywhere
          else updates it everywhere. Installs and updates run in a terminal you can watch.
        </p>
        {agentClis ? (
          <ul className="agentCliList">
            {agentClis.agents.map((agent) => {
              const needsNode = agent.needsNpm && !agent.npmAvailable;
              const command = agent.installed ? agent.updateCommand : agent.installCommand;
              return (
                <li key={agent.kind} className={agent.installed ? "" : "missing"}>
                  <AgentGlyph kind={agent.kind} />
                  <div className="agentCliText">
                    <strong>{agent.label}</strong>
                    <span className="agentCliPath" title={agent.path ?? command}>
                      {agent.installed ? agent.path : needsNode ? "Not installed · needs Node.js (npm)" : "Not installed"}
                    </span>
                  </div>
                  <button
                    className={agent.installed ? "ghostButton small" : "primaryButton small"}
                    type="button"
                    disabled={busy || !canRunSetup || needsNode}
                    title={!canRunSetup ? "Open a workspace first: this runs in a terminal there" : needsNode ? "Needs npm: install Node.js LTS first" : command}
                    onClick={() => onAgentSetup(agent.kind, agent.installed ? "update" : "install")}
                  >
                    {agent.installed ? <><RefreshCw size={13} /> Update</> : <><Download size={13} /> Install</>}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <pre className="settingsPre">{adapterSummary}</pre>
        )}
        {privateCopies ? (
          <div className="agentCliNotice">
            <span>
              Earlier versions of Athena installed their own copies of {privateCopies.labels.join(" and ")} in{" "}
              <code>{privateCopies.prefix}</code> and ran those instead of yours. Athena no longer uses them; remove them
              to save space and avoid confusion.
            </span>
            <button
              className="ghostButton small"
              type="button"
              disabled={busy || !canRunSetup}
              title={privateCopies.command}
              onClick={() => onAgentSetup(privateCopies.kinds[0], "cleanup")}
            >
              Remove old copies
            </button>
          </div>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Hermes" actions={<StatusPill tone={hermesStatus.tone}>{hermesStatus.label}</StatusPill>}>
        <SettingsRow label="Status" help={hermes?.message ?? "Status unavailable"}>
          {hermes && !hermes.installed && hermes.install_supported ? (
            <button className="primaryButton small" type="button" onClick={() => void onInstallHermes()} disabled={installingHermes}>
              <Download size={13} className={installingHermes ? "spinning" : undefined} /> {installingHermes ? "Installing" : "Install Hermes"}
            </button>
          ) : null}
        </SettingsRow>
        {hermesPaths.length > 0 && (
          <dl className="settingsPaths">
            {hermesPaths.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd><code title={value}>{value}</code></dd>
              </div>
            ))}
          </dl>
        )}
        <details className="settingsDisclosure">
          <summary>Connect Hermes to Athena (MCP bridge)</summary>
          <div className="settingsDisclosureBody">
            <p>
              Lets Hermes call Athena's <code>context_workspace_*</code> tools and answer "ask hermes" requests. Add this
              block to your Hermes config (<code>~/.hermes/config.yaml</code>), adjust the paths for your install, then
              restart Hermes. See the README "Hermes MCP Bridge" section for the full setup.
            </p>
            <pre className="settingsPre">{HERMES_BRIDGE_SNIPPET}</pre>
            <button
              className="ghostButton small"
              type="button"
              onClick={() => void copyToClipboard(HERMES_BRIDGE_SNIPPET).then(() => setCopied(true)).catch(() => undefined)}
            >
              {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy config</>}
            </button>
          </div>
        </details>
      </SettingsGroup>
    </>
  );
}

const REMOTE_ACCESS_POLL_MS = 5_000;

function RemoteAccessGroup() {
  const [state, setState] = useState<RemoteAccessState | null>(null);
  const [portDraft, setPortDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"url" | "token" | "example" | null>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void desktop.getRemoteAccessState()
        .then((next) => {
          if (!cancelled) setState(next);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, REMOTE_ACCESS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (state && !portDraft) setPortDraft(String(state.port));
  }, [state, portDraft]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(null), 1_600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  // Regenerate is destructive (every paired machine loses access), so it takes a second click.
  useEffect(() => {
    if (!confirmRegenerate) return undefined;
    const timer = window.setTimeout(() => setConfirmRegenerate(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [confirmRegenerate]);

  async function run(action: () => Promise<RemoteAccessState>) {
    setPending(true);
    setError(null);
    try {
      setState(await action());
    } catch (caught) {
      setError(String(caught instanceof Error ? caught.message : caught).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    } finally {
      setPending(false);
    }
  }

  async function copy(kind: "url" | "token" | "example", text: Promise<string> | string) {
    try {
      const value = await text;
      if (!value) return;
      await copyToClipboard(value);
      setCopied(kind);
    } catch {
      // Clipboard access can be refused; the value is still shown or retrievable.
    }
  }

  const enabled = Boolean(state?.enabled);
  const status = remoteAccessStatusView(state);
  const url = preferredRemoteUrl(state);
  const port = parseRemotePortInput(portDraft);
  const addresses = state ? [state.dnsUrl, ...state.urls].filter((value): value is string => Boolean(value)) : [];

  return (
    <SettingsGroup
      title="Remote access"
      actions={status ? <StatusPill tone={status.tone}>{status.label}</StatusPill> : undefined}
    >
      <p className="settingsGroupIntro">
        Let your other machines on the same Tailscale network list, watch, type into, and launch terminals here. Athena
        listens only on this machine's Tailscale addresses and answers only tailnet peers. A request must come from
        another device signed in to your Tailscale account, or carry this machine's access token. Anyone who can do
        either can run commands on this machine.
      </p>
      <SettingsRow
        label="Allow remote access"
        help={enabled
          ? "Your other machines can connect now. Turning this off disconnects them immediately."
          : state?.tailscale.detected === false ? "Off. Tailscale is not running on this machine yet." : "Off by default."}
        labelId="remoteAccessEnabledLabel"
      >
        <div className="segmentedControl" role="group" aria-labelledby="remoteAccessEnabledLabel">
          <button
            type="button"
            className={enabled ? "active" : ""}
            aria-pressed={enabled}
            disabled={pending || !state}
            onClick={() => void run(() => desktop.setRemoteAccessEnabled(true))}
          >
            <Globe size={14} /> On
          </button>
          <button
            type="button"
            className={!enabled ? "active" : ""}
            aria-pressed={!enabled}
            disabled={pending || !state}
            onClick={() => void run(() => desktop.setRemoteAccessEnabled(false))}
          >
            Off
          </button>
        </div>
      </SettingsRow>
      {error ? <p className="settingsGroupIntro remoteAccessError" role="alert">{error}</p> : null}
      {enabled && state ? (
        <>
          <SettingsRow label="Trust my own devices" help={trustOwnDevicesHelp(state)} labelId="remoteAccessTrustLabel">
            <div className="segmentedControl" role="group" aria-labelledby="remoteAccessTrustLabel">
              <button
                type="button"
                className={state.trustOwnDevices ? "active" : ""}
                aria-pressed={state.trustOwnDevices}
                disabled={pending}
                onClick={() => void run(() => desktop.setRemoteAccessTrustOwnDevices(true))}
              >
                On
              </button>
              <button
                type="button"
                className={!state.trustOwnDevices ? "active" : ""}
                aria-pressed={!state.trustOwnDevices}
                disabled={pending}
                onClick={() => void run(() => desktop.setRemoteAccessTrustOwnDevices(false))}
              >
                Token only
              </button>
            </div>
          </SettingsRow>
          <SettingsRow
            label="Reachable at"
            help={
              <>
                {addresses.length
                  ? addresses.map((address) => <code key={address} className="settingsPath remoteAccessAddress">{address}</code>)
                  : null}
                {state.errors.map((message) => <span key={message} className="remoteAccessWarning">{message}</span>)}
              </>
            }
          >
            <div className="settingsControlCluster">
              <button className="ghostButton small" type="button" disabled={!url} onClick={() => url && void copy("url", url)}>
                {copied === "url" ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy address</>}
              </button>
              <button
                className="ghostButton small"
                type="button"
                disabled={pending}
                title="Look for Tailscale addresses again"
                onClick={() => void run(() => desktop.refreshRemoteAccess())}
              >
                <RefreshCw size={13} className={pending ? "spinning" : undefined} /> Refresh
              </button>
            </div>
          </SettingsRow>
          <SettingsRow label="Port" help="Using the same port on every machine keeps pairing simple. Default 47821.">
            <div className="settingsControlCluster">
              <input
                className="textInput remoteAccessPort"
                type="text"
                inputMode="numeric"
                aria-label="Remote access port"
                aria-invalid={port === null}
                value={portDraft}
                onChange={(event) => setPortDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && port !== null && port !== state.port) void run(() => desktop.setRemoteAccessPort(port));
                }}
              />
              <button
                className="ghostButton small"
                type="button"
                disabled={pending || port === null || port === state.port}
                onClick={() => port !== null && void run(() => desktop.setRemoteAccessPort(port))}
              >
                Apply
              </button>
            </div>
          </SettingsRow>
          <SettingsRow
            label="Access token"
            help={state.trustOwnDevices
              ? "Only needed for devices outside your Tailscale account, and for scripts. Regenerating disconnects anything using the old one."
              : "Give this to the machines you want to connect from. Regenerating disconnects every machine using the old one."}
          >
            <div className="settingsControlCluster">
              <button className="ghostButton small" type="button" onClick={() => void copy("token", desktop.getRemoteAccessToken())}>
                {copied === "token" ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy token</>}
              </button>
              <button
                className={confirmRegenerate ? "dangerButton small" : "ghostButton small"}
                type="button"
                disabled={pending}
                onClick={() => {
                  if (!confirmRegenerate) {
                    setConfirmRegenerate(true);
                    return;
                  }
                  setConfirmRegenerate(false);
                  void run(async () => desktop.regenerateRemoteAccessToken());
                }}
              >
                <RotateCcw size={13} /> {confirmRegenerate ? "Click again to regenerate" : "Regenerate"}
              </button>
            </div>
          </SettingsRow>
          <SettingsRow label="Activity" help={remoteActivitySummary(state)} />
          <details className="settingsDisclosure">
            <summary>Test it from another machine</summary>
            <div className="settingsDisclosureBody">
              <p>
                Both machines must be signed in to the same tailnet. If nothing answers from Windows, allow Athena through
                Windows Defender Firewall for private networks.
              </p>
              <pre className="settingsPre">{remoteAccessCurlExample(state)}</pre>
              <button className="ghostButton small" type="button" onClick={() => void copy("example", remoteAccessCurlExample(state))}>
                {copied === "example" ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy commands</>}
              </button>
            </div>
          </details>
        </>
      ) : null}
    </SettingsGroup>
  );
}

function YourMachinesGroup() {
  const [state, setState] = useState<RemoteMachinesState | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void desktop.getRemoteMachines()
        .then((next) => {
          if (!cancelled) setState(next);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, REMOTE_ACCESS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      setState(await desktop.refreshRemoteMachines());
    } catch {
      // Keep the last list; the next poll tries again.
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <SettingsGroup
      title="Your machines"
      actions={(
        <button className="ghostButton small" type="button" disabled={refreshing} onClick={() => void refresh()}>
          <RefreshCw size={13} className={refreshing ? "spinning" : undefined} /> {refreshing ? "Checking" : "Check again"}
        </button>
      )}
    >
      <p className="settingsGroupIntro">
        {machinesSummary(state)} A machine is ready once Athena is running there with remote access on. Athena checks
        port {state?.port ?? 47821} on each one.
      </p>
      {state?.machines.length ? (
        <ul className="remoteMachineList">
          {state.machines.map((machine) => {
            const view = machineStatusView(machine);
            return (
              <li key={machine.id}>
                <div className="remoteMachineText">
                  <strong>{machine.name}</strong>
                  <span title={machine.dnsName ?? undefined}>{machineDetail(machine)}</span>
                </div>
                <StatusPill tone={view.tone}>{view.label}</StatusPill>
              </li>
            );
          })}
        </ul>
      ) : null}
    </SettingsGroup>
  );
}

function DiagnosticsSection({
  performance,
  onRefresh,
}: {
  performance: PerformanceDiagnostics | null;
  onRefresh: () => Promise<void>;
}) {
  const [sampling, setSampling] = useState(false);

  async function sample() {
    setSampling(true);
    try {
      await onRefresh();
    } finally {
      setSampling(false);
    }
  }

  const blocks: Array<{ id: string; title: string; tone: StatusTone; pill: string; body: string }> = [
    {
      id: "performance",
      title: "Terminal throughput",
      tone: performance?.pendingOutputBytes ? "warn" : "ok",
      pill: performance ? `${performance.activeTerminals} terminals` : "Unavailable",
      body: performance ? performanceSummary(performance) : "Open Settings while the desktop app is running to sample terminal throughput.",
    },
    {
      id: "control",
      title: "Terminal control state",
      tone: performance?.terminalControl.some((terminal) => terminal.attentionReason) ? "warn" : "ok",
      pill: performance ? `${performance.terminalControl.length} tracked` : "Unavailable",
      body: performance ? terminalControlSummary(performance) : "No terminal control state loaded.",
    },
    {
      id: "processes",
      title: "Agent processes",
      tone: performance?.agentProcesses.some((process) => !process.managedTerminalId) ? "warn" : "ok",
      pill: performance ? `${performance.agentProcesses.filter((process) => !process.managedTerminalId).length} unmanaged` : "Unavailable",
      body: performance ? agentProcessSummary(performance) : "No agent process diagnostics loaded.",
    },
    {
      id: "events",
      title: "Recent control events",
      tone: performance?.controlEvents.some((event) => event.kind.endsWith(".failed")) ? "bad" : "ok",
      pill: performance ? `${performance.controlEvents.length} events` : "Unavailable",
      body: performance ? controlEventsSummary(performance) : "No control events loaded.",
    },
  ];

  return (
    <SettingsGroup
      title="Live sample"
      actions={
        <button className="ghostButton small" type="button" onClick={() => void sample()} disabled={sampling}>
          <RefreshCw size={13} className={sampling ? "spinning" : undefined} /> Sample now
        </button>
      }
    >
      {performance && (
        <div className="diagnosticStats">
          <DiagnosticStat label="Main-process lag" value={`${Math.round(performance.eventLoopLagMs)} ms`} detail={`${Math.round(performance.maxEventLoopLagMs)} ms max`} />
          <DiagnosticStat label="PTY input" value={`${formatBytes(performance.ptyBytesPerSecond)}/s`} detail={`${performance.ptyChunksPerSecond} chunks/s`} />
          <DiagnosticStat label="Renderer output" value={`${formatBytes(performance.ipcBytesPerSecond)}/s`} detail={`${performance.ipcBatchesPerSecond} batches/s`} />
          <DiagnosticStat label="Pending output" value={formatBytes(performance.pendingOutputBytes)} detail={`${performance.rendererTerminalSubscribers} visible consumers`} />
        </div>
      )}
      <div className="diagnosticBlocks">
        {blocks.map((block, index) => (
          <details key={block.id} className="settingsDisclosure diagnostic" open={index === 0}>
            <summary>
              <span>{block.title}</span>
              <StatusPill tone={block.tone}>{block.pill}</StatusPill>
            </summary>
            <pre className="settingsPre">{block.body}</pre>
          </details>
        ))}
      </div>
    </SettingsGroup>
  );
}

function DiagnosticStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="diagnosticStat">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function ShortcutsSection() {
  const rows = shortcutReference();
  return (
    <SettingsGroup title="Anywhere in Athena">
      <table className="shortcutTable">
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">{row.label}</th>
              <td>
                <span className="kbdGroup">
                  {row.keys.map((key) => <kbd key={key} className="kbd">{key}</kbd>)}
                </span>
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row">Close menus, dialogs and the command palette</th>
            <td><span className="kbdGroup"><kbd className="kbd">Esc</kbd></span></td>
          </tr>
        </tbody>
      </table>
    </SettingsGroup>
  );
}

function performanceSummary(performance: PerformanceDiagnostics): string {
  return [
    `PTY input: ${performance.ptyChunksPerSecond}/s, ${formatBytes(performance.ptyBytesPerSecond)}/s`,
    `Renderer batches: ${performance.ipcBatchesPerSecond}/s, ${formatBytes(performance.ipcBytesPerSecond)}/s`,
    `Main process lag: ${Math.round(performance.eventLoopLagMs)} ms latest, ${Math.round(performance.maxEventLoopLagMs)} ms max`,
    `Buffered: ${formatBytes(performance.bufferedTerminalChars)} chars across terminals`,
    `Pending renderer output: ${formatBytes(performance.pendingOutputBytes)}`,
    `Per-terminal cap: ${formatBytes(performance.maxBufferChars)} chars`,
    `Visible renderer consumers: ${performance.rendererTerminalSubscribers}`,
    `Output recovery: ${performance.terminalOutputRetries} retries, ${performance.terminalOutputResets} resets`,
    `Flow control: ${performance.terminalOutputFlowPauses} PTY pauses, ${performance.terminalOutputFlowForcedResumes} forced resumes`,
    `Explicitly truncated: ${formatBytes(performance.terminalOutputDroppedChars)} chars`,
    `Delivered / acknowledged: ${formatBytes(performance.terminalOutputDeliveredChars)} / ${formatBytes(performance.terminalOutputAcknowledgedChars)} chars`,
    `Attach replay: ${performance.terminalReplayCount} snapshots, ${formatBytes(performance.terminalReplayBytes)}, ${performance.terminalReplayDurationMs.toFixed(2)} ms total (${performance.terminalReplayMaxDurationMs.toFixed(2)} ms max)`,
    performance.sessionIndex
      ? `Session index: ${performance.sessionIndex.filesParsed} parsed / ${performance.sessionIndex.cacheHits} cached, ${formatBytes(performance.sessionIndex.bytesParsed)}, ${Math.round(performance.sessionIndex.durationMs)} ms${performance.sessionIndex.lastError ? ` · ${performance.sessionIndex.lastError}` : ""}`
      : "Session index: not run yet",
    `Last batch: ${performance.lastOutputBatchAt ?? "none"}`,
  ].join("\n");
}

function agentProcessSummary(performance: PerformanceDiagnostics): string {
  if (performance.agentProcesses.length === 0) return "No Codex, Claude, OpenCode, or Hermes processes detected.";
  return performance.agentProcesses.slice(0, 14).map((process) => [
    `${process.agent} · PID ${process.pid}${process.ppid == null ? "" : ` · parent ${process.ppid}`}`,
    process.managedTerminalId
      ? `managed by ${process.managedTerminalTitle ?? process.managedTerminalId}`
      : "not managed by Athena",
    process.workspace ? `workspace: ${process.workspace}` : null,
    `command: ${truncateMiddle(process.command, 180)}`,
  ].filter(Boolean).join("\n")).join("\n\n");
}

function terminalControlSummary(performance: PerformanceDiagnostics): string {
  if (performance.terminalControl.length === 0) return "No terminal control state recorded yet.";
  return performance.terminalControl.slice(0, 8).map((terminal) => [
    `${terminal.title} (${terminal.kind}${terminal.pid == null ? "" : ` · PID ${terminal.pid}`})`,
    `spawn: ${terminal.lastSpawnResult ?? "unknown"}${terminal.spawnSource ? ` via ${terminal.spawnSource}` : ""}`,
    terminal.lastInjectResult
      ? `inject: ${terminal.lastInjectResult}${terminal.lastInjectedBy ? ` via ${terminal.lastInjectedBy}` : ""}${terminal.lastInjectTextPreview ? ` · ${terminal.lastInjectTextPreview}` : ""}`
      : "inject: none",
    `last output: ${terminal.lastOutputAt ?? "none"}`,
    terminal.attentionReason ? `attention: ${terminal.attentionReason}` : null,
  ].filter(Boolean).join("\n")).join("\n\n");
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const half = Math.floor((maxLength - 3) / 2);
  return `${value.slice(0, half)}...${value.slice(-half)}`;
}

function controlEventsSummary(performance: PerformanceDiagnostics): string {
  if (performance.controlEvents.length === 0) return "No spawn or injection events recorded yet.";
  return performance.controlEvents.slice(0, 12).map((event) => [
    `${event.at} · ${event.kind} · ${event.source}`,
    event.terminalTitle ? `${event.terminalTitle}${event.terminalKind ? ` (${event.terminalKind})` : ""}` : null,
    event.detail,
    event.preview ? `preview: ${event.preview}` : null,
  ].filter(Boolean).join("\n")).join("\n\n");
}

function notificationDescription(preferences: NotificationPreferences): string {
  if (preferences.level === "off") {
    return "No sounds or desktop notifications. Workspace tabs still show a badge when an agent needs you or finishes.";
  }
  const what = preferences.level === "all"
    ? "when an agent is waiting for your approval or an answer, and when it finishes a turn"
    : "only when an agent is waiting for your approval or an answer; finished turns just badge their workspace tab";
  return `Alerts ${what}. Terminals you are looking at stay quiet; the rest alert with a tab badge, sound, and (while Athena is in the background) a desktop notification.`;
}

function formatBytes(value: number): string {
  if (value < 1000) return `${Math.round(value)} B`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)} KB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}
