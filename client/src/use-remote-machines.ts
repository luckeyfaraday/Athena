import { useEffect, useState } from "react";
import { desktop, type RemoteSnapshot } from "./electron";

// Main pushes a snapshot whenever a remote machine, its terminals, or its tabs
// change; the slow poll only covers a missed push (e.g. a reloaded window).
const REMOTE_SNAPSHOT_POLL_MS = 30_000;

export function useRemoteMachines(): RemoteSnapshot | null {
  const [snapshot, setSnapshot] = useState<RemoteSnapshot | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void desktop.getRemoteSnapshot()
        .then((next) => {
          if (!cancelled) setSnapshot(next);
        })
        .catch(() => undefined);
    };
    const removeUpdate = desktop.onRemoteUpdate((next) => {
      if (!cancelled) setSnapshot(next);
    });
    load();
    const timer = window.setInterval(load, REMOTE_SNAPSHOT_POLL_MS);
    return () => {
      cancelled = true;
      removeUpdate();
      window.clearInterval(timer);
    };
  }, []);
  return snapshot;
}
