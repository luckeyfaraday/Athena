import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Bot, CheckCircle2, Code2, FileText, Play, ScrollText, Sparkles, TerminalSquare, XCircle } from "lucide-react";
import type { RecallSourceSession, WorkspaceSnapshot } from "../api";
import {
  desktop,
  type AgentSession,
  type EmbeddedTerminalDataPayload,
  type EmbeddedTerminalKind,
  type EmbeddedTerminalSession,
} from "../electron";
import { agentSessionDotStatus, embeddedSessionDotStatus, inspectorStatusView, StatusDot, StatusPill } from "../components/status";
import {
  byteLength,
  embeddedSessionKey,
  providerLabel,
  selectedAgentSessionKey,
  type AgentTranscriptState,
  type HandoffPreview,
} from "../session-utils";
import { normalizeWorkspaceKey } from "../workspace-utils";
import type { HandoffAgentKind } from "../handoff-launch";

const inspectorBufferTailChars = 80_000;
const inspectorBufferFlushMs = 120;
const visibleHandoffSourceLimit = 60;
const handoffSchemaVersion = 2;

type HandoffSourceProvider = EmbeddedTerminalKind | AgentSession["provider"];

type HandoffSessionSource =
  | {
      key: string;
      selectionKey: string;
      kind: "embedded";
      title: string;
      label: string;
      status: string;
      id: string;
      workspace: string;
      provider: HandoffSourceProvider;
      session: EmbeddedTerminalSession;
    }
  | {
      key: string;
      selectionKey: string;
      kind: "native";
      title: string;
      label: string;
      status: string;
      id: string;
      workspace: string;
      provider: HandoffSourceProvider;
      session: AgentSession;
    };

type HandoffEvidence = HandoffSessionSource & {
  evidence: string;
  analysis: HandoffAnalysis;
  usable: boolean;
  note: string | null;
};

type HandoffAnalysis = {
  score: number;
  files: string[];
  commands: string[];
  outcomes: string[];
  failures: string[];
  decisions: string[];
  questions: string[];
  nextSteps: string[];
  notable: string[];
};

type HandoffBuild = {
  markdown: string;
  handoffId: string;
  confidence: "high" | "medium" | "low";
  sourceWorkspaces: string[];
  sourceSessions: RecallSourceSession[];
};

