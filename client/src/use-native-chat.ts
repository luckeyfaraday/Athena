import { useEffect, useRef, useState } from "react";
import { BackendClient, type NativeChatSnapshot } from "./api";
import { desktop, type EmbeddedTerminalSession } from "./electron";

export function useNativeChat(session: EmbeddedTerminalSession) {
  const [snapshot, setSnapshot] = useState<NativeChatSnapshot | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  useEffect(() => {
    if (session.kind === "shell" || !session.providerSessionId) return;
    let disposed = false;
    let timer = 0;
    let request: AbortController | null = null;
    async function refresh() {
      let interval = session.status === "running" ? 1_000 : 5_000;
      request = new AbortController();
      try {
        const backend = await desktop.getBackendState();
        if (disposed) return;
        if (!backend.baseUrl) throw new Error("Conversation history is reconnecting. You can continue in the terminal.");
        const next = await new BackendClient(backend.baseUrl).chatMessages(
          session.kind, session.providerSessionId!, AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]),
        );
        if (disposed) return;
        // An empty file during startup or an atomic rewrite must not erase replies.
        if (next.messages.length) setSnapshot((previous) => previous?.revision === next.revision ? previous : next);
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
  }, [session.id, session.kind, session.providerSessionId, session.status]);
  return { snapshot, snapshotRef, historyError };
}
