import { useCallback, useEffect, useRef, useState } from "react";
import { desktop, type AgentSession, type RemoteSessionPage } from "./electron";

type History = { key: string; sessions: AgentSession[]; cursor: string | null; message: string | null; loading: boolean; at: number };
const empty = (key: string): History => ({ key, sessions: [], cursor: null, message: null, loading: false, at: 0 });

/** One visible workspace, no polling or prefetching. Late IPC replies cannot change the selected device/folder. */
export function useRemoteSessionHistory(machineId: string, workspace: string, visible: boolean) {
  const key = JSON.stringify([machineId, workspace]);
  const [history, setHistory] = useState<History>(() => empty(key));
  const current = useRef({ key, visible });
  current.current = { key, visible };
  const latest = useRef(history);
  latest.current = history;
  const sequence = useRef(0);
  const inFlight = useRef(new Map<string, Promise<RemoteSessionPage>>());

  const load = useCallback(async (cursor: string | null = null, maxAgeMs = 0) => {
    if (!workspace || !current.current.visible || current.current.key !== key) return;
    if (!cursor && latest.current.key === key && Date.now() - latest.current.at < maxAgeMs) return;
    const requestKey = JSON.stringify([machineId, workspace, cursor]);
    let pending = inFlight.current.get(requestKey);
    if (!pending && inFlight.current.size >= 2) {
      setHistory((value) => ({ ...(value.key === key ? value : empty(key)), message: "A history request is still finishing. Try Refresh again shortly." }));
      return;
    }
    const version = ++sequence.current;
    setHistory((value) => ({ ...(value.key === key ? value : empty(key)), loading: true, message: null }));
    if (!pending) {
      pending = desktop.listRemoteAgentSessions(machineId, workspace, cursor);
      inFlight.current.set(requestKey, pending);
      void pending.finally(() => inFlight.current.delete(requestKey)).catch(() => undefined);
    }
    const stillCurrent = () => sequence.current === version && current.current.key === key && current.current.visible;
    try {
      const page = await pending;
      if (!stillCurrent()) return;
      setHistory((value) => ({
        key, sessions: cursor && value.key === key ? [...value.sessions, ...page.sessions] : page.sessions,
        cursor: page.nextCursor, message: page.warning, loading: false, at: Date.now(),
      }));
    } catch (error) {
      if (!stillCurrent()) return;
      const message = String(error).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "").replace(/^Error: /, "");
      setHistory((value) => ({ ...(value.key === key ? value : empty(key)), loading: false, message }));
    }
  }, [key, machineId, workspace]);

  useEffect(() => {
    if (!visible) return;
    const open = () => { if (document.visibilityState === "visible") void load(null, 30_000); };
    open();
    document.addEventListener("visibilitychange", open);
    return () => {
      ++sequence.current;
      document.removeEventListener("visibilitychange", open);
    };
  }, [visible, load]);

  const value = history.key === key ? history : empty(key);
  return { ...value, refresh: () => load(), loadMore: value.cursor ? () => load(value.cursor) : undefined };
}
