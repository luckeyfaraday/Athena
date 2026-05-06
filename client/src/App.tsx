import { type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bot,
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Code2,
  Database,
  Eye,
  FileText,
  Layers3,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Maximize2,
  Minimize2,
  TerminalSquare,
  Users,
  Workflow,
  Wrench,
  XCircle,
} from "lucide-react";
import { BackendClient, type AdapterStatus, type BackendStatus, type HermesStatus, type Run } from "./api";
import { desktop, type EmbeddedTerminalKind, type EmbeddedTerminalSession } from "./electron";
import { WorkspaceSelector } from "./components/WorkspaceSelector";
import { EmbeddedTerminal } from "./components/EmbeddedTerminal";

type LoadState = {
  hermes: HermesStatus | null;
  adapters: Record<string, AdapterStatus>;
  memory: string[];
  runs: Run[];
};

type ActiveRoom = "command" | "swarm" | "review" | "memory";

type AgentRole = {
  role: string;
  type: string;
  icon: ReactNode;
  status: "ready" | "running" | "waiting" | "offline";
  brief: string;
};

type PaneDragState = {
  id: string;
  deltaX: number;
  deltaY: number;
  targetId: string | null;
};

const emptyLoadState: LoadState = {
  hermes: null,
  adapters: {},
  memory: [],
  runs: [],
};

const roomCopy: Record<ActiveRoom, { label: string; eyebrow: string; description: string }> = {
  command: {
    label: "Command Room",
    eyebrow: "01 · Native work",
    description: "Terminals, repo state, and Hermes context open in one controlled workspace.",
  },
  swarm: {
    label: "Swarm Room",
    eyebrow: "02 · Parallel agents",
    description: "Spin up builders, reviewers, scouts, and fixers with memory already attached.",
  },
  review: {
    label: "Review Room",
    eyebrow: "03 · Human control",
    description: "Turn agent output into a clean ship, revise, or investigate decision.",
  },
  memory: {
    label: "Memory Room",
    eyebrow: "04 · Persistent context",
    description: "Inspect what Hermes knows, what agents asked, and what future runs inherit.",
  },
};

const defaultWorkspace = "C:\\Users\\alanq\\context-workspace";
const workspaceStorageKey = "context-workspace:lastWorkspace";

function initialWorkspace(): string {
  try {
    return window.localStorage.getItem(workspaceStorageKey) || defaultWorkspace;
  } catch {
    return defaultWorkspace;
  }
}

