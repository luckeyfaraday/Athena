import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { BackendClient, type AdapterStatus, type BackendStatus, type HermesStatus, type Run } from "./api";
import { desktop } from "./electron";
import { ActivityFeed } from "./components/ActivityFeed";
import { AgentSpawnForm } from "./components/AgentSpawnForm";
import { LogViewer } from "./components/LogViewer";
import { RunList } from "./components/RunList";
import { WorkspaceSelector } from "./components/WorkspaceSelector";

type LoadState = {
  hermes: HermesStatus | null;
  adapters: Record<string, AdapterStatus>;
  runs: Run[];
  memory: string[];
};

const emptyLoadState: LoadState = {
  hermes: null,
  adapters: {},
  runs: [],
  memory: [],
};

export function App() {
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [workspace, setWorkspace] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>(emptyLoadState);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const client = useMemo(() => {
    return backend?.baseUrl ? new BackendClient(backend.baseUrl) : null;
  }, [backend?.baseUrl]);

  const refreshBackend = useCallback(async () => {
    const status = await desktop.checkBackendHealth();
    setBackend(status);
    return status;
  }, []);

  const refreshData = useCallback(async () => {
    if (!client) return;
    try {
      const [hermes, adapters, runs, memory] = await Promise.all([
        client.hermesStatus(),
        client.adapters(),
        client.runs(),
        client.recentMemory(20),
      ]);
      setState({ hermes, adapters, runs, memory });
      setSelectedRunId((current) => current ?? runs[0]?.run_id ?? null);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [client]);

  useEffect(() => {
    desktop.getBackendState().then(setBackend).catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    void refreshData();
  }, [refreshData]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshBackend().then((status) => {
        if (status.healthy) {
          void refreshData();
        }
      });
    }, 2500);
    return () => window.clearInterval(timer);
  }, [refreshBackend, refreshData]);

  const selectedRun = state.runs.find((run) => run.run_id === selectedRunId) ?? null;

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

  async function spawnCodex(task: string) {
    if (!client || !workspace) return;
    setBusy(true);
    try {
      const run = await client.spawnCodex(workspace, task);
      setSelectedRunId(run.run_id);
      await refreshData();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancelRun(runId: string) {
    if (!client) return;
    await client.cancelRun(runId);
    await refreshData();
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Context Workspace</h1>
          <p>{backend?.baseUrl ?? "Backend starting"}</p>
        </div>
        <div className="statusCluster">
          <span className={backend?.healthy ? "status ok" : "status bad"}>
            {backend?.healthy ? "Backend online" : "Backend offline"}
          </span>
          <button className="iconButton" onClick={restartBackend} disabled={busy} title="Restart backend">
            <RefreshCw size={18} />
          </button>
        </div>
      </header>

      {error && <div className="notice">{error}</div>}

      <section className="workspaceBand">
        <WorkspaceSelector workspace={workspace} onWorkspaceChange={setWorkspace} />
        <div className="summaryGrid">
          <StatusBlock label="Hermes" value={state.hermes?.message ?? "Checking"} tone={state.hermes?.installed ? "ok" : "warn"} />
          <StatusBlock label="Codex" value={state.adapters.codex?.installed ? "Installed" : "Missing"} tone={state.adapters.codex?.installed ? "ok" : "warn"} />
          <StatusBlock label="Runs" value={String(state.runs.length)} tone="neutral" />
        </div>
      </section>

      <section className="mainGrid">
        <div className="leftPane">
          <AgentSpawnForm disabled={!client || !backend?.healthy || !workspace || busy} onSpawn={spawnCodex} />
          <RunList runs={state.runs} selectedRunId={selectedRunId} onSelect={setSelectedRunId} onCancel={cancelRun} />
        </div>
        <LogViewer client={client} run={selectedRun} />
        <ActivityFeed entries={state.memory} />
      </section>
    </main>
  );
}

function StatusBlock({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" | "neutral" }) {
  return (
    <div className={`statusBlock ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
