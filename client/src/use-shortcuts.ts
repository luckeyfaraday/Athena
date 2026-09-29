import { useEffect, useRef } from "react";
import { isMacPlatform, matchShortcut, type ShortcutId } from "./shortcuts";

export type ShortcutHandlers = Partial<Record<ShortcutId, () => void>>;

// Listens in the capture phase on window so app shortcuts win over xterm,
// which would otherwise swallow the key in its hidden textarea. Only keys with
// a handler are consumed; everything else reaches the terminal untouched.
export function useGlobalShortcuts(handlers: ShortcutHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const mac = isMacPlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      const id = matchShortcut(event, mac);
      if (!id) return;
      const handler = handlersRef.current[id];
      if (!handler) return;
      event.preventDefault();
      event.stopPropagation();
      handler();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