export function App() {
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [state, setState] = useState<LoadState>(emptyLoadState);
  const [embeddedSessions, setEmbeddedSessions] = useState<EmbeddedTerminalSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeRoom, setActiveRoom] = useState<ActiveRoom>("command");
  const [terminalFocus, setTerminalFocus] = useState(false);
  const [layoutResetNonce, setLayoutResetNonce] = useState(0);
  const backendRefreshInFlight = useRef(false);
  const dataRefreshInFlight = useRef(false);
  const autoStartedTerminals = useRef(false);

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
      setEmbeddedSessions(await desktop.listEmbeddedTerminals());
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const refreshData = useCallback(async () => {
    if (!client || dataRefreshInFlight.current) return;
    dataRefreshInFlight.current = true;
    try {
      const [hermes, adapters, memory, runs] = await Promise.all([
        client.hermesStatus(),
        client.adapters(),
        client.recentMemory(30),
        client.runs(),
      ]);
      setState({ hermes, adapters, memory, runs });
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      dataRefreshInFlight.current = false;
    }
  }, [client]);

  useEffect(() => {
    try {
      if (workspace.trim()) window.localStorage.setItem(workspaceStorageKey, workspace);
    } catch {
      // Ignore storage failures; the selected workspace still works for this session.
    }
  }, [workspace]);

  useEffect(() => {
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
    }, 8000);
    return () => window.clearInterval(timer);
  }, [refreshBackend, refreshData, refreshSessions]);

  useEffect(() => {
    if (autoStartedTerminals.current || !workspace || embeddedSessions.length > 0) return;
    autoStartedTerminals.current = true;
    void launchEmbedded("shell", 1);
  }, [workspace, embeddedSessions.length]);

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

  async function launchEmbedded(kind: EmbeddedTerminalKind, count = 1) {
    if (!workspace || busy) return;
    setBusy(true);
    setError(null);
    try {
      const titles = terminalGridTitles(kind);
      const created = await Promise.all(
        Array.from({ length: count }, (_, index) =>
          desktop.spawnEmbeddedTerminal(workspace, {
            kind,
            title: titles[index] ?? `${kind}-${index + 1}`,
            cols: 96,
            rows: 28,
          }),
        ),
      );
      setEmbeddedSessions((current) => [...created.reverse(), ...current.filter((item) => !created.some((createdItem) => createdItem.id === item.id))]);
      if (count > 1) setLayoutResetNonce((value) => value + 1);
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

  const activeRuns = state.runs.filter((run) => run.status === "running" || run.status === "pending");
  const completedRuns = state.runs.filter((run) => run.status === "succeeded" || run.status === "failed" || run.status === "cancelled");
  const latestRun = state.runs.at(-1) ?? null;
  const memoryEntries = [...state.memory].reverse();
  const codexInstalled = Boolean(state.adapters.codex?.installed);

  const agentRoles: AgentRole[] = [
    {
      role: "Builder",
      type: "codex",
      icon: <Wrench size={18} />,
      status: activeRuns.length ? "running" : codexInstalled ? "ready" : "offline",
      brief: "Implements the selected task against the live repo.",
    },
    {
      role: "Reviewer",
      type: "codex",
      icon: <Eye size={18} />,
      status: codexInstalled ? "ready" : "offline",
      brief: "Reads diffs, tests, and artifacts before anything ships.",
    },
    {
      role: "Scout",
      type: "opencode",
      icon: <Search size={18} />,
      status: state.adapters.opencode?.installed ? "ready" : "waiting",
      brief: "Explores code, docs, and prior Hermes memory for context.",
    },
    {
      role: "Fixer",
      type: "claude",
      icon: <ShieldCheck size={18} />,
      status: state.adapters.claude?.installed ? "ready" : "waiting",
      brief: "Takes failed runs and drives them back to green.",
    },
  ];

  return (
    <main className="workspaceSurface">
      <aside className="roomRail" aria-label="Workspace rooms">
        <div className="railMark" title="Context Workspace">
          <BrainCircuit size={23} />
        </div>
        <RoomButton active={activeRoom === "command"} icon={<TerminalSquare size={19} />} label="Command" onClick={() => setActiveRoom("command")} />
        <RoomButton active={activeRoom === "swarm"} icon={<Users size={19} />} label="Swarm" onClick={() => setActiveRoom("swarm")} />
        <RoomButton active={activeRoom === "review"} icon={<ShieldCheck size={19} />} label="Review" onClick={() => setActiveRoom("review")} />
        <RoomButton active={activeRoom === "memory"} icon={<Database size={19} />} label="Memory" onClick={() => setActiveRoom("memory")} />
        <div className="railSpacer" />
        <span className={backend?.healthy ? "railPulse ok" : "railPulse bad"} />
      </aside>

      <section className={terminalFocus && activeRoom === "command" ? "workspaceShell terminalFocusShell" : "workspaceShell"}>
        <header className="heroTopbar">
          <div className="brandLockup">
            <span className="tinyLabel">Context Workspace</span>
            <h1>A workroom where every agent remembers.</h1>
            <p>Rooms with Hermes memory riding on top of terminals, swarms, and reviews.</p>
          </div>
          <div className="topbarActions">
            <StatusPill tone={backend?.healthy ? "ok" : "bad"}>{backend?.healthy ? "Backend online" : "Backend offline"}</StatusPill>
            <StatusPill tone={state.hermes?.installed ? "ok" : "warn"}>{state.hermes?.installed ? "Hermes attached" : "Hermes setup"}</StatusPill>
            <button className="iconButton" onClick={restartBackend} disabled={busy} title="Restart backend">
              <RefreshCw size={17} />
            </button>
          </div>
        </header>

        {(error || (!backend?.healthy && backend?.lastError)) && <div className="noticeBar">{error ?? backend?.lastError}</div>}

        <section className="controlBand">
          <WorkspaceSelector workspace={workspace} onWorkspaceChange={setWorkspace} />
          <div className="missionCard primaryMission">
            <div>
              <span className="tinyLabel">Live workflow map</span>
              <strong>Task → context → agents → review → memory</strong>
            </div>
            <div className="flowSteps">
              <FlowStep icon={<FileText size={14} />} label="Task" active />
              <FlowStep icon={<BrainCircuit size={14} />} label="Hermes" active={Boolean(state.hermes?.installed)} />
              <FlowStep icon={<Bot size={14} />} label="Agents" active={activeRuns.length > 0} />
              <FlowStep icon={<ShieldCheck size={14} />} label="Review" active={completedRuns.length > 0} />
            </div>
          </div>
          <div className="missionCard compactMetric">
            <span>Active</span>
            <strong>{activeRuns.length}</strong>
            <small>running or pending</small>
          </div>
          <div className="missionCard compactMetric">
            <span>Memory</span>
            <strong>{state.memory.length}</strong>
            <small>recent entries</small>
          </div>
        </section>

        <section className="roomHeading">
          <div>
            <span className="tinyLabel">{roomCopy[activeRoom].eyebrow}</span>
            <h2>{roomCopy[activeRoom].label}</h2>
            <p>{roomCopy[activeRoom].description}</p>
          </div>
          <div className="roomTabs" role="tablist" aria-label="Room views">
            {(Object.keys(roomCopy) as ActiveRoom[]).map((room) => (
              <button key={room} className={activeRoom === room ? "active" : ""} onClick={() => setActiveRoom(room)}>
                {roomCopy[room].label.replace(" Room", "")}
              </button>
            ))}
          </div>
        </section>

        <section className={terminalFocus && activeRoom === "command" ? "roomGrid terminalFocusGrid" : "roomGrid"}>
          <div className="mainRoom">
            {activeRoom === "command" && (
              <CommandRoom
                workspace={workspace}
                sessions={embeddedSessions}
                busy={busy}
                focused={terminalFocus}
                layoutResetNonce={layoutResetNonce}
                onFocusChange={setTerminalFocus}
                onLaunch={launchEmbedded}
                onClose={closeEmbeddedTerminal}
              />
            )}
            {activeRoom === "swarm" && <SwarmRoom roles={agentRoles} runs={activeRuns} adapters={state.adapters} />}
            {activeRoom === "review" && <ReviewRoom latestRun={latestRun} completedRuns={completedRuns} />}
            {activeRoom === "memory" && <MemoryRoom entries={memoryEntries} />}
          </div>
          {!(terminalFocus && activeRoom === "command") && <HermesMemoryPanel entries={memoryEntries} hermes={state.hermes} latestRun={latestRun} />}
        </section>
      </section>
    </main>
  );
}

function RoomButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button className={active ? "roomRailButton active" : "roomRailButton"} onClick={onClick} title={label}>
      {icon}
    </button>
  );
}

