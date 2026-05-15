import { Maximize2, MessageSquare, FolderOpen, RefreshCw, TerminalSquare } from "lucide-react";
import type { AdapterStatus, BackendStatus, HermesStatus, RecallStatus } from "../api";
import { adapterInstallStatusView, backendStatusView, hermesStatusView, recallStatusView, StatusPill } from "../components/status";
import { formatAge, recallAuditLines } from "../session-utils";

export function SettingsRoom({
  workspace,
  backend,
  hermes,
  recall,
  adapters,
  busy,
  refreshing,
  interfaceMode,
  terminalFocus,
  onSelectWorkspace,
  onRestartBackend,
  onRefreshRecall,
  onInterfaceModeChange,
  onTerminalFocusChange,
}: {
  workspace: string;
  backend: BackendStatus | null;
  hermes: HermesStatus | null;
  recall: RecallStatus | null;
  adapters: Record<string, AdapterStatus>;
  busy: boolean;
  refreshing: boolean;
  interfaceMode: "terminal" | "chat";
  terminalFocus: boolean;
  onSelectWorkspace: () => Promise<void>;
  onRestartBackend: () => Promise<void>;
  onRefreshRecall: () => void;
  onInterfaceModeChange: (mode: "terminal" | "chat") => void;
  onTerminalFocusChange: (focused: boolean) => void;
}) {
  const backendStatus = backendStatusView(backend);
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
      </div>
    </section>
  );
}
