import { useEffect, useRef, useState } from "react";
import { BackendClient, type NativeChatSnapshot } from "./api";
import { desktop, type EmbeddedTerminalSession } from "./electron";

/** Polling for a session whose file does not exist yet (a fresh pane before its first message). */
const MISSING_POLL_MS = 2_000;

type NativeChatState = { key: string; snapshot: NativeChatSnapshot; changedAt: number };

/** When each pane's native history last changed; survives chat-view remounts. */
const revisionSeenBySession = new Map<string, { key: string; revision: string; changedAt: number }>();

export function useNativeChat(session: EmbeddedTerminalSession) {
  const key = `${session.kind}:${session.providerSessionId ?? ""}`;
  const [state, setState] = useState<NativeChatState | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  // Another provider session is another conversation: never show the old one for it.
  const current = state?.key === key ? state : null;
  const snapshot = current?.snapshot ?? null;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  useEffect(() => {
    setHistoryError(null);
    if (session.kind === "shell" || !session.providerSessionId) return;
    let disposed = false;
    let timer = 0;
    let request: AbortController | null = null;
    async function refresh() {
      const running = session.status === "running";
      let interval = running ? 1_000 : 5_000;
      request = new AbortController();
      try {
        const backend = await desktop.getBackendState();
        if (disposed) return;
        if (!backend.baseUrl) throw new Error("Conversation history is reconnecting. You can continue in the terminal.");
        const next = await new BackendClient(backend.baseUrl).chatMessages(
          session.kind, session.providerSessionId!, AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]), session.workspace,
        );
        if (disposed) return;
        // Not written yet: the terminal transcript stands in, without an error.
        if (next.missing) interval = running ? MISSING_POLL_MS : 10_000;
        // An empty file during startup or an atomic rewrite must not erase replies.
        else if (next.messages.length) {
          const seen = revisionSeenBySession.get(session.id);
          const changedAt = seen?.key === key && seen.revision === next.revision ? seen.changedAt : Date.now();
          revisionSeenBySession.set(session.id, { key, revision: next.revision, changedAt });
          setState((previous) => previous?.key === key && previous.snapshot.revision === next.revision
            ? previous
            : { key, snapshot: next, changedAt });
        }
        setHistoryError(null);
      } catch (error) {
        if (disposed) return;
        interval = 3_000;
        setHistoryError(error instanceof Error ? error.message : "Conversation history is unavailable.");
      }
      if (!disposed) timer = window.setTimeout(() => void refresh(), interval);
    }
    void refresh();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      request?.abort();
    };
  }, [key, session.id, session.kind, session.providerSessionId, session.status, session.workspace]);
  return { snapshot, snapshotRef, snapshotChangedAt: current?.changedAt ?? 0, historyError };
}