function StatusPill({ tone, children }: { tone: "ok" | "warn" | "bad"; children: ReactNode }) {
  return (
    <span className={`statusPill ${tone}`}>
      <span />
      {children}
    </span>
  );
}

function FlowStep({ icon, label, active }: { icon: ReactNode; label: string; active?: boolean }) {
  return (
    <div className={active ? "flowStep active" : "flowStep"}>
      {icon}
      <span>{label}</span>
    </div>
  );
}

function CommandRoom({
  workspace,
  sessions,
  busy,
  focused,
  layoutResetNonce,
  onFocusChange,
  onLaunch,
  onClose,
}: {
  workspace: string;
  sessions: EmbeddedTerminalSession[];
  busy: boolean;
  focused: boolean;
  layoutResetNonce: number;
  onFocusChange: (focused: boolean) => void;
  onLaunch: (kind: EmbeddedTerminalKind, count?: number) => Promise<void>;
  onClose: (id: string) => Promise<void>;
}) {
  const [paneOrder, setPaneOrder] = useState<string[]>([]);
  const [dragState, setDragState] = useState<PaneDragState | null>(null);
  const dragStartRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const dragTargetRef = useRef<string | null>(null);

  useEffect(() => {
    setPaneOrder((current) => {
      const sessionIds = sessions.map((session) => session.id);
      const known = current.filter((id) => sessionIds.includes(id));
      const added = sessionIds.filter((id) => !known.includes(id));
      return [...known, ...added];
    });
  }, [sessions]);

  useEffect(() => {
    if (layoutResetNonce === 0 || sessions.length === 0) return;
    setPaneOrder(sessions.map((session) => session.id));
  }, [layoutResetNonce, sessions]);

  const visibleSessions = paneOrder
    .map((id) => sessions.find((session) => session.id === id))
    .filter((session): session is EmbeddedTerminalSession => Boolean(session));
  const shownCount = visibleSessions.length;

  function arrangeGrid() {
    setPaneOrder(sessions.map((session) => session.id));
  }

  function movePaneToSlot(sourceSessionId: string, targetSessionId: string) {
    if (sourceSessionId === targetSessionId) return;
    setPaneOrder((current) => {
      const sourceIndex = current.indexOf(sourceSessionId);
      const targetIndex = current.indexOf(targetSessionId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const next = [...current];
      next[sourceIndex] = targetSessionId;
      next[targetIndex] = sourceSessionId;
      return next;
    });
  }

  function startPaneDrag(event: ReactPointerEvent, sessionId: string) {
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const chrome = event.currentTarget as HTMLElement;
    chrome.setPointerCapture(event.pointerId);
    dragStartRef.current = { id: sessionId, x: event.clientX, y: event.clientY };
    setDragState({ id: sessionId, deltaX: 0, deltaY: 0, targetId: null });

    const move = (moveEvent: PointerEvent) => {
      const dragStart = dragStartRef.current;
      if (!dragStart) return;
      const element = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY) as HTMLElement | null;
      const targetPane = element?.closest<HTMLElement>("[data-pane-id]");
      const targetId = targetPane?.dataset.paneId;
      const nextTargetId = targetId && targetId !== dragStart.id ? targetId : null;
      dragTargetRef.current = nextTargetId;
      setDragState({
        id: dragStart.id,
        deltaX: moveEvent.clientX - dragStart.x,
        deltaY: moveEvent.clientY - dragStart.y,
        targetId: nextTargetId,
      });
    };

    const end = () => {
      const dragStart = dragStartRef.current;
      const targetId = dragTargetRef.current;
      dragStartRef.current = null;
      dragTargetRef.current = null;
      if (dragStart && targetId) movePaneToSlot(dragStart.id, targetId);
      setDragState(null);
      chrome.removeEventListener("pointermove", move);
      chrome.removeEventListener("pointerup", end);
      chrome.removeEventListener("pointercancel", end);
    };

    chrome.addEventListener("pointermove", move);
    chrome.addEventListener("pointerup", end);
    chrome.addEventListener("pointercancel", end);
  }

  return (
    <div className={focused ? "roomPanel commandRoom focused" : "roomPanel commandRoom"}>
      <div className="roomPanelHeader">
        <div>
          <span className="tinyLabel">Embedded PTY control</span>
          <h3>Real terminals inside the workspace</h3>
          <span className="panelMeta">{sessions.length ? `${shownCount} running sessions` : "No sessions running"}</span>
        </div>
        <div className="buttonRow">
          <button className="ghostButton" onClick={() => onFocusChange(!focused)} title={focused ? "Exit terminal focus" : "Focus terminals"}>
            {focused ? <Minimize2 size={15} /> : <Maximize2 size={15} />} {focused ? "Exit Focus" : "Focus"}
          </button>
          <button className="ghostButton" onClick={() => void onLaunch("shell", 1)} disabled={!workspace || busy}>
            <TerminalSquare size={15} /> New Shell
          </button>
          <button className="ghostButton" onClick={arrangeGrid} disabled={sessions.length === 0}>
            <Layers3 size={15} /> Arrange Grid
          </button>
          <button className="primaryButton" onClick={() => void onLaunch("codex", 4)} disabled={!workspace || busy}>
            <Bot size={15} /> Codex Grid
          </button>
          <button className="primaryButton" onClick={() => void onLaunch("opencode", 4)} disabled={!workspace || busy}>
            <Bot size={15} /> OpenCode Grid
          </button>
          <button className="primaryButton" onClick={() => void onLaunch("claude", 4)} disabled={!workspace || busy}>
            <Bot size={15} /> Claude Grid
          </button>
        </div>
      </div>

      <div className="terminalStage embeddedStage slotTerminalStage">
        {visibleSessions.map((session) => (
          <div
            key={session.id}
            data-pane-id={session.id}
            className={[
              "terminalPane liveTerminalPane slotPane",
              dragState?.id === session.id ? "dragging" : "",
              dragState?.targetId === session.id ? "dropTarget" : "",
            ].filter(Boolean).join(" ")}
            style={
              dragState?.id === session.id
                ? { transform: `translate(${dragState.deltaX}px, ${dragState.deltaY}px)` }
                : undefined
            }
          >
            <div
              className="terminalChrome draggableChrome"
              onPointerDown={(event) => startPaneDrag(event, session.id)}
            >
              <button className="terminalControl close" onClick={() => void onClose(session.id)} title={`Close ${session.title}`} />
              <span className="dot amber" />
              <span className="dot green" />
              <strong>{session.title}</strong>
              <em>{session.status}{session.pid ? ` · pid ${session.pid}` : ""}</em>
            </div>
            <EmbeddedTerminal session={session} />
          </div>
        ))}
        {visibleSessions.length === 0 && (
          <div className="terminalEmptyState">
            <TerminalSquare size={34} />
            <strong>No embedded terminals yet.</strong>
            <span>Select a workspace, then start a shell or launch a four-pane Codex grid with Hermes memory attached.</span>
          </div>
        )}
      </div>

      <div className="sessionStrip embeddedSessionStrip">
        {sessions.map((session) => (
          <div key={session.id} className="sessionChip active">
            <TerminalSquare size={15} />
            <div>
              <strong>{session.title}</strong>
              <span>{session.kind} · {session.status}{session.promptPath ? " · Hermes prompt" : ""}</span>
            </div>
          </div>
        ))}
        {sessions.length === 0 &&            <p>Embedded terminals replace the old pop-out launcher. This is the Context Workspace surface.</p>}
      </div>
    </div>
  );
}