export function ReviewRoom({
  embeddedSessions,
  agentSessions,
  selectedEmbeddedSession,
  selectedAgentSession,
  selectedSessionKey,
  agentTranscript,
  workspace,
  onSelectEmbeddedSession,
  onSelectAgentSession,
  onLoadAgentTranscript,
  onReadAgentTranscript,
  onLoadWorkspaceSnapshot,
  onSaveHandoff,
  onStartFreshFromHandoff,
}: {
  embeddedSessions: EmbeddedTerminalSession[];
  agentSessions: AgentSession[];
  selectedEmbeddedSession: EmbeddedTerminalSession | null;
  selectedAgentSession: AgentSession | null;
  selectedSessionKey: string | null;
  agentTranscript: AgentTranscriptState | null;
  workspace: string;
  onSelectEmbeddedSession: (session: EmbeddedTerminalSession) => void;
  onSelectAgentSession: (session: AgentSession) => void;
  onLoadAgentTranscript: (session: AgentSession) => Promise<string>;
  onReadAgentTranscript: (session: AgentSession) => Promise<string>;
  onLoadWorkspaceSnapshot: () => Promise<WorkspaceSnapshot | null>;
  onSaveHandoff: (preview: HandoffPreview) => Promise<void>;
  onStartFreshFromHandoff: (kind: HandoffAgentKind, preview: HandoffPreview) => Promise<void>;
}) {
  const [handoffSelection, setHandoffSelection] = useState<Set<string>>(() => new Set());
  const [handoffPreview, setHandoffPreview] = useState<HandoffPreview | null>(null);
  const [handoffGenerating, setHandoffGenerating] = useState(false);
  const [handoffSaving, setHandoffSaving] = useState(false);
  const [handoffLaunching, setHandoffLaunching] = useState<EmbeddedTerminalKind | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [handoffSavedAt, setHandoffSavedAt] = useState<string | null>(null);
  const [handoffProviderTab, setHandoffProviderTab] = useState<HandoffSourceProvider | "all">("all");
  const [handoffWorkspaceTab, setHandoffWorkspaceTab] = useState("all");
  const [handoffQuery, setHandoffQuery] = useState("");
  const selectedLabel = selectedEmbeddedSession?.title ?? selectedAgentSession?.title ?? "No session selected";
  const liveAgentSessions = embeddedSessions.filter((session) => session.kind !== "shell" && session.status === "running");
  const historicalAgentSessions = agentSessions.filter((session) => session.status === "historical");
  const handoffSources = useMemo<HandoffSessionSource[]>(
    () => [
      ...embeddedSessions.map((session) => {
        const selectionKey = embeddedSessionKey(session);
        return {
          key: handoffSourceKey(session.workspace, selectionKey),
          selectionKey,
          kind: "embedded" as const,
          title: session.title,
          label: `embedded ${session.kind}`,
          status: session.status,
          id: session.id,
          workspace: session.workspace,
          session,
          provider: session.kind,
        };
      }),
      ...agentSessions.map((session) => {
        const selectionKey = selectedAgentSessionKey(session);
        return {
          key: handoffSourceKey(session.workspace, selectionKey),
          selectionKey,
          kind: "native" as const,
          title: session.title,
          label: `native ${providerLabel(session.provider)}`,
          status: session.status,
          id: session.id,
          workspace: session.workspace,
          session,
          provider: session.provider,
        };
      }),
    ],
    [agentSessions, embeddedSessions],
  );
  const handoffProviderTabs = useMemo(() => {
    const counts = new Map<HandoffSourceProvider | "all", number>([["all", handoffSources.length]]);
    for (const source of handoffSources) {
      counts.set(source.provider, (counts.get(source.provider) ?? 0) + 1);
    }
    return (["all", "codex", "opencode", "athena", "claude", "grok", "hermes", "shell"] as (HandoffSourceProvider | "all")[])
      .filter((provider) => provider === "all" || (counts.get(provider) ?? 0) > 0)
      .map((provider) => ({
        provider,
        label: provider === "all" ? "All" : provider === "shell" ? "Shell" : providerLabel(provider as AgentSession["provider"]),
        count: counts.get(provider) ?? 0,
      }));
  }, [handoffSources]);
  const handoffWorkspaceTabs = useMemo(() => {
    const counts = new Map<string, { workspace: string; count: number }>();
    for (const source of handoffSources) {
      const key = sourceWorkspaceKey(source.workspace);
      const current = counts.get(key);
      counts.set(key, { workspace: current?.workspace ?? source.workspace, count: (current?.count ?? 0) + 1 });
    }
    return [
      { key: "all", label: "All workspaces", workspace: "", count: handoffSources.length },
      ...Array.from(counts.entries())
        .sort((left, right) => right[1].count - left[1].count || workspaceLabel(left[1].workspace).localeCompare(workspaceLabel(right[1].workspace)))
        .map(([key, value]) => ({ key, label: workspaceLabel(value.workspace), workspace: value.workspace, count: value.count })),
    ];
  }, [handoffSources]);
  const normalizedHandoffQuery = handoffQuery.trim().toLowerCase();
  const visibleHandoffSources = handoffSources.filter((source) => {
    if (handoffProviderTab !== "all" && source.provider !== handoffProviderTab) return false;
    if (handoffWorkspaceTab !== "all" && sourceWorkspaceKey(source.workspace) !== handoffWorkspaceTab) return false;
    if (!normalizedHandoffQuery) return true;
    return [source.title, source.label, source.status, source.id, source.workspace, source.provider]
      .join(" ")
      .toLowerCase()
      .includes(normalizedHandoffQuery);
  });
  const hiddenHandoffSourceCount = Math.max(0, visibleHandoffSources.length - visibleHandoffSourceLimit);
  const selectedHandoffSources = handoffSelection.size > 0
    ? handoffSources.filter((source) => handoffSelection.has(source.key))
    : handoffSources.filter((source) => source.selectionKey === selectedSessionKey);
  const selectedHandoffWorkspaceCount = new Set(selectedHandoffSources.map((source) => sourceWorkspaceKey(source.workspace))).size;
  const selectedHandoffSignature = selectedHandoffSources
    .map((source) => `${source.key}:${source.status}:${source.workspace}`)
    .sort()
    .join("|");
  const canCreateHandoff = selectedHandoffSources.length > 0 && !handoffGenerating;

  useEffect(() => {
    const available = new Set(handoffSources.map((source) => source.key));
    setHandoffSelection((current) => {
      const next = new Set([...current].filter((key) => available.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [handoffSources]);

  useEffect(() => {
    if (handoffProviderTab === "all") return;
    if (handoffSources.some((source) => source.provider === handoffProviderTab)) return;
    setHandoffProviderTab("all");
  }, [handoffProviderTab, handoffSources]);

  useEffect(() => {
    if (handoffWorkspaceTab === "all") return;
    if (handoffSources.some((source) => sourceWorkspaceKey(source.workspace) === handoffWorkspaceTab)) return;
    setHandoffWorkspaceTab("all");
  }, [handoffWorkspaceTab, handoffSources]);

  useEffect(() => {
    setHandoffPreview(null);
    setHandoffError(null);
    setHandoffSavedAt(null);
  }, [workspace, selectedHandoffSignature]);

  function toggleHandoffSource(key: string) {
    setHandoffSelection((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setHandoffPreview(null);
    setHandoffError(null);
    setHandoffSavedAt(null);
  }

  async function createHandoffPreview() {
    if (!workspace || selectedHandoffSources.length === 0) return;
    setHandoffGenerating(true);
    setHandoffError(null);
    try {
      const [evidence, workspaceSnapshot] = await Promise.all([
        Promise.all(selectedHandoffSources.map((source) => loadHandoffEvidence(source, onReadAgentTranscript))),
        onLoadWorkspaceSnapshot().catch(() => null),
      ]);
      if (!evidence.some((source) => source.usable)) {
        setHandoffPreview(null);
        setHandoffError("No usable handoff evidence found. Pick live sessions with task output or sessions with readable transcripts.");
        return;
      }
      const handoff = buildHandoffMarkdown(workspace, evidence, workspaceSnapshot);
      setHandoffPreview({
        markdown: handoff.markdown,
        bytes: byteLength(handoff.markdown),
        sourceCount: evidence.length,
        sourceTitles: evidence.map((source) => `${source.title} (${workspaceLabel(source.workspace)})`),
        schemaVersion: handoffSchemaVersion,
        handoffId: handoff.handoffId,
        confidence: handoff.confidence,
        sourceWorkspaces: handoff.sourceWorkspaces,
        sourceSessions: handoff.sourceSessions,
        workspace,
      });
    } catch (err) {
      setHandoffError(String(err));
    } finally {
      setHandoffGenerating(false);
    }
  }

  async function saveHandoffPreview() {
    if (!handoffPreview) return;
    setHandoffSaving(true);
    setHandoffError(null);
    try {
      await onSaveHandoff(handoffPreview);
      setHandoffSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setHandoffError(String(err));
    } finally {
      setHandoffSaving(false);
    }
  }

  async function startFreshFromHandoff(kind: HandoffAgentKind) {
    if (!handoffPreview) return;
    setHandoffLaunching(kind);
    setHandoffError(null);
    try {
      await onStartFreshFromHandoff(kind, handoffPreview);
      setHandoffSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setHandoffError(String(err));
    } finally {
      setHandoffLaunching(null);
    }
  }

  return (
    <div className="roomPanel reviewRoom">
      <div className="decisionHero">
        <div>
          <span className="tinyLabel">Session review</span>
          <h3>{selectedLabel}</h3>
          <p>Inspect live buffers, native history, and source evidence across open workspaces before creating a handoff.</p>
        </div>
        <div className={liveAgentSessions.length ? "decisionBadge ship" : historicalAgentSessions.length ? "decisionBadge idle" : "decisionBadge risk"}>
          {liveAgentSessions.length ? <Activity size={20} /> : historicalAgentSessions.length ? <Code2 size={20} /> : <XCircle size={20} />}
          <span>{liveAgentSessions.length ? `${liveAgentSessions.length} live` : historicalAgentSessions.length ? `${historicalAgentSessions.length} historical` : "No sessions"}</span>
        </div>
      </div>

      <div className="reviewColumns">
        <ReviewCard title="Live buffers" icon={<TerminalSquare size={17} />} items={[`${embeddedSessions.length} embedded terminals`, `${liveAgentSessions.length} live agent panes`, "Terminal output captured from panes"]} />
        <ReviewCard title="Native history" icon={<Code2 size={17} />} items={[`${historicalAgentSessions.length} historical sessions`, "Provider metadata", "Transcript reads when available"]} />
        <ReviewCard title="Handoff scope" icon={<Play size={17} />} items={[`${Math.max(0, handoffWorkspaceTabs.length - 1)} workspaces in review`, "Cross-workspace evidence basket", "Active workspace is the launch target"]} />
      </div>

      <section className="handoffPanel">
        <div className="handoffPanelHeader">
          <div>
            <span className="tinyLabel">Session continuity</span>
            <strong>
              {selectedHandoffSources.length
                ? `${selectedHandoffSources.length} selected across ${selectedHandoffWorkspaceCount} workspace${selectedHandoffWorkspaceCount === 1 ? "" : "s"}`
                : "Select sessions for handoff"}
            </strong>
          </div>
          <div className="sessionInspectorActions">
            <button type="button" className="ghostButton" onClick={() => void createHandoffPreview()} disabled={!canCreateHandoff}>
              <FileText size={14} /> {handoffGenerating ? "Creating" : "Create handoff"}
            </button>
            <button type="button" className="ghostButton" onClick={() => void saveHandoffPreview()} disabled={!handoffPreview || handoffSaving}>
              <CheckCircle2 size={14} /> {handoffSaving ? "Saving" : "Save to recall"}
            </button>
          </div>
        </div>
        <p>Build a bounded handoff from selected sources across workspaces. Save and launch still target the active workspace: {workspace || "none"}.</p>
        <div className="handoffProviderTabs" aria-label="Handoff source providers">
          {handoffProviderTabs.map((tab) => (
            <button
              key={tab.provider}
              type="button"
              className={handoffProviderTab === tab.provider ? "active" : ""}
              onClick={() => setHandoffProviderTab(tab.provider)}
            >
              {tab.label}
              <span>{tab.count}</span>
            </button>
          ))}
        </div>
        <div className="handoffWorkspaceTabs" aria-label="Handoff source workspaces">
          {handoffWorkspaceTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={handoffWorkspaceTab === tab.key ? "active" : ""}
              title={tab.workspace || "All workspaces"}
              onClick={() => setHandoffWorkspaceTab(tab.key)}
            >
              {tab.label}
              <span>{tab.count}</span>
            </button>
          ))}
        </div>
        <div className="handoffFilters">
          <input
            type="search"
            value={handoffQuery}
            placeholder="Search title, workspace, provider, status"
            aria-label="Search handoff sources"
            onChange={(event) => setHandoffQuery(event.target.value)}
          />
          <button
            type="button"
            className="ghostButton"
            onClick={() => {
              setHandoffSelection(new Set());
              setHandoffPreview(null);
              setHandoffError(null);
              setHandoffSavedAt(null);
            }}
            disabled={handoffSelection.size === 0}
          >
            Clear basket
          </button>
        </div>
        <div className="handoffSourcePicker" aria-label="Handoff sources">
          {visibleHandoffSources.slice(0, visibleHandoffSourceLimit).map((source) => {
            const selected = handoffSelection.has(source.key) || (handoffSelection.size === 0 && selectedSessionKey === source.selectionKey);
            return (
              <button
                key={source.key}
                type="button"
                className={selected ? "handoffSourceChip selected" : "handoffSourceChip"}
                onClick={() => toggleHandoffSource(source.key)}
              >
                {selected ? <CheckCircle2 size={13} /> : <span />}
                <strong>{source.title}</strong>
                <em>{source.label}</em>
                <small>{workspaceLabel(source.workspace)}</small>
              </button>
            );
          })}
          {handoffSources.length === 0 && <span className="handoffSourceEmpty">No sessions available for handoff.</span>}
          {handoffSources.length > 0 && visibleHandoffSources.length === 0 && <span className="handoffSourceEmpty">No sessions match these filters.</span>}
          {hiddenHandoffSourceCount > 0 && <span className="handoffSourceEmpty">{hiddenHandoffSourceCount} more sources hidden. Refine the search or workspace filter.</span>}
        </div>
        {selectedHandoffSources.length > 0 && (
          <div className="handoffSelectionBasket" aria-label="Selected handoff sources">
            {selectedHandoffSources.map((source) => (
              <button key={source.key} type="button" onClick={() => toggleHandoffSource(source.key)} title={`Remove ${source.title}`}>
                <strong>{source.title}</strong>
                <span>{workspaceLabel(source.workspace)}</span>
              </button>
            ))}
          </div>
        )}
        {handoffError && <p className="handoffError">{handoffError}</p>}
        {handoffSavedAt && <p className="handoffSaved">Saved to recall at {handoffSavedAt}</p>}
        {handoffPreview && (
          <div className="handoffPreview">
            <div>
              <span>{handoffPreview.sourceCount} sources</span>
              <span>{selectedHandoffWorkspaceCount} workspaces</span>
              <span>{handoffPreview.bytes} bytes</span>
              <span>{handoffPreview.workspace}</span>
            </div>
            <pre>{handoffPreview.markdown}</pre>
            <div className="handoffLaunchActions">
              <button type="button" className="ghostButton" onClick={() => void startFreshFromHandoff("codex")} disabled={Boolean(handoffLaunching)}>
                <Bot size={14} /> {handoffLaunching === "codex" ? "Launching" : "Start Codex"}
              </button>
              <button type="button" className="ghostButton" onClick={() => void startFreshFromHandoff("opencode")} disabled={Boolean(handoffLaunching)}>
                <Code2 size={14} /> {handoffLaunching === "opencode" ? "Launching" : "Start OpenCode"}
              </button>
              <button type="button" className="ghostButton" onClick={() => void startFreshFromHandoff("claude")} disabled={Boolean(handoffLaunching)}>
                <Sparkles size={14} /> {handoffLaunching === "claude" ? "Launching" : "Start Claude"}
              </button>
              <button type="button" className="ghostButton" onClick={() => void startFreshFromHandoff("athena")} disabled={Boolean(handoffLaunching)}>
                <ScrollText size={14} /> {handoffLaunching === "athena" ? "Launching" : "Start Athena Code"}
              </button>
              <button type="button" className="ghostButton" onClick={() => void startFreshFromHandoff("grok")} disabled={Boolean(handoffLaunching)}>
                <Bot size={14} /> {handoffLaunching === "grok" ? "Launching" : "Start Grok"}
              </button>
            </div>
          </div>
        )}
      </section>

      <div className="sessionReviewList">
        {embeddedSessions.map((session) => {
          const selectionKey = embeddedSessionKey(session);
          const handoffKey = handoffSourceKey(session.workspace, selectionKey);
          const included = handoffSelection.has(handoffKey);
          return (
            <article
              key={handoffKey}
              className={selectedSessionKey === selectionKey || included ? "selected" : ""}
              onClick={() => onSelectEmbeddedSession(session)}
            >
              <button
                type="button"
                className={included ? "handoffSelectButton selected" : "handoffSelectButton"}
                aria-pressed={included}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleHandoffSource(handoffKey);
                }}
              >
                {included ? <CheckCircle2 size={14} /> : <span />}
                {included ? "Selected" : "Include"}
              </button>
              <StatusDot status={embeddedSessionDotStatus(session.status)} />
              <div>
                <strong>{session.title}</strong>
                <span>{session.kind} · {workspaceLabel(session.workspace)} · {session.status}{session.promptPath ? " · prompt attached" : ""}</span>
              </div>
              <em>{session.pid ? `pid ${session.pid}` : "no pid"}</em>
              <button type="button" className="ghostIconButton" onClick={(event) => {
                event.stopPropagation();
                onSelectEmbeddedSession(session);
              }}>
                <FileText size={14} />
              </button>
            </article>
          );
        })}
        {agentSessions.map((session) => {
          const selectionKey = selectedAgentSessionKey(session);
          const handoffKey = handoffSourceKey(session.workspace, selectionKey);
          const included = handoffSelection.has(handoffKey);
          return (
            <article
              key={handoffKey}
              className={selectedSessionKey === selectionKey || included ? "selected" : ""}
              onClick={() => onSelectAgentSession(session)}
            >
              <button
                type="button"
                className={included ? "handoffSelectButton selected" : "handoffSelectButton"}
                aria-pressed={included}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleHandoffSource(handoffKey);
                }}
              >
                {included ? <CheckCircle2 size={14} /> : <span />}
                {included ? "Selected" : "Include"}
              </button>
              <StatusDot status={agentSessionDotStatus(session.status)} />
              <div>
                <strong>{session.title}</strong>
                <span>{providerLabel(session.provider)} · {workspaceLabel(session.workspace)} · {session.id}</span>
              </div>
              <em>{session.status}</em>
              <button type="button" className="ghostIconButton" onClick={(event) => {
                event.stopPropagation();
                onSelectAgentSession(session);
              }}>
                <FileText size={14} />
              </button>
              <button type="button" className="ghostIconButton" onClick={(event) => {
                event.stopPropagation();
                void onLoadAgentTranscript(session);
              }}>
                <ScrollText size={14} />
              </button>
            </article>
          );
        })}
        {embeddedSessions.length === 0 && agentSessions.length === 0 && <p>No sessions yet. Launch an embedded agent or resume a native session from the Command Room.</p>}
      </div>
      <SessionInspector embeddedSession={selectedEmbeddedSession} agentSession={selectedAgentSession} agentTranscript={agentTranscript} onLoadAgentTranscript={onLoadAgentTranscript} />
    </div>
  );
}

function SessionInspector({
  embeddedSession,
  agentSession,
  agentTranscript,
  onLoadAgentTranscript,
}: {
  embeddedSession: EmbeddedTerminalSession | null;
  agentSession: AgentSession | null;
  agentTranscript: AgentTranscriptState | null;
  onLoadAgentTranscript: (session: AgentSession) => Promise<string>;
}) {
  const [buffer, setBuffer] = useState("");
  const pendingBufferRef = useRef("");
  const flushTimerRef = useRef<number | null>(null);
  const terminalId = embeddedSession?.id ?? agentSession?.terminalId ?? null;
  const transcriptKey = agentSession ? selectedAgentSessionKey(agentSession) : null;
  const transcript = transcriptKey && agentTranscript?.key === transcriptKey ? agentTranscript : null;
  const inspectorStatus = inspectorStatusView({
    terminalId,
    hasTranscript: Boolean(transcript?.text),
    hasAgentSession: Boolean(agentSession),
  });

  useEffect(() => {
    pendingBufferRef.current = "";
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (!terminalId) {
      setBuffer("");
      return;
    }

    let cancelled = false;
    let attached = false;
    let streamEpoch: string | null = null;
    let throughSequence = 0;
    let attachGeneration = 0;
    const beforeAttach: EmbeddedTerminalDataPayload[] = [];
    const flushPending = () => {
      flushTimerRef.current = null;
      const pending = pendingBufferRef.current;
      pendingBufferRef.current = "";
      if (!pending) return;
      setBuffer((current) => tailBuffer(`${current}${pending}`, inspectorBufferTailChars));
    };
    const applyPayload = (payload: EmbeddedTerminalDataPayload) => {
      if (!attached) {
        beforeAttach.push(payload);
        return;
      }
      if (payload.epoch !== streamEpoch || (!payload.reset && payload.fromSequence > throughSequence + 1)) {
        void attachStream();
        return;
      }
      if (payload.sequence <= throughSequence) return;
      throughSequence = payload.sequence;
      if (payload.reset) {
        if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
        pendingBufferRef.current = "";
        setBuffer(tailBuffer(payload.data, inspectorBufferTailChars));
      } else {
        pendingBufferRef.current += payload.data;
        if (flushTimerRef.current === null) {
          flushTimerRef.current = window.setTimeout(flushPending, inspectorBufferFlushMs);
        }
      }
    };
    const attachStream = async () => {
      const generation = ++attachGeneration;
      attached = false;
      const snapshot = await desktop.attachEmbeddedTerminalStream(terminalId).catch(() => null);
      if (!snapshot || cancelled || generation !== attachGeneration) return;
      streamEpoch = snapshot.epoch;
      throughSequence = snapshot.throughSequence;
      pendingBufferRef.current = "";
      setBuffer(tailBuffer(snapshot.buffer, inspectorBufferTailChars));
      attached = true;
      const deferred = beforeAttach.splice(0);
      for (const payload of deferred) {
        if (payload.epoch === snapshot.epoch && payload.sequence <= snapshot.throughSequence) continue;
        applyPayload(payload);
      }
    };
    const removeData = desktop.onEmbeddedTerminalDataFor(terminalId, applyPayload);
    void attachStream();
    return () => {
      cancelled = true;
      attachGeneration += 1;
      removeData();
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      pendingBufferRef.current = "";
      beforeAttach.length = 0;
    };
  }, [terminalId]);

  const metadata = embeddedSession
    ? [
        `Type: embedded ${embeddedSession.kind}`,
        `Status: ${embeddedSession.status}`,
        `Workspace: ${embeddedSession.workspace}`,
        `PID: ${embeddedSession.pid ?? "none"}`,
        `Prompt path: ${embeddedSession.promptPath ?? "none"}`,
        `Provider session: ${embeddedSession.providerSessionId ?? "none"}`,
      ]
    : agentSession
      ? [
          `Type: native ${providerLabel(agentSession.provider)}`,
          `Status: ${agentSession.status}`,
          `Workspace: ${agentSession.workspace}`,
          `Session ID: ${agentSession.id}`,
          `Model: ${agentSession.model ?? "unknown"}`,
          `Agent: ${agentSession.agent ?? "default"}`,
          `Branch: ${agentSession.branch ?? "unknown"}`,
          agentSession.metadata?.model_provider ? `Model provider: ${agentSession.metadata.model_provider}` : null,
          agentSession.metadata?.cli_version ? `CLI version: ${agentSession.metadata.cli_version}` : null,
          agentSession.metadata?.collaboration_mode ? `Collaboration: ${agentSession.metadata.collaboration_mode}` : null,
          agentSession.metadata?.approval_policy ? `Approval: ${agentSession.metadata.approval_policy}` : null,
          agentSession.metadata?.sandbox_policy ? `Sandbox: ${agentSession.metadata.sandbox_policy}` : null,
          agentSession.metadata?.git_commit_hash ? `Commit: ${agentSession.metadata.git_commit_hash}` : null,
          `Resume: ${agentSession.resumeCommand ?? "none"}`,
        ].filter((line): line is string => Boolean(line))
      : ["Select a session to inspect metadata and live buffer output."];

  return (
    <section className="sessionInspector">
      <div className="sessionInspectorHeader">
        <div>
          <span className="tinyLabel">Session inspector</span>
          <strong>{embeddedSession?.title ?? agentSession?.title ?? "No session selected"}</strong>
        </div>
        <div className="sessionInspectorActions">
          {agentSession && !terminalId && (
            <button type="button" className="ghostButton" onClick={() => void onLoadAgentTranscript(agentSession)} disabled={transcript?.loading}>
              <ScrollText size={14} /> {transcript?.loading ? "Loading" : "Transcript"}
            </button>
          )}
          <StatusPill tone={inspectorStatus.tone}>{inspectorStatus.label}</StatusPill>
        </div>
      </div>
      <div className="sessionInspectorGrid">
        <pre>{metadata.join("\n")}</pre>
        <pre>
          {terminalId
            ? buffer || "No terminal output captured yet."
            : transcript?.loading
              ? "Loading native session transcript..."
              : transcript?.error
                ? transcript.error
                : transcript?.text
                  ? transcript.text
                  : "No live terminal buffer is attached to this session. Use Transcript for native session content."}
        </pre>
      </div>
    </section>
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

async function loadHandoffEvidence(source: HandoffSessionSource, readAgentTranscript: (session: AgentSession) => Promise<string>): Promise<HandoffEvidence> {
  const terminalId = source.kind === "embedded" ? source.session.id : source.session.terminalId;
  if (!terminalId) {
    if (source.kind === "native") {
      try {
        const transcript = await readAgentTranscript(source.session);
        const analysis = analyzeHandoffEvidence(transcript, source);
        return {
          ...source,
          evidence: analysis.notable.join("\n"),
          analysis,
          usable: isUsableHandoffAnalysis(analysis),
          note: isUsableHandoffAnalysis(analysis) ? null : "Native transcript was readable, but it did not contain enough task evidence for a useful handoff.",
        };
      } catch (err) {
        return {
          ...source,
          evidence: "",
          analysis: emptyHandoffAnalysis(),
          usable: false,
          note: `Unable to read native transcript: ${String(err)}`,
        };
      }
    }
    return {
      ...source,
      evidence: "",
      analysis: emptyHandoffAnalysis(),
      usable: false,
      note: "No live terminal buffer is attached to this session.",
    };
  }
  try {
    const buffer = await desktop.getEmbeddedTerminalBuffer(terminalId);
    const analysis = analyzeHandoffEvidence(buffer, source);
    const evidence = analysis.notable.join("\n");
    return {
      ...source,
      evidence,
      analysis,
      usable: isUsableHandoffAnalysis(analysis),
      note: isUsableHandoffAnalysis(analysis) ? null : "No usable task evidence could be extracted from the terminal buffer.",
    };
  } catch (err) {
    return {
      ...source,
      evidence: "",
      analysis: emptyHandoffAnalysis(),
      usable: false,
      note: `Unable to read live buffer: ${String(err)}`,
    };
  }
}

function buildHandoffMarkdown(targetWorkspace: string, sources: HandoffEvidence[], workspaceSnapshot: WorkspaceSnapshot | null): HandoffBuild {
  const generated = new Date().toISOString();
  const usableSources = sources.filter((source) => source.usable);
  const unusableSources = sources.filter((source) => !source.usable);
  const combined = combineHandoffAnalyses(usableSources.map((source) => source.analysis));
  const sourceWorkspaces = uniqueSourceWorkspaces(sources);
  const sourceSessions = sources.map(sourceSessionMetadata);
  const handoffId = createHandoffId(generated, targetWorkspace, sources);
  const confidence = handoffConfidence(combined, sources, workspaceSnapshot);
  const confidenceReasons = handoffConfidenceReasons(confidence, combined, sources, workspaceSnapshot);
  const workspaceMap = formatWorkspaceMap(targetWorkspace, sourceWorkspaces, sources);
  const selectedSessions = sourceSessions.map(formatSourceSessionLine).join("\n");
  const evidenceSections: string[] = [];
  let remainingEvidenceChars = 10000;
  for (const source of usableSources) {
    if (remainingEvidenceChars <= 0) {
      evidenceSections.push(`### ${source.title}\n\n[omitted because handoff evidence reached its size cap]`);
      continue;
    }
    const evidence = [
      formatEvidenceGroup("Files touched or inspected", source.analysis.files, 10, 4),
      formatEvidenceGroup("Commands and checks", source.analysis.commands, 10, 4),
      formatEvidenceGroup("Outcomes", source.analysis.outcomes, 10, 4),
      formatEvidenceGroup("Failures or blockers", source.analysis.failures, 10, 4),
      formatEvidenceGroup("Decisions", source.analysis.decisions, 10, 4),
      formatEvidenceGroup("Open questions", source.analysis.questions, 8, 4),
      formatEvidenceGroup("Next steps", source.analysis.nextSteps, 8, 4),
      formatEvidenceGroup("Raw supporting excerpts", source.analysis.notable, 10, 4),
    ].filter(Boolean).join("\n\n");
    const cappedEvidence = tailText(evidence || "No evidence available.", Math.min(2200, remainingEvidenceChars));
    remainingEvidenceChars -= cappedEvidence.length;
    evidenceSections.push([`### ${source.title}`, formatSourceProvenance(source), cappedEvidence].join("\n\n"));
  }
  for (const source of unusableSources) {
    evidenceSections.push(`### ${source.title}\n\n${formatSourceProvenance(source)}\n\n${source.note ?? "No usable evidence found."}`);
  }
  const evidence = evidenceSections.join("\n\n");
  const markdown = [
    "# Athena Handoff",
    "",
    "---",
    `schema_version: ${handoffSchemaVersion}`,
    `handoff_id: ${handoffId}`,
    `generated_at: ${generated}`,
    `target_workspace: ${targetWorkspace}`,
    `source: athena-reviews`,
    `confidence: ${confidence}`,
    `source_count: ${sources.length}`,
    `usable_source_count: ${usableSources.length}`,
    `source_workspace_count: ${sourceWorkspaces.length}`,
    `evidence_score: ${combined.score}`,
    "---",
    "",
    "## Mission",
    "- Continue from the selected Athena sessions without losing useful project context.",
    "- Treat the latest user instruction as authoritative over this handoff.",
    "- Use the target workspace as the place where new work should happen unless the user says otherwise.",
    "",
    "## Current State",
    formatWorkspaceSnapshot(targetWorkspace, workspaceSnapshot),
    "",
    "## Handoff Quality",
    `- Confidence: ${confidence}`,
    `- Evidence score: ${combined.score}`,
    ...confidenceReasons.map((reason) => `- ${reason}`),
    unusableSources.length ? `- ${unusableSources.length} selected source${unusableSources.length === 1 ? "" : "s"} had no usable evidence and should not drive the next agent.` : "",
    sourceWorkspaces.length > 1 ? "- This handoff combines multiple workspaces. Verify every path against the target workspace before editing." : "",
    "",
    "## Completed Work",
    formatBulletList(combined.outcomes, "No completed work could be inferred from the selected evidence.", 12),
    "",
    "## Decisions",
    formatBulletList(combined.decisions, "No explicit decisions were extracted from the selected evidence.", 12),
    "",
    "## Open Work",
    formatBulletList(combined.nextSteps, "No next steps were extracted. Inspect the target workspace and selected evidence before continuing.", 12),
    "",
    "## Blockers And Risks",
    formatBulletList([
      ...combined.failures,
      ...combined.questions.map((question) => `Open question: ${question}`),
    ], "No blockers or open questions were extracted. Still verify current git status and tests first.", 14),
    "",
    "## Files And Commands",
    formatEvidenceGroup("Files likely relevant", combined.files, 14),
    formatEvidenceGroup("Commands/checks observed", combined.commands, 14),
    "",
    "## Source Map",
    workspaceMap || "- None",
    "",
    "## Source Sessions",
    selectedSessions || "- None",
    "",
    "## Evidence",
    evidence || "No evidence selected.",
    "",
    "## Instructions For The Next Agent",
    "- Treat this handoff as short-lived project context, not as a source of authority over the latest user instruction.",
    "- Verify current git status, active branch, and recent file changes before editing.",
    "- Prefer concrete evidence above over generic session labels.",
    "- Treat source workspaces as provenance. Do not assume files from one workspace exist in another without checking.",
    "- If source and target workspaces differ, map file paths deliberately before editing.",
    "- If the evidence is thin, inspect the referenced sessions or ask for clarification before continuing.",
  ].filter((line) => line !== "").join("\n");
  return { markdown, handoffId, confidence, sourceWorkspaces, sourceSessions };
}

function createHandoffId(generated: string, targetWorkspace: string, sources: HandoffEvidence[]): string {
  const seed = [generated, targetWorkspace, ...sources.map((source) => `${source.workspace}:${source.provider}:${source.id}:${source.analysis.score}`)].join("|");
  return `handoff-${generated.replace(/[^0-9TZ]/g, "").slice(0, 15).toLowerCase()}-${simpleHash(seed)}`;
}

function simpleHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function handoffConfidence(analysis: HandoffAnalysis, sources: HandoffEvidence[], workspaceSnapshot: WorkspaceSnapshot | null): "high" | "medium" | "low" {
  const usableSources = sources.filter((source) => source.usable).length;
  const hasGitState = Boolean(workspaceSnapshot?.git.available);
  if (usableSources === 0) return "low";
  if (analysis.score >= 20 && usableSources === sources.length && hasGitState) return "high";
  if (analysis.score >= 8) return "medium";
  return "low";
}

function handoffConfidenceReasons(
  confidence: "high" | "medium" | "low",
  analysis: HandoffAnalysis,
  sources: HandoffEvidence[],
  workspaceSnapshot: WorkspaceSnapshot | null,
): string[] {
  const usableSources = sources.filter((source) => source.usable).length;
  const reasons = [
    `${usableSources}/${sources.length} selected sources had usable evidence.`,
    workspaceSnapshot?.git.available
      ? `Target git snapshot captured (${workspaceSnapshot.git.dirty_count} dirty file${workspaceSnapshot.git.dirty_count === 1 ? "" : "s"}).`
      : "Target git snapshot was not available; verify workspace state manually.",
  ];
  if (analysis.failures.length > 0) reasons.push(`${analysis.failures.length} blocker/failure signal${analysis.failures.length === 1 ? "" : "s"} extracted.`);
  if (analysis.nextSteps.length === 0) reasons.push("No explicit next steps were extracted.");
  if (confidence === "low") reasons.push("Use this handoff as orientation only until current state is verified.");
  return reasons;
}

function formatWorkspaceSnapshot(targetWorkspace: string, snapshot: WorkspaceSnapshot | null): string {
  if (!snapshot) {
    return [
      `- Target workspace: ${targetWorkspace}`,
      "- Git snapshot: unavailable",
      "- Required first action: run git status and inspect recent changes before editing.",
    ].join("\n");
  }
  if (!snapshot.git.available) {
    return [
      `- Target workspace: ${snapshot.project_dir}`,
      `- Git snapshot: unavailable (${snapshot.git.error ?? "not a git workspace"})`,
      "- Required first action: inspect the workspace manually before editing.",
    ].join("\n");
  }
  return [
    `- Target workspace: ${snapshot.project_dir}`,
    `- Git root: ${snapshot.git.root ?? "unknown"}`,
    `- Branch: ${snapshot.git.branch ?? "detached or unknown"}`,
    `- HEAD: ${snapshot.git.head ?? "unknown"}`,
    `- Dirty files: ${snapshot.git.dirty_count}`,
    formatBulletGroup("Recent commits", snapshot.git.recent_commits, 5, "No recent commits reported."),
    formatBulletGroup("Dirty file summary", snapshot.git.status_short, 20, "Working tree was clean when the snapshot was captured."),
  ].join("\n");
}

function formatWorkspaceMap(targetWorkspace: string, sourceWorkspaces: string[], sources: HandoffEvidence[]): string {
  return sourceWorkspaces
    .map((sourceWorkspace) => {
      const count = sources.filter((source) => sourceWorkspaceKey(source.workspace) === sourceWorkspaceKey(sourceWorkspace)).length;
      const targetMarker = sourceWorkspaceKey(sourceWorkspace) === sourceWorkspaceKey(targetWorkspace) ? "target" : "source";
      return `- ${workspaceLabel(sourceWorkspace)} (${targetMarker}): ${sourceWorkspace} (${count} source${count === 1 ? "" : "s"})`;
    })
    .join("\n");
}

function sourceSessionMetadata(source: HandoffEvidence): RecallSourceSession {
  return {
    key: source.key,
    kind: source.kind,
    provider: source.provider,
    title: source.title,
    workspace: source.workspace,
    id: source.id,
    status: source.status,
    usable: source.usable,
    evidence_score: source.analysis.score,
    terminal_id: source.kind === "embedded" ? source.session.id : source.session.terminalId ?? undefined,
    provider_session_id: source.kind === "embedded" ? source.session.providerSessionId ?? undefined : source.session.id,
    branch: source.kind === "native" ? source.session.branch ?? undefined : undefined,
    model: source.kind === "native" ? source.session.model ?? undefined : undefined,
  };
}

function formatSourceSessionLine(source: RecallSourceSession): string {
  const score = typeof source.evidence_score === "number" ? `, score ${source.evidence_score}` : "";
  const usable = source.usable ? "usable" : "no usable evidence";
  return `- [${workspaceLabel(String(source.workspace ?? ""))}] ${source.kind ?? "source"} ${source.provider ?? "unknown"}: ${source.title ?? "Untitled"} (${source.status ?? "unknown"}, ${source.id ?? "no id"}, ${usable}${score})`;
}

function formatSourceProvenance(source: HandoffEvidence): string {
  return [
    `- Workspace: ${source.workspace}`,
    `- Provider: ${source.provider}`,
    `- Session: ${source.id}`,
    `- Status: ${source.status}`,
    `- Evidence score: ${source.analysis.score}`,
  ].join("\n");
}

function formatBulletList(items: string[], empty: string, limit: number): string {
  const visible = items.slice(0, limit).filter(Boolean);
  return visible.length ? visible.map((item) => `- ${item}`).join("\n") : `- ${empty}`;
}

function formatBulletGroup(title: string, items: string[], limit: number, empty: string): string {
  const visible = items.slice(0, limit).filter(Boolean);
  return [`- ${title}:`, ...(visible.length ? visible : [empty]).map((item) => `  - ${item}`)].join("\n");
}

function uniqueSourceWorkspaces(sources: HandoffSessionSource[]): string[] {
  const workspaces: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const key = sourceWorkspaceKey(source.workspace);
    if (seen.has(key)) continue;
    seen.add(key);
    workspaces.push(source.workspace);
  }
  return workspaces;
}

function sourceWorkspaceKey(workspace: string): string {
  return normalizeWorkspaceKey(workspace || "unknown");
}

function handoffSourceKey(workspace: string, selectionKey: string): string {
  return `${sourceWorkspaceKey(workspace)}::${selectionKey}`;
}

function workspaceLabel(workspace: string): string {
  const normalized = workspace.replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized.split("/").filter(Boolean).at(-1) || workspace || "Unknown workspace";
}

function analyzeHandoffEvidence(value: string, source: HandoffSessionSource): HandoffAnalysis {
  const lines = extractHandoffLines(value);
  const analysis = emptyHandoffAnalysis();
  for (const line of lines) {
    collectUnique(analysis.files, extractFileReferences(line), 18);
    if (isCommandLine(line)) collectUnique(analysis.commands, [cleanCommandLine(line)], 14);
    if (isFailureLine(line)) collectUnique(analysis.failures, [line], 12);
    if (isDecisionLine(line)) collectUnique(analysis.decisions, [line], 12);
    if (isQuestionLine(line)) collectUnique(analysis.questions, [line], 8);
    if (isNextStepLine(line)) collectUnique(analysis.nextSteps, [normalizeActionLine(line)], 10);
    if (isOutcomeLine(line)) collectUnique(analysis.outcomes, [line], 12);
    if (isConcreteEvidenceLine(line)) collectUnique(analysis.notable, [normalizeEvidenceLine(line)], 24);
  }
  if (source.kind === "native") {
    collectUnique(analysis.outcomes, [
      source.session.branch ? `Branch: ${source.session.branch}` : "",
      source.session.model ? `Model: ${source.session.model}` : "",
      source.session.metadata?.git_commit_hash ? `Commit: ${source.session.metadata.git_commit_hash}` : "",
      source.session.metadata?.collaboration_mode ? `Collaboration: ${source.session.metadata.collaboration_mode}` : "",
    ], 12);
  }
  analysis.score = handoffScore(analysis);
  return analysis;
}

function extractHandoffLines(value: string): string[] {
  const cleaned = stripTerminalControls(removeExistingHandoffBlocks(value));
  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter(isMeaningfulHandoffLine);
  const uniqueLines: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueLines.push(line);
  }
  return uniqueLines.slice(-160);
}

function emptyHandoffAnalysis(): HandoffAnalysis {
  return {
    score: 0,
    files: [],
    commands: [],
    outcomes: [],
    failures: [],
    decisions: [],
    questions: [],
    nextSteps: [],
    notable: [],
  };
}

function combineHandoffAnalyses(analyses: HandoffAnalysis[]): HandoffAnalysis {
  const combined = emptyHandoffAnalysis();
  for (const analysis of analyses) {
    collectUnique(combined.files, analysis.files, 20);
    collectUnique(combined.commands, analysis.commands, 18);
    collectUnique(combined.outcomes, analysis.outcomes, 18);
    collectUnique(combined.failures, analysis.failures, 18);
    collectUnique(combined.decisions, analysis.decisions, 18);
    collectUnique(combined.questions, analysis.questions, 12);
    collectUnique(combined.nextSteps, analysis.nextSteps, 12);
    collectUnique(combined.notable, analysis.notable, 32);
  }
  combined.score = analyses.reduce((total, analysis) => total + analysis.score, 0);
  return combined;
}

function isUsableHandoffAnalysis(analysis: HandoffAnalysis): boolean {
  return analysis.score >= 3;
}

function handoffScore(analysis: HandoffAnalysis): number {
  return Math.min(6, analysis.files.length)
    + Math.min(6, analysis.commands.length)
    + Math.min(8, analysis.outcomes.length)
    + Math.min(8, analysis.failures.length)
    + Math.min(8, analysis.decisions.length)
    + Math.min(6, analysis.nextSteps.length)
    + Math.min(4, analysis.notable.length);
}

function formatEvidenceGroup(title: string, items: string[], limit = 10, headingLevel = 3): string {
  const visible = items.slice(0, limit).filter(Boolean);
  if (visible.length === 0) return "";
  return [`${"#".repeat(headingLevel)} ${title}`, ...visible.map((item) => `- ${item}`)].join("\n");
}

function collectUnique(target: string[], values: string[], limit: number): void {
  const seen = new Set(target.map((value) => value.toLowerCase()));
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(trimmed);
    if (target.length >= limit) return;
  }
}

