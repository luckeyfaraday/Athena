import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Cpu, Database, FolderKanban, RefreshCw, Server, TerminalSquare } from "lucide-react";
import { BackendClient, type AdapterStatus, type BackendStatus, type HermesStatus } from "./api";
import { desktop } from "./electron";
import { ActivityFeed } from "./components/ActivityFeed";
import { CodexTerminal } from "./components/CodexTerminal";
import { WorkspaceSelector } from "./components/WorkspaceSelector";

type LoadState = {
  hermes: HermesStatus | null;
  adapters: Record<string, AdapterStatus>;
  memory: string[];
};

type ActiveView = "terminal" | "memory" | "agents";

const emptyLoadState: LoadState = {
  hermes: null,
  adapters: {},
  memory: [],
};

export function App() {
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [workspace, setWorkspace] = useState("");
  const [state, setState] = useState<LoadState>(emptyLoadState);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeView, setActiveView] = useState<ActiveView>("terminal");
  const backendRefreshInFlight = useRef(false);
  const dataRefreshInFlight = useRef(false);

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

  const refreshData = useCallback(async () => {
    if (!client || dataRefreshInFlight.current) return;
    dataRefreshInFlight.current = true;
    try {
      const [hermes, adapters, memory] = await Promise.all([
        client.hermesStatus(),
        client.adapters(),
        client.recentMemory(20),
      ]);
      setState({ hermes, adapters, memory });
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      dataRefreshInFlight.current = false;
    }
  }, [client]);

  useEffect(() => {
    desktop
      .getBackendState()
      .then((status) => {
        setBackend(status);
        if (status.healthy) {
          void refreshData();
        }
      })
      .catch((err) => setError(String(err)));
  }, [refreshData]);

  useEffect(() => {
    void refreshData();
  }, [refreshData]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshBackend().then((status) => {
        if (status?.healthy) {
          void refreshData();
        }
      });
    }, 10000);
    return () => window.clearInterval(timer);
  }, [refreshBackend, refreshData]);

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

  return (
    <main className="appFrame">
      <aside className="productRail" aria-label="Product navigation">
        <div className="railLogo">
          <FolderKanban size={21} />
        </div>
        <button
          className={activeView === "terminal" ? "railItem active" : "railItem"}
          onClick={() => setActiveView("terminal")}
          title="Workspace"
        >
          <TerminalSquare size={18} />
        </button>
        <button
          className={activeView === "memory" ? "railItem active" : "railItem"}
          onClick={() => setActiveView("memory")}
          title="Memory"
        >
          <Database size={18} />
        </button>
        <button
          className={activeView === "agents" ? "railItem active" : "railItem"}
          onClick={() => setActiveView("agents")}
          title="Agents"
        >
          <Bot size={18} />
        </button>
      </aside>

      <section className="shell">
        <header className="topbar">
          <div className="brandBlock">
            <div>
              <span className="eyebrow">Agent Operations</span>
              <h1>Context Workspace</h1>
              <p>{backend?.baseUrl ?? "Backend starting"}</p>
            </div>
          </div>
          <div className="statusCluster">
            <span className={backend?.healthy ? "statusPill ok" : "statusPill bad"}>
              <span />
              {backend?.healthy ? "Backend online" : "Backend offline"}
            </span>
            <button className="button buttonIcon" onClick={restartBackend} disabled={busy} title="Restart backend">
              <RefreshCw size={17} />
            </button>
          </div>
        </header>

        {(error || (!backend?.healthy && backend?.lastError)) && <div className="notice">{error ?? backend?.lastError}</div>}

        <section className="workspaceBand">
          <WorkspaceSelector workspace={workspace} onWorkspaceChange={setWorkspace} />
          <div className="summaryGrid">
            <StatusBlock
              icon={<Server size={17} />}
              label="Hermes"
              value={state.hermes?.message ?? "Checking"}
              tone={state.hermes?.installed ? "ok" : "warn"}
            />
            <StatusBlock
              icon={<Bot size={17} />}
              label="Codex"
              value={state.adapters.codex?.installed ? "Installed" : "Missing"}
              tone={state.adapters.codex?.installed ? "ok" : "warn"}
            />
            <StatusBlock icon={<Cpu size={17} />} label="Workspace" value={workspace || "Not selected"} tone="neutral" />
            <StatusBlock icon={<Database size={17} />} label="Memory" value={`${state.memory.length} entries`} tone="neutral" />
          </div>
        </section>

        <div className="sectionBar">
          <div>
            <h2>{activeView === "memory" ? "Memory" : activeView === "agents" ? "Agents" : "Codex Session"}</h2>
            <p>{viewDescription(activeView)}</p>
          </div>
          <div className="sectionTabs" role="tablist" aria-label="Workspace views">
            <button className={activeView === "terminal" ? "active" : ""} onClick={() => setActiveView("terminal")}>
              Sessions
            </button>
            <button className={activeView === "memory" ? "active" : ""} onClick={() => setActiveView("memory")}>
              Memory
            </button>
            <button className={activeView === "agents" ? "active" : ""} onClick={() => setActiveView("agents")}>
              Agents
            </button>
          </div>
        </div>

        {activeView === "terminal" && (
          <section className="mainGrid">
            <CodexTerminal workspace={workspace} />
            <ActivityFeed entries={state.memory} />
          </section>
        )}
        {activeView === "memory" && <ActivityFeed entries={state.memory} variant="full" />}
        {activeView === "agents" && <AgentOverview adapters={state.adapters} />}
      </section>
    </main>
  );
}

function viewDescription(activeView: ActiveView) {
  if (activeView === "memory") return "Review recent persisted context used to seed native Codex sessions.";
  if (activeView === "agents") return "Check configured agent runtimes and availability.";
  return "Launch native Codex terminals with Hermes memory attached to the startup prompt.";
}

function StatusBlock({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone: "ok" | "warn" | "neutral";
}) {
  return (
    <div className={`statusBlock ${tone}`}>
      <div className="statusBlockIcon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong title={value}>{value}</strong>
      </div>
    </div>
  );
}

function AgentOverview({ adapters }: { adapters: Record<string, AdapterStatus> }) {
  const entries = Object.values(adapters);
  return (
    <section className="panel fullPanel">
      <div className="panelHeader">
        <div className="panelTitle">
          <Bot size={16} />
          <h2>Agent Runtimes</h2>
        </div>
        <span>{entries.length} adapters</span>
      </div>
      <div className="agentRows">
        {entries.map((adapter) => (
          <article key={adapter.agent_type} className="agentRow">
            <div>
              <strong>{adapter.agent_type}</strong>
              <span>{adapter.command_path ?? adapter.executable}</span>
            </div>
            <span className={adapter.installed ? "statusPill ok" : "statusPill bad"}>
              <span />
              {adapter.installed ? "Installed" : "Missing"}
            </span>
          </article>
        ))}
        {entries.length === 0 && <p className="empty">No adapter status loaded.</p>}
      </div>
    </section>
  );
}
