import { Maximize2, MessageSquare, FolderOpen, RefreshCw, TerminalSquare } from "lucide-react";
import type { AdapterStatus, BackendStatus, ElectronControlStatus, HermesStatus, RecallStatus } from "../api";
import { adapterInstallStatusView, backendStatusView, electronControlStatusView, hermesStatusView, recallStatusView, StatusPill } from "../components/status";
import type { AthenaLaunchState, PerformanceDiagnostics } from "../electron";
import { formatAge, recallAuditLines } from "../session-utils";

type UiTheme = "classic" | "monolith" | "press" | "mono-light" | "mono-dark";

export function SettingsRoom({
  workspace,
  backend,
  electronControl,
  hermes,
  recall,
  adapters,
  busy,
  refreshing,
  interfaceMode,
  uiTheme,
  terminalFocus,
  performance,
  launchState,
  onSelectWorkspace,
  onRestartBackend,
  onRestartControl,
  onClearTerminalRestorePause,
  onRefreshRecall,
  onInterfaceModeChange,
  onThemeChange,
  onTerminalFocusChange,
}: {
  workspace: string;
  backend: BackendStatus | null;
  electronControl: ElectronControlStatus | null;
  hermes: HermesStatus | null;
  recall: RecallStatus | null;
  adapters: Record<string, AdapterStatus>;
  busy: boolean;
  refreshing: boolean;
  interfaceMode: "terminal" | "chat";
  uiTheme: UiTheme;
  terminalFocus: boolean;
  performance: PerformanceDiagnostics | null;
  launchState: AthenaLaunchState | null;
  onSelectWorkspace: () => Promise<void>;
  onRestartBackend: () => Promise<void>;
  onRestartControl: () => Promise<void>;
  onClearTerminalRestorePause: () => Promise<void>;
  onRefreshRecall: () => void;
  onInterfaceModeChange: (mode: "terminal" | "chat") => void;
  onThemeChange: (theme: UiTheme) => void;
  onTerminalFocusChange: (focused: boolean) => void;
}) {
  const backendStatus = backendStatusView(backend);
  const electronControlStatus = electronControlStatusView(electronControl);
  const hermesStatus = hermesStatusView(hermes);
  const recallStatus = recallStatusView(recall);
  const adapterList = Object.values(adapters);
  const adapterStatus = adapterInstallStatusView(adapterList);
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
          <StatusPill tone={backendStatus.tone}>{backendStatus.label}</StatusPill>
          <button className="ghostButton" type="button" onClick={() => void onRestartBackend()} disabled={busy}>
            <RefreshCw size={14} /> {busy ? "Restarting" : "Restart"}
          </button>
        </article>
        <article className="settingsSection">
          <div>
            <strong>Electron control</strong>
            <span>{electronControl?.lastError ?? electronControl?.baseUrl ?? "Not connected"}</span>
          </div>
          <StatusPill tone={electronControlStatus.tone}>{electronControlStatus.label}</StatusPill>
          <button className="ghostButton" type="button" onClick={() => void onRestartControl()} disabled={busy}>
            <RefreshCw size={14} /> {busy ? "Restarting" : "Restart"}
          </button>
        </article>
        <article className="settingsSection">
          <div>
            <strong>Terminal restore</strong>
            <span>{launchState?.terminalRestorePaused
              ? `Paused after previous unclean launch${launchState.previousCrashAt ? ` at ${launchState.previousCrashAt}` : ""}. Enabling starts fresh.`
              : "Saved terminal metadata is kept, but live PTYs are resumed only by explicit user or Hermes action."}</span>
          </div>
          <StatusPill tone={launchState?.terminalRestorePaused ? "warn" : "ok"}>
            {launchState?.terminalRestorePaused ? "Paused" : "Enabled"}
          </StatusPill>
          <button className="ghostButton" type="button" onClick={() => void onClearTerminalRestorePause()} disabled={busy || !launchState?.terminalRestorePaused}>
            <RefreshCw size={14} /> Enable Restore
          </button>
        </article>
        <article className="settingsSection">
          <div>
            <strong>Interface mode</strong>
            <span>{interfaceMode === "chat" ? "All instances use the chat visual layer. Terminal processes still run underneath." : "All instances use the current embedded terminal view."}</span>
          </div>
          <div className="segmentedControl" role="group" aria-label="Interface mode">
            <button
              type="button"
              className={interfaceMode === "terminal" ? "active" : ""}
              onClick={() => onInterfaceModeChange("terminal")}
            >
              <TerminalSquare size={14} /> Terminal
            </button>
            <button
              type="button"
              className={interfaceMode === "chat" ? "active" : ""}
              onClick={() => onInterfaceModeChange("chat")}
            >
              <MessageSquare size={14} /> Chat
            </button>
          </div>
        </article>
        <article className="settingsSection">
          <div>
            <strong>Theme</strong>
            <span>{themeDescription(uiTheme)}</span>
          </div>
          <div className="segmentedControl themeSegmentedControl" role="group" aria-label="Theme">
            <button
              type="button"
              className={uiTheme === "classic" ? "active" : ""}
              onClick={() => onThemeChange("classic")}
            >
              Classic
            </button>
            <button
              type="button"
              className={uiTheme === "monolith" ? "active" : ""}
              onClick={() => onThemeChange("monolith")}
            >
              Monolith
            </button>
            <button
              type="button"
              className={uiTheme === "press" ? "active" : ""}
              onClick={() => onThemeChange("press")}
            >
              Press
            </button>
            <button
              type="button"
              className={uiTheme === "mono-light" ? "active" : ""}
              onClick={() => onThemeChange("mono-light")}
            >
              Mono Light
            </button>
            <button
              type="button"
              className={uiTheme === "mono-dark" ? "active" : ""}
              onClick={() => onThemeChange("mono-dark")}
            >
              Mono Dark
            </button>
          </div>
        </article>
        <article className="settingsSection">
          <div>
            <strong>Shell focus</strong>
            <span>{terminalFocus ? "Command Room terminals fill the app while surrounding workspace chrome is hidden. Press Esc to restore the full workspace." : "The full Athena workspace is visible around the terminal grid."}</span>
          </div>
          <div className="segmentedControl" role="group" aria-label="Shell focus">
            <button
              type="button"
              className={!terminalFocus ? "active" : ""}
              onClick={() => onTerminalFocusChange(false)}
            >
              <TerminalSquare size={14} /> Normal
            </button>
            <button
              type="button"
              className={terminalFocus ? "active" : ""}
              onClick={() => onTerminalFocusChange(true)}
            >
              <Maximize2 size={14} /> Focus
            </button>
          </div>
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
          <StatusPill tone={hermesStatus.tone}>{hermesStatus.label}</StatusPill>
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
                    ...recallAuditLines(recall),
                  ].filter(Boolean).join("\n")
                : "No recall status"}
            </span>
          </div>
          <StatusPill tone={recallStatus.tone}>{recallStatus.label}</StatusPill>
          <button className="ghostButton" type="button" onClick={onRefreshRecall} disabled={refreshing || !recall?.refresh_configured}>
            <RefreshCw size={14} /> {refreshing ? "Refreshing" : "Refresh"}
          </button>
        </article>
        <article className="settingsSection wide">
          <div>
            <strong>Agent adapters</strong>
            <span>{adapterSummary}</span>
          </div>
          <StatusPill tone={adapterStatus.tone}>{adapterStatus.label}</StatusPill>
        </article>
        <article className="settingsSection wide">
          <div>
            <strong>Performance diagnostics</strong>
            <span className="settingsDiagnosticsText">
              {performance ? performanceSummary(performance) : "Open Settings while the desktop app is running to sample terminal throughput."}
            </span>
          </div>
          <StatusPill tone={performance?.pendingOutputBytes ? "warn" : "ok"}>{performance ? `${performance.activeTerminals} terminals` : "Unavailable"}</StatusPill>
        </article>
        <article className="settingsSection wide">
          <div>
            <strong>Terminal control state</strong>
            <span className="settingsDiagnosticsText">{performance ? terminalControlSummary(performance) : "No terminal control state loaded."}</span>
          </div>
          <StatusPill tone={performance?.terminalControl.some((terminal) => terminal.attentionReason) ? "warn" : "ok"}>
            {performance ? `${performance.terminalControl.length} tracked` : "Unavailable"}
          </StatusPill>
        </article>
        <article className="settingsSection wide">
          <div>
            <strong>Agent process diagnostics</strong>
            <span className="settingsDiagnosticsText">{performance ? agentProcessSummary(performance) : "No agent process diagnostics loaded."}</span>
          </div>
          <StatusPill tone={performance?.agentProcesses.some((process) => !process.managedTerminalId) ? "warn" : "ok"}>
            {performance ? `${performance.agentProcesses.filter((process) => !process.managedTerminalId).length} unmanaged` : "Unavailable"}
          </StatusPill>
        </article>
        <article className="settingsSection wide">
          <div>
            <strong>Recent control events</strong>
            <span className="settingsDiagnosticsText">{performance ? controlEventsSummary(performance) : "No control events loaded."}</span>
          </div>
          <StatusPill tone={performance?.controlEvents.some((event) => event.kind.endsWith(".failed")) ? "bad" : "ok"}>
            {performance ? `${performance.controlEvents.length} events` : "Unavailable"}
          </StatusPill>
        </article>
      </div>
    </section>
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

function themeDescription(theme: UiTheme): string {
  if (theme === "monolith") return "Void black, acid lime, and sharp terminal surfaces.";
  if (theme === "press") return "Warm editorial dark with serif headings and vermillion accents.";
  if (theme === "mono-light") return "Pure grayscale light theme. System-default typography, no color accents.";
  if (theme === "mono-dark") return "Pure grayscale dark theme. System-default typography, no color accents.";
  return "Original Athena forest palette and neutral workspace typography.";
}

function formatBytes(value: number): string {
  if (value < 1000) return `${Math.round(value)} B`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)} KB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}
