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
  usable: boolean;
  note: string | null;
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
  onLoadAgentTranscript: (session: AgentSession) => Promise<void>;
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
      const evidence = await Promise.all(selectedHandoffSources.map(loadHandoffEvidence));
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
  onLoadAgentTranscript: (session: AgentSession) => Promise<void>;
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

async function loadHandoffEvidence(source: HandoffSessionSource): Promise<HandoffEvidence> {
  const terminalId = source.kind === "embedded" ? source.session.id : source.session.terminalId;
  if (!terminalId) {
    return {
      ...source,
      evidence: "",
      usable: false,
      note: "No live terminal buffer is attached to this session.",
    };
  }
  try {
    const buffer = await desktop.getEmbeddedTerminalBuffer(terminalId);
    const evidence = extractHandoffEvidence(buffer);
    return {
      ...source,
      evidence,
      usable: evidence.length > 0,
      note: evidence.length > 0 ? null : "No usable task evidence could be extracted from the terminal buffer.",
    };
  } catch (err) {
    return {
      ...source,
      evidence: "",
      usable: false,
      note: `Unable to read live buffer: ${String(err)}`,
    };
  }
}

function buildHandoffMarkdown(workspace: string, sources: HandoffEvidence[]): string {
  const generated = new Date().toISOString();
  const usableSources = sources.filter((source) => source.usable);
  const unusableSources = sources.filter((source) => !source.usable);
  const selectedSessions = sources
    .map((source) => `- ${source.label}: ${source.title} (${source.status}, ${source.id})${source.usable ? "" : " - no usable evidence"}`)
    .join("\n");
  const evidenceSections: string[] = [];
  let remainingEvidenceChars = 12000;
  for (const source of usableSources) {
    if (remainingEvidenceChars <= 0) {
      evidenceSections.push(`### ${source.title}\n\n[omitted because handoff evidence reached its size cap]`);
      continue;
    }
    const evidence = tailText(source.evidence.trim() || "No evidence available.", Math.min(1800, remainingEvidenceChars));
    remainingEvidenceChars -= evidence.length;
    evidenceSections.push([`### ${source.title}`, evidence].join("\n\n"));
  }
  for (const source of unusableSources) {
    evidenceSections.push(`### ${source.title}\n\n${source.note ?? "No usable evidence found."}`);
  }
  const evidence = evidenceSections.join("\n\n");
  return [
    "# Athena Session Handoff",
    "",
    `Generated: ${generated}`,
    `Workspace: ${workspace}`,
    `Sources: ${usableSources.length} usable of ${sources.length} selected`,
    "",
    "## Summary",
    "- Bounded handoff generated from selected Athena sessions with usable evidence.",
    unusableSources.length ? `- ${unusableSources.length} selected source${unusableSources.length === 1 ? "" : "s"} had no usable evidence and should not drive the next agent.` : "",
    "",
    "## Selected Sessions",
    selectedSessions || "- None",
    "",
    "## Recent Evidence",
    evidence || "No evidence selected.",
    "",
    "## Next Suggested Context",
    "- Use this handoff as short-lived project context.",
    "- Verify current git state and latest user instructions before making changes.",
  ].filter((line) => line !== "").join("\n");
}

function extractHandoffEvidence(value: string): string {
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
  return tailText(uniqueLines.slice(-24).join("\n"), 1800);
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
  if (/^(generated|workspace|sources|summary|selected sessions|recent evidence|next suggested context)$/i.test(line)) return false;
  if (/^#*\s*athena session handoff/i.test(line)) return false;
  if (/^\[?truncated to last \d+ chars\]?/i.test(line)) return false;
  if (/\b(ctrl\+p commands|parent up|prev left|next right|explore \(|build ·|mini.?max|tokens?\)|\d+(?:\.\d+)?k \(\d+%\))/i.test(line)) return false;
  if (/^\W+$/.test(line)) return false;
  const letters = line.match(/[a-zA-Z]/g)?.length ?? 0;
  const visible = line.replace(/\s/g, "").length;
  return visible > 0 && letters / visible > 0.25;
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
