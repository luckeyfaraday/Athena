import { FolderOpen, RefreshCw } from "lucide-react";
import type { AdapterStatus, BackendStatus, HermesStatus, RecallStatus } from "../api";
import { StatusPill } from "../components/status";
import { formatAge, recallAuditLines } from "../session-utils";

export function SettingsRoom({
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
                    ...recallAuditLines(recall),
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
