type TerminalWindowReturnListener = () => void;

const listeners = new Set<TerminalWindowReturnListener>();
let installed = false;

function notifyWindowReturn(): void {
  for (const listener of Array.from(listeners)) listener();
}

function handleVisibilityChange(): void {
  if (document.visibilityState === "visible") notifyWindowReturn();
}

function install(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("focus", notifyWindowReturn);
  window.addEventListener("pageshow", notifyWindowReturn);
  document.addEventListener("visibilitychange", handleVisibilityChange);
}

function uninstall(): void {
  if (!installed) return;
  installed = false;
  window.removeEventListener("focus", notifyWindowReturn);
  window.removeEventListener("pageshow", notifyWindowReturn);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
}

/** One shared browser lifecycle listener fan-outs to mounted terminal views. */
export function subscribeTerminalWindowReturn(listener: TerminalWindowReturnListener): () => void {
  listeners.add(listener);
  install();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) uninstall();
  };
}
