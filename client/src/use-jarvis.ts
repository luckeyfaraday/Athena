import { useCallback, useEffect, useState } from "react";
import { desktop, type JarvisState } from "./electron";

// Main pushes the Jarvis bridge state on every meaningful change (what Jarvis
// hears and says, its mic, its activity), so one load plus the subscription is
// enough; there is nothing to poll.
export function useJarvis(): [JarvisState | null, (next: JarvisState) => void] {
  const [state, setState] = useState<JarvisState | null>(null);

  // An invoke's reply can land after a newer push: keep whichever is newest.
  const apply = useCallback((next: JarvisState) => {
    setState((current) => (current && current.updatedAt > next.updatedAt ? current : next));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const removeUpdate = desktop.onJarvisState((next) => {
      if (!cancelled) apply(next);
    });
    void desktop.getJarvisState()
      .then((next) => {
        if (!cancelled) apply(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      removeUpdate();
    };
  }, [apply]);

  return [state, apply];
}