function terminalGridTitles(kind: EmbeddedTerminalKind): string[] {
  if (kind === "codex") return ["Codex Builder", "Codex Reviewer", "Codex Scout", "Codex Fixer"];
  if (kind === "opencode") return ["OpenCode Builder", "OpenCode Reviewer", "OpenCode Scout", "OpenCode Fixer"];
  if (kind === "claude") return ["Claude Builder", "Claude Reviewer", "Claude Scout", "Claude Fixer"];
  return ["Shell"];
}

function SwarmRoom({ roles, runs, adapters }: { roles: AgentRole[]; runs: Run[]; adapters: Record<string, AdapterStatus> }) {
  return (
    <div className="roomPanel swarmRoom">
      <div className="agentRoleGrid">
        {roles.map((agent) => (
          <article key={agent.role} className={`agentCard ${agent.status}`}>
            <div className="agentCardTop">
              <div className="agentIcon">{agent.icon}</div>
              <StatusDot status={agent.status} />
            </div>
            <span className="tinyLabel">{agent.type}</span>
            <h3>{agent.role}</h3>
            <p>{agent.brief}</p>
            <div className="agentCardFooter">
              <span>{agent.status}</span>
              <ChevronRight size={16} />
            </div>
          </article>
        ))}
      </div>

      <div className="liveRunBoard">
        <div className="roomPanelHeader compact">
          <div>
            <span className="tinyLabel">Live agents</span>
            <h3>{runs.length ? "Work in motion" : "Ready room"}</h3>
          </div>
          <StatusPill tone={adapters.codex?.installed ? "ok" : "warn"}>{adapters.codex?.installed ? "Codex installed" : "Codex missing"}</StatusPill>
        </div>
        <div className="runTimeline">
          {runs.map((run) => (
            <article key={run.run_id}>
              <CircleDot size={16} />
              <div>
                <strong>{run.agent_id}</strong>
                <p>{run.task}</p>
              </div>
              <span>{run.status}</span>
            </article>
          ))}
          {runs.length === 0 && (
            <div className="emptyState">
              <Workflow size={22} />
              <strong>No active swarm yet.</strong>
              <span>Launch a run from Hermes and this board becomes the live crew map.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ReviewRoom({ latestRun, completedRuns }: { latestRun: Run | null; completedRuns: Run[] }) {
  const failed = completedRuns.filter((run) => run.status === "failed" || run.status === "cancelled");
  const passed = completedRuns.filter((run) => run.status === "succeeded");
  return (
    <div className="roomPanel reviewRoom">
      <div className="decisionHero">
        <div>
          <span className="tinyLabel">Decision point</span>
          <h3>{latestRun ? latestRun.task : "No run selected yet"}</h3>
          <p>Hermes turns terminal noise into a concise review packet before anything ships.</p>
        </div>
        <div className={failed.length ? "decisionBadge risk" : passed.length ? "decisionBadge ship" : "decisionBadge idle"}>
          {failed.length ? <XCircle size={20} /> : passed.length ? <CheckCircle2 size={20} /> : <Activity size={20} />}
          <span>{failed.length ? "Needs work" : passed.length ? "Ready to review" : "Waiting"}</span>
        </div>
      </div>

      <div className="reviewColumns">
        <ReviewCard title="Changed files" icon={<Code2 size={17} />} items={["Artifacts captured per run", "stdout.log / stderr.log", "result.md summary"]} />
        <ReviewCard title="Checks" icon={<ShieldCheck size={17} />} items={[`${passed.length} successful runs`, `${failed.length} blocked runs`, "Human approval required"]} />
        <ReviewCard title="Next actions" icon={<Play size={17} />} items={["Spawn reviewer", "Fix failures", "Save decision to memory"]} />
      </div>

      <div className="completedRuns">
        {completedRuns.slice(-6).reverse().map((run) => (
          <article key={run.run_id}>
            <StatusDot status={run.status === "succeeded" ? "ready" : "offline"} />
            <div>
              <strong>{run.agent_id}</strong>
              <span>{run.task}</span>
            </div>
            <em>{run.status}</em>
          </article>
        ))}
        {completedRuns.length === 0 && <p>No completed runs yet. The first finished agent will produce the review packet.</p>}
      </div>
    </div>
  );
}

function ReviewCard({ title, icon, items }: { title: string; icon: ReactNode; items: string[] }) {
  return (
    <article className="reviewCard">
      <div className="reviewCardIcon">{icon}</div>
      <h4>{title}</h4>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </article>
  );
}

function MemoryRoom({ entries }: { entries: string[] }) {
  return (
    <div className="roomPanel memoryRoomFull">
      <div className="memoryHero">
        <BrainCircuit size={28} />
        <div>
          <span className="tinyLabel">Hermes source of truth</span>
          <h3>Every future agent inherits this trail.</h3>
          <p>Project decisions, agent questions, task outcomes, and user preferences stay available across sessions.</p>
        </div>
      </div>
      <div className="memoryGrid">
        {entries.map((entry, index) => (
          <article key={`${index}-${entry.slice(0, 24)}`} className="memoryCard">
            <span>memory · {String(index + 1).padStart(2, "0")}</span>
            <p>{entry}</p>
          </article>
        ))}
        {entries.length === 0 && <p className="emptyStateText">No memory entries loaded.</p>}
      </div>
    </div>
  );
}

function HermesMemoryPanel({ entries, hermes, latestRun }: { entries: string[]; hermes: HermesStatus | null; latestRun: Run | null }) {
  return (
    <aside className="memorySidecar">
      <div className="sidecarHeader">
        <div>
          <span className="tinyLabel">Hermes riding on top</span>
          <h3>Shared Memory</h3>
        </div>
        <BrainCircuit size={20} />
      </div>
      <div className="contextStack">
        <article className="contextCard highlighted">
          <span>What agents receive</span>
          <strong>Task context + relevant memory + dynamic lookup URL</strong>
        </article>
        <article className="contextCard">
          <span>Hermes home</span>
          <strong>{hermes?.hermes_home ?? "checking"}</strong>
        </article>
        <article className="contextCard">
          <span>Latest run</span>
          <strong>{latestRun ? `${latestRun.agent_id} · ${latestRun.status}` : "none yet"}</strong>
        </article>
      </div>
      <div className="memoryListHeader">
        <span>Recent memory</span>
        <Sparkles size={15} />
      </div>
      <div className="sideMemoryList">
        {entries.slice(0, 8).map((entry, index) => (
          <article key={`${index}-${entry.slice(0, 18)}`}>
            <Layers3 size={14} />
            <p>{entry}</p>
          </article>
        ))}
        {entries.length === 0 && <p>No entries loaded.</p>}
      </div>
    </aside>
  );
}

function StatusDot({ status }: { status: "ready" | "running" | "waiting" | "offline" }) {
  return <span className={`statusDot ${status}`} />;
}
