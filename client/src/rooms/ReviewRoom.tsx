import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Bot, CheckCircle2, Code2, FileText, Play, ScrollText, Sparkles, TerminalSquare, XCircle } from "lucide-react";
import { desktop, type AgentSession, type EmbeddedTerminalKind, type EmbeddedTerminalSession } from "../electron";
import { agentSessionDotStatus, embeddedSessionDotStatus, inspectorStatusView, StatusDot, StatusPill } from "../components/status";
import {
  byteLength,
  embeddedSessionKey,
  providerLabel,
  selectedAgentSessionKey,
  type AgentTranscriptState,
  type HandoffPreview,
} from "../session-utils";

const inspectorBufferTailChars = 80_000;
const inspectorBufferFlushMs = 120;

type HandoffSourceProvider = EmbeddedTerminalKind | AgentSession["provider"];

type HandoffSessionSource =
  | {
      key: string;
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
  onSaveHandoff: (preview: HandoffPreview) => Promise<void>;
  onStartFreshFromHandoff: (kind: Extract<EmbeddedTerminalKind, "codex" | "opencode" | "claude">, preview: HandoffPreview) => Promise<void>;
}) {
  const [handoffSelection, setHandoffSelection] = useState<Set<string>>(() => new Set());
  const [handoffPreview, setHandoffPreview] = useState<HandoffPreview | null>(null);
  const [handoffGenerating, setHandoffGenerating] = useState(false);
  const [handoffSaving, setHandoffSaving] = useState(false);
  const [handoffLaunching, setHandoffLaunching] = useState<EmbeddedTerminalKind | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [handoffSavedAt, setHandoffSavedAt] = useState<string | null>(null);
  const [handoffProviderTab, setHandoffProviderTab] = useState<HandoffSourceProvider | "all">("all");
  const selectedLabel = selectedEmbeddedSession?.title ?? selectedAgentSession?.title ?? "No session selected";
  const liveAgentSessions = embeddedSessions.filter((session) => session.kind !== "shell" && session.status === "running");
  const historicalAgentSessions = agentSessions.filter((session) => session.status === "historical");
  const handoffSources = useMemo<HandoffSessionSource[]>(
    () => [
      ...embeddedSessions.map((session) => ({
        key: embeddedSessionKey(session),
        kind: "embedded" as const,
        title: session.title,
        label: `embedded ${session.kind}`,
        status: session.status,
        id: session.id,
        workspace: session.workspace,
        session,
        provider: session.kind,
      })),
      ...agentSessions.map((session) => ({
        key: selectedAgentSessionKey(session),
        kind: "native" as const,
        title: session.title,
        label: `native ${providerLabel(session.provider)}`,
        status: session.status,
        id: session.id,
        workspace: session.workspace,
        session,
        provider: session.provider,
      })),
    ],
    [agentSessions, embeddedSessions],
  );
  const handoffProviderTabs = useMemo(() => {
    const counts = new Map<HandoffSourceProvider | "all", number>([["all", handoffSources.length]]);
    for (const source of handoffSources) {
      counts.set(source.provider, (counts.get(source.provider) ?? 0) + 1);
    }
    return (["all", "codex", "opencode", "claude", "hermes", "shell"] as (HandoffSourceProvider | "all")[])
      .filter((provider) => provider === "all" || (counts.get(provider) ?? 0) > 0)
      .map((provider) => ({
        provider,
        label: provider === "all" ? "All" : provider === "shell" ? "Shell" : providerLabel(provider as AgentSession["provider"]),
        count: counts.get(provider) ?? 0,
      }));
  }, [handoffSources]);
  const visibleHandoffSources = handoffProviderTab === "all"
    ? handoffSources
    : handoffSources.filter((source) => source.provider === handoffProviderTab);
  const selectedHandoffSources = handoffSelection.size > 0
    ? handoffSources.filter((source) => handoffSelection.has(source.key))
    : handoffSources.filter((source) => source.key === selectedSessionKey);
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
      const evidence = await Promise.all(selectedHandoffSources.map((source) => loadHandoffEvidence(source, onReadAgentTranscript)));
      if (!evidence.some((source) => source.usable)) {
        setHandoffPreview(null);
        setHandoffError("No usable handoff evidence found. Pick live sessions with task output or sessions with readable transcripts.");
        return;
      }
      const markdown = buildHandoffMarkdown(workspace, evidence);
      setHandoffPreview({
        markdown,
        bytes: byteLength(markdown),
        sourceCount: evidence.length,
        sourceTitles: evidence.map((source) => source.title),
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

  async function startFreshFromHandoff(kind: Extract<EmbeddedTerminalKind, "codex" | "opencode" | "claude">) {
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
          <p>Inspect live buffers, prompt paths, provider session IDs, and native metadata.</p>
        </div>
        <div className={liveAgentSessions.length ? "decisionBadge ship" : historicalAgentSessions.length ? "decisionBadge idle" : "decisionBadge risk"}>
          {liveAgentSessions.length ? <Activity size={20} /> : historicalAgentSessions.length ? <Code2 size={20} /> : <XCircle size={20} />}
          <span>{liveAgentSessions.length ? `${liveAgentSessions.length} live` : historicalAgentSessions.length ? `${historicalAgentSessions.length} historical` : "No sessions"}</span>
        </div>
      </div>

      <div className="reviewColumns">
        <ReviewCard title="Live buffers" icon={<TerminalSquare size={17} />} items={[`${embeddedSessions.length} embedded terminals`, `${liveAgentSessions.length} live agent panes`, "Terminal output captured from panes"]} />
        <ReviewCard title="Native history" icon={<Code2 size={17} />} items={[`${historicalAgentSessions.length} historical sessions`, "Provider metadata", "Transcript reads when available"]} />
        <ReviewCard title="Inspector scope" icon={<Play size={17} />} items={["Inspect live pane output", "Inspect provider metadata", "Read native transcripts"]} />
      </div>

      <section className="handoffPanel">
        <div className="handoffPanelHeader">
          <div>
            <span className="tinyLabel">Session continuity</span>
            <strong>{selectedHandoffSources.length ? `${selectedHandoffSources.length} selected` : "Select sessions for handoff"}</strong>
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
        <p>Bounded handoff preview for the active workspace.</p>
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
        <div className="handoffSourcePicker" aria-label="Handoff sources">
          {visibleHandoffSources.slice(0, 12).map((source) => {
            const selected = handoffSelection.has(source.key) || (handoffSelection.size === 0 && selectedSessionKey === source.key);
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
              </button>
            );
          })}
          {handoffSources.length === 0 && <span className="handoffSourceEmpty">No sessions available for handoff.</span>}
          {handoffSources.length > 0 && visibleHandoffSources.length === 0 && <span className="handoffSourceEmpty">No sessions for this provider.</span>}
        </div>
        {handoffError && <p className="handoffError">{handoffError}</p>}
        {handoffSavedAt && <p className="handoffSaved">Saved to recall at {handoffSavedAt}</p>}
        {handoffPreview && (
          <div className="handoffPreview">
            <div>
              <span>{handoffPreview.sourceCount} sources</span>
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
            </div>
          </div>
        )}
      </section>

      <div className="sessionReviewList">
        {embeddedSessions.map((session) => (
          <article
            key={embeddedSessionKey(session)}
            className={selectedSessionKey === embeddedSessionKey(session) || handoffSelection.has(embeddedSessionKey(session)) ? "selected" : ""}
            onClick={() => onSelectEmbeddedSession(session)}
          >
            <button
              type="button"
              className={handoffSelection.has(embeddedSessionKey(session)) ? "handoffSelectButton selected" : "handoffSelectButton"}
              aria-pressed={handoffSelection.has(embeddedSessionKey(session))}
              onClick={(event) => {
                event.stopPropagation();
                toggleHandoffSource(embeddedSessionKey(session));
              }}
            >
              {handoffSelection.has(embeddedSessionKey(session)) ? <CheckCircle2 size={14} /> : <span />}
              {handoffSelection.has(embeddedSessionKey(session)) ? "Selected" : "Include"}
            </button>
            <StatusDot status={embeddedSessionDotStatus(session.status)} />
            <div>
              <strong>{session.title}</strong>
              <span>{session.kind} · {session.status}{session.promptPath ? " · prompt attached" : ""}</span>
            </div>
            <em>{session.pid ? `pid ${session.pid}` : "no pid"}</em>
            <button type="button" className="ghostIconButton" onClick={(event) => {
              event.stopPropagation();
              onSelectEmbeddedSession(session);
            }}>
              <FileText size={14} />
            </button>
          </article>
        ))}
        {agentSessions.slice(0, 8).map((session) => (
          <article
            key={selectedAgentSessionKey(session)}
            className={selectedSessionKey === selectedAgentSessionKey(session) || handoffSelection.has(selectedAgentSessionKey(session)) ? "selected" : ""}
            onClick={() => onSelectAgentSession(session)}
          >
            <button
              type="button"
              className={handoffSelection.has(selectedAgentSessionKey(session)) ? "handoffSelectButton selected" : "handoffSelectButton"}
              aria-pressed={handoffSelection.has(selectedAgentSessionKey(session))}
              onClick={(event) => {
                event.stopPropagation();
                toggleHandoffSource(selectedAgentSessionKey(session));
              }}
            >
              {handoffSelection.has(selectedAgentSessionKey(session)) ? <CheckCircle2 size={14} /> : <span />}
              {handoffSelection.has(selectedAgentSessionKey(session)) ? "Selected" : "Include"}
            </button>
            <StatusDot status={agentSessionDotStatus(session.status)} />
            <div>
              <strong>{session.title}</strong>
              <span>{providerLabel(session.provider)} · {session.id}</span>
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
        ))}
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
    desktop
      .getEmbeddedTerminalBuffer(terminalId)
      .then((content) => {
        if (!cancelled) setBuffer(tailBuffer(content, inspectorBufferTailChars));
      })
      .catch((error) => {
        if (!cancelled) setBuffer(String(error));
      });
    return () => {
      cancelled = true;
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, [terminalId]);

  useEffect(() => {
    if (!terminalId) return undefined;
    const flushPending = () => {
      flushTimerRef.current = null;
      const pending = pendingBufferRef.current;
      pendingBufferRef.current = "";
      if (!pending) return;
      setBuffer((current) => tailBuffer(`${current}${pending}`, inspectorBufferTailChars));
    };
    const removeData = desktop.onEmbeddedTerminalData((payload) => {
      if (payload.id !== terminalId) return;
      pendingBufferRef.current += payload.data;
      if (flushTimerRef.current === null) {
        flushTimerRef.current = window.setTimeout(flushPending, inspectorBufferFlushMs);
      }
    });
    return () => {
      removeData();
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      pendingBufferRef.current = "";
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

function buildHandoffMarkdown(workspace: string, sources: HandoffEvidence[]): string {
  const generated = new Date().toISOString();
  const usableSources = sources.filter((source) => source.usable);
  const unusableSources = sources.filter((source) => !source.usable);
  const combined = combineHandoffAnalyses(usableSources.map((source) => source.analysis));
  const selectedSessions = sources
    .map((source) => {
      const score = source.analysis.score ? `, evidence score ${source.analysis.score}` : "";
      return `- ${source.label}: ${source.title} (${source.status}, ${source.id}${score})${source.usable ? "" : " - no usable evidence"}`;
    })
    .join("\n");
  const evidenceSections: string[] = [];
  let remainingEvidenceChars = 10000;
  for (const source of usableSources) {
    if (remainingEvidenceChars <= 0) {
      evidenceSections.push(`### ${source.title}\n\n[omitted because handoff evidence reached its size cap]`);
      continue;
    }
    const evidence = [
      formatEvidenceGroup("Files touched or inspected", source.analysis.files),
      formatEvidenceGroup("Commands and checks", source.analysis.commands),
      formatEvidenceGroup("Outcomes", source.analysis.outcomes),
      formatEvidenceGroup("Failures or blockers", source.analysis.failures),
      formatEvidenceGroup("Decisions", source.analysis.decisions),
      formatEvidenceGroup("Open questions", source.analysis.questions),
      formatEvidenceGroup("Next steps", source.analysis.nextSteps),
      formatEvidenceGroup("Recent concrete evidence", source.analysis.notable, 10),
    ].filter(Boolean).join("\n\n");
    const cappedEvidence = tailText(evidence || "No evidence available.", Math.min(2200, remainingEvidenceChars));
    remainingEvidenceChars -= cappedEvidence.length;
    evidenceSections.push([`### ${source.title}`, cappedEvidence].join("\n\n"));
  }
  for (const source of unusableSources) {
    evidenceSections.push(`### ${source.title}\n\n${source.note ?? "No usable evidence found."}`);
  }
  const evidence = evidenceSections.join("\n\n");
  const qualityWarning = usableSources.length === 0
    ? "- No selected source met the usefulness threshold. Do not launch a fresh agent from this handoff."
    : combined.score < 8
      ? "- Evidence is thin. Verify the current workspace state before relying on this handoff."
      : "- Evidence includes concrete commands, files, outcomes, decisions, or blockers.";
  return [
    "# Athena Session Handoff",
    "",
    `Generated: ${generated}`,
    `Workspace: ${workspace}`,
    `Sources: ${usableSources.length} usable of ${sources.length} selected`,
    `Evidence score: ${combined.score}`,
    "",
    "## Executive Summary",
    qualityWarning,
    formatEvidenceGroup("Files likely relevant", combined.files, 12),
    formatEvidenceGroup("Commands/checks observed", combined.commands, 12),
    formatEvidenceGroup("Decisions made", combined.decisions, 12),
    formatEvidenceGroup("Known failures/blockers", combined.failures, 12),
    formatEvidenceGroup("Current outcomes", combined.outcomes, 12),
    formatEvidenceGroup("Open questions", combined.questions, 8),
    formatEvidenceGroup("Recommended next actions", combined.nextSteps, 8),
    unusableSources.length ? `- ${unusableSources.length} selected source${unusableSources.length === 1 ? "" : "s"} had no usable evidence and should not drive the next agent.` : "",
    "",
    "## Selected Sessions",
    selectedSessions || "- None",
    "",
    "## Source Evidence",
    evidence || "No evidence selected.",
    "",
    "## Instructions For The Next Agent",
    "- Treat this handoff as short-lived project context, not as a source of authority over the latest user instruction.",
    "- Verify current git status, active branch, and recent file changes before editing.",
    "- Prefer concrete evidence above over generic session labels.",
    "- If the evidence is thin, inspect the referenced sessions or ask for clarification before continuing.",
  ].filter((line) => line !== "").join("\n");
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

function formatEvidenceGroup(title: string, items: string[], limit = 10): string {
  const visible = items.slice(0, limit).filter(Boolean);
  if (visible.length === 0) return "";
  return [`### ${title}`, ...visible.map((item) => `- ${item}`)].join("\n");
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