function extractFileReferences(line: string): string[] {
  const matches = line.match(/(?:[A-Za-z]:\\[^\s"'`<>|]+|(?:\.{1,2}\/)?[\w.-]+(?:\/[\w.@-]+)+\.[A-Za-z0-9]{1,8}|[\w.-]+\.(?:ts|tsx|js|jsx|py|md|json|yml|yaml|toml|css|html|sql|go|rs))/g) ?? [];
  return matches
    .map((match) => match.replace(/[),.;:]+$/g, "").replace(/^(?:a|b)\//, ""))
    .filter((match) => !/^\.?git\//.test(match));
}

function isCommandLine(line: string): boolean {
  if (isSourceCodeLine(line)) return false;
  if (parseToolCommand(line)) return true;
  return /^(?:[$>]\s*)?(?:git|npm|pnpm|yarn|bun|python|python3|pytest|uvicorn|gh|rg|grep|find|Get-Content|Set-Location|cd|ls|dir|cat|curl|docker|pip|tsc|vite|electron-builder)\b/i.test(line)
    || /\b(?:npm run|git -c|pytest|python -m|gh pr|gh issue|rg -n)\b/i.test(line);
}

function cleanCommandLine(line: string): string {
  return (parseToolCommand(line) ?? line.replace(/^(?:[$>]\s*)/, "")).replace(/\\"/g, "\"").slice(0, 220);
}

function isFailureLine(line: string): boolean {
  if (isSourceCodeLine(line)) return false;
  if (isTemplateFragmentLine(line)) return false;
  if (isDiffLine(line) || isGitLogLine(line) || isToolJsonLine(line)) return false;
  return /\b(error|failed|failure|exception|traceback|timeout|timed out|crash|blocked|cannot|can't|unable|refused|denied|regression|bug|warning)\b/i.test(line);
}

function isDecisionLine(line: string): boolean {
  if (isSourceCodeLine(line)) return false;
  if (isTemplateFragmentLine(line)) return false;
  if (isDiffLine(line) || isGitLogLine(line) || isToolJsonLine(line)) return false;
  return /\b(decision|decided|chosen|choose|we should|should use|recommend|recommended|approach|instead|keep|remove|do not|don't|won't|will not)\b/i.test(line);
}

function isQuestionLine(line: string): boolean {
  if (isSourceCodeLine(line)) return false;
  if (isTemplateFragmentLine(line)) return false;
  if (isDiffLine(line) || isGitLogLine(line) || isToolJsonLine(line)) return false;
  return line.endsWith("?") || /\b(open question|unclear|needs clarification|unknown|investigate|verify whether)\b/i.test(line);
}

function isNextStepLine(line: string): boolean {
  if (isSourceCodeLine(line)) return false;
  if (isTemplateFragmentLine(line) || isCompletedPrLine(line)) return false;
  if (isDiffLine(line) || isGitLogLine(line) || isToolJsonLine(line)) return false;
  return /^(?:next|todo|follow[- ]?up|remaining|recommended next|open task)\b/i.test(line)
    || /\b(?:still need|needs? to|should be|go ahead and|implement|fix|add|update|clean up|tighten|rerun|verify|pr this|open a pr)\b/i.test(line);
}

function isOutcomeLine(line: string): boolean {
  if (isSourceCodeLine(line)) return false;
  if (isTemplateFragmentLine(line)) return false;
  if (isDiffLine(line) || isToolJsonLine(line)) return false;
  return /\b(done|completed|implemented|fixed|merged|passed|succeeded|works|verified|built|created|updated|added|removed|changed|saved|wrote|opened PR|PR #\d+)\b/i.test(line);
}

function isConcreteEvidenceLine(line: string): boolean {
  if (isSourceCodeLine(line)) return false;
  if (isTemplateFragmentLine(line)) return false;
  return isCommandLine(line)
    || isFailureLine(line)
    || isDecisionLine(line)
    || isOutcomeLine(line)
    || (!isDiffLine(line) && extractFileReferences(line).length > 0)
    || /\b(PR #\d+|commit|branch|build|dist|test|backend|frontend|Electron|FastAPI|Hermes|Codex|OpenCode|Claude|recall|handoff)\b/i.test(line);
}

function normalizeEvidenceLine(line: string): string {
  return cleanCommandLine(line);
}

function normalizeActionLine(line: string): string {
  return line
    .replace(/^I(?:'|’)ll\s+/i, "")
    .replace(/^I will\s+/i, "")
    .replace(/^go ahead and\s+/i, "")
    .replace(/^okay\s+/i, "")
    .trim();
}

function parseToolCommand(line: string): string | null {
  if (!isToolJsonLine(line)) return null;
  try {
    const parsed = JSON.parse(line) as { command?: unknown };
    return typeof parsed.command === "string" && parsed.command.trim() ? parsed.command.trim() : null;
  } catch {
    const match = line.match(/"command"\s*:\s*"((?:\\"|[^"])*)"/);
    return match?.[1]?.replace(/\\"/g, "\"").trim() || null;
  }
}

function isToolJsonLine(line: string): boolean {
  return /^\{\s*"command"\s*:/.test(line);
}

function isDiffLine(line: string): boolean {
  return /^(?:\+|-)(?!\s?(?:PR #|\d|\w+\s))/i.test(line)
    || /^(?:\+|-)\|/.test(line)
    || /^(?:@@|diff --git|index [a-f0-9]+\.\.|--- |\+\+\+ )/.test(line);
}

function isGitLogLine(line: string): boolean {
  return /^[a-f0-9]{7,40}\s+(?:Merge pull request|Merge branch|Add |Fix |Update |Read |Reduce |Centralize |Extract |Polish |Curate )/i.test(line);
}

function isCompletedPrLine(line: string): boolean {
  return /PR #\d+.*\b(?:merged|closed|superseded)\b/i.test(line)
    || /\b(?:merged|closed|superseded)\b.*PR #\d+/i.test(line);
}

function isTemplateFragmentLine(line: string): boolean {
  return /^[-*]\s*(?:failed approaches|next recommended action|task goal|files touched or inspected|commands run and results|decisions made|current state|open questions|next-step context)\s*$/i.test(line)
    || /^(?:failed approaches|next recommended action|task goal|files touched or inspected|commands run and results|decisions made|current state|open questions|next-step context)$/i.test(line);
}

function removeExistingHandoffBlocks(value: string): string {
  const index = value.indexOf("# Athena Session Handoff");
  return index >= 0 ? value.slice(0, index) : value;
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/[╹┃━─▀▄█]+/g, " ");
}

function isMeaningfulHandoffLine(line: string): boolean {
  if (line.length < 6 || line.length > 240) return false;
  if (!/[a-zA-Z]/.test(line)) return false;
  if (isSourceCodeLine(line)) return false;
  if (/^(generated|workspace|sources|summary|selected sessions|recent evidence|next suggested context)$/i.test(line)) return false;
  if (/^#*\s*athena session handoff/i.test(line)) return false;
  if (/^\[?truncated to last \d+ chars\]?/i.test(line)) return false;
  if (/\b(ctrl\+p commands|parent up|prev left|next right|explore \(|build ·|mini.?max|tokens?\)|\d+(?:\.\d+)?k \(\d+%\))/i.test(line)) return false;
  if (/^\W+$/.test(line)) return false;
  const letters = line.match(/[a-zA-Z]/g)?.length ?? 0;
  const visible = line.replace(/\s/g, "").length;
  return visible > 0 && letters / visible > 0.25;
}

function isSourceCodeLine(line: string): boolean {
  const normalized = line.replace(/^\d+:\s*/, "").trim();
  if (isToolJsonLine(normalized)) return false;
  if (/^(?:import|export|const|let|var|function|return|if|else|for|while|switch|case|type|interface|class|try|catch|await|async)\b/.test(normalized)) return true;
  if (/^(?:\}|\{|\)|\]|\[|<\/?[A-Za-z][^>]*>|[});,]+)$/.test(normalized)) return true;
  if (/[{}]/.test(normalized) && /(?:=>|\$\{|<\w+|<\/\w+|on[A-Z]\w*=|className=|use[A-Z]\w+\(|set[A-Z]\w*\()/.test(normalized)) return true;
  if (/(?:\?\?|\?\.|=>|<\/|\/>|;\s*$)/.test(normalized) && /[{}()[\]=]/.test(normalized)) return true;
  if (/^(?:["'`][\w.-]+["'`]\s*:|[A-Za-z_$][\w$]*\s*:)/.test(normalized) && /[,{}[\]]/.test(normalized)) return true;
  if (/^\*\*Tool:\s+.+\s+\(completed\)\*\*$/.test(normalized)) return true;
  if (/`[^`]*\$\{[^`]*\}[^`]*`/.test(normalized)) return true;

  const punctuation = normalized.match(/[{}()[\];=<>`]/g)?.length ?? 0;
  const visible = normalized.replace(/\s/g, "").length;
  return visible > 0 && punctuation / visible > 0.22 && !isCommandLikeText(normalized);
}

function isCommandLikeText(line: string): boolean {
  return /^(?:[$>]\s*)?(?:git|npm|pnpm|yarn|bun|python|python3|pytest|uvicorn|gh|rg|grep|find|Get-Content|Set-Location|cd|ls|dir|cat|curl|docker|pip|tsc|vite|electron-builder)\b/i.test(line);
}

function tailText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) return normalized;
  return `[truncated to last ${maxChars} chars]\n${normalized.slice(-maxChars)}`;
}

function tailBuffer(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `[truncated to last ${maxChars} chars]\n${value.slice(-maxChars)}`;
}
